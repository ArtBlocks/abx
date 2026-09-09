/**
 * `abx preview` — the studio lane: run a code project on localhost, live, before deploying it.
 *
 * The gap this closes: `abx inspect` proves a script is WIRED correctly (static analysis) and a
 * testnet deploy shows the real thing, but neither lets a creator sit with a piece and refine it.
 * A still-image sweep isn't enough either — it flattens every time-based piece, and `abx.done()`
 * exists precisely because stills need a settle point. So the primary surface is a real browser
 * page the creator opens, refreshes, and drives.
 *
 * FIDELITY IS THE WHOLE POINT: `/view` serves the *same* template-mode document
 * `assembleGeneratorDocument` builds (same shape, same real `ABX_JS`, same dependency script tags,
 * same canonical tokenData serialization) with a synthetic seed in place of a minted one. There is
 * no second copy of the runtime to drift — that was the flaw in hand-rolled preview harnesses,
 * which stub `window.abx` themselves and happily run a sketch that reads its seed the wrong way.
 *
 * The script is re-read from disk on every request, so edit-then-refresh needs no watcher.
 *
 * `--shoot <dir>` drives the SAME server headlessly (Playwright) and exits — that's how an agent,
 * which can't open localhost, sees what the creator sees. Captures are a derived read of the
 * preview document, never a parallel harness.
 */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {dirname, extname, join, resolve as resolvePath} from 'node:path';
import {createRequire} from 'node:module';
import {PARAM_TYPES, canonicalTokenDataJson, type ParsedDependencyRef} from '@artblocks/abx-sdk';
import {buildGeneratorDocument, injectTokenDataIntoHtml, registryDepUrl} from '@artblocks/abx-token-api';
import type {Flags} from './flags.js';
import {parseSchemaSpecs, type ParsedSchema} from './schema.js';
import {parseDepFlag} from './deps.js';

/** The studio's default port — deliberately not the resolver's (8787), so both can run at once. */
export const DEFAULT_PREVIEW_PORT = 8788;
/** A stand-in collection address. Real shape (20 bytes, lowercase) so `contractAddress` reads true. */
const PREVIEW_ADDRESS = '0x' + '11'.repeat(20);
const PREVIEW_CHAIN_ID = 84532;

// ── seeds ────────────────────────────────────────────────────────────────────────

/**
 * A deterministic preview seed per index. The on-chain seed is a full bytes32, and sha256 hex is
 * exactly 64 chars — real width, well mixed, and STABLE across runs, so re-rendering after an edit
 * is a like-for-like comparison instead of a whole new set of output. (A short stub seed would starve
 * the sketch's PRNG of entropy and can hide a distribution bug until it's permanent.)
 */
export function previewSeed(index: number): string {
  return '0x' + createHash('sha256').update(`abx-preview-seed-${index}`).digest('hex');
}

/** A fresh unpredictable seed — what the studio's "new" button asks for. */
function randomSeed(): string {
  return '0x' + randomBytes(32).toString('hex');
}

function normalizeSeed(raw: string | undefined, fallbackIndex = 0): string {
  const t = String(raw ?? '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  // Tolerate a short hex seed (someone pasting by hand) by left-padding to bytes32 — the same
  // width the chain would give it, so the sketch sees production-shaped entropy either way.
  if (/^0x[0-9a-fA-F]{1,64}$/.test(t)) return ('0x' + t.slice(2).toLowerCase().padStart(64, '0'));
  return previewSeed(fallbackIndex);
}

// ── the preview document ─────────────────────────────────────────────────────────

export interface PreviewSource {
  kind: 'script' | 'dir';
  /** Template mode: the script file. Directory mode: the build root. */
  path: string;
}

export interface PreviewConfig {
  source: PreviewSource;
  schemas: ParsedSchema[];
  deps: ParsedDependencyRef[];
}

/** Build the flat tokenData a token would carry, in the canonical shape `buildTokenData` produces. */
function previewTokenData(cfg: PreviewConfig, seed: string, tokenId: string, params: Record<string, string>) {
  const data: Record<string, string | number> = {
    chainId: PREVIEW_CHAIN_ID,
    contractAddress: PREVIEW_ADDRESS,
    tokenId,
    seed,
  };
  // Inject ONLY params that actually have a value — exactly what production does. `buildTokenData`
  // (the real path) walks the params that exist on-chain, so a declared schema key nobody has set is
  // ABSENT from tokenData and the program's own `?? fallback` runs.
  //
  // This used to inject a per-type default for every declared key (Select → its FIRST option) on the
  // theory that "a key that only appears once someone sets it is a preview that lies". That had it
  // backwards: the fabricated value is the lie. An optional `theme:Select[Newsprint|…]` override made
  // every frame render `theme: "Newsprint"` with nobody having set anything — nine seed-distinct
  // puzzles collapsed into one palette here, while the deployed drop (where the key is absent) would
  // take the program's other branch entirely. Unset must be indistinguishable from on-chain unset.
  for (const s of cfg.schemas) {
    const v = params[s.key];
    if (v !== undefined && v !== '') data[s.key] = v;
  }
  return {data, json: canonicalTokenDataJson(data)};
}

/**
 * Dependency script tags for the preview. Without a chain we can't read registry on-chain bytes,
 * so a `name@version` ref resolves through the SAME built-in CDN map the resolver falls back to,
 * and a raw on-chain data-contract ref can't be fetched at all (reported, not silently dropped).
 */
export function previewDepTags(deps: ParsedDependencyRef[]): {tags: string[]; notes: string[]} {
  const tags: string[] = [];
  const notes: string[] = [];
  for (const d of deps) {
    if (d.display.startsWith('0x')) {
      notes.push(`${d.display} — an on-chain data contract; not fetchable offline, so it is NOT loaded in preview`);
      continue;
    }
    const url = registryDepUrl(d.display);
    if (url) {
      tags.push(`<script src="${url}"></script>`);
      notes.push(`${d.display} → ${url} (built-in CDN map; on-chain bytes are resolved at deploy)`);
    } else {
      notes.push(`${d.display} — unresolvable to a CDN URL; not loaded in preview`);
    }
  }
  return {tags, notes};
}

/**
 * The template-mode document. This used to be a hand-maintained duplicate of
 * `assembleGeneratorDocument`'s shape in @artblocks/abx-token-api (token-api/src/code.ts), kept
 * byte-identical by a "if that changes, change this with it" comment and nothing else enforcing
 * it. Now it just IS that shape: a re-export of the token-api package's own
 * `buildGeneratorDocument`, the pure (chain-free) half `assembleGeneratorDocument` calls after
 * fetching the script + dep tags from chain. One definition; the studio cannot drift from it.
 */
export const buildPreviewDocument = buildGeneratorDocument;

/**
 * The logical viewport every preview frame renders into, then CSS-scaled to fit its slot.
 *
 * Why not just size the iframe to the slot: a sketch that hardcodes a 1000×1000 canvas (most do)
 * would be CLIPPED to the top-left corner of itself — which made an early grid look like a wall of
 * blank tiles. Giving every frame the same generous square (a typical marketplace live-view size)
 * and scaling the *result* means you always see the whole composition, and every tile is directly
 * comparable. The sketch's own view of the world is unchanged, so nothing is misrepresented.
 */
const STAGE_PX = 1000;

/** Fit-to-slot scaling for a fixed-size frame. Shared by the studio stage and every grid cell. */
const FIT_SNIPPET = `<script>(function(){
  var LOGICAL = ${STAGE_PX};
  function fit(){
    for (var s of document.querySelectorAll('.stage')) {
      s.style.setProperty('--k', (s.clientWidth / LOGICAL).toFixed(4));
    }
  }
  window.addEventListener('resize', fit);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(fit);
    for (var s of document.querySelectorAll('.stage')) ro.observe(s);
  }
  fit();
})();</script>`;

/** Stage CSS: a square slot holding a fixed-size frame, scaled down to fit it. */
const STAGE_CSS = `
  .stage{position:relative;aspect-ratio:1;overflow:hidden;background:#000;border:1px solid #24242c}
  .stage iframe{position:absolute;top:0;left:0;border:0;display:block;
    width:${STAGE_PX}px;height:${STAGE_PX}px;transform:scale(var(--k,0.25));transform-origin:0 0}`;

/** Report traits + completion back to the studio chrome (and to --shoot). Preview-only chrome. */
const REPORT_SNIPPET = `<script>(function(){
  function post(){
    try {
      parent.postMessage({abxPreview:true, traits: window.abx && window.abx.__traits,
        done: !!(window.abx && window.abx.__done), t: Math.round(performance.now())}, '*');
    } catch (e) {}
  }
  document.addEventListener('abx:traits', post);
  document.addEventListener('abx:done', post);
  setTimeout(post, 400); setTimeout(post, 1500);
})();</script>`;

async function renderViewDocument(cfg: PreviewConfig, seed: string, tokenId: string, params: Record<string, string>, withReport: boolean): Promise<string> {
  const {json} = previewTokenData(cfg, seed, tokenId, params);
  const {tags} = previewDepTags(cfg.deps);
  if (cfg.source.kind === 'dir') {
    // Directory mode mirrors the resolver's primary serving path: fetch the build's own entry
    // document and inject tokenData into it (the build ships its own abx.js by convention).
    const html = await readFile(join(cfg.source.path, 'index.html'), 'utf8');
    const injected = injectTokenDataIntoHtml(html, json, '/__abx_code/');
    return withReport ? injected.replace(/<\/body>/i, `${REPORT_SNIPPET}</body>`) : injected;
  }
  const script = await readFile(cfg.source.path, 'utf8'); // re-read per request → edit + refresh
  const doc = buildPreviewDocument(script, json, tags);
  return withReport ? doc.replace('</body>', `${REPORT_SNIPPET}</body>`) : doc;
}

// ── the studio chrome ────────────────────────────────────────────────────────────

function paramControl(s: ParsedSchema): string {
  const type = PARAM_TYPES[s.paramType];
  const id = `p_${s.key}`;
  const label = `<label for="${id}">${escapeHtml(s.key)}<span class="ty">${escapeHtml(type)}</span></label>`;
  let input: string;
  switch (type) {
    case 'Bool':
      input = `<input type="checkbox" id="${id}" data-key="${escapeHtml(s.key)}" data-kind="bool">`;
      break;
    case 'Select':
      // "— unset —" is FIRST and therefore the default position, so a fresh studio frame renders like
      // a fresh token: the key absent, the program's own fallback in charge. Without it, HTML selects
      // the first real option and there is no way to express "nobody has set this yet" — the state
      // every token is actually in until an owner writes one.
      input = `<select id="${id}" data-key="${escapeHtml(s.key)}" data-kind="text"><option value="">— unset (program fallback) —</option>${s.selectOptions
        .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
        .join('')}</select>`;
      break;
    case 'HexColor':
      input = `<input type="color" id="${id}" value="#3355ff" data-key="${escapeHtml(s.key)}" data-kind="text">`;
      break;
    case 'Uint256Range':
    case 'Int256Range':
    case 'DecimalRange':
    case 'Timestamp':
      input = `<input type="number" id="${id}" value="0" data-key="${escapeHtml(s.key)}" data-kind="text">`;
      break;
    default:
      input = `<input type="text" id="${id}" data-key="${escapeHtml(s.key)}" data-kind="text" placeholder="${escapeHtml(type)}">`;
  }
  return `<div class="ctl">${label}${input}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function studioPage(cfg: PreviewConfig, depNotes: string[]): string {
  const controls = cfg.schemas.map(paramControl).join('\n');
  const sourceLabel = cfg.source.kind === 'dir' ? `${cfg.source.path}/ (directory build)` : cfg.source.path;
  return `<!doctype html><html><head><meta charset="utf-8"><title>abx preview — studio</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0d0d10;color:#e6e6ea;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid #24242c;background:#131318}
  button{background:#22222b;color:#e6e6ea;border:1px solid #33333f;border-radius:6px;padding:5px 11px;font:inherit;cursor:pointer}
  button:hover{background:#2c2c37}
  .seed{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#9a9aa8;cursor:pointer}
  .seed:hover{color:#e6e6ea}
  .grow{flex:1}
  .ctls{display:flex;flex-wrap:wrap;gap:14px;padding:8px 14px;border-bottom:1px solid #24242c;background:#101014}
  .ctl{display:flex;align-items:center;gap:7px}
  .ctl label{color:#9a9aa8}
  .ctl .ty{color:#5b5b6b;margin-left:5px;font-size:11px}
  input,select{background:#1b1b22;color:#e6e6ea;border:1px solid #33333f;border-radius:5px;padding:3px 6px;font:inherit}
  input[type=color]{padding:1px;width:34px;height:24px}
  main{padding:16px;display:flex;justify-content:center}
  main .stage{width:min(78vh,100%)}
  ${STAGE_CSS}
  footer{padding:9px 14px;border-top:1px solid #24242c;background:#131318;display:flex;flex-wrap:wrap;gap:16px;align-items:center}
  .traits{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .warn{color:#e0a03a}.ok{color:#7ec07e}.dim{color:#6b6b7b}
  a{color:#8fa8e0}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#9a9aa8;word-break:break-all}
  .src{padding:0 14px 16px;font-size:12px}
</style></head><body>
<header>
  <button id="new">↻ new seed</button>
  <button id="prev">←</button><button id="next">→</button>
  <span class="seed" id="seedLabel" title="click to copy"></span>
  <span class="dim" id="idx"></span>
  <span class="grow"></span>
  <a href="/grid" target="_blank">grid ↗</a>
  <a href="#" id="viewLink" target="_blank">bare view ↗</a>
</header>
${controls ? `<div class="ctls">${controls}</div>` : ''}
<main><div class="stage"><iframe id="stage" title="preview"></iframe></div></main>
<footer>
  <span class="dim">traits</span> <span class="traits" id="traits">—</span>
  <span class="grow"></span>
  <span id="done" class="dim">waiting…</span>
</footer>
<div class="src dim">
  <code>${escapeHtml(sourceLabel)}</code> — re-read from disk on every render, so edit and refresh.
  Rendered at ${STAGE_PX}×${STAGE_PX} and scaled to fit.
  ${depNotes.length ? `<br>deps: ${depNotes.map((n) => escapeHtml(n)).join('<br>')}` : ''}
</div>
${FIT_SNIPPET}
<script>
  let index = 0, seed = null;
  const stage = document.getElementById('stage');
  function params() {
    const out = {};
    for (const el of document.querySelectorAll('[data-key]')) {
      out[el.dataset.key] = el.dataset.kind === 'bool' ? String(el.checked) : String(el.value);
    }
    return out;
  }
  function url(extra) {
    const q = new URLSearchParams({tokenId: String(index), ...params(), ...(extra || {})});
    if (seed) q.set('seed', seed);
    return '/view?' + q.toString();
  }
  function render() {
    document.getElementById('traits').textContent = '—';
    const d = document.getElementById('done'); d.textContent = 'waiting…'; d.className = 'dim';
    const u = url();
    stage.src = u;
    document.getElementById('viewLink').href = u;
    document.getElementById('idx').textContent = '#' + index;
  }
  function setSeed(s) { seed = s; document.getElementById('seedLabel').textContent = s.slice(0, 10) + '…' + s.slice(-4); }
  document.getElementById('new').onclick = async () => {
    const r = await fetch('/api/seed'); setSeed((await r.json()).seed); render();
  };
  document.getElementById('next').onclick = () => { index++; seed = null; boot(); };
  document.getElementById('prev').onclick = () => { if (index > 0) { index--; seed = null; boot(); } };
  document.getElementById('seedLabel').onclick = () => seed && navigator.clipboard?.writeText(seed);
  for (const el of document.querySelectorAll('[data-key]')) el.addEventListener('change', render);
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.abxPreview) return;
    const t = e.data.traits;
    document.getElementById('traits').textContent = t && Object.keys(t).length
      ? Object.entries(t).map(([k, v]) => k + ' ' + v).join('  ·  ')
      : 'none reported — abx.traits({…}) is the ONLY thing that becomes attributes';
    document.getElementById('traits').className = 'traits' + (t && Object.keys(t).length ? '' : ' warn');
    const d = document.getElementById('done');
    d.textContent = e.data.done ? 'abx.done() ✓ ' + e.data.t + 'ms' : 'no abx.done() yet — stills capture on a timeout fallback';
    d.className = e.data.done ? 'ok' : 'warn';
  });
  async function boot() { const r = await fetch('/api/seed?index=' + index); setSeed((await r.json()).seed); render(); }
  boot();
</script></body></html>`;
}

function gridPage(count: number): string {
  const cells = Array.from({length: count}, (_, i) => {
    const seed = previewSeed(i);
    const src = `/view?tokenId=${i}&seed=${seed}`;
    return `<figure><div class="stage"><iframe src="${src}" loading="lazy" title="seed ${i}"></iframe></div>
      <figcaption><a href="${src}" target="_blank">#${i}</a> <span>${seed.slice(0, 10)}…</span></figcaption></figure>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>abx preview — grid</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0d0d10;color:#e6e6ea;font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
  h1{font-size:14px;font-weight:600;padding:12px 16px;margin:0;border-bottom:1px solid #24242c;background:#131318}
  h1 span{color:#6b6b7b;font-weight:400}
  .wrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:16px}
  figure{margin:0}
  ${STAGE_CSS}
  figcaption{padding:5px 2px;color:#9a9aa8;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  figcaption span{color:#5b5b6b}
  figcaption a{color:#9a9aa8;text-decoration:none}figcaption a:hover{color:#e6e6ea}
</style></head><body>
<h1>${count} seeds, live <span>— every frame is the real preview document, animated. Rendered at ${STAGE_PX}×${STAGE_PX}, scaled to fit. Click a number to open one.</span></h1>
<div class="wrap">${cells}</div>
${FIT_SNIPPET}</body></html>`;
}

// ── the server ───────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
};

export interface PreviewServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startPreviewServer(cfg: PreviewConfig, port: number): Promise<PreviewServerHandle> {
  const {notes} = previewDepTags(cfg.deps);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const send = (code: number, type: string, body: string | Buffer) => {
        // Never cache: the whole point is that a refresh picks up the edit you just made.
        res.writeHead(code, {'content-type': type, 'cache-control': 'no-store'});
        res.end(body);
      };
      try {
        if (u.pathname === '/') return send(200, MIME['.html'], studioPage(cfg, notes));

        if (u.pathname === '/api/seed') {
          const idx = u.searchParams.get('index');
          const seed = idx === null ? randomSeed() : previewSeed(Number(idx) || 0);
          return send(200, MIME['.json'], JSON.stringify({seed}));
        }

        if (u.pathname === '/grid') {
          const count = Math.min(Math.max(Number(u.searchParams.get('count') ?? 9) || 9, 1), 64);
          return send(200, MIME['.html'], gridPage(count));
        }

        if (u.pathname === '/view') {
          const tokenId = String(Number(u.searchParams.get('tokenId') ?? 0) || 0);
          const seed = normalizeSeed(u.searchParams.get('seed') ?? undefined, Number(tokenId));
          const params: Record<string, string> = {};
          for (const s of cfg.schemas) {
            const v = u.searchParams.get(s.key);
            if (v !== null) params[s.key] = v;
          }
          const report = u.searchParams.get('report') !== '0';
          return send(200, MIME['.html'], await renderViewDocument(cfg, seed, tokenId, params, report));
        }

        // Directory mode: serve the build's own assets under a fixed base.
        if (cfg.source.kind === 'dir' && u.pathname.startsWith('/__abx_code/')) {
          const rel = decodeURIComponent(u.pathname.slice('/__abx_code/'.length));
          const root = resolvePath(cfg.source.path);
          const target = resolvePath(join(root, rel));
          // Path-traversal guard: a build asset can never escape the declared root.
          if (target !== root && !target.startsWith(root + '/')) return send(403, 'text/plain', 'forbidden');
          const body = await readFile(target);
          return send(200, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', body);
        }

        send(404, 'text/plain', 'not found');
      } catch (err) {
        send(500, 'text/plain', `preview error: ${(err as Error).message}`);
      }
    })();
  });

  const actual = await new Promise<number>((res2, rej) => {
    server.on('error', rej);
    // Port 0 ⇒ let the OS pick, so a busy studio port never blocks a --shoot run.
    server.listen(port, () => res2((server.address() as {port: number}).port));
  });

  return {
    port: actual,
    url: `http://localhost:${actual}`,
    close: () => new Promise<void>((res2) => server.close(() => res2())),
  };
}

// ── --shoot: headless capture of the SAME document ───────────────────────────────

export interface ShootResult {
  seed: string;
  file: string;
  traits: Record<string, unknown> | null;
  done: boolean;
  /** The wait for `abx.done()`/`abx.traits()` expired before the program signalled. The frame was
   *  still captured, but a `traits: null` on a timed-out frame says NOTHING about the program — it
   *  means we stopped watching. Reported separately so "we gave up" can never be printed as "your
   *  program reports no traits" (a correct program was condemned that way, and the agent spent a
   *  full diagnostic cycle on it). */
  timedOut: boolean;
}

/**
 * Render `count` seeds from a running preview server to PNGs, collecting each frame's reported
 * traits. This is how an agent (which cannot open localhost) sees the work — and because it drives
 * the same `/view` document the creator sees, there is nothing to keep in sync.
 */
export async function shootPreview(
  base: string,
  outDir: string,
  count: number,
  opts: {width?: number; timeoutMs?: number; params?: Record<string, string>} = {},
): Promise<ShootResult[]> {
  // Playwright is a BUILD-TIME type dependency only (a `devDependency` of this package), never a
  // runtime one: `--shoot` is opt-in and the interactive studio needs no browser at all, so shipping
  // it as a real dependency would force every `abx` install to pull a browser driver it won't use.
  // Hence: declared for `tsc`, imported dynamically, and absence handled below.
  // Do NOT promote this to `dependencies`, and do NOT drop the devDependency — an undeclared
  // `import('playwright')` typechecks locally only if a stray copy sits in some PARENT directory of
  // the checkout, then fails in CI with TS2307. That exact hole broke a release.
  let chromium: typeof import('playwright').chromium;
  try {
    ({chromium} = await import('playwright'));
  } catch {
    throw new Error(
      '--shoot needs Playwright + its Chromium build (the interactive preview does not — that runs in YOUR browser).\n' +
        '  install: npm i -D playwright && npx playwright install chromium\n' +
        '  or drop --shoot and open the preview URL yourself.',
    );
  }
  // Same logical square the interactive stage uses, so a shot frames the piece identically.
  const width = opts.width ?? STAGE_PX;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  await mkdir(outDir, {recursive: true});

  // A missing BROWSER BUILD is a different failure from a missing package, and its stock message
  // ("please run npx playwright install") can send you in a circle: `npx playwright install` resolves
  // whatever playwright npm feels like, which may be a DIFFERENT version than the one that just
  // launched — you download a browser revision this playwright won't use, get the identical error,
  // and run the same command again. Name the install command for the playwright we ACTUALLY loaded.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!/Executable doesn't exist|playwright install/i.test(msg)) throw err;
    let hint = 'npx playwright install chromium';
    let version = '';
    try {
      const req = createRequire(import.meta.url);
      const pkgDir = dirname(req.resolve('playwright/package.json'));
      version = ` ${JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).version}`;
      hint = `node ${join(pkgDir, 'cli.js')} install chromium`;
    } catch {
      /* fall back to the generic command */
    }
    throw new Error(
      `--shoot loaded Playwright${version} but its Chromium build is missing.\n` +
        `  install the build THIS Playwright expects:\n    ${hint}\n` +
        `  (a bare \`npx playwright install\` may fetch a build for a different Playwright version — same error, again.)`,
    );
  }
  try {
    const page = await browser.newPage({viewport: {width, height: width}});
    const out: ShootResult[] = [];
    for (let i = 0; i < count; i++) {
      const seed = previewSeed(i);
      // Forward any --param overrides, so a batch can answer "what does the collection look like when
      // a collector HAS set this?" — previously unreachable: --shoot rendered only the unset state, and
      // seeing the other one meant hand-rolling a Playwright script against /view.
      const overrides = Object.entries(opts.params ?? {})
        .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('');
      await page.goto(`${base}/view?tokenId=${i}&seed=${seed}&report=0${overrides}`, {waitUntil: 'load'});
      // Wait for the sketch's own completion signal; a piece that never calls abx.done() (or
      // animates forever) still gets captured — same timeout fallback the render effect uses.
      // A timeout here is NOT a verdict on the program — the machine may simply be loaded (a studio
      // instance + a second Chromium is enough). Record it instead of swallowing it, so the caller
      // can tell "the program reported nothing" from "we stopped waiting".
      let timedOut = false;
      await page
        .waitForFunction('window.abx && (window.abx.__done || window.abx.__traits)', {timeout: timeoutMs})
        .catch(() => { timedOut = true; });
      const file = join(outDir, `seed-${i}.png`);
      await page.screenshot({path: file});
      const probe = (await page.evaluate(
        '({traits: (window.abx && window.abx.__traits) || null, done: !!(window.abx && window.abx.__done)})',
      )) as {traits: Record<string, unknown> | null; done: boolean};
      // The wait can expire and the program still land its traits a moment later (the screenshot +
      // probe cost real time) — so a frame that timed out but DID report is not a timeout for
      // reporting purposes. Only an expiry that also produced nothing is worth flagging.
      out.push({seed, file, traits: probe.traits, done: probe.done, timedOut: timedOut && !probe.traits});
    }
    await writeFile(
      join(outDir, 'traits.json'),
      JSON.stringify(out.map(({seed, traits, done}) => ({seed, traits, done})), null, 2),
    );
    return out;
  } finally {
    await browser.close();
  }
}

// ── flag surface ─────────────────────────────────────────────────────────────────

export const PREVIEW_FLAGS: ReadonlySet<string> = new Set([
  'script', 'code-dir', 'schema', 'dep', 'port', 'shoot', 'count', 'width', 'timeout-ms', 'param',
]);

/**
 * Parse `--param key=value` (repeatable, comma-joined by the flag parser) into overrides for a
 * `--shoot` batch. Values are the same human form the studio's controls submit, so a Select takes its
 * label. An empty value means "unset" — the same wire shape production uses for a param nobody has
 * written — which makes `--param theme=` a way to shoot the fallback state explicitly.
 */
export function parsePreviewParams(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of String(raw ?? '').split(',')) {
    const t = pair.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq === -1) throw new Error(`--param "${t}" — expected key=value (a Select takes its label; an empty value means unset).`);
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Resolve `--script`/`--code-dir` into a source, with the same either-or rule as `deploy-code`. */
export function previewSourceFromFlags(flags: Flags): PreviewSource {
  const script = flags.script && flags.script !== 'true' ? String(flags.script) : undefined;
  const dir = flags['code-dir'] && flags['code-dir'] !== 'true' ? String(flags['code-dir']) : undefined;
  if (script && dir) throw new Error('pass either --script <file> or --code-dir <dir>, not both.');
  if (script) return {kind: 'script', path: script};
  if (dir) return {kind: 'dir', path: dir};
  throw new Error(
    'abx preview needs the program: --script <file.js> (a single sketch) or --code-dir <dir> (a build).',
  );
}

export function previewConfigFromFlags(flags: Flags): PreviewConfig {
  return {
    source: previewSourceFromFlags(flags),
    schemas: parseSchemaSpecs(flags.schema),
    deps: parseDepFlag(flags.dep),
  };
}
