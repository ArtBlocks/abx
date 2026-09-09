/**
 * Read-only commands: `preview` (the studio lane — no chain), `inspect` (static analysis of a
 * generative script + lane recommendation), `render` (effect-runner repair lane), `tokenuri` /
 * `contracturi` (read directly from the contract, decode, optionally follow + report what's
 * served), and `tokens` (every token's owner/seed/params, from chain alone).
 */
import {existsSync, readFileSync} from 'node:fs';
import {basename, resolve as resolvePath} from 'node:path';
import {getAddress, isAddress} from 'viem';
import {SqliteStore} from '@artblocks/abx-indexer';
import {
  type Address,
  analyzeScript,
  editionCapOf,
  listTokens,
  makePublicClient,
  oneOfOneImageAbi,
  oneOfOneEditionAbi,
  recommendLane,
  redactRpcUrl,
  resolveChain,
  resolveRpcUrl,
} from '@artblocks/abx-sdk';
import {resolveBackend} from '@artblocks/abx-storage';
import {
  resolveBaseUrl,
  tokenArtifacts,
  type ArtifactEntry,
  type EffectArtifactStatus,
  type PlaneAccess,
} from '@artblocks/abx-token-api';
import {CHAIN, localIndexer, storageOptions, storageOverrides} from '../config.js';
import {type Flags, parseFlags, positionalArgs, warnStrayFlags} from '../flags.js';
import {jsonSafe, withJson} from '../jsonout.js';
import {assertPortFree, bold, c, dim, g, info, loadEffects, ok, requirePublishableBackend, step, warn} from '../output.js';
import {detectTokenKind, describeKind, isEditionContract} from '../kind.js';
import {
  DEFAULT_PREVIEW_PORT,
  PREVIEW_FLAGS,
  parsePreviewParams,
  previewConfigFromFlags,
  previewDepTags,
  shootPreview,
  startPreviewServer,
} from '../preview.js';
import {type RemoteTarget, remoteFlag, requireRemoteToken} from '../remote.js';
import {SCHEMA_CATALOG, describeSchema} from '../schema.js';
import {type ServedTokenUri, decodeOnChainJson, fetchServedTokenUri, prettyBody, servedOk} from '../served.js';

/**
 * `abx preview` — serve the program on localhost, live, for as long as the work is being made.
 *
 * The studio lane, and deliberately the FIRST thing to reach for on a code project: it renders the
 * same document the generator serves (real `abx.js`, real tokenData shape, real dependency tags)
 * with a synthetic seed, so a creator can refresh for new seeds, drive their PostParams from real
 * inputs, and watch an animated piece actually move — none of which a still-image sweep can show.
 * No chain, no key, no deploy. `--shoot` renders the same document headlessly for an agent that
 * can't open a browser.
 */
export async function cmdPreview(flags: Flags) {
  warnStrayFlags(flags, PREVIEW_FLAGS as Set<string>, 'preview');
  const cfg = previewConfigFromFlags(flags);
  const shootDir = flags.shoot && flags.shoot !== 'true' ? String(flags.shoot) : flags.shoot === 'true' ? 'abx-preview' : undefined;
  const count = Math.min(Math.max(Number(flags.count ?? 9) || 9, 1), 64);

  console.log(bold(`\n  ABX Self-Host Toolkit — preview\n  ${dim('the program, running locally — no chain, no deploy')}`));

  const {notes} = previewDepTags(cfg.deps);
  step('Program');
  info(cfg.source.kind === 'dir' ? `directory build ${cfg.source.path}/ (its own index.html + abx.js)` : `script ${cfg.source.path} ${dim('(re-read from disk on every render)')}`);
  if (cfg.schemas.length) info(`params: ${cfg.schemas.map(describeSchema).join(' · ')}`);
  else info(dim('params: none declared — add --schema key:Type:Auth to drive them from the studio'));
  for (const n of notes) info(`dep ${n}`);

  // A raw on-chain dependency can't be fetched without a chain, so the preview would render a
  // sketch missing its runtime and look broken for the wrong reason. Say so rather than let them
  // debug their own code.
  if (cfg.deps.some((d) => d.display.startsWith('0x'))) {
    warn('an on-chain data-contract dep is NOT loaded in preview — the sketch will run without it here. Use a name@version ref to preview against the CDN copy.');
  }

  // `--shoot` takes an ephemeral port (0), so only the studio lane can collide.
  const previewPort = shootDir ? 0 : Number(flags.port ?? DEFAULT_PREVIEW_PORT);
  if (previewPort !== 0) await assertPortFree(previewPort, 'preview');
  const server = await startPreviewServer(cfg, previewPort);

  if (shootDir) {
    step(`Render ${count} seeds headlessly`);
    try {
      const shotParams = parsePreviewParams(flags.param as string | undefined);
      if (Object.keys(shotParams).length) {
        info(`param overrides applied to every frame: ${Object.entries(shotParams).map(([k, v]) => `${k}=${v || dim('(unset)')}`).join(' · ')}`);
      }
      const shots = await shootPreview(server.url, shootDir, count, {
        width: Number(flags.width ?? 1000) || 1000,
        timeoutMs: Number(flags['timeout-ms'] ?? 10_000) || 10_000,
        params: shotParams,
      });
      ok(`${shots.length} frames → ${shootDir}/  ${dim('(traits in traits.json)')}`);
      for (const s of shots) {
        const t = s.traits && Object.keys(s.traits).length
          ? Object.entries(s.traits).map(([k, v]) => `${k} ${String(v)}`).join(' · ')
          : s.timedOut
            ? `${c.orange}timed out — traits unknown${c.reset}`
            : `${c.orange}no traits reported${c.reset}`;
        console.log(`      ${dim(s.seed.slice(0, 10) + '…')}  ${t}${s.done || s.timedOut ? '' : dim('  (no abx.done())')}`);
      }
      const timedOut = shots.filter((s) => s.timedOut).length;
      const silent = shots.filter((s) => !s.traits || !Object.keys(s.traits).length).length;
      // A timeout is a measurement failure, not a finding about the program — so it must never be
      // reported as one. The old code printed the "NO frame reported traits" alarm whenever traits
      // came back empty for any reason, which condemned a CORRECT program on a loaded machine and
      // inverted the one line agents are told to trust.
      if (timedOut) {
        warn(
          `${timedOut} of ${shots.length} frame(s) hit the ${Math.round((Number(flags['timeout-ms'] ?? 10_000) || 10_000) / 1000)}s wait with nothing reported — ` +
            `that is a TIMEOUT, not a verdict on the program. Re-run with ${bold('--timeout-ms 30000')} (or on an idle machine) before believing anything about its traits.`,
        );
      }
      if (silent === shots.length && !timedOut) {
        warn('NO frame reported traits — `abx.traits({…})` is the only thing that becomes marketplace `attributes`. Verify with `abx inspect`.');
      } else if (silent < shots.length && shots.length > 1 && new Set(shots.map((s) => JSON.stringify(s.traits))).size === 1) {
        // Only meaningful when traits DID come back: identical values across seeds is the signature
        // of a sketch that never reads `abx.tokenData.seed` (prototyped on Math.random()), which
        // deploys as N visually identical tokens. Skipped when nothing reported at all — the
        // warning above already covers that, and firing both reads as noise.
        warn('every seed produced identical traits — check the sketch actually reads `abx.tokenData.seed` (the silent "all tokens the same" failure).');
      }
    } finally {
      await server.close();
    }
    return;
  }

  step('Studio');
  console.log(`\n  ${g('●')} ${bold('preview')}  ${server.url}`);
  console.log(`    ${dim('studio     ')}${server.url}          ${dim('seed + params + live traits')}`);
  console.log(`    ${dim('grid       ')}${server.url}/grid     ${dim('9 seeds at once, all live')}`);
  console.log(`    ${dim('bare view  ')}${server.url}/view     ${dim('the generator document itself')}`);
  console.log(`\n  ${dim('Edit the program and refresh — it is re-read from disk. Ctrl-C to stop.')}`);
  console.log(`  ${dim('This is a preview: `abx inspect` is still the wiring check, and a testnet deploy is the faithful end-to-end.')}\n`);
  await new Promise<void>(() => {}); // block like `serve` — the creator drives it
}

/**
 * `abx inspect <script.js>` — read a generative script and, WITHOUT executing it, report what it
 * needs (traits + their on-chain reproducibility, dependency hints, size → assembled-document size →
 * single-`tokenURI`-eth_call viability) and RECOMMEND a lane. The decision-tree entry point: run it
 * before choosing `--onchain-uri` vs a resolver vs directory mode, so the choice is derived, not guessed.
 */
export async function cmdInspect(path: string | undefined, flags: Flags) {
  if (!path || path.startsWith('--')) {
    console.error('usage: abx inspect <script.js> [--dep <name@version>[,…]]   (static analysis + a lane recommendation — abx inspect --help)\n');
    process.exitCode = 1;
    return;
  }
  // `abx inspect` analyzes a JS generative SCRIPT. A creator on the in-chain Solidity lane naturally
  // tries `abx inspect <renderer address>` — redirect them instead of crashing with a raw ENOENT.
  if (/^0x[0-9a-fA-F]{40}$/.test(path)) {
    console.error(
      `abx inspect analyzes a JS generative SCRIPT file, not an address. For a Solidity renderer (an in-chain SVG/traits contract) there's nothing to statically analyze here — deploy it, then pass its address to ${bold('abx deploy-code --image-renderer 0x..')} / ${bold('--attributes-renderer 0x..')} (deploy-code verifies the address has code).\n`,
    );
    process.exitCode = 1;
    return;
  }
  const abs = resolvePath(path);
  if (!existsSync(abs)) {
    console.error(
      `abx inspect: no such file '${path}'. It takes a JS generative script (e.g. sketch.js). For a Solidity renderer, pass its DEPLOYED address to ${bold('abx deploy-code --image-renderer/--attributes-renderer')} instead.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const source = readFileSync(abs, 'utf8');
  const declaredDeps = String(flags.dep ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const a = analyzeScript(source, declaredDeps);

  console.log(bold(`\n  abx inspect — ${basename(path)}  ${dim('(static analysis; the script is never executed)')}`));
  step('Program');
  info(`size: ${a.bytes} bytes → ${a.estChunks} on-chain chunk(s)`);
  info(
    `libraries: ${
      a.depHints.length
        ? a.depHints.join(', ') + (declaredDeps.length ? '' : dim(' — declare on-chain with --dep <name@version>'))
        : 'none detected'
    }`,
  );

  step('Runtime data contract');
  if (a.runtime.readsTokenData) {
    ok(`reads state via ${bold('abx.tokenData')}${a.runtime.reportsTraits ? ` and reports traits via ${bold('abx.traits({…})')}` : ''} — the recognized accessor(s).`);
    if (!a.runtime.reportsTraits) info(`no ${bold('abx.traits({…})')} call — fine if this piece has no marketplace traits; add one if you want filterable traits (see below).`);
  } else {
    // The silent-breaker: a fresh sketch that invents its own global deploys + renders without error
    // but never receives the seed/params. This is the #1 authoring trap the skill's contract prevents.
    warn(`this script never reads the abx token data via a recognized accessor (${bold('abx.tokenData')} or ${bold('window.abxTokenData')}).`);
    if (a.runtime.wrongGlobal) warn(`  found instead: ${bold(a.runtime.wrongGlobal)}.`);
    info(`the mint ${bold('seed')} and collector ${bold('params')} will NOT reach it → every token renders IDENTICALLY, and traits stay empty. Read state the one supported way: ${bold('var td = (window.abx && abx.tokenData) || {}')} then ${bold('td.seed')} / ${bold('td.<paramKey>')} (flat), report with ${bold('abx.traits({…})')}. Contract + a worked example: the skill's "Authoring the program" section.`);
  }

  step('Traits');
  if (a.traits.present) {
    info(`reports ${a.traits.keys.length}: ${a.traits.keys.join(', ')}`);
    const line = `on-chain reproducibility: ${bold(a.feasibility.verdict)} — ${a.feasibility.reason}`;
    if (a.feasibility.verdict === 'exact-likely') ok(line);
    else if (a.feasibility.verdict === 'infeasible') warn(line);
    else info(line);
  } else {
    warn(a.feasibility.reason);
  }

  step('PostParams (collector-set inputs)');
  if (a.paramHints.length) {
    warn(`the script READS ${a.paramHints.length} param(s): ${bold(a.paramHints.join(', '))}`);
    info(`declare EACH at deploy or it's silently dropped (render sees undefined → its default): ${bold(`--schema ${a.paramHints.map((k) => `${k}:<Type>:<Auth>`).join(',')}`)} ${dim(SCHEMA_CATALOG)}`);
  } else {
    // "none detected" is a HINT, not proof — the scan only sees params read as `abx.tokenData.<key>`
    // (flat) or destructured from it. A creator who reads them a different way (a nested `.params`,
    // an invented global) gets a false "none" and drops the --schema. Say so, don't reassure.
    info(`none detected reading ${bold('abx.tokenData.<key>')} (flat) or destructuring from it. If you INTENDED a collector param (e.g. a palette) but see this, you're likely reading it a different way — read it as ${bold('abx.tokenData.<key>')} and re-run, or declare it explicitly with ${bold('--schema')} or it's dropped at render.`);
  }

  step('On-chain document — RPC viability');
  info(
    `estimated assembled document: ~${Math.round(a.doc.estBytes / 1000)}KB` +
      `${a.doc.unknownDepSizes ? ' + undeclared/unknown dep bytes' : ''} ` +
      dim(`(script + runtime${a.doc.deps.length ? ' + ' + a.doc.deps.join('+') : ''})`),
  );
  if (a.doc.fitsSingleCall) ok('fits a single tokenURI eth_call — the template (fully-on-chain) branch is viable.');
  else warn('may exceed a single tokenURI eth_call — prefer directory mode, a CDN dep, or the generator piecewise getters.');

  step('Recommended lane');
  console.log(`  ${bold(recommendLane(a))}`);
  console.log(`  ${dim('trait feasibility deep-dive: docs.abx.io/docs/protocol/renderers · all lanes: abx deploy-code --help')}\n`);
}

/**
 * `abx render <address> [tokenId…]` — the ops/repair lane of the effect runner
 * (`site/content/docs/protocol/effects.mdx → The reference runner`). Same code path as the deployed
 * service, so a hand-fix and the daemon can't diverge: with a runner up
 * (ABX_EFFECTS_URL / --effects-url) this enqueues via its `POST /run`; otherwise it
 * runs the sweep inline (which needs Playwright installed locally — the error says how).
 * Idempotent either way: only missing artifacts at the CURRENT inputsHash render.
 */
export async function cmdRender(address: Address | undefined, tokenIds: string[], flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx render <address> [tokenId…] [--force] [--remote [name|url]]   (missing stills/traits; --force re-renders an existing one — abx render --help)\n');
    process.exitCode = 1;
    return;
  }
  // Token ids are decimal (mint order). Keep only those — `parseFlags` leaves `--flag value` pairs
  // in `rest`, so a flag's VALUE (e.g. the `--remote <url>`) would otherwise be read as a bogus id
  // and make the sweep match nothing (a silent `ran=0`).
  const ids = tokenIds.filter((t) => /^\d+$/.test(t));
  // --force re-renders even when the still already exists at the current inputsHash — the repair
  // lane for a bad/blank/timed-out capture (the render is otherwise deterministic, so a plain render
  // idempotent-skips). Overwrites the artifact (and republishes it on --remote).
  const force = !!flags.force;
  const runnerUrl = (flags['effects-url'] as string | undefined) ?? process.env.ABX_EFFECTS_URL;
  if (runnerUrl) {
    let res: Response;
    try {
      res = await fetch(`${runnerUrl.replace(/\/$/, '')}/run`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({address, tokenIds: ids.length ? ids : undefined, force}),
      });
    } catch (err) {
      // A bare "fetch failed" (ECONNREFUSED) here means nothing is LISTENING at the configured
      // effects URL — name it and give the two ways out, rather than a contentless error.
      throw new Error(
        `no effect runner reachable at ${runnerUrl} (${(err as Error).message}). ` +
          `Start one there with \`abx effects\`, or unset ABX_EFFECTS_URL (and drop --effects-url) to render inline on this machine.`,
      );
    }
    if (!res.ok) throw new Error(`effect runner at ${runnerUrl} replied ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const stats = (await res.json()) as {ran: number; skipped: number; failed: number; errors?: string[]};
    const line = `runner: ran=${stats.ran} skipped=${stats.skipped} failed=${stats.failed} ${dim(`(${runnerUrl})`)}`;
    if (stats.failed) warn(`${line}\n  ${dim(stats.errors?.[0] ?? 'see runner logs')}`);
    else ok(line);
    return;
  }
  // --remote publishes each render to the remote resolver's control plane (the locator bridge) so a
  // laptop render lands on a resolver that doesn't share this disk; republish=true makes a re-run
  // restore a resolver that lost its volume without re-rendering. Local (no --remote): shared backend.
  const remote = remoteFlag(flags);
  const resolverUrl = (remote?.url ?? process.env.ABX_RESOLVER_URL ?? resolveBaseUrl()).replace(/\/$/, '');
  const adminToken = remote ? requireRemoteToken(remote) : undefined;
  // Refuse the combination that can't work before launching Chromium (a laptop render against a
  // hosted resolver, on a backend with no public URL) — the render would end in a 400 either way.
  if (remote) requirePublishableBackend(flags, 'abx render --remote');
  // Co-located (no --remote): record each declared output into the shared store's artifact
  // registry so the local resolver's `artifacts` manifest enumerates it. Remote: the publish
  // lane (adminToken) records rows on the hosted resolver instead.
  const localStore = remote ? null : new SqliteStore();
  const {EffectRunner, renderEffect} = await loadEffects();
  const runner = new EffectRunner({
    resolverUrl,
    client: makePublicClient({chainKey: CHAIN}),
    storage: resolveBackend(storageOptions(storageOverrides(flags))),
    effects: [renderEffect()],
    environmentId: process.env.ABX_ENVIRONMENT_ID ?? 'web:any',
    adminToken,
    republish: remote ? true : undefined,
    recordArtifact: localStore ? (row) => localStore.putEffectArtifact(row) : undefined,
  });
  const stats = await runner.sweepProject(address, ids.length ? ids : undefined, {force});
  const where = remote ? `published → ${resolverUrl}` : `resolver ${resolverUrl}`;
  const forceNote = force ? ' (forced re-render)' : '';
  const summary = `inline: ran=${stats.ran} skipped=${stats.skipped} failed=${stats.failed}${forceNote} ${dim(`(${where})`)}`;
  if (stats.failed) warn(`${summary}\n  ${dim(stats.errors[0] ?? 'see error above')}`);
  else ok(summary);
  if (stats.ran) noteArweavePropagation(flags);
}

/**
 * After an Arweave publish, say that a fresh 404 at the gateway is PROPAGATION, not a failed render.
 *
 * `arweave.net` lags Turbo uploads by minutes: a tester found 32/32 of their renders 404ing there
 * while Turbo reported CONFIRMED and 22/32 already served fine from other ar.io gateways. The bytes
 * were never in doubt — only the gateway was behind. Unexplained, a "broken" thumbnail on a fresh
 * drop reads as a failed render, and the natural next move is `abx render --force` on all of them:
 * a full re-upload that fixes nothing.
 *
 * Note this is advisory only, and deliberately so — the locator is baked into what the resolver
 * registers at publish time, so it cannot be repaired by a redirect later. Choosing the gateway is
 * the operator's call (`ABX_ARWEAVE_GATEWAY`), which is why this names it.
 */
export function noteArweavePropagation(flags: Flags): void {
  const opts = storageOptions(storageOverrides(flags));
  if (resolveBackend(opts).id !== 'arweave') return;
  const gateway = opts.arweave?.gateway ?? 'https://arweave.net';
  if (!/(^|\/\/)([^/]*\.)?arweave\.net/.test(gateway)) return; // a gateway they chose — don't lecture
  info(
    `${dim('arweave: the locator points at')} ${gateway}${dim(', which can 404 for several minutes after upload while it catches up. That is PROPAGATION, not a failed render — the bytes are already confirmed. Do NOT re-run with')} ${bold('--force')}${dim('; the URL starts working on its own.')}`,
  );
  info(`  ${dim('to bake a different gateway into the locator instead (it is fixed at publish time):')} ${bold('ABX_ARWEAVE_GATEWAY=https://<gateway>')} ${dim('before you render.')}`);
  // The note is advisory; this is the answer. Naming it here is the difference between "wait and
  // hope" and a check a script can gate on — which is what both reporters ended up building.
  info(`  ${dim('to KNOW rather than wait:')} ${bold('abx storage status <locator>')} ${dim('— ready vs propagating vs unreachable, exits non-zero until it serves.')}`);
}

/**
 * `abx artifacts <address> [--token <id>]` — the direct, typed read behind a token's `artifacts`
 * manifest through structured read surfaces.
 *
 * Before this, the manifest was visible only as a BYPRODUCT of assembling the full tokenURI
 * document (`buildTokenArtifacts` in `@artblocks/abx-token-api`) — an integrator who wanted just the
 * artifact set had to fetch and parse the whole document. This reads it directly, and — critically —
 * from whichever surface actually OWNS it: a self-hosted node's local projection reads its OWN store
 * (this repo's `buildTokenArtifacts`), while a HOSTED project's real artifact set lives on the remote
 * resolver, which independently re-implements the same logic rather than importing this package. So
 * `--remote` here is not an alternate view of the same answer — it is a DIFFERENT surface, and the
 * report says explicitly which one answered (`surface: 'local' | 'remote'`), exactly like
 * `abx verify` / `abx verify --remote` (`cmdVerify` / `cmdVerifyRemote` in `project.ts`) already do
 * for byte integrity.
 *
 * Nothing reported here is on-chain data itself: every entry is a resolver-published projection —
 * either of an on-chain-anchored field or an off-chain effect output — never claimed to BE on-chain.
 * `currentInputsHash` is the active effect key: an `effects` row whose own `inputsHash` doesn't match
 * it is STALE (a param changed since it rendered), not wrong or missing.
 */
export async function cmdArtifacts(address: Address | undefined, flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx artifacts <address> [--token <id>] [--remote <name|url>] [--json]\n');
    process.exitCode = 1;
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error(`abx artifacts: '${address}' isn't a 0x contract address.\n`);
    process.exitCode = 1;
    return;
  }
  const tokenId = String(flags.token ?? '0');
  const remote = remoteFlag(flags);
  if (remote) return cmdArtifactsRemote(address, tokenId, remote, flags);
  return withJson(flags, async (emit) => cmdArtifactsBody(address, tokenId, flags, emit));
}

/** One line per manifest entry / effect row — shared by the local and remote lanes so the two print
 *  identically (the only difference a reader should see is the `surface`/`remote` line above it). */
function printArtifactsHuman(entries: ArtifactEntry[], effects: EffectArtifactStatus[], currentInputsHash: string | null): void {
  if (!entries.length && !effects.length) {
    info('no artifacts — no creator-set content fields and no producer-registered effect output for this token.');
  }
  for (const e of entries) info(`${bold(e.key)}  ${dim(e.mimeType)}  ${e.uri}`);
  if (effects.length) {
    info(dim(`effect registry rows (current AND stale — a stale row is silently absent from ${bold('entries')} above):`));
    for (const e of effects) {
      const line = `  ${e.key}  ${dim(e.contentType ?? 'application/octet-stream')}  ${e.uri}`;
      if (e.status === 'current') ok(`${line} ${dim('(current)')}`);
      else console.log(`    ${c.orange}⚠${c.reset}${line} STALE${e.inputsHash ? dim(` (rendered at ${e.inputsHash.slice(0, 10)}…, not ${currentInputsHash?.slice(0, 10)}…)`) : ''}`);
    }
  }
}

/** The LOCAL lane: this node's own projection + byte custody — never a network call to another
 *  resolver. Correct for a self-hosted project this node indexes; the WRONG surface for a hosted
 *  drop (see the doc comment on `cmdArtifacts`). */
async function cmdArtifactsBody(
  address: Address,
  tokenId: string,
  flags: Flags,
  emit: (p: Record<string, unknown>) => void,
): Promise<void> {
  console.log(bold(`\n  artifacts ${address} #${tokenId}  ${dim('(local)')}`));
  const indexer = localIndexer();
  const state = indexer.getProject(address);
  const base: Record<string, unknown> = {address, tokenId, surface: 'local' as const};
  // "Not registered" is a NEGATIVE case this read must answer usefully, not by throwing — a caller
  // asking "who owns this project's artifacts" is exactly as likely to learn "nobody, here" as to
  // learn the manifest itself, and both are legitimate answers to the same question.
  if (!state) {
    emit({...base, registered: false, available: false, reason: 'not-registered', entries: [], effects: []});
    warn(`${address} isn't indexed by this node — nothing to report locally.`);
    info(`register it here: ${bold(`abx add ${address}`)}  ·  or ask a resolver that already knows it: ${bold(`abx artifacts ${address} --remote <name|url>`)}`);
    return;
  }
  const token = state.tokens.find((t) => t.tokenId === tokenId);
  if (!token) {
    emit({...base, registered: true, available: false, reason: 'token-not-found', entries: [], effects: []});
    warn(`token #${tokenId} isn't known for ${state.name ?? address} (not minted yet, or out of range).`);
    return;
  }
  const client = makePublicClient({chainKey: CHAIN});
  const storage = resolveBackend(storageOptions(storageOverrides(flags)));
  const chainId = resolveChain(CHAIN).id;
  // The manifest's own read surface over the effect-artifact registry — the SAME shape server.ts's
  // `planeAccess()` builds for the HTTP route, so a local read and a served tokenURI can never see
  // a different plane.
  const plane: PlaneAccess = {
    list: (addr, tid) => indexer.store.listEffectArtifacts(addr, tid),
    get: (key) => indexer.store.getEffectArtifact(key),
  };
  const result = await tokenArtifacts(client, state, token, resolveBaseUrl(), chainId, {}, storage, plane);
  info(`canonical: ${state.isCanonical === true ? 'yes' : state.isCanonical === false ? 'no' : 'not checked'} · project "${state.name ?? address}"`);
  emit(
    jsonSafe({
      ...base,
      registered: true,
      available: true,
      entries: result.entries,
      effects: result.effects,
      planeConsulted: result.planeConsulted,
      currentInputsHash: result.currentInputsHash,
    }),
  );
  printArtifactsHuman(result.entries, result.effects, result.currentInputsHash);
}

/**
 * The REMOTE lane: probe what a named resolver's own REST surface (`GET /api/project/:address` +
 * `GET /api/project/:address/artifacts`) actually reports — the surface a HOSTED drop's artifacts
 * really live on, and the one abx-services must expose to match (site/content/docs coordination:
 * this route mirrors the existing `GET /api/project/:address/effects` this repo's own resolver
 * already serves). Public reads, no bearer token, matching `/effects` and `/api/project/:address`.
 */
async function cmdArtifactsRemote(address: Address, tokenId: string, remote: RemoteTarget, flags: Flags): Promise<void> {
  const base = remote.url.replace(/\/$/, '');
  return withJson(flags, async (emit) => {
    console.log(bold(`\n  artifacts ${address} #${tokenId}  ${dim(`(remote → ${base})`)}`));
    const report: Record<string, unknown> = {address, tokenId, surface: 'remote' as const, remote: {name: remote.name ?? null, url: base}};
    let stateRes: Response;
    try {
      stateRes = await fetch(`${base}/api/project/${address}`);
    } catch {
      throw new Error(
        `artifacts: nothing responded at ${base}${remote.source === 'named' ? ` (from ABX_REMOTE_${remote.name}_URL)` : ''}. Is it running, and is that the right address?`,
      );
    }
    // "No resolver [there] configured [for this project]" — the second negative case this read must
    // answer usefully: the resolver is UP (it answered), it just doesn't index this contract. Same
    // condition `cmdVerifyRemote` treats as a hard error; here it's a legitimate reportable state,
    // since asking "does anyone serve this" is a normal question with "nobody, there" as a real answer.
    if (!stateRes.ok) {
      emit({...report, registered: false, available: false, reason: 'not-registered-on-remote', entries: [], effects: []});
      warn(`resolver ${base} doesn't serve ${address} (HTTP ${stateRes.status}) — no artifacts to report there.`);
      info(`register it there first: ${bold(`abx add ${address} --remote ${remote.name?.toLowerCase() ?? base}`)}`);
      return;
    }
    const projState = (await stateRes.json()) as {name?: string};
    info(`serving as "${projState.name ?? address}"`);
    let artRes: Response;
    try {
      artRes = await fetch(`${base}/api/project/${address}/artifacts?token=${encodeURIComponent(tokenId)}`);
    } catch {
      throw new Error(`artifacts: ${base} stopped responding mid-request.`);
    }
    if (artRes.status === 404) {
      const body = (await artRes.json().catch(() => ({}))) as {error?: string; code?: string};
      emit({...report, registered: true, available: false, reason: body.code ?? 'not-found', entries: [], effects: []});
      warn(`${base} has no artifacts to report for #${tokenId}${body.error ? `: ${body.error}` : ''}${!body.code ? dim(' (an older resolver without this route yet? redeploy it)') : ''}`);
      return;
    }
    if (!artRes.ok) throw new Error(`resolver ${base} replied ${artRes.status} to the artifacts read`);
    const data = (await artRes.json()) as {
      entries?: ArtifactEntry[];
      effects?: EffectArtifactStatus[];
      planeConsulted?: boolean;
      currentInputsHash?: string | null;
    };
    const entries = data.entries ?? [];
    const effects = data.effects ?? [];
    emit({
      ...report,
      registered: true,
      available: true,
      entries,
      effects,
      planeConsulted: !!data.planeConsulted,
      currentInputsHash: data.currentInputsHash ?? null,
    });
    printArtifactsHuman(entries, effects, data.currentInputsHash ?? null);
  });
}

export async function cmdTokenUri(address: Address | undefined, flags: Flags, extra: string[] = []) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx tokenuri <address> [--token <id>] [--fetch] [--json]\n');
    process.exitCode = 1;
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error(`abx tokenuri: '${address}' isn't a 0x contract address.\n`);
    process.exitCode = 1;
    return;
  }
  // `abx tokenuri <addr> 0` silently ignored the `0` and printed token 0 — a COINCIDENTALLY correct
  // answer, which is the dangerous kind: `… <addr> 7` would have printed token 0 just as confidently
  // and exited 0. The token id is a flag here, so name it rather than guessing at intent.
  const strayPositionals = positionalArgs(extra);
  if (strayPositionals.length) {
    const first = strayPositionals[0];
    const looksLikeTokenId = /^\d+$/.test(first);
    console.error(
      `abx tokenuri: unexpected extra argument '${first}'.` +
        (looksLikeTokenId
          ? ` The token id is a flag — did you mean:\n    abx tokenuri ${address} --token ${first}\n`
          : `\n  usage: abx tokenuri <address> [--token <id>] [--fetch] [--json]\n`),
    );
    process.exitCode = 1;
    return;
  }
  const tokenId = BigInt(flags.token ?? '0');
  const publicClient = makePublicClient({chainKey: CHAIN});
  // An edition serves its metadata via the native ERC-1155 `uri(id)`, not `tokenURI(id)` — the ONE
  // read that genuinely differs between the two families (the config/setter surface is identical;
  // see kind.ts's own note). Everything else below reads identically either way.
  const isEdition = await isEditionContract(publicClient, address);
  // A creator verifying their work often runs this on a wrong / not-yet-mined address — turn viem's
  // raw revert (with its viem.sh docs link) into a black-box-clean, actionable message.
  let uri: string;
  try {
    uri = (await publicClient.readContract({
      address,
      abi: isEdition ? oneOfOneEditionAbi : oneOfOneImageAbi,
      functionName: isEdition ? 'uri' : 'tokenURI',
      args: [tokenId],
    })) as string;
  } catch {
    const code = await publicClient.getCode({address}).catch(() => undefined);
    if (!code || code === '0x') {
      // Name the endpoint we actually asked. "No contract here" is indistinguishable from "you're
      // pointed at the wrong node", and a chain KEY doesn't disambiguate that — two endpoints can
      // both claim `sepolia` (a fork, a stale duplicate .env line) and only one has your contract.
      console.error(
        `abx tokenuri: no contract at ${address} on ${CHAIN} (asked ${redactRpcUrl(resolveRpcUrl(CHAIN))}) — ` +
          `double-check the address, and that this endpoint is the network you deployed to. ` +
          `If you JUST deployed, give the tx a block or two to mine.\n`,
      );
    } else {
      console.error(
        `abx tokenuri: ${address} didn't return a ${isEdition ? 'uri' : 'tokenURI'} for ${isEdition ? 'id' : 'token'} ${tokenId} — it may not be an ABX/ERC-${isEdition ? '1155' : '721'} token, ${isEdition ? 'id' : 'token'} ${tokenId} may have no copies minted yet (try --token <id>), or — on a large on-chain tokenURI — an unauthenticated RPC read hit its gas cap (try a wallet-connected / high-gas RPC).\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  // --fetch: FOLLOW the URL the contract commits to and print what is actually served.
  // The gap this closes: `tokenuri` read the chain, `verify` re-hashed bytes, `status` reported the
  // lifecycle — none of them shows the served JSON body. It also makes a provider mismatch
  // self-evident without a warning that cries wolf: if you
  // registered with one provider while a different base is baked on-chain, the fetch shows you what
  // the BAKED base returns (often a 404, or another project's document entirely).
  const served = flags.fetch !== undefined ? await fetchServedTokenUri(uri) : null;

  // --json: the verbatim document, nothing else on stdout — no banner, no ANSI, no truncation, so
  // `abx tokenuri <addr> --json | jq` is a supported read path rather than something to regex.
  if (flags.json !== undefined) {
    const onChain = decodeOnChainJson(uri, true);
    if (served === null) {
      process.stdout.write((onChain ?? uri) + '\n');
      return;
    }
    // With --fetch the payload has to say WHICH answer is which: a marketplace reads the served body,
    // and conflating it with the on-chain URI is the confusion the flag exists to remove.
    process.stdout.write(
      JSON.stringify(
        {
          tokenId: tokenId.toString(),
          contract: address,
          chain: CHAIN,
          tokenURI: uri,
          onChain: onChain !== null,
          served,
        },
        null,
        2,
      ) + '\n',
    );
    if (served.status !== null && (served.status < 200 || served.status >= 300)) process.exitCode = 1;
    return;
  }
  console.log(`\n  ${bold(`${isEdition ? 'uri' : 'tokenURI'}(${tokenId})`)} ${dim(`— read directly from ${address} on ${CHAIN}, no server`)}`);
  const json = decodeOnChainJson(uri);
  if (json) {
    info('decoded on-chain JSON:');
    console.log(json.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  } else {
    console.log(`    ${uri.slice(0, 240)}${uri.length > 240 ? dim(`… (${uri.length} chars)`) : ''}\n`);
  }
  if (served) reportServedTokenUri(served, address);
}

/** The human readout for `--fetch`. */
export function reportServedTokenUri(served: ServedTokenUri, address: Address): void {
  if (served.skipped) {
    info(`--fetch: ${served.skipped}`);
    return;
  }
  console.log(`  ${bold('served')} ${dim(`— GET ${served.url}`)}`);
  if (served.status === null) {
    warn(`the baked URL did not respond: ${served.error}. That host is what a marketplace will ask, so this is what they see too.`);
    return;
  }
  const line = `HTTP ${served.status}${served.contentType ? dim(` · ${served.contentType.split(';')[0]}`) : ''}`;
  if (servedOk(served)) ok(line);
  else console.log(`    ${c.orange}\u26a0${c.reset} ${line}`);
  const pretty = prettyBody(served.body);
  const clipped =
    pretty.length > 1200 ? `${pretty.slice(0, 1200)}\n    \u2026 (${pretty.length} chars \u2014 --json for the full body)` : pretty;
  console.log(clipped.split('\n').map((l) => '    ' + l).join('\n'));
  if (!servedOk(served)) {
    // The mismatch case, stated where it is actionable rather than as a standing warning that would
    // cry wolf on the common custom-domain setup.
    console.log(
      `\n    ${dim('the contract commits to that URL, so a non-2xx is about the SERVICE, never a mistyped path:')} ` +
        `${dim('the project may not be registered there, the service may serve a different chain, or the base baked on-chain may point at a provider you never registered with.')}\n` +
        `    ${dim('check the lifecycle:')} ${bold(`abx status ${address} --remote <name|url>`)}`,
    );
  }
  console.log('');
}

// ── contracturi ──────────────────────────────────────────────────────────────
/**
 * `abx contracturi <address>` — the collection-level counterpart of `tokenuri`: read
 * `contractURI()` (ERC-7572) STRAIGHT FROM THE CONTRACT, then FOLLOW it and decode the JSON.
 *
 * Why this exists, and why it follows the URL: the resolver's route grammar is committed
 * on-chain at deploy (`contractURIBase` = `<baseUrl>/c`), so the contract — not a doc, not a
 * service descriptor — is the source of truth for where a collection's metadata lives. Without
 * this command the only way to look was to hand-build the URL from memory of the grammar, and a
 * guessed path that 404s reads exactly like a broken service. Ask the chain instead.
 */
export async function cmdContractUri(address: Address | undefined, _flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx contracturi <address>\n');
    process.exitCode = 1;
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error(`abx contracturi: '${address}' isn't a 0x contract address.\n`);
    process.exitCode = 1;
    return;
  }
  const publicClient = makePublicClient({chainKey: CHAIN});
  let uri: string;
  try {
    uri = (await publicClient.readContract({
      address,
      abi: oneOfOneImageAbi,
      functionName: 'contractURI',
      args: [],
    })) as string;
  } catch {
    const code = await publicClient.getCode({address}).catch(() => undefined);
    if (!code || code === '0x') {
      // Name the endpoint we actually asked — "no contract here" and "you're pointed at the wrong
      // node" are indistinguishable otherwise (same reasoning as `tokenuri`).
      console.error(
        `abx contracturi: no contract at ${address} on ${CHAIN} (asked ${redactRpcUrl(resolveRpcUrl(CHAIN))}) — ` +
          `double-check the address, and that this endpoint is the network you deployed to. ` +
          `If you JUST deployed, give the tx a block or two to mine.\n`,
      );
    } else {
      console.error(
        `abx contracturi: ${address} didn't return a contractURI — it may not be an ABX/ERC-7572 contract, or ` +
          `— on a large on-chain contractURI — an unauthenticated RPC read hit its gas cap (try a wallet-connected / high-gas RPC).\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${bold('contractURI()')} ${dim(`— read directly from ${address} on ${CHAIN}`)}`);
  if (!uri) {
    console.error(
      `\n  ${bold('empty')} — this contract has no contractURI set: no collection-level metadata to resolve. ` +
        `Set one with ${bold(`abx set-contract-uri ${address} --uri <base>`)}, or point it at the canonical renderer for the on-chain lane.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const onChain = decodeOnChainJson(uri);
  if (onChain) {
    info('resolution: ON-CHAIN (data: URI from the renderer — no server in the path)');
    console.log(onChain.split('\n').map((l) => '    ' + l).join('\n') + '\n');
    return;
  }
  console.log(`  ${dim('resolves to')} ${uri}`);
  if (!/^https?:\/\//i.test(uri)) {
    // ipfs:// / ar:// — a locator, not something we can fetch without choosing a gateway. Print it
    // rather than silently picking one; the creator's gateway choice is theirs.
    info(`not an http(s) URL — a ${uri.split(':')[0]}: locator needs a gateway to fetch. Nothing more to read from here.`);
    console.log('');
    return;
  }
  let body: string;
  try {
    const res = await fetch(uri, {headers: {accept: 'application/json'}});
    body = await res.text();
    if (!res.ok) {
      // The URL came FROM THE CHAIN, so a bad status here is genuinely about the service (or the
      // contract pointing somewhere stale) — never a mistyped path. Say which, so nobody re-guesses.
      console.error(
        `\n  ${bold(`HTTP ${res.status}`)} from the contract's own contractURI — the URL is correct by construction (it came from ` +
          `${address} on-chain), so this is the SERVICE, not the path. Likely: the project isn't registered on that resolver ` +
          `(${bold('abx add ' + address + ' --remote')}), the node serves a different chain, or it's down. ` +
          `Response: ${body.slice(0, 200)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    console.error(
      `\n  couldn't reach ${uri} — ${(e as Error).message}. The URL is what the contract commits to, so check that the ` +
        `host is up and publicly reachable (a localhost base URL resolves for no one but this machine).\n`,
    );
    process.exitCode = 1;
    return;
  }
  info('resolution: OFF-CHAIN (fetched from the URL the contract commits to)');
  try {
    console.log(
      JSON.stringify(JSON.parse(body), null, 2)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n') + '\n',
    );
  } catch {
    console.log(`    ${dim('(not JSON)')} ${body.slice(0, 400)}\n`);
  }
}

// ── status ────────────────────────────────────────────────────────────────--
// ── tokens: every token's seed + params, read straight from chain ────────────────────────────
// For a generative collection the seed list IS the collection — it's the first thing you want after
// a drop ("what did the seeds actually deal?") and, before this existed, the one thing no command
// could answer. An agent's workaround was: start `abx serve`, GET the project API, base64-decode
// each tokenURI, base64-decode the animation_url inside it, then regex `0x[0-9a-f]{64}` out of the
// resulting HTML — 32 times. Every input to that was already a plain contract read.
// The stray-flag allowlist for `tokens` lives in flag-allowlists.ts' COMMAND_FLAGS, which main.ts
// applies centrally before dispatch. This command previously ALSO called warnStrayFlags with an
// identical local copy, so one misspelled flag printed the same warning twice. Kept as the single
// source the central map mirrors; do not re-add a local guard (see `tokens` in flag-allowlists.ts).
export const TOKENS_FLAGS = new Set<string>(['json', 'limit', 'from', 'holder']);

/** An owner address abbreviated for a human table. Abbreviating for eyes is fine; abbreviating for a
 *  PROGRAM is not — which is why every value here is also reachable verbatim via `--json`. */
export function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function cmdTokens(address: Address | undefined, flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx tokens <address> [--json] [--from <id>] [--limit <n>]  — every token\'s owner, seed, and params, from chain\n');
    process.exitCode = 1;
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error(`abx tokens: '${address}' isn't a 0x contract address.\n`);
    process.exitCode = 1;
    return;
  }
  const jsonMode = flags.json !== undefined;
  const publicClient = makePublicClient({chainKey: CHAIN});
  const code = await publicClient.getCode({address}).catch(() => undefined);
  if (!code || code === '0x') {
    // Name the endpoint we actually asked — "no contract here" and "wrong node" are otherwise
    // indistinguishable (same reasoning as `tokenuri` / `contracturi`).
    console.error(
      `abx tokens: no contract at ${address} on ${CHAIN} (asked ${redactRpcUrl(resolveRpcUrl(CHAIN))}) — ` +
        `double-check the address, and that this endpoint is the network you deployed to. ` +
        `If you JUST deployed, give the tx a block or two to mine.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Kind, up front: an edition has no whole-contract `totalSupply()` and no single owner per id
  // (many concurrent holders) — the header + table below both branch on it.
  const kind = await detectTokenKind(publicClient, address);
  // Refuse a misused flag BEFORE doing any listing work — `--holder` is in this command's allowlist,
  // so the stray-flag warning can never fire for it, and an unminted 721 returns early below, which
  // would have let it slip through silently. A 721 already answers "who holds this" in its owner column.
  if (flags.holder !== undefined && !kind.isEdition) {
    throw new Error(
      `--holder is edition-only (it reads balanceOf(holder, id) for ERC-1155 copies) — ${address} is a ${kind.label} (721), ` +
        `where each token has exactly one owner. Drop --holder: the owner column already answers that.`,
    );
  }

  const listing = await listTokens(publicClient, address, {
    from: flags.from === undefined ? undefined : Number(flags.from),
    limit: flags.limit === undefined ? undefined : Number(flags.limit),
    // Progress on stderr only — stdout must stay pure JSON in --json mode (the ANSI-in-a-locator
    // lesson: a program's channel is not a place to narrate).
    onProgress: (done, total) =>
      total > 50 && done % 25 === 0 ? process.stderr.write(`  reading ${done}/${total}…\r`) : undefined,
  });
  if (listing.tokens.length > 50) process.stderr.write('                          \r');

  if (jsonMode) {
    process.stdout.write(JSON.stringify(listing, null, 2) + '\n');
    return;
  }

  if (kind.isEdition) {
    const totalCopies = listing.tokens.reduce((n, t) => n + (t.supply !== undefined ? Number(t.supply) : 0), 0);
    const idSpace = listing.maxInvocations !== null && listing.maxInvocations > 0 ? ` of ${listing.maxInvocations} id(s)` : '';
    console.log(
      `\n  ${bold(`${describeKind(kind)} ${address}`)} ${dim(`— ${listing.tokens.length} id(s) read${idSpace}, ${totalCopies} total cop${totalCopies === 1 ? 'y' : 'ies'} on ${CHAIN}`)}`,
    );
  } else {
    const supply = listing.totalSupply ?? listing.tokens.length;
    const cap = listing.maxInvocations !== null && listing.maxInvocations > 0 ? ` of ${listing.maxInvocations} max` : '';
    console.log(`\n  ${bold(`tokens ${address}`)} ${dim(`— ${supply} minted${cap} on ${CHAIN}`)}`);
  }
  info('read straight from the contract — no indexer, no resolver, no server in the loop');

  if (!listing.hasParams) {
    info(`this token type has no params extension — so no seeds or params to list (that is correct, not a failed read). ${kind.isEdition ? 'Copies' : 'Owners'} below.`);
  } else if (!listing.hasParamEnumeration) {
    warn('this contract predates on-chain param enumeration — seeds still read, but params cannot be listed. Redeploy on a current implementation to enumerate them.');
  }
  const contractKeys = Object.keys(listing.contractParams);
  if (contractKeys.length) {
    info(`contract-scope params ${dim('(every token inherits these; a token-scope value of the same key wins)')}`);
    for (const k of contractKeys.sort()) console.log(`      ${g(k)}=${listing.contractParams[k]}`);
  }

  if (!listing.tokens.length) {
    console.log(`\n  ${dim(`no ${kind.isEdition ? 'ids' : 'tokens'} in range — nothing minted yet, or --from is past the mint frontier.`)}\n`);
    return;
  }
  const anySeed = listing.tokens.some((t) => t.seed !== null);
  if (kind.isEdition) {
    // No `owner` column (an id can have many concurrent holders — not chain-enumerable outside the
    // event log; see `TokenRow.owner`'s own doc). `supply`/`maxSupply` are what a head read CAN say.
    //
    // `--holder 0x..` answers the ONE question the supply columns can't: what does a SPECIFIC address
    // hold? There was no way to ask that at all — after transferring a copy, an agent could confirm the
    // tx but not the recipient's balance, so it either reported nothing or made a number up. This is a
    // direct `balanceOf(holder, id)` head read, so it stays true to this command's "no indexer" promise.
    const holderRaw = flags.holder as string | undefined;
    if (holderRaw !== undefined && (holderRaw === 'true' || !isAddress(holderRaw))) {
      throw new Error(`--holder must be a 0x address (whose per-id copies to read); got '${holderRaw}'.`);
    }
    const holder = holderRaw ? getAddress(holderRaw) : undefined;
    const balances = new Map<string, bigint>();
    if (holder) {
      await Promise.all(
        listing.tokens.map(async (t) => {
          const b = await publicClient
            .readContract({address, abi: oneOfOneEditionAbi, functionName: 'balanceOf', args: [holder, BigInt(t.tokenId)]})
            .catch(() => null);
          if (b !== null) balances.set(t.tokenId, b as bigint);
        }),
      );
      info(`held by ${shortAddr(holder)} ${dim('— balanceOf(holder, id), read per id straight from the contract')}`);
    }
    console.log(
      `\n    ${dim('id'.padStart(4))}  ${anySeed ? dim('seed'.padEnd(66)) + '  ' : ''}${dim('copies (cap)')}${holder ? '  ' + dim('held') : ''}`,
    );
    for (const t of listing.tokens) {
      const seedCell = anySeed ? `${t.seed ?? dim('—'.padEnd(66))}  ` : '';
      // One rule for reading a cap, shared with the fold lane and the dashboard (`editionCapOf`).
      // This is the HEAD-read lane, so a `'0'` cap reads "open": `maxSupply(id)` cannot tell an id
      // never capped from one deliberately closed, and only the log can (`abx index`).
      const cap = editionCapOf(t);
      const supplyCell =
        t.supply !== undefined
          ? `${t.supply}${cap?.kind === 'capped' ? `/${cap.cap}` : dim(' (open)')}`
          : dim('—');
      const heldCell = holder ? '  ' + (balances.has(t.tokenId) ? bold(String(balances.get(t.tokenId))) : dim('—')) : '';
      console.log(`    ${bold(('#' + t.tokenId).padStart(4))}  ${seedCell}${supplyCell}${heldCell}`);
      const keys = Object.keys(t.params).sort();
      if (keys.length) console.log(`          ${keys.map((k) => `${g(k)}=${t.params[k]}`).join(dim(' · '))}`);
    }
  } else {
    console.log(`\n    ${dim('id'.padStart(4))}  ${anySeed ? dim('seed'.padEnd(66)) + '  ' : ''}${dim('owner')}`);
    for (const t of listing.tokens) {
      // A seed is the whole reason this command exists, so it prints in FULL. The owner truncates —
      // an address stays recognizable abbreviated, and `--json` carries both verbatim either way.
      const seedCell = anySeed ? `${t.seed ?? dim('—'.padEnd(66))}  ` : '';
      const owner = t.owner ? shortAddr(t.owner) : dim('— unminted or burned');
      console.log(`    ${bold(('#' + t.tokenId).padStart(4))}  ${seedCell}${owner}`);
      const keys = Object.keys(t.params).sort();
      if (keys.length) console.log(`          ${keys.map((k) => `${g(k)}=${t.params[k]}`).join(dim(' · '))}`);
    }
  }

  // The token-scope param SPREAD — what collectors actually chose, which is the question a param
  // dump is usually a step toward. Deliberately NOT called a trait spread: traits come from running
  // the script against the seed (that's `abx render`), not from params.
  const spread = new Map<string, Map<string, number>>();
  for (const t of listing.tokens) {
    for (const [k, v] of Object.entries(t.params)) {
      const counts = spread.get(k) ?? new Map<string, number>();
      counts.set(v, (counts.get(v) ?? 0) + 1);
      spread.set(k, counts);
    }
  }
  if (spread.size && listing.tokens.length > 1) {
    console.log(`\n  ${bold('token-scope param spread')} ${dim('(what has actually been set — not the trait spread, which comes from running the script)')}`);
    for (const key of [...spread.keys()].sort()) {
      const counts = [...spread.get(key)!.entries()].sort((a, b) => b[1] - a[1]);
      const shown = counts.slice(0, 8).map(([v, n]) => `${v} ${dim('×' + n)}`).join(dim(' · '));
      const rest = counts.length > 8 ? dim(` …+${counts.length - 8} more values`) : '';
      console.log(`      ${g(key)}: ${shown}${rest}`);
    }
  }
  console.log(`\n  ${dim('every value above verbatim + machine-readable:')} ${bold(`abx tokens ${address} --json`)}\n`);
}
