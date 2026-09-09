// Regression coverage for the code-project serving path — including the three bugs the
// Sepolia drop rehearsal caught: (1) resolveTokenView must carry `params` (the live view
// went seedless without them), (2) object-form script traits (`abx.traits({K: v})`)
// normalize to the OpenSea array, (3) the render seam is keyed to the CURRENT inputsHash
// (a param change makes yesterday's artifacts unreachable — self-invalidating).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stringToHex} from 'viem';
import {
  buildTokenData,
  contentDigestOf,
  inputsHash,
  renderArtifactKey,
  type ParamValue,
  type ProjectState,
  type TokenState,
} from '@artblocks/abx-sdk';
import type {StorageBackend, StoredContent} from '@artblocks/abx-storage';
import {buildTokenMetadata} from '../src/metadata.js';
import {liveViewAvailability, resetEntryDocumentCache, resolveLiveView, resolveLocatorUrl} from '../src/code.js';
import {assertServableBaseUrl, resolveTokenView} from '../src/server.js';

const client = {} as never; // no reader fields, no augment hook, no data-backed params
const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;

const pv = (key: string, value: bigint): ParamValue => ({
  key,
  value: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
  valueIsHash: false,
  updatedBy: ADDR,
});

function codeState(over: Partial<ProjectState> = {}): ProjectState {
  return {
    address: ADDR,
    chainId: 11155111,
    name: 'Drift',
    collectionFields: [{field: 'code', representation: 'ipfs', value: stringToHex('QmDir')}],
    tokens: [],
    paramHooks: null,
    maxInvocations: '8',
    ...over,
  } as never;
}

const driftToken = (params?: ParamValue[]): TokenState =>
  ({tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], params}) as never;

function memoryStorage(entries: Record<string, StoredContent> = {}): StorageBackend {
  const map = new Map(Object.entries(entries));
  return {
    id: 'memory',
    put: async (h, c) => void map.set(h, c),
    get: async (h) => map.get(h) ?? null,
    has: async (h) => map.has(h),
  };
}

/** A stub gateway fetch serving a fixed entry document (records requested URLs). */
const okFetch = (html: string, calls?: string[]) =>
  (async (url: unknown) => {
    calls?.push(String(url));
    return {ok: true, status: 200, text: async () => html};
  }) as unknown as typeof fetch;

/** A dead gateway — forces the directory live view onto the ?abx= redirect fallback. */
const failingFetch = (async () => {
  throw new Error('gateway down');
}) as unknown as typeof fetch;

/** Run with console.warn silenced (the redirect fallback warns by design). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = orig;
  }
}

/** The canonical key producers write to — computed the same way the seam computes it. */
async function currentKey(state: ProjectState, token: TokenState, output: 'image' | 'traits') {
  const {json} = await buildTokenData(null, state, token);
  return renderArtifactKey(state.chainId, state.address, token.tokenId, inputsHash(contentDigestOf(state), json), output);
}

test('resolveTokenView carries params (the rehearsal seedless-live-view bug)', () => {
  const token = driftToken([pv('seed', 0xabcdn)]);
  const view = resolveTokenView(codeState({tokens: [token]}), '0');
  assert.equal(view?.params?.[0]?.key, 'seed');
});

// The edition twin of the bug above: resolveTokenView used to reconstruct the returned TokenState
// field-by-field rather than passing `issued` through, so ERC-1155 editions' supply/maxSupply/
// holders — added after `params` — got silently dropped on every route that goes through it
// (`/t/…/:id`, `/a/…/:id`). Caught while generalizing this route for editions, not in production.
test('resolveTokenView carries supply/maxSupply/holders for an issued edition token', () => {
  const holders = {'0x1111111111111111111111111111111111111111': '3'};
  const tok = {tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '3', maxSupply: '10', holders} as never;
  const view = resolveTokenView(codeState({tokens: [tok], contractType: 'edition-code'}), '0');
  assert.equal(view?.supply, '3');
  assert.equal(view?.maxSupply, '10');
  assert.deepEqual(view?.holders, holders);
});

test('resolveTokenView leaves supply/maxSupply/holders absent for a synthesized (not-yet-issued) edition id', () => {
  const view = resolveTokenView(codeState({tokens: [], maxInvocations: '5', contractType: 'edition'}), '2');
  assert.equal(view?.lifecycle, 'unminted');
  assert.equal(view?.supply, undefined);
  assert.equal(view?.maxSupply, undefined);
  assert.equal(view?.holders, undefined);
});

test('code project derives animation_url to the live view; display.animation=none suppresses', async () => {
  const state = codeState();
  const json = await buildTokenMetadata(client, state, driftToken(), 'http://node', 11155111);
  assert.equal(json.animation_url, `http://node/a/11155111/${ADDR}/0`);

  const suppressed = codeState({contractParams: [{key: 'display.animation', value: stringToHex('none', {size: 32}), valueIsHash: false, updatedBy: ADDR}]});
  const json2 = await buildTokenMetadata(client, suppressed, driftToken(), 'http://node', 11155111);
  assert.equal(json2.animation_url, undefined);
});

test('render seam: image flips to effect:render only when the CURRENT address is populated', async () => {
  const state = codeState();
  const token = driftToken([pv('seed', 1n)]);
  const prov = (j: Record<string, unknown>) =>
    (j.abx_provenance as Array<{field: string; source: string}>).find((p) => p.field === 'image')!.source;

  // empty custody → honest placeholder
  const before = await buildTokenMetadata(client, state, token, 'http://node', 11155111, {}, memoryStorage());
  assert.equal(prov(before), 'placeholder');

  // artifact at the current inputsHash → effect:render
  const key = await currentKey(state, token, 'image');
  const withArtifact = memoryStorage({[key]: {bytes: new Uint8Array([1]), contentType: 'image/png'}});
  const after = await buildTokenMetadata(client, state, token, 'http://node', 11155111, {}, withArtifact);
  assert.equal(prov(after), 'effect:render');

  // a param change re-addresses: the same stored artifact no longer matches → placeholder
  const changed = driftToken([pv('seed', 1n), pv('palette', 0x22ddaan)]);
  const stale = await buildTokenMetadata(client, state, changed, 'http://node', 11155111, {}, withArtifact);
  assert.equal(prov(stale), 'placeholder');
});

test('render seam: a PUBLISHED locator (no local bytes) reads effect:render, not a false placeholder', async () => {
  const state = codeState();
  const token = driftToken([pv('seed', 1n)]);
  const prov = (j: Record<string, unknown>) =>
    (j.abx_provenance as Array<{field: string; source: string}>).find((p) => p.field === 'image')!.source;

  // The locator-bridge topology: the render lives ONLY as a published row (effect_artifacts),
  // NOT in this node's storage. Before the fix this read "placeholder" while /image served it fine.
  const key = await currentKey(state, token, 'image');
  const emptyStorage = memoryStorage();
  const row = {key, effectKey: 'render', outputKey: 'image', contentType: 'image/png', locator: 'ipfs://QmReal'};
  const plane = {
    list: (_a: string, _t: string) => [row],
    get: (k: string) => (k === key ? row : null),
  };
  const json = await buildTokenMetadata(client, state, token, 'http://node', 11155111, {}, emptyStorage, plane);
  assert.equal(prov(json), 'effect:render');
  // …and the manifest lists the published render at its durable locator
  const entries = json.artifacts as Array<{key: string; mimeType: string; uri: string}>;
  assert.deepEqual(entries, [{key: 'render/image', mimeType: 'image/png', uri: 'ipfs://QmReal'}]);

  // self-invalidation is preserved: a row keyed to the OLD inputsHash is NOT claimed after a param change.
  const changed = driftToken([pv('seed', 1n), pv('palette', 0x22ddaan)]);
  const stale = await buildTokenMetadata(client, state, changed, 'http://node', 11155111, {}, emptyStorage, plane);
  assert.equal(prov(stale), 'placeholder');
  assert.equal(stale.artifacts, undefined); // stale row filtered → empty manifest → key omitted
});

test('object-form script traits normalize to the OpenSea array (render wins over operator)', async () => {
  const state = codeState();
  const token = driftToken([pv('seed', 2n)]);
  const traitsKey = await currentKey(state, token, 'traits');
  const storage = memoryStorage({
    [traitsKey]: {
      bytes: new TextEncoder().encode(JSON.stringify({Palette: '#22ddaa', Density: 'Flowing'})),
      contentType: 'application/json',
    },
  });
  const json = await buildTokenMetadata(client, state, token, 'http://node', 11155111, {attributes: [{trait_type: 'Density', value: 'Operator says otherwise'}]}, storage);
  assert.deepEqual(json.attributes, [
    {trait_type: 'Palette', value: '#22ddaa'},
    {trait_type: 'Density', value: 'Flowing'}, // render wins per trait_type
  ]);
  const prov = (json.abx_provenance as Array<{field: string; source: string}>).find((p) => p.field === 'attributes')!;
  assert.equal(prov.source, 'effect:render');
});

test('bound traits stitch from the REGISTRY ROW — the publish topology needs no byte custody at all', async () => {
  // `traits` is a bound output: a producer that doesn't share this node's disk sends the CONTENT
  // (≤64KB) and it rides the artifact row. So the resolver stitches with NO StorageBackend in play —
  // which is what makes "conforming means a bounded amount of JSON in the DB you already run" literal.
  const state = codeState();
  const token = driftToken([pv('seed', 3n)]);
  const key = await currentKey(state, token, 'traits');
  const row = {
    key,
    effectKey: 'render',
    outputKey: 'traits',
    contentType: 'application/json',
    locator: null,
    bytes: new TextEncoder().encode(JSON.stringify({Palette: 'Dusk'})),
  };
  const plane = {list: () => [row], get: (k: string) => (k === key ? row : null)};
  const json = await buildTokenMetadata(client, state, token, 'http://node', 11155111, {}, undefined, plane);
  assert.deepEqual(json.attributes, [{trait_type: 'Palette', value: 'Dusk'}]);

  // Hash-gated: after a param change the row addresses a state it no longer depicts, so it does not
  // stitch — one state's features are never attributed to another.
  const changed = driftToken([pv('seed', 3n), pv('palette', 0x22ddaan)]);
  const stale = await buildTokenMetadata(client, state, changed, 'http://node', 11155111, {}, undefined, plane);
  assert.equal(stale.attributes, undefined);
});

// ── directory serving: inline injection (PRIMARY) ─────────────────────────────────
// The resolver fetches the build's entry document and serves it with `window.abxTokenData`
// injected at the top of <head> (abx.js reads the global BEFORE the ?abx= query param) plus
// a <base> at the code root so relative assets still ride the gateway. tokenData never
// touches a URL on this path; the ?abx= 302 survives only as the fetch-failure fallback.

test('directory live view (primary): entry html served with the global injected BEFORE the build script + <base> at the code root', async () => {
  resetEntryDocumentCache();
  const build = '<!doctype html><html><head><meta charset="utf-8"><script src="app.js"></script></head><body></body></html>';
  const calls: string[] = [];
  const v = await resolveLiveView(client, codeState(), driftToken([pv('seed', 1n)]), okFetch(build, calls));
  assert.equal(v?.kind, 'html');
  const html = (v as {html: string}).html;
  assert.deepEqual(calls, ['https://ipfs.io/ipfs/QmDir/index.html'], 'fetched via the gateway path');
  const inject = html.indexOf('window.abxTokenData=');
  const buildScript = html.indexOf('<script src="app.js">');
  assert.ok(inject !== -1 && buildScript !== -1 && inject < buildScript, 'the global lands before any build script');
  const base = html.indexOf('<base href="https://ipfs.io/ipfs/QmDir/">');
  assert.ok(base !== -1 && base < buildScript, 'relative asset paths keep riding the gateway');
  assert.ok(html.includes('"seed"'), 'the canonical tokenData rides inside the document');
});

test('directory live view: a build that already carries a <base> never gets a second one', async () => {
  resetEntryDocumentCache();
  const build = '<html><head><base href="./assets/"><script src="app.js"></script></head><body></body></html>';
  const v = await resolveLiveView(client, codeState(), driftToken([pv('seed', 1n)]), okFetch(build));
  const html = (v as {html: string}).html;
  assert.equal(html.match(/<base[\s/>]/gi)?.length, 1, 'first <base> wins — never doubled');
  assert.ok(html.includes('<base href="./assets/">'), 'the build\'s own base is untouched');
  assert.ok(html.indexOf('window.abxTokenData=') < html.indexOf('<script src="app.js">'));
});

test('directory live view: a document with no <head> still gets the global injected first', async () => {
  resetEntryDocumentCache();
  // no <head>, no <html> — the injection prepends
  const bare = await resolveLiveView(client, codeState(), driftToken([pv('seed', 1n)]), okFetch('<script>boot()</script>'));
  const bareHtml = (bare as {html: string}).html;
  assert.ok(bareHtml.startsWith('<base href='), 'prepended when there is nothing to anchor on');
  assert.ok(bareHtml.indexOf('window.abxTokenData=') < bareHtml.indexOf('boot()'));

  resetEntryDocumentCache();
  // <html> but no <head> — inject right after the <html …> tag
  const v = await resolveLiveView(client, codeState(), driftToken([pv('seed', 1n)]), okFetch('<html lang="en"><body><script>boot()</script></body></html>'));
  const html = (v as {html: string}).html;
  assert.ok(html.startsWith('<html lang="en"><base href='), 'injected immediately after <html>');
  assert.ok(html.indexOf('window.abxTokenData=') < html.indexOf('boot()'));
});

test('directory live view: the entry document caches by locator; the injection stays per-request (live tokenData)', async () => {
  resetEntryDocumentCache();
  const calls: string[] = [];
  const f = okFetch('<html><head></head><body></body></html>', calls);
  const state = codeState();
  const first = await resolveLiveView(client, state, driftToken([pv('seed', 1n)]), f);
  const second = await resolveLiveView(client, state, driftToken([pv('seed', 2n)]), f);
  assert.equal(calls.length, 1, 'content-addressed root: one gateway fetch, then cache');
  assert.ok((first as {html: string}).html.includes('1'.padStart(64, '0')), 'first serve carries token 1 seed');
  assert.ok((second as {html: string}).html.includes('2'.padStart(64, '0')), 'second serve carries token 2 seed');
});

test('directory live view: entry fetch failure → 302 ?abx= fallback with FULL tokenData + a warn (never a hard failure)', async () => {
  resetEntryDocumentCache();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  try {
    const v = await resolveLiveView(client, codeState(), driftToken([pv('seed', 1n)]), failingFetch);
    assert.equal(v?.kind, 'redirect');
    assert.match((v as {location: string}).location, /^https:\/\/ipfs\.io\/ipfs\/QmDir\/index\.html\?abx=/);
    assert.ok(warns.some((w) => w.includes('falling back to the ?abx= redirect')), 'the degrade is loud');
  } finally {
    console.warn = orig;
  }
});

// ── directory serving: the ?abx= redirect (FALLBACK lane) ─────────────────────────
// These target the fallback path EXPLICITLY (dead gateway) — it must keep the original
// locator semantics. Regression: the Sepolia code-drop live view redirected to a DOUBLE-
// prefixed `https://arweave.net/https://arweave.net/<txid>/index.html` — the deploy stored
// the `code` locator as a full gateway URL, and the resolver prefixed the arweave gateway
// again. The resolver must serve an already-absolute locator verbatim (repairs the immutable
// on-chain contract), and a bare txid/CID must still get exactly one gateway prefix.
const liveView = (rep: string, value: string) =>
  quiet(() =>
    resolveLiveView(client, codeState({collectionFields: [{field: 'code', representation: rep, value: stringToHex(value)}]} as never), driftToken([pv('seed', 1n)]), failingFetch),
  );

test('code locator (fallback): an absolute URL is served verbatim (no double gateway prefix)', async () => {
  const v = await liveView('arweave', 'https://arweave.net/mQEHtxid');
  assert.equal(v?.kind, 'redirect');
  const loc = (v as {location: string}).location;
  assert.match(loc, /^https:\/\/arweave\.net\/mQEHtxid\/index\.html\?abx=/);
  assert.doesNotMatch(loc, /arweave\.net\/https/); // never re-prefixed
});

test('code locator (fallback): a bare arweave txid gets exactly one gateway prefix', async () => {
  const v = await liveView('arweave', 'mQEHtxid');
  assert.match((v as {location: string}).location, /^https:\/\/arweave\.net\/mQEHtxid\/index\.html\?abx=/);
});

test('code locator (fallback): a bare ipfs CID gets exactly one /ipfs/ prefix', async () => {
  const v = await liveView('ipfs', 'QmDir');
  assert.match((v as {location: string}).location, /^https:\/\/ipfs\.io\/ipfs\/QmDir\/index\.html\?abx=/);
});

// The render-artifact locator bridge: a runner publishes a durable locator; the /image route resolves
// it to a fetchable URL at serve time (absolute = verbatim). Since v11 the gateway comes from the
// project first — the collection's `abx_gateway_*` field — with env as the floor beneath it.
const noGateways = {collectionFields: []} as unknown as Parameters<typeof resolveLocatorUrl>[0];

function statedGateway(prefix: string): Parameters<typeof resolveLocatorUrl>[0] {
  return {
    collectionFields: [{field: 'abx_gateway_ipfs', representation: 'inline', value: stringToHex(prefix)}],
  } as unknown as Parameters<typeof resolveLocatorUrl>[0];
}

test('resolveLocatorUrl: ipfs://, ar://, and an absolute URL (never re-prefixed)', () => {
  const prevIpfs = process.env.ABX_IPFS_GATEWAY;
  const prevAr = process.env.ABX_ARWEAVE_GATEWAY;
  delete process.env.ABX_IPFS_GATEWAY;
  delete process.env.ABX_ARWEAVE_GATEWAY;
  try {
    assert.equal(resolveLocatorUrl(noGateways, 'ipfs://QmCid'), 'https://ipfs.io/ipfs/QmCid');
    assert.equal(resolveLocatorUrl(noGateways, 'ar://txid123'), 'https://arweave.net/txid123');
    assert.equal(resolveLocatorUrl(noGateways, 'https://cdn.example.com/a/0.png'), 'https://cdn.example.com/a/0.png');
    assert.doesNotMatch(resolveLocatorUrl(noGateways, 'https://arweave.net/txid'), /arweave\.net\/https/);
  } finally {
    if (prevIpfs === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prevIpfs;
    if (prevAr === undefined) delete process.env.ABX_ARWEAVE_GATEWAY;
    else process.env.ABX_ARWEAVE_GATEWAY = prevAr;
  }
});

test('resolveLocatorUrl: env is a FLOOR — it fills a silence, never overrides the project', () => {
  const prev = process.env.ABX_IPFS_GATEWAY;
  process.env.ABX_IPFS_GATEWAY = 'https://my.gw/';
  try {
    // no on-chain preference → this host's gateway is better than ipfs.io
    assert.equal(resolveLocatorUrl(noGateways, 'ipfs://QmCid'), 'https://my.gw/ipfs/QmCid');
    // the project stated one → every conforming resolver must serve THAT, host config or not
    assert.equal(
      resolveLocatorUrl(statedGateway('https://stated.example/ipfs/'), 'ipfs://QmCid'),
      'https://stated.example/ipfs/QmCid',
    );
  } finally {
    if (prev === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prev;
  }
});

// The base-URL guard: a `.example` host is a scaffold leftover (reserved TLD) and is refused
// everywhere; a localhost base is fine for a local `abx serve` (dev) but refused in a hosted image
// (ABX_HOSTED=1), where it means the public URL was never set — a loud fail beats dead image links.
test('assertServableBaseUrl: refuses .example always; localhost only when hosted', () => {
  const prev = process.env.ABX_HOSTED;
  try {
    delete process.env.ABX_HOSTED;
    assert.throws(() => assertServableBaseUrl('https://abx-resolver.example'), /placeholder/);
    assert.doesNotThrow(() => assertServableBaseUrl('http://localhost:8787')); // local dev serve — fine
    assert.doesNotThrow(() => assertServableBaseUrl('https://drift.fly.dev'));

    process.env.ABX_HOSTED = '1';
    assert.throws(() => assertServableBaseUrl('http://localhost:8787'), /no public ABX_PUBLIC_BASE_URL/);
    assert.throws(() => assertServableBaseUrl('https://abx-resolver.example'), /placeholder/);
    assert.doesNotThrow(() => assertServableBaseUrl('https://drift.fly.dev'));
  } finally {
    if (prev === undefined) delete process.env.ABX_HOSTED;
    else process.env.ABX_HOSTED = prev;
  }
});

// ── the live view's three-way verdict ─────────────────────────────────────────
// `/a/` used to answer one confident 404 ("not a code project") for every reason resolveLiveView
// returned null — including "the code hasn't been folded into the projection yet", which is a
// statement about the INDEX, not the contract. The response must distinguish a retryable indexing
// state from a contract-type mismatch.

test('liveViewAvailability: a template project mid-index is retry-able, not "not a code project"', () => {
  // chunkCount is a HEAD READ — null until it resolves, which isCodeProject reads as zero. But
  // contractType is folded from the deployed extensions, so it already knows this is a code project.
  const midIndex = codeState({
    collectionFields: [], // no `code` field: template mode
    contractType: 'code',
    script: {chunkCount: null, locked: false, digest: null},
  } as never);
  assert.equal(liveViewAvailability(midIndex), 'indexing');
});

test('liveViewAvailability: chunks folded in ⇒ ready', () => {
  const ready = codeState({
    collectionFields: [],
    contractType: 'code',
    script: {chunkCount: 3, locked: false, digest: null},
  } as never);
  assert.equal(liveViewAvailability(ready), 'ready');
});

test('liveViewAvailability: a directory-mode code field is ready with no chunks at all', () => {
  assert.equal(liveViewAvailability(codeState({contractType: 'code'} as never)), 'ready');
});

test('liveViewAvailability: a genuinely non-code contract stays a terminal no', () => {
  for (const contractType of ['series', '1of1', undefined]) {
    // `undefined` = the fold never saw a deploy block. Still terminal: there is no positive
    // evidence to retry on, so promising a retry would be its own lie.
    assert.equal(liveViewAvailability(codeState({collectionFields: [], contractType} as never)), 'not-a-code-project');
  }
});

// ── the two verdicts the code-contract branch used to get wrong ───────────────
// The test above pins "mid-index is retry-able". Its mirror image was never pinned, and was wrong:
// a code CONTRACT with no executable content is EITHER mid-index OR renderer-only, and the branch
// answered `indexing` for both. `chunkCount` is a head read, so `0` is the chain saying there is
// nothing to wait for — distinct from `null`, which is nobody having asked yet.

test('liveViewAvailability: a RENDERER-ONLY code project is terminal, not "indexing" forever', () => {
  // `deploy-code --image-renderer 0x.. --onchain-uri` with no --script: image + traits are computed
  // in Solidity and there is no program, ever. Answering 503 + Retry-After here told a caller to keep
  // waiting for content that does not exist.
  const rendererOnly = codeState({
    collectionFields: [],
    contractType: 'code',
    script: {chunkCount: 0, locked: false, digest: null}, // head read succeeded: zero chunks
  } as never);
  assert.equal(liveViewAvailability(rendererOnly), 'not-a-code-project');
});

test('liveViewAvailability: an EditionCode mid-index is retry-able too — `edition-code` is a code contract', () => {
  // `edition-code` was missing from the contract-type check, so the ERC-1155 twin fell through to the
  // TERMINAL 404 — the exact inverse of the bug the mid-index test above exists to prevent.
  const midIndex = codeState({
    collectionFields: [],
    contractType: 'edition-code',
    script: {chunkCount: null, locked: false, digest: null},
  } as never);
  assert.equal(liveViewAvailability(midIndex), 'indexing');
});

test('liveViewAvailability: a renderer-only EditionCode — the fully on-chain 1155 — is terminal', () => {
  const rendererOnlyEdition = codeState({
    collectionFields: [],
    contractType: 'edition-code',
    script: {chunkCount: 0, locked: false, digest: null},
  } as never);
  assert.equal(liveViewAvailability(rendererOnlyEdition), 'not-a-code-project');
});

test('liveViewAvailability: an EditionCode WITH a folded script is ready', () => {
  const ready = codeState({
    collectionFields: [],
    contractType: 'edition-code',
    script: {chunkCount: 2, locked: false, digest: null},
  } as never);
  assert.equal(liveViewAvailability(ready), 'ready');
});
