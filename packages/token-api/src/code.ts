import {hexToString} from 'viem';
import {
  buildGeneratorDocument,
  buildTokenData,
  codeField,
  contentDigestOf,
  contractParamString,
  gatewayConfigFromEnv,
  projectGatewayPrefix,
  projectGatewayUrl,
  injectTokenDataIntoHtml,
  inputsHash,
  isCodeProject,
  renderArtifactKey,
  type Hex,
  type ProjectState,
  type PublicClient,
  type TokenState,
} from '@artblocks/abx-sdk';
import {seriesCodeAbi} from '@artblocks/abx-sdk';
import type {StorageBackend} from '@artblocks/abx-storage';
import {checkUrlBudget, dependencyScriptTags, recordDirectoryServe} from './deps.js';

/**
 * The live view + the render-effect consumption seam.
 *
 * The live view is the document a collector (and any render node) loads: directory mode
 * serves the build's entry document from the resolver with `window.abxTokenData` injected
 * (+ a `<base>` at the code root so relative assets still ride the gateway) — abx.js reads
 * the injected global FIRST, so no tokenData ever rides a URL on this path; the `?abx=`
 * 302 redirect survives only as the fallback when the entry document can't be fetched.
 * Template mode assembles the generator document from chain (dependencies in order →
 * `window.abxTokenData` → the script chunks). The seam: `image` resolution consults byte
 * custody at the canonical effect address for the CURRENT `inputsHash` — a param change
 * re-addresses output, so a stale render is never served (a miss falls back to the
 * placeholder until re-rendered).
 */

export function liveViewUrl(baseUrl: string, chainId: number, address: string, tokenId: string): string {
  return `${baseUrl}/a/${chainId}/${address}/${tokenId}`;
}

/** Whether the derived live view should fill `animation_url` (code present, not suppressed). */
export function liveViewEnabled(state: ProjectState): boolean {
  return isCodeProject(state) && contractParamString(state, 'display.animation') !== 'none';
}

export {isCodeProject};

/**
 * Whether the live view can be served — and, when it can't, WHICH KIND of "can't" it is.
 *
 * The `/a/` route used to collapse every negative into one confident verdict about the *contract*
 * ("not a code project"), when at least one of them is a statement about the *index*. `chunkCount`
 * is a head read, so a template-mode project whose chunks have not been folded in yet reads as
 * zero — not-yet-a-code-project to the check, and forever-not-a-code-project to the reader. A
 * tester lost a day to that wording: they got `live · caught up · 127 events · 32 tokens` from the
 * node and this 404 from `/a/`, concluded the resolver did not recognise the SeriesCode factory,
 * and a `--full` re-index did not clear it.
 *
 * `contractType` is folded from the deployed extensions, so it knows this is a code project before
 * any code lands — which is exactly the distinction the route needs.
 *
 *  - `ready` — there is executable content; go serve it.
 *  - `indexing` — this IS a code contract, but its code hasn't been folded in yet. Retry-able.
 *  - `not-a-code-project` — no executable content and nothing says there should be. Terminal.
 *
 * Pure, and deliberately so: this is a projection-only decision that needs no RPC (a contract with
 * no executable content does not acquire some when a chain client appears), which is why the route
 * answers it before touching one.
 */
export type LiveViewAvailability = 'ready' | 'indexing' | 'not-a-code-project';

/** The contract types that COMPOSE OnChainScript, and so could carry executable content.
 *  `edition-code` is the ERC-1155 twin of `code` and was missing here — see below. */
const CODE_CONTRACT_TYPES = new Set(['code', 'edition-code']);

export function liveViewAvailability(state: ProjectState): LiveViewAvailability {
  if (isCodeProject(state)) return 'ready';
  if (!CODE_CONTRACT_TYPES.has(state.contractType ?? '')) return 'not-a-code-project';
  // A code CONTRACT with no executable content is one of two very different things, and the
  // difference is exactly what this function exists to draw:
  //
  //   - its chunks have not been folded in yet          → retry (`indexing`)
  //   - it is a RENDERER-ONLY project and never will     → terminal (`not-a-code-project`)
  //
  // `chunkCount` is a HEAD read, so it separates them: a number is what the chain says right now,
  // and `0` means there is no script to wait for. `null` means nobody has asked the chain yet
  // (projection-only reconstruction, or the read failed), which is genuinely unknown — and the
  // honest answer to unknown is the retryable one.
  //
  // Both halves were wrong before. A renderer-only `SeriesCode` (`--image-renderer --onchain-uri`
  // with no `--script`) answered `indexing` forever, so the live-view route served 503 +
  // `Retry-After` for content that does not exist and never would. And `edition-code` was simply
  // absent from the type check, so an EditionCode mid-index answered the TERMINAL 404 — the exact
  // inverse failure this function's own docstring says cost a tester a day, just on the 1155 lane.
  const chunkCount = state.script?.chunkCount ?? null;
  if (chunkCount === 0) return 'not-a-code-project';
  return 'indexing';
}

/**
 * A render-artifact locator (`ipfs://<cid>`, `ar://<txid>`, or an absolute `https://…`) → a fetchable
 * URL, applying the gateway at SERVE time. Same source of truth as `codeLocatorUrl` and the metadata
 * planes: the collection's `abx_gateway_*` preference first, this host's env as the floor. An
 * already-absolute URL is returned verbatim (never re-prefixed).
 *
 * `state` is required rather than optional because these locators are the SAME project's content
 * reached by a different route (an effect artifact, a computed `text/uri-list`), and a redirect that
 * ignored the project's stated gateway while `image` honoured it would be a difference nobody could
 * explain from the chain.
 */
export function resolveLocatorUrl(state: ProjectState, locator: string): string {
  if (/^https?:\/\//i.test(locator)) return locator;
  // Explicit compose (the on-chain preference + the SDK's env helper) rather than a single call, so
  // the env read (`ABX_IPFS_GATEWAY`/`ABX_ARWEAVE_GATEWAY`) is visibly host-side here, at the
  // one place this resolver actually reads it.
  const gateways = gatewayConfigFromEnv();
  for (const network of ['ipfs', 'arweave'] as const) {
    const scheme = network === 'ipfs' ? 'ipfs://' : 'ar://';
    if (locator.startsWith(scheme)) {
      const wrapped = projectGatewayUrl(network, locator, projectGatewayPrefix(state, network, gateways));
      if (wrapped !== null) return wrapped;
    }
  }
  return locator;
}

/**
 * The token's CURRENT settled inputsHash — the effect-run identity every artifact address is
 * keyed by. SETTLED tokenData (augment: false) — must mirror the producer's addressing
 * (EffectRunner.runToken): artifacts are keyed on event-derived state only, never live augment
 * data (live data animates the live view; a capture snapshots it without re-addressing every
 * block). Computed once per metadata build and shared across the image seam, the traits stitch,
 * and the `artifacts` manifest. Uses the default environmentId ('web:any') — a runner with a
 * custom ABX_ENVIRONMENT_ID must match the resolver's (pre-existing constraint).
 */
export async function currentSettledInputsHash(
  client: PublicClient,
  state: ProjectState,
  token: TokenState,
): Promise<Hex> {
  const {json} = await buildTokenData(client, state, token, {augment: false});
  return inputsHash(contentDigestOf(state), json);
}

/** The current artifact address for one (effect, output) of a token — and whether a conforming
 *  producer has stored it in THIS node's byte custody. A locator-bridge artifact lives in the
 *  effect_artifacts registry instead (checked by the caller), so `storage` may be absent here. */
export async function currentRenderArtifact(
  client: PublicClient,
  state: ProjectState,
  token: TokenState,
  storage?: StorageBackend,
  outputKey: string = 'image',
  opts: {hash?: Hex; effectKey?: string} = {},
): Promise<{key: Hex; found: boolean; hash: Hex}> {
  const hash = opts.hash ?? (await currentSettledInputsHash(client, state, token));
  const key = renderArtifactKey(state.chainId, state.address, token.tokenId, hash, outputKey, opts.effectKey ?? 'render');
  return {key, found: storage ? await storage.has(key) : false, hash};
}

export type LiveView = {kind: 'redirect'; location: string} | {kind: 'html'; html: string} | null;

/** Resolve the live view for a token: a served document (directory inline-injection or
 *  template assembly) or the directory 302 fallback. The live view carries FULL tokenData
 *  (settled + the augment hook's live entries) — the one place live data belongs. The hook's
 *  presence on-chain IS the live-data opt-in: no hook, no live read, zero per-view cost.
 *  ABX_DISABLE_AUGMENT=1 is a resolver-operator kill-switch (cost/abuse control on a public
 *  node) that degrades gracefully to settled params. */
export async function resolveLiveView(
  client: PublicClient,
  state: ProjectState,
  token: TokenState,
  fetchFn: typeof fetch = fetch,
): Promise<LiveView> {
  const {json} = await buildTokenData(client, state, token, {augment: process.env.ABX_DISABLE_AUGMENT !== '1'});
  const code = codeField(state);
  if (code) {
    const base = codeLocatorUrl(state, code.representation, code.value);
    if (!base) return null;
    const entry = base.endsWith('.html') ? base : `${base.replace(/\/$/, '')}/index.html`;
    // PRIMARY: serve the entry document from the resolver with `window.abxTokenData`
    // injected at the very top of <head> (abx.js reads the global before the ?abx= query
    // param) + a <base> at the code root so the build's relative assets still ride the
    // gateway. tokenData never touches a URL on this path — no query-string budget.
    try {
      const doc = await fetchEntryDocument(code.representation, entry, fetchFn);
      recordDirectoryServe(state.address, 'inline-injection');
      const codeRoot = entry.slice(0, entry.lastIndexOf('/') + 1);
      return {kind: 'html', html: injectTokenDataIntoHtml(doc, json, codeRoot)};
    } catch (err) {
      // FALLBACK: the ?abx= redirect the old path survived on — never a hard failure.
      console.warn(
        `[code] entry-document fetch failed for ${state.address} (${entry}): ${(err as Error).message} — falling back to the ?abx= redirect`,
      );
      recordDirectoryServe(state.address, 'redirect-fallback');
    }
    const packed = Buffer.from(json, 'utf8').toString('base64url');
    const location = `${entry}?abx=${packed}`;
    // The spec's query-string budget applies to URL-carried tokenData only (this fallback):
    // gateway request lines cap near 8KB. The FULL URL is always served (params are never
    // dropped) — a breach warns loudly, once per project.
    checkUrlBudget(state.address, token.tokenId, location);
    return {kind: 'redirect', location};
  }
  if ((state.script?.chunkCount ?? 0) > 0) {
    return {kind: 'html', html: await assembleGeneratorDocument(client, state, json)};
  }
  return null;
}

// ── directory-mode inline injection (the primary serving path) ────────────────────

// Fetched entry documents cache in-process keyed by the resolved entry URL. A
// content-addressed root (ipfs/arweave) can never change under its locator — cache
// indefinitely (bounded by entry count); a mutable `url` root gets a short TTL.
const ENTRY_DOC_CACHE_MAX = 32;
const ENTRY_DOC_URL_TTL_MS = 5 * 60 * 1000;
const ENTRY_DOC_FETCH_TIMEOUT_MS = 10_000;
const entryDocCache = new Map<string, {html: string; expiresAt: number}>();

/** Reset the in-process entry-document cache — for tests. */
export function resetEntryDocumentCache(): void {
  entryDocCache.clear();
}

/** Fetch (and cache) a directory build's entry document text. Throws on any failure —
 *  the caller falls back to the ?abx= redirect. */
async function fetchEntryDocument(representation: string, url: string, fetchFn: typeof fetch): Promise<string> {
  const hit = entryDocCache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.html;
  const res = await fetchFn(url, {signal: AbortSignal.timeout(ENTRY_DOC_FETCH_TIMEOUT_MS)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const ttl = representation === 'ipfs' || representation === 'arweave' ? Number.POSITIVE_INFINITY : ENTRY_DOC_URL_TTL_MS;
  if (entryDocCache.size >= ENTRY_DOC_CACHE_MAX) {
    entryDocCache.delete(entryDocCache.keys().next().value as string); // oldest insert
  }
  entryDocCache.set(url, {html, expiresAt: Date.now() + ttl});
  return html;
}

// `injectTokenDataIntoHtml` lives in `@artblocks/abx-sdk` (src/generator-document.ts).

/**
 * A `code` field locator → a fetchable https URL.
 *
 * The twin of `AbxGenerator._directoryUrl`'s gateway handling, and it reads the SAME source the
 * generator does: the collection's reserved `abx_gateway_ipfs` / `abx_gateway_arweave` field, with
 * this host's env as the floor beneath it. That is the whole point of `state` being a parameter
 * here — the two lanes serve the same project, so they must agree on the code root's URL, and this
 * used to consult env alone while the generator consulted a contract param.
 */
function codeLocatorUrl(state: ProjectState, representation: string, value: Hex): string | null {
  const text = hexToString(value);
  // A stored locator can already be an absolute URL (e.g. a gateway URL saved verbatim by an older
  // deploy) — serve it directly rather than prefixing a gateway again (which double-prefixes to a
  // broken `https://arweave.net/https://arweave.net/…`). Applies to any representation.
  if (/^https?:\/\//i.test(text)) return text;
  if (representation === 'url') return text;
  if (representation === 'ipfs' || representation === 'arweave') {
    // Explicit compose (the on-chain preference + this host's env floor) — the env read stays
    // visibly host-side here, at the one place this resolver actually reaches for it.
    const prefix = projectGatewayPrefix(state, representation, gatewayConfigFromEnv());
    return projectGatewayUrl(representation, text, prefix);
  }
  return null; // `code` is locators-only by the registry; anything else is unserveable
}

/**
 * Template mode: the reference generator convention — dependencies in order (index 0 =
 * the runtime), `abx.js` + the injected tokenData, then the script chunks from chain.
 */
async function assembleGeneratorDocument(
  client: PublicClient,
  state: ProjectState,
  tokenDataJson: string,
): Promise<string> {
  const n = state.script?.chunkCount ?? 0;
  const reads = (await client.multicall({
    contracts: Array.from({length: n}, (_, i) => ({
      address: state.address,
      abi: seriesCodeAbi,
      functionName: 'scriptChunk',
      args: [BigInt(i)],
    })) as never,
    allowFailure: true,
  })) as Array<{status: 'success'; result: unknown} | {status: 'failure'; error: unknown}>;
  const script = reads
    .map((r) => (r.status === 'success' ? hexToString(r.result as Hex) : ''))
    .join('\n');

  // Dependencies resolve per the registry order (site/content/docs/protocol/code-projects.mdx
  // "Consumers"): the collection's registry pointer (on-chain bytes → preferredCDN) → the
  // built-in CDN map. Resolution never throws — the document always assembles.
  const depTags = await dependencyScriptTags(client, state);

  return buildGeneratorDocument(script, tokenDataJson, depTags);
}

// `buildGeneratorDocument` lives in `@artblocks/abx-sdk` (src/generator-document.ts).
