import {editionCapOf, explorerUrl, type ProjectState, type TokenState} from '@artblocks/abx-sdk';

/** Wrap page content in the shared, dependency-free HTML shell. */
function page(title: string, baseUrl: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>
<header class="bar">
  <div class="brand"><span class="dot"></span> ABX <em>Self-Host Toolkit</em></div>
  <div class="node">node: <code>${esc(baseUrl)}</code></div>
</header>
<main>${body}</main>
<footer>
  <p>The exit isn't a promise — it's this. <a href="/api/projects">/api/projects</a> · reference implementation, intentionally plain, fully forkable.</p>
</footer>
</body></html>`;
}

/**
 * The per-contract dashboard, served at `/d/<chainId>/<address>`. **Read-only by design**: it
 * renders reconstructed state but takes NO actions. Re-indexing and verification are mutating /
 * load-bearing operations gated behind the admin token (from the CLI: `abx index <addr> --remote`),
 * never public buttons — a public host should never let a stranger trigger a full chain replay.
 */
export function renderDashboard(project: ProjectState, baseUrl: string, chainId: number): string {
  return page(`${project.name ?? project.address} · ABX`, baseUrl, `
  <section class="intro">
    <div class="kicker">Layer 3 · the credible exit, running</div>
    <h1>${esc(project.name ?? 'Your project')}, served from chain alone.</h1>
    <p>This node indexed this ABX contract on chain ${chainId}, rebuilt its <strong>entire state by replaying the event spine</strong>, and now serves the standard token API + image — touching <strong>zero</strong> centralized services. Delete the database and replay: identical, every time.</p>
  </section>
  ${renderProject(project, baseUrl, chainId)}`);
}

/** The node index at `/`, served read-only: which contracts this resolver serves, each linking to
 *  its per-contract dashboard. No actions — operate via the CLI (admin-token gated). */
export function renderIndex(projects: ProjectState[], baseUrl: string, chainId: number): string {
  const ordered = [...projects].sort((a, b) => b.reconstructedAt.localeCompare(a.reconstructedAt));
  const rows = ordered
    .map(
      (s) =>
        `<li><a href="/d/${chainId}/${esc(s.address)}">${esc(s.name ?? s.address)}</a> <code>${shorten(s.address)}</code> <span class="muted">· ${s.tokens.length} token(s) · ${esc(timeago(s.reconstructedAt))}</span></li>`,
    )
    .join('');
  return page('ABX Self-Host Node', baseUrl, `
  <section class="intro">
    <div class="kicker">Layer 3 · the credible exit, running</div>
    <h1>Projects served from chain alone.</h1>
    <p>This node reconstructs each contract below from the event spine and serves the standard token API + image. Read-only — operate it from the <code>abx</code> CLI.</p>
  </section>
  ${ordered.length ? `<section class="index"><ul class="proj-list">${rows}</ul></section>` : EMPTY_STATE}`);
}

function renderProject(s: ProjectState, baseUrl: string, chainId: number): string {
  const tok = s.tokens[0];
  const img = tok ? `${baseUrl}/t/${chainId}/${s.address}/${tok.tokenId}/image` : '';
  const canonical = s.isCanonical
    ? `<span class="badge ok">✓ canonical — factory-verified</span>`
    : `<span class="badge warn">discovery only — unverified</span>`;
  const isEdition = s.contractType === '1of1-edition' || s.contractType === 'edition' || s.contractType === 'edition-code';

  return `
  <section class="grid" data-address="${esc(s.address)}">
    <div class="work-col">
      <div class="work">${img ? `<img src="${esc(img)}" alt="token image"/>` : 'no token'}</div>
      <div class="links">
        <a href="${baseUrl}/t/${chainId}/${s.address}/${tok?.tokenId ?? '0'}" target="_blank">tokenURI JSON →</a>
        <a href="${baseUrl}/c/${chainId}/${s.address}" target="_blank">contractURI JSON →</a>
      </div>
    </div>

    <div class="info-col">
      <h2>${esc(s.name ?? s.address)} ${s.symbol ? `<span class="sym">${esc(s.symbol)}</span>` : ''}</h2>
      <div class="chip-row">
        <a class="chip" href="${explorerUrl(chainId)}/address/${s.address}" target="_blank" title="View on the block explorer">${shorten(s.address)} ↗</a>
        ${canonical}
      </div>

      <div class="facts">
        ${fact('Token #0', tokenBadge(tok))}
        ${isEdition ? supplyFacts(tok) : fact('Owner', tok?.lifecycle === 'live' && tok.owner ? linkAddr(tok.owner, chainId) : s.owner ? `${linkAddr(s.owner, chainId)} <span class="muted">(admin)</span>` : '—')}
        ${fact('Royalty', royaltyFact(s))}
        ${fact('ABX core version', s.abxVersion !== null ? `v${s.abxVersion}` : '—')}
        ${fact('Implementation', s.implementation ? linkAddr(s.implementation, chainId) : '—')}
      </div>

      <div class="exts">
        <span class="lbl">Extensions detected via beacon:</span>
        ${s.extensions.map((e) => `<span class="pill">${esc(friendly(e.name))} <em>v${e.version}</em></span>`).join('') || '<span class="muted">none</span>'}
      </div>

      ${renderCommitments(s)}

      <div class="rebuild">
        <div class="rebuild-head">
          <span class="lbl">Reconstructed from chain</span>
          <span class="meta">blocks ${esc(s.deployBlock ?? s.fromBlock)} → ${esc(s.toBlock)} · <strong>${s.eventCount}</strong> spine events · ${esc(timeago(s.reconstructedAt))}</span>
        </div>
        <p class="muted readonly-note">Read-only view — re-index and verify are CLI operations. Replay this project from
          its deploy block and confirm it lands on identical state:<br>
          <code>abx index ${esc(s.address)} --full</code> &nbsp;·&nbsp; <code>abx verify ${esc(s.address)}</code><br>
          <span class="muted">(add <code>--remote &lt;url&gt;</code> to re-index a hosted resolver instead of this node.)</span></p>
      </div>
    </div>
  </section>

  <section class="spine">
    <h3>The event spine, replayed <span class="muted">— this is the whole reconstruction</span></h3>
    <table>
      <thead><tr><th></th><th>event</th><th>what it told us</th><th>block</th><th>tx</th></tr></thead>
      <tbody>
        ${s.events.map((e) => eventRow(e, chainId)).join('')}
      </tbody>
    </table>
  </section>`;
}

function renderCommitments(s: ProjectState): string {
  const tokenFields = s.tokens.flatMap((t) =>
    t.fields.map((f) => ({...f, locked: t.lockedFields.includes(f.field)})),
  );
  const collection = s.collectionFields.map((f) => ({...f, locked: s.lockedCollectionFields.includes(f.field)}));
  const all = [...tokenFields, ...collection];
  if (all.length === 0) return '';
  return `<div class="commit">
    <span class="lbl">On-chain metadata (field · representation):</span>
    ${all
      .map(
        (f) =>
          `<div class="commit-row"><code>${esc(f.field)} · ${esc(f.representation)}</code> <span class="hash">${esc(f.value)}</span> ${f.locked ? '<span class="badge ok">locked</span>' : ''}</div>`,
      )
      .join('')}
  </div>`;
}

function eventRow(e: {register: 1 | 2; name: string; what: string; blockNumber: string; txHash: string}, chainId: number): string {
  const reg = e.register === 2 ? `<span class="reg r2" title="Native ABX event">ABX</span>` : `<span class="reg r1" title="Standard ERC event">ERC</span>`;
  return `<tr>
    <td>${reg}</td>
    <td class="evt">${esc(e.name)}</td>
    <td class="what">${esc(e.what)}</td>
    <td class="num">${esc(e.blockNumber)}</td>
    <td><a href="${explorerUrl(chainId)}/tx/${e.txHash}" target="_blank">${shorten(e.txHash)} ↗</a></td>
  </tr>`;
}

function fact(label: string, value: string): string {
  return `<div class="f"><span class="fl">${esc(label)}</span><span class="fv">${value}</span></div>`;
}

/** An edition has many concurrent holders per id, not a single owner — the per-token dashboard
 *  fact swaps `Owner` for the copies-in-circulation figure ("12 / 100", or "12 (open)" when
 *  uncapped) and the live holder count. Both fold straight from TransferSingle/TransferBatch
 *  (`reconstruct.ts`), so an unminted id (no `tok`, or one the fold has never touched) reads "0".
 *
 *  The cap goes through {@link editionCapOf} rather than truthiness on `maxSupply`, which was wrong
 *  in both directions: it called every `--copies N` id "open" (the fold carried no cap for an id
 *  that inherits the collection default — the default shape), and a `'0'` string is truthy, so an
 *  id deliberately closed would have read "12 / 0" instead of saying closed. */
/** Token #0's lifecycle as a badge. A burned token gets its own — it used to render "minted", which
 *  is how a destroyed token looked exactly like a live one on the operator's own dashboard. */
function tokenBadge(tok?: {lifecycle?: string}): string {
  if (tok?.lifecycle === 'live') return '<span class="badge ok">minted</span>';
  if (tok?.lifecycle === 'burned') return '<span class="badge warn">burned</span>';
  // An edition id at zero is not "not yet minted" — it may have been minted and fully burned, and it
  // can mint again. Saying "no live copies" is the only claim the state actually supports.
  if (tok?.lifecycle === 'no-live-copies') return '<span class="badge warn">no live copies</span>';
  return '<span class="badge warn">not yet minted</span>';
}

/** The royalty rate WITH its ceiling. Shown as a pair because the rate alone is half the fact: the
 *  owner can raise it to the ceiling unilaterally, and reducing the ceiling to the current rate is
 *  what makes a rate a promise. `null` ceiling ⇒ the contract publishes none; say so rather than
 *  quoting a default it never committed to. */
function royaltyFact(s: ProjectState): string {
  if (!s.royalty) return 'none';
  const rate = `${(s.royalty.bps / 100).toFixed(2)}% → ${shorten(s.royalty.receiver)}`;
  if (s.maxRoyaltyBps == null) return `${rate} <span class="muted">(ceiling not published)</span>`;
  const headroom = s.maxRoyaltyBps > s.royalty.bps;
  return `${rate} <span class="muted">(ceiling ${(s.maxRoyaltyBps / 100).toFixed(2)}%${headroom ? ', raisable to it' : ' — locked to the rate'})</span>`;
}

function supplyFacts(tok: TokenState | undefined): string {
  const supply = tok?.supply ?? '0';
  const cap = tok ? editionCapOf(tok) : null;
  const holders = tok?.holders ? Object.keys(tok.holders).length : 0;
  const copies =
    cap?.kind === 'capped'
      ? `${esc(supply)} / ${esc(cap.cap)}`
      : cap?.kind === 'closed'
        ? `${esc(supply)} (closed — no more can be minted)`
        : `${esc(supply)} (open)`;
  return `${fact('Supply', copies)}${fact('Holders', String(holders))}`;
}

function linkAddr(a: string, chainId: number): string {
  return `<a href="${explorerUrl(chainId)}/address/${a}" target="_blank">${shorten(a)} ↗</a>`;
}

function friendly(name: string): string {
  if (name === 'abx.extension.royalty') return 'Royalty';
  if (name === 'abx.extension.content-commitment') return 'Content Commitment';
  return name;
}

function shorten(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function timeago(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
}

// `abx`, never `pnpm abx` — this page is served to a published user who has no repo and no pnpm
// (the contributor invocation is `pnpm abx`, and leaking it here is an uncopyable command).
const EMPTY_STATE = `<section class="empty">
  <h2>No project indexed yet</h2>
  <p>Deploy a 1/1 and index it in one command:</p>
  <pre>abx demo</pre>
  <p class="muted">Already deployed elsewhere? Register it with this node: <code>abx add &lt;address&gt; --remote</code>. Then refresh this page.</p>
</section>`;

const CSS = `
:root{--bg:#0a0a0f;--raised:#12121a;--card:#16161f;--ink:#e8e8ef;--dim:#9a9aad;--faint:#5b5b70;--accent:#7df9c6;--accent2:#8b7dff;--accent3:#ffb86b;--line:#26263a;--mono:"SF Mono","Fira Code",ui-monospace,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased}
code,pre{font-family:var(--mono)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.bar{display:flex;justify-content:space-between;align-items:center;padding:18px 32px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,10,15,.85);backdrop-filter:blur(8px);z-index:5}
.brand{font-weight:600;letter-spacing:.02em}.brand em{color:var(--dim);font-style:normal;font-weight:400}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);margin-right:8px;animation:pulse 2s infinite}
@keyframes pulse{50%{opacity:.4}}
.node{font-size:13px;color:var(--dim)}.node code{color:var(--accent2)}
main{max-width:1080px;margin:0 auto;padding:0 32px 64px}
.intro{padding:56px 0 32px}
.kicker{font-family:var(--mono);font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
h1{font-size:40px;line-height:1.1;letter-spacing:-.02em;margin-bottom:16px}
.intro p{color:var(--dim);max-width:680px;font-size:17px}
.intro strong{color:var(--ink)}
.grid{display:grid;grid-template-columns:340px 1fr;gap:32px;margin-bottom:40px}
.work{aspect-ratio:1;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--card)}
.work img{width:100%;height:100%;display:block}
.links{display:flex;flex-direction:column;gap:6px;margin-top:14px;font-size:13px;font-family:var(--mono)}
h2{font-size:26px;letter-spacing:-.01em}h2 .sym{color:var(--faint);font-size:16px;font-family:var(--mono)}
.chip-row{display:flex;gap:10px;align-items:center;margin:12px 0 20px;flex-wrap:wrap}
.chip{font-family:var(--mono);font-size:12px;background:var(--raised);border:1px solid var(--line);padding:5px 10px;border-radius:8px;color:var(--ink)}
.badge{font-size:11px;font-family:var(--mono);padding:4px 9px;border-radius:8px;text-transform:uppercase;letter-spacing:.05em}
.badge.ok{background:rgba(125,249,198,.12);color:var(--accent);border:1px solid rgba(125,249,198,.3)}
.badge.warn{background:rgba(255,184,107,.12);color:var(--accent3);border:1px solid rgba(255,184,107,.3)}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:18px}
.f{background:var(--card);padding:12px 14px}
.fl{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin-bottom:3px}
.fv{font-family:var(--mono);font-size:13px}
.exts{margin-bottom:18px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.lbl{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
.pill{background:rgba(139,125,255,.12);border:1px solid rgba(139,125,255,.3);color:var(--accent2);font-family:var(--mono);font-size:12px;padding:4px 10px;border-radius:8px}
.pill em{color:var(--dim);font-style:normal}
.commit{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:18px}
.commit-row{display:flex;gap:10px;align-items:center;margin-top:8px;font-size:12px}
.hash{font-family:var(--mono);color:var(--dim);word-break:break-all;font-size:11px}
.muted{color:var(--faint)}
.rebuild{background:linear-gradient(180deg,rgba(125,249,198,.04),transparent);border:1px solid var(--line);border-radius:12px;padding:18px}
.rebuild-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.meta{font-family:var(--mono);font-size:12px;color:var(--dim)}.meta strong{color:var(--accent)}
.actions{display:flex;gap:10px}
button{font-family:var(--mono);font-size:13px;background:var(--accent);color:#06120d;border:0;padding:10px 16px;border-radius:9px;cursor:pointer;font-weight:600}
button:hover{opacity:.9}button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:wait}
.result{margin-top:14px;font-family:var(--mono);font-size:13px;min-height:0}
.result .line{padding:4px 0}.result .good{color:var(--accent)}.result .bad{color:#ff7d8b}
.spine{margin-top:8px}
.spine h3{font-size:18px;margin-bottom:14px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.evt{font-family:var(--mono);color:var(--ink)}.what{color:var(--dim)}.num{font-family:var(--mono);color:var(--faint)}
.reg{font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px}
.reg.r2{background:rgba(139,125,255,.15);color:var(--accent2)}.reg.r1{background:rgba(125,249,198,.12);color:var(--accent)}
.empty{text-align:center;padding:60px 0}.empty pre{display:inline-block;background:var(--card);border:1px solid var(--line);padding:12px 20px;border-radius:10px;margin:14px 0;color:var(--accent)}
.index{padding:8px 0 40px}
.proj-list{list-style:none;display:flex;flex-direction:column;gap:10px}
.proj-list li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
.proj-list code{color:var(--dim);font-size:12px;font-family:var(--mono)}
.readonly-note{margin-top:14px;font-size:12px}.readonly-note code{color:var(--accent2);font-family:var(--mono)}
footer{border-top:1px solid var(--line);padding:24px 32px;text-align:center;color:var(--faint);font-size:13px}
@media(max-width:720px){.grid{grid-template-columns:1fr}.facts{grid-template-columns:1fr}h1{font-size:30px}}
`;

