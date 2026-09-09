// The `artifacts` manifest (site/content/docs/protocol/data-plane.mdx): the COMPLETE listing of a token's data
// plane — creator-set content fields (deliberately including ones already projected into reserved
// keys) plus every producer-registered effect output at the CURRENT settled inputsHash. Entry shape
// is exactly {key, mimeType, uri}; empty → the key is omitted; stale rows go silently unlisted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stringToHex} from 'viem';
import {
  buildTokenData,
  contentDigestOf,
  inputsHash,
  renderArtifactKey,
  type MetadataField,
  type ParamValue,
  type ProjectState,
  type TokenState,
} from '@artblocks/abx-sdk';
import type {StorageBackend, StoredContent} from '@artblocks/abx-storage';
import {buildContractMetadata, buildTokenMetadata, tokenArtifacts, type ArtifactEntry, type PlaneArtifactRow} from '../src/metadata.js';

const client = {} as never; // no reader fields, no augment hook, no data-backed params
const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;

const pv = (key: string, value: bigint): ParamValue => ({
  key,
  value: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
  valueIsHash: false,
  updatedBy: ADDR,
});

const field = (name: string, representation: string, text: string): MetadataField =>
  ({field: name, representation, value: stringToHex(text)}) as never;

function projectState(over: Partial<ProjectState> = {}): ProjectState {
  return {
    address: ADDR,
    chainId: 11155111,
    name: 'Drift',
    collectionFields: [],
    tokens: [],
    paramHooks: null,
    maxInvocations: '8',
    ...over,
  } as never;
}

const tokenState = (fields: MetadataField[] = [], params?: ParamValue[]): TokenState =>
  ({tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields, lockedFields: [], params}) as never;

function memoryStorage(entries: Record<string, StoredContent> = {}): StorageBackend {
  const map = new Map(Object.entries(entries));
  return {
    id: 'memory',
    put: async (h, c) => void map.set(h, c),
    get: async (h) => map.get(h) ?? null,
    has: async (h) => map.has(h),
  };
}

/** The canonical effect-artifact key at the token's CURRENT settled inputsHash. */
async function currentKey(state: ProjectState, token: TokenState, outputKey: string, effectKey = 'render') {
  const {json} = await buildTokenData(null, state, token);
  return renderArtifactKey(state.chainId, state.address, token.tokenId, inputsHash(contentDigestOf(state), json), outputKey, effectKey);
}

const planeOf = (rows: PlaneArtifactRow[]) => ({
  list: () => rows,
  get: (k: string) => rows.find((r) => r.key.toLowerCase() === k.toLowerCase()) ?? null,
});

const entriesOf = (json: Record<string, unknown>) => json.artifacts as ArtifactEntry[] | undefined;

test('complete listing: the projected image field AND every current effect output, deterministic order', async () => {
  const state = projectState({
    collectionFields: [
      field('code', 'ipfs', 'QmDir'),
      field('image', 'ipfs', 'ipfs://QmStill/nft.png'), // projected into `image` — still listed (deliberate duplication)
    ],
  });
  const token = tokenState([], [pv('seed', 1n)]);
  const rows: PlaneArtifactRow[] = [
    {key: await currentKey(state, token, 'model', 'world.rebuild'), effectKey: 'world.rebuild', outputKey: 'model', contentType: 'model/gltf-binary', locator: 'ar://TX'},
    {key: await currentKey(state, token, 'image'), effectKey: 'render', outputKey: 'image', contentType: 'image/png', locator: 'ipfs://QmRender'},
    {key: await currentKey(state, token, 'traits'), effectKey: 'render', outputKey: 'traits', contentType: 'application/json', locator: null},
  ];
  const json = await buildTokenMetadata(client, state, token, 'http://node', 11155111, {}, memoryStorage(), planeOf(rows));
  assert.deepEqual(entriesOf(json), [
    // v11: a content-addressed field lists the SAME gateway-wrapped URL the `image` key carries —
    // a manifest entry and the reserved key it duplicates must never point at two different URLs.
    {key: 'image', mimeType: 'image/png', uri: 'https://ipfs.io/ipfs/QmStill/nft.png'}, // MIME = labeled extension fallback
    // effect-output locators are producer-published rows, wrapped at serve time by the /image
    // redirect rather than in the manifest — the manifest reports what the producer registered.
    {key: 'render/image', mimeType: 'image/png', uri: 'ipfs://QmRender'},
    {key: 'render/traits', mimeType: 'application/json', uri: `http://node/t/11155111/${ADDR}/0/data/render/traits`}, // no locator → the /data route
    {key: 'world.rebuild/model', mimeType: 'model/gltf-binary', uri: 'ar://TX'},
  ]);
  // effect entries carry provenance: honestly-labeled derived bytes
  const prov = json.abx_provenance as Array<{field: string; source: string; status: string}>;
  const model = prov.find((p) => p.field === 'world.rebuild/model')!;
  assert.equal(model.source, 'effect:world.rebuild');
  assert.equal(model.status, 'off-chain');
});

test('stale rows are silently unlisted (a param change re-addresses the plane)', async () => {
  const state = projectState({collectionFields: [field('code', 'ipfs', 'QmDir')]});
  const token = tokenState([], [pv('seed', 1n)]);
  const fresh = {key: await currentKey(state, token, 'image'), effectKey: 'render', outputKey: 'image', contentType: 'image/png', locator: 'ipfs://QmFresh'};
  const changed = tokenState([], [pv('seed', 1n), pv('palette', 2n)]);
  const json = await buildTokenMetadata(client, state, changed, 'http://node', 11155111, {}, memoryStorage(), planeOf([fresh]));
  assert.equal(entriesOf(json), undefined); // the only row is stale → empty manifest → key omitted
});

test('empty plane → no artifacts key (no boilerplate)', async () => {
  const json = await buildTokenMetadata(client, projectState(), tokenState(), 'http://node', 11155111);
  assert.equal(entriesOf(json), undefined);
});

test('mimeType ladder: inline SVG convention, custody contentType, bridged-locator label, octet-stream floor', async () => {
  const svg = field('image', 'inline', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const inlineJson = await buildTokenMetadata(client, projectState(), tokenState([svg]), 'http://node', 11155111);
  assert.equal(entriesOf(inlineJson)![0].mimeType, 'image/svg+xml'); // on-chain image bytes are SVG by convention

  // keccak256 custody: the type declared at upload wins
  const hash = `0x${'ab'.repeat(32)}` as `0x${string}`;
  const anchored: MetadataField = {field: 'image', representation: 'keccak256', value: hash} as never;
  const storage = memoryStorage({[hash]: {bytes: new Uint8Array([1]), contentType: 'image/webp'}});
  const custodyJson = await buildTokenMetadata(client, projectState(), tokenState([anchored]), 'http://node', 11155111, {}, storage);
  assert.equal(entriesOf(custodyJson)![0].mimeType, 'image/webp');

  // keccak256 with only a bridged locator: labeled extension fallback + the durable uri
  const bridged = await buildTokenMetadata(client, projectState(), tokenState([anchored]), 'http://node', 11155111, {
    contentLocators: {[hash]: 'ipfs://QmX/master.png'},
  });
  assert.equal(entriesOf(bridged)![0].mimeType, 'image/png');
  assert.equal(entriesOf(bridged)![0].uri, 'ipfs://QmX/master.png');

  // unknown extension → the honest floor, never omitted
  const opaque = await buildTokenMetadata(client, projectState(), tokenState([field('image', 'url', 'https://host/blob')]), 'http://node', 11155111);
  assert.equal(entriesOf(opaque)![0].mimeType, 'application/octet-stream');
});

test('a non-reserved field is a first-class artifact (key = the field tag), with provenance', async () => {
  const stems = field('stems', 'ipfs', 'ipfs://QmStems/stems.zip');
  const json = await buildTokenMetadata(client, projectState(), tokenState([stems]), 'http://node', 11155111);
  assert.deepEqual(entriesOf(json), [{key: 'stems', mimeType: 'application/zip', uri: 'https://ipfs.io/ipfs/QmStems/stems.zip'}]);
  const prov = json.abx_provenance as Array<{field: string; source: string; status: string}>;
  const row = prov.find((p) => p.field === 'stems')!;
  assert.equal(row.source, 'ipfs');
  assert.equal(row.status, 'on-chain');
});

test('`code` never appears in the manifest; the explicit animation field does', async () => {
  const state = projectState({
    collectionFields: [field('code', 'ipfs', 'QmDir'), field('animation_url', 'url', 'https://host/loop.mp4')],
  });
  const json = await buildTokenMetadata(client, state, tokenState([], [pv('seed', 1n)]), 'http://node', 11155111);
  const keys = (entriesOf(json) ?? []).map((e) => e.key);
  assert.ok(!keys.includes('code'));
  assert.deepEqual(keys, ['animation_url']);
  assert.equal(entriesOf(json)![0].mimeType, 'video/mp4');
});

test('a derived live view is a projection, not an artifact (no animation field → no animation entry)', async () => {
  const state = projectState({collectionFields: [field('code', 'ipfs', 'QmDir')]});
  const json = await buildTokenMetadata(client, state, tokenState([], [pv('seed', 1n)]), 'http://node', 11155111);
  assert.ok(String(json.animation_url).includes('/a/11155111/')); // projected live view
  assert.equal(entriesOf(json), undefined); // …but the plane holds no creator artifact yet
});

test('collection manifest: banner + non-reserved collection fields; url-template stays token-scoped', async () => {
  const state = projectState({
    collectionFields: [
      field('banner_image', 'url', 'https://host/banner.jpg'),
      field('presskit', 'arweave', 'ar://TXKIT'),
      field('image', 'url-template', 'https://cdn/x/{id}.png'), // per-token template → lists on tokens, not here
    ],
  });
  const json = await buildContractMetadata(client, state, 'http://node', 11155111);
  assert.deepEqual(json.artifacts, [
    {key: 'banner_image', mimeType: 'image/jpeg', uri: 'https://host/banner.jpg'},
    {key: 'presskit', mimeType: 'application/octet-stream', uri: 'https://arweave.net/TXKIT'},
  ]);
});

// v10: both reserved collection image keys are top-level on BOTH planes. Before, `featured_image` was
// reserved (so filtered out of the top level) yet still listed in `artifacts` — "reserved but only in
// artifacts", which is neither — and `banner_image` reached the top level only for `url`, silently
// dropping an `inline` or `reader` banner that resolves perfectly well.
test('collection: banner + featured are BOTH top-level, for every chain-reachable representation', async () => {
  const state = projectState({
    collectionFields: [
      field('banner_image', 'inline', 'https://host/banner-from-inline.jpg'),
      field('featured_image', 'url', 'https://host/featured.png'),
    ],
  });
  const json = await buildContractMetadata(client, state, 'http://node', 11155111);
  assert.equal(json.banner_image, 'https://host/banner-from-inline.jpg', 'inline banner must project');
  assert.equal(json.featured_image, 'https://host/featured.png', 'featured must be top-level, not artifacts-only');
});

// `collaborators` was a reserved key neither plane projected — and reserved-ness also kept it OUT of
// the artifacts listing, so setting it did nothing observable anywhere. It is no longer reserved, so it
// behaves like any other creator field: it lists.
test('collection: a collaborators field is now an ordinary creator key that lists in artifacts', async () => {
  const state = projectState({collectionFields: [field('collaborators', 'url', 'https://host/team.json')]});
  const json = await buildContractMetadata(client, state, 'http://node', 11155111);
  assert.deepEqual(json.artifacts, [
    {key: 'collaborators', mimeType: 'application/json', uri: 'https://host/team.json'},
  ]);
  assert.equal(json.collaborators, undefined, 'not promoted to a top-level key — it is not reserved');
});

test('token manifest lists the collection-scope url-template image, substituted for THIS token', async () => {
  const state = projectState({collectionFields: [field('image', 'url-template', 'https://cdn/x/{id}.png')]});
  const json = await buildTokenMetadata(client, state, tokenState(), 'http://node', 11155111);
  assert.deepEqual(entriesOf(json), [{key: 'image', mimeType: 'image/png', uri: 'https://cdn/x/0.png'}]);
});

test('a renderer-represented image declares its mimeType from the field renderer eth_call', async () => {
  // stub client: IAbxFieldRenderer.render → (contentType, bytes)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const rendererClient = {
    readContract: async () => ['image/svg+xml', `0x${Buffer.from(svg, 'utf8').toString('hex')}`],
  } as never;
  const rendererField: MetadataField = {
    field: 'image',
    representation: 'renderer',
    value: `0x${'00'.repeat(12)}${'ab'.repeat(20)}`, // abi.encode(address)
  } as never;
  const json = await buildTokenMetadata(rendererClient, projectState(), tokenState([rendererField]), 'http://node', 11155111);
  const entries = entriesOf(json)!;
  assert.equal(entries[0].key, 'image');
  assert.equal(entries[0].mimeType, 'image/svg+xml'); // declared at the source, via the staticcall twin
  assert.ok(entries[0].uri.endsWith('/image')); // this node serves the computed bytes
  const prov = json.abx_provenance as Array<{field: string; source: string}>;
  assert.equal(prov.find((p) => p.field === 'image')!.source, 'renderer');
});

// `tokenArtifacts` — the direct, typed read behind `abx artifacts`. Unlike
// `buildTokenArtifacts`'s own manifest filter (which silently drops a stale row), this surface
// exists specifically to make current-vs-stale VISIBLE, and to say honestly when it couldn't check
// at all (no plane) rather than reading identically to "checked, found nothing".
test('tokenArtifacts: no resolver (no plane passed) — effects stay empty and explicitly UNCONSULTED', async () => {
  const state = projectState({collectionFields: [field('code', 'ipfs', 'QmDir')]});
  const token = tokenState([], [pv('seed', 1n)]);
  const result = await tokenArtifacts(client, state, token, 'http://node', 11155111, {}, memoryStorage());
  assert.equal(result.planeConsulted, false, 'no plane means the registry was never asked');
  assert.deepEqual(result.effects, []);
  // A code project still has a settled inputsHash regardless of whether anything was asked about
  // it — the hash is a property of the token's own state, not of the plane.
  assert.ok(result.currentInputsHash);
});

test('tokenArtifacts: no artifacts — plane consulted, nothing registered', async () => {
  const state = projectState({collectionFields: [field('code', 'ipfs', 'QmDir')]});
  const token = tokenState([], [pv('seed', 1n)]);
  const result = await tokenArtifacts(client, state, token, 'http://node', 11155111, {}, memoryStorage(), planeOf([]));
  assert.equal(result.planeConsulted, true);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.effects, []);
});

test('tokenArtifacts: current artifacts — a row at the live inputsHash is served AND labeled current', async () => {
  const state = projectState({collectionFields: [field('code', 'ipfs', 'QmDir')]});
  const token = tokenState([], [pv('seed', 1n)]);
  const row: PlaneArtifactRow = {
    key: await currentKey(state, token, 'image'),
    effectKey: 'render',
    outputKey: 'image',
    contentType: 'image/png',
    locator: 'ipfs://QmRender',
  };
  const result = await tokenArtifacts(client, state, token, 'http://node', 11155111, {}, memoryStorage(), planeOf([row]));
  assert.deepEqual(result.entries, [{key: 'render/image', mimeType: 'image/png', uri: 'ipfs://QmRender'}]);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].status, 'current');
  assert.equal(result.effects[0].key, 'render/image');
  assert.equal(result.effects[0].uri, 'ipfs://QmRender');
  assert.ok(result.currentInputsHash, 'a code project reports the settled inputsHash it judged currency against');
});

test('tokenArtifacts: stale artifacts — a param change re-addresses the row; the manifest drops it, this read LABELS it stale', async () => {
  const state = projectState({collectionFields: [field('code', 'ipfs', 'QmDir')]});
  const token = tokenState([], [pv('seed', 1n)]);
  const fresh: PlaneArtifactRow = {
    key: await currentKey(state, token, 'image'),
    effectKey: 'render',
    outputKey: 'image',
    contentType: 'image/png',
    locator: 'ipfs://QmFresh',
  };
  const changed = tokenState([], [pv('seed', 1n), pv('palette', 2n)]); // a param added → re-addresses the row
  const result = await tokenArtifacts(client, state, changed, 'http://node', 11155111, {}, memoryStorage(), planeOf([fresh]));
  assert.deepEqual(result.entries, [], 'silently unlisted from the manifest itself, same as buildTokenArtifacts');
  assert.equal(result.effects.length, 1, 'but still VISIBLE to this read, unlike the manifest');
  assert.equal(result.effects[0].status, 'stale');
  assert.equal(result.effects[0].key, 'render/image');
});
