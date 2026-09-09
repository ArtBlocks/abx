import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters, stringToHex, type Hex} from 'viem';
import {METADATA_REPRESENTATION as R, type ParamValue, type ProjectState} from '@artblocks/abx-sdk';
import {buildTokenMetadata, buildContractMetadata} from '../src/metadata.js';

// The off-chain resolver twin of AbxMetadataRenderer: url-template substitution + the
// token→collection field fallback must resolve identically to the on-chain renderer.

// url/url-template/inline paths never call the RPC client, so a stub is fine.
const client = {} as never;
const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;
const field = (name: string, representation: string, value: string) => ({field: name, representation, value: stringToHex(value)});
const token = (tokenId: string, fields: ReturnType<typeof field>[] = [], params?: ParamValue[]) =>
  ({tokenId, lifecycle: 'live', owner: null, tokenURI: null, fields, lockedFields: [], params}) as never;
const project = (collectionFields: ReturnType<typeof field>[] = [], over: Partial<ProjectState> = {}) =>
  ({address: ADDR, chainId: 11155111, name: 'Cats', collectionFields, tokens: [], ...over}) as never;

const provOf = (json: Record<string, unknown>, f: string) =>
  (json.abx_provenance as Array<{field: string; source: string; note: string}>).find((p) => p.field === f)!;

test('url-template image substitutes the tokenId', async () => {
  const json = await buildTokenMetadata(client, project(), token('3', [field('image', R.urlTemplate, 'https://arweave.net/M/{id}.png')]), 'http://node', 11155111);
  assert.equal(json.image, 'https://arweave.net/M/3.png');
  assert.equal(provOf(json, 'image').source, 'url-template');
});

test('collection-scope image covers a token via fallback (O(1) directory)', async () => {
  const json = await buildTokenMetadata(client, project([field('image', R.urlTemplate, 'ipfs://DIR/{id}.png')]), token('2', []), 'http://node', 11155111);
  assert.equal(json.image, 'ipfs://DIR/2.png');
  assert.match(provOf(json, 'image').note, /\[collection\]/);
});

test('token-scope image overrides the collection image', async () => {
  const s = project([field('image', R.urlTemplate, 'ipfs://DIR/{id}.png')]);
  const json = await buildTokenMetadata(client, s, token('2', [field('image', R.url, 'https://specific/pic.png')]), 'http://node', 11155111);
  assert.equal(json.image, 'https://specific/pic.png');
  assert.doesNotMatch(provOf(json, 'image').note, /\[collection\]/);
});

test('collection-scope description covers a token', async () => {
  const json = await buildTokenMetadata(client, project([field('description', R.inline, 'Shared across the collection.')]), token('0', []), 'http://node', 11155111);
  assert.equal(json.description, 'Shared across the collection.');
  assert.match(provOf(json, 'description').note, /\[collection\]/);
});

// Authorship + rights: reserved collection fields projected into contractURI (parity with the
// on-chain renderer's v3 contractURI). On-chain-only — set → projected; unset → omitted.
test('contractURI projects creator / display_notes / creator_links / license when set on-chain', async () => {
  const state = project([
    field('creator', R.inline, 'Casey Reas'),
    field('display_notes', R.inline, 'An exploration of signals.'),
    field('creator_links', R.inline, 'https://reas.com'),
    field('license', R.inline, 'CC BY-NC 4.0'),
  ]);
  const json = await buildContractMetadata(client, state, 'http://node', 11155111);
  assert.equal(json.creator, 'Casey Reas');
  assert.equal(json.display_notes, 'An exploration of signals.');
  assert.equal(json.creator_links, 'https://reas.com');
  assert.equal(json.license, 'CC BY-NC 4.0');
  // reserved keys, so they never leak into the artifacts manifest.
  assert.equal(json.artifacts, undefined);
});

test('contractURI omits authorship / license when unset (no boilerplate)', async () => {
  const json = await buildContractMetadata(client, project(), 'http://node', 11155111);
  assert.equal(json.creator, undefined);
  assert.equal(json.display_notes, undefined);
  assert.equal(json.creator_links, undefined);
  assert.equal(json.license, undefined);
});

// Per-token off-chain traits: the Series' resolver-lane traits. A token's own entry defines its
// off-chain traits (fully replacing the collection-scope `attributes` a 1/1 would use); on-chain
// attributes still win per trait_type. Mirrors the 1/1's lane-aware behavior for symmetry.
const attrsOf = (json: Record<string, unknown>) => (json.attributes as Array<{trait_type: string; value: string | number}>) ?? [];

test('per-token off-chain attributes apply to their token', async () => {
  const json = await buildTokenMetadata(client, project(), token('2', []), 'http://node', 11155111, {
    tokenAttributes: {'2': [{trait_type: 'Subject', value: 'Cat'}]},
  });
  assert.deepEqual(attrsOf(json), [{trait_type: 'Subject', value: 'Cat'}]);
  assert.equal(provOf(json, 'attributes').status, 'off-chain');
});

test('a per-token entry wins over the collection-scope attributes; tokens without one fall back to it', async () => {
  const display = {attributes: [{trait_type: 'Rarity', value: 'Common'}], tokenAttributes: {'2': [{trait_type: 'Subject', value: 'Cat'}]}};
  const tokenTwo = await buildTokenMetadata(client, project(), token('2', []), 'http://node', 11155111, display);
  assert.deepEqual(attrsOf(tokenTwo), [{trait_type: 'Subject', value: 'Cat'}]); // its own entry, not Rarity
  const tokenFive = await buildTokenMetadata(client, project(), token('5', []), 'http://node', 11155111, display);
  assert.deepEqual(attrsOf(tokenFive), [{trait_type: 'Rarity', value: 'Common'}]); // falls back to collection-scope
});

test('on-chain attributes win over per-token off-chain (per trait_type)', async () => {
  const onChain = field('attributes', R.inline, JSON.stringify([{trait_type: 'Subject', value: 'OnChainCat'}]));
  const json = await buildTokenMetadata(client, project(), token('2', [onChain]), 'http://node', 11155111, {
    tokenAttributes: {'2': [{trait_type: 'Subject', value: 'OffChainCat'}]},
  });
  assert.deepEqual(attrsOf(json), [{trait_type: 'Subject', value: 'OnChainCat'}]);
  assert.equal(provOf(json, 'attributes').status, 'on-chain');
});

// ── ERC-1155 editions: the metadata ladder is per-id and standard-agnostic ────────
// `buildTokenMetadata` never branches on contractType — image/attributes/provenance resolve off
// the token's fields exactly as a 721 token's do. `supply`/`maxSupply`/`holders` are the
// dashboard/status surfaces' business (control-plane.ts, dashboard.ts), not the served JSON's —
// this pins down that they don't leak in just because the token happens to carry them.
const editionToken = (tokenId: string, fields: ReturnType<typeof field>[] = [], over: Partial<Record<string, unknown>> = {}) =>
  ({
    tokenId,
    lifecycle: 'live',
    owner: null, // editions never carry a single owner
    tokenURI: null,
    fields,
    lockedFields: [],
    supply: '4',
    maxSupply: '20',
    holders: {'0x1111111111111111111111111111111111111111': '4'},
    ...over,
  }) as never;

test('an edition-shaped token resolves image + attributes identically to a 721 token (per-id, standard-agnostic)', async () => {
  const state = project([field('image', R.urlTemplate, 'ipfs://DIR/{id}.png')], {contractType: 'edition', maxInvocations: '50'});
  const tok = editionToken('7');
  const json = await buildTokenMetadata(client, state, tok, 'http://node', 11155111, {
    tokenAttributes: {'7': [{trait_type: 'Subject', value: 'Cat'}]},
  });
  assert.equal(json.image, 'ipfs://DIR/7.png');
  assert.match(provOf(json, 'image').note, /\[collection\]/);
  assert.deepEqual(attrsOf(json), [{trait_type: 'Subject', value: 'Cat'}]);
  assert.equal(provOf(json, 'attributes').status, 'off-chain');
  // the served JSON is the tokenURI/uri target, not the dashboard — supply/holders stay out of it
  assert.equal('supply' in json, false);
  assert.equal('holders' in json, false);
});

test('on-chain attributes win over per-token off-chain on an edition token too (the same rule, same code path)', async () => {
  const onChain = field('attributes', R.inline, JSON.stringify([{trait_type: 'Subject', value: 'OnChainCat'}]));
  const json = await buildTokenMetadata(client, project(), editionToken('2', [onChain]), 'http://node', 11155111, {
    tokenAttributes: {'2': [{trait_type: 'Subject', value: 'OffChainCat'}]},
  });
  assert.deepEqual(attrsOf(json), [{trait_type: 'Subject', value: 'OnChainCat'}]);
  assert.equal(provOf(json, 'attributes').status, 'on-chain');
});

// ── params reach `tokenData`, never the document ───────────────────────────────────
// `abx_params` was removed from BOTH planes at renderer spec v8 (see the spec's "Params are NOT in
// tokenURI"), so the only param-shaped helper left here is the one that feeds a token's `seed` into
// a metadata build. The rest of this block — a `dataClient` RPC stub, a schema factory, a
// hash-backed param, and a `paramsOf(json) => json.abx_params` reader — outlived the assertions it
// served and was deleted; dead scaffolding would read like evidence the key still exists.

const b32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;

/** A literal param, exactly as evented: a bigint rides right-aligned, a string left-aligned
 *  (the on-chain `bytes32("warm")` form). */
const pv = (key: string, value: bigint | string): ParamValue => ({
  key,
  value: typeof value === 'bigint' ? b32(value) : stringToHex(value, {size: 32}),
  valueIsHash: false,
  updatedBy: ADDR,
});

// ── animation_url is a ROUTE off chain ────────────────────────────────────────────
// On-chain CONTENT is the document, and off chain it is served from this node — exactly as `image`
// always has been, through the same kind of route. It is NOT inlined as a `data:` URI here; that is
// the on-chain plane's form, because a contract has no URL space to offer.
//
// These three assertions used to cite `AbxMetadataRenderer.t.sol` as their parity source and pin the
// `data:` wrap. That parity claim was wrong for this key in the same way it is wrong for `image`: the
// on-chain renderer governs the note, the status and the declared type, but not the off-chain VALUE of
// a URI-valued field. Inlining cost the document twice over, since the value is repeated verbatim into
// the `artifacts` listing — and a code project's `animation_url` was already a route (the live view),
// so the wrap was the exception, not the rule. `animation-route.test.ts` proves the link is live.
//
// Locator representations (url / url-template), a computed `text/uri-list`, and the derived live view
// are untouched: those are already URIs, and re-hosting them would hide them.

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** The data-plane route this node serves a field's bytes at (`data-plane.md` → Serving). */
const dataRoute = (field: string, tokenId = '0') => `http://node/t/11155111/${ADDR}/${tokenId}/data/${field}`;

test('an inline animation_url is served from this node’s route, and the document appears nowhere in the JSON', async () => {
  const doc = '<html><body>hi</body></html>';
  const fields = [field('animation_url', R.inline, doc), field('description', R.inline, 'A study in light.')];
  const json = await buildTokenMetadata(client, project(), token('0', fields), 'http://node', 11155111);
  assert.equal(json.animation_url, dataRoute('animation_url'));
  assert.equal(provOf(json, 'animation_url').source, 'inline'); // where the bytes LIVE is unchanged
  assert.equal(json.description, 'A study in light.'); // a plain text field still carries its text
  // The listing points at the same route. It used to repeat the whole payload, so the bytes shipped
  // twice in one document; `b64` survives only to prove they now ship zero times.
  assert.deepEqual(json.artifacts, [{key: 'animation_url', mimeType: 'text/html', uri: dataRoute('animation_url')}]);
  assert.ok(!JSON.stringify(json).includes(b64(doc)), 'the document must not be inlined anywhere');
});

test('a reader animation_url takes the same route (chunked bytes, one link)', async () => {
  const doc = '<html><body>read</body></html>';
  const readerClient = {readContract: async () => stringToHex(doc)} as never;
  const value = encodeAbiParameters([{type: 'address'}, {type: 'address'}], [ADDR, ADDR]);
  const entry = {field: 'animation_url', representation: R.reader, value} as never;
  const json = await buildTokenMetadata(readerClient, project(), token('0', [entry]), 'http://node', 11155111);
  assert.equal(json.animation_url, dataRoute('animation_url'));
  assert.equal(provOf(json, 'animation_url').source, 'reader');
  assert.ok(!JSON.stringify(json).includes(b64(doc)));
});

test('a url animation_url passes through verbatim (a locator is not a document)', async () => {
  const json = await buildTokenMetadata(client, project(), token('0', [field('animation_url', R.url, 'https://host/loop.mp4')]), 'http://node', 11155111);
  assert.equal(json.animation_url, 'https://host/loop.mp4');
  assert.equal(provOf(json, 'animation_url').source, 'url');
});

test('the derived live view is unaffected by the wrap (an off-chain enrichment, not a field)', async () => {
  const state = project([field('code', R.ipfs, 'QmDir')]);
  const json = await buildTokenMetadata(client, state, token('0', [], [pv('seed', 1n)]), 'http://node', 11155111);
  assert.equal(json.animation_url, `http://node/a/11155111/${ADDR}/0`);
  assert.equal(provOf(json, 'animation_url').source, 'live-view');
});

// ── the `renderer` representation on a TEXT field ─────────────────────────────
// `resolveImage` always had an R.renderer branch; `resolveText` did not, so every
// renderer-computed TEXT field resolved as if UNSET — silently replaced by the operator's
// off-chain value (with provenance claiming `off-chain`) or omitted entirely. The shape below
// mirrors AbxMetadataRenderer._appendText's R_RENDERER arm,
// because with tokenURIRenderer set the chain assembles this JSON and we merely re-serve it.

/** A `renderer` field: the value is abi.encode(address fieldRenderer). */
const rendererField = (name: string) => ({field: name, representation: R.renderer, value: encodeAbiParameters([{type: 'address'}], [ADDR])}) as never;
/** A client whose field-renderer eth_call returns (contentType, bytes). */
const rendererClient = (contentType: string, body: string) =>
  ({readContract: async () => [contentType, stringToHex(body)]}) as never;

test('a renderer-computed description carries the computed bytes as its value', async () => {
  const json = await buildTokenMetadata(
    rendererClient('text/plain', 'Computed from chain state at read.'),
    project(),
    token('0', [rendererField('description')]),
    'http://node',
    11155111,
  );
  assert.equal(json.description, 'Computed from chain state at read.');
  assert.equal(provOf(json, 'description').source, 'renderer');
  assert.match(provOf(json, 'description').note, /computed on chain/);
});

// One representation, one note — across every path that can produce it.
//
// `sourceNote` mirrors the DEPLOYED renderer's `_sourceNote` verbatim, which is what makes the two
// planes describe the same route in the same words. Three separate code paths built the `renderer`
// provenance by hand instead of calling it, and two of them had drifted to a longer wording the
// on-chain renderer cannot emit: a text field went through `sourceNote`, the same field listed as a
// plane artifact said something else, and `image` said the same something else again. Nothing caught
// it because no test asserted the note and the values were all plausible.
const RENDERER_NOTE = 'computed on chain (field renderer)'; // = AbxMetadataRenderer._sourceNote(R_RENDERER)

test('every path that resolves a `renderer` field emits the on-chain renderer’s own note', async () => {
  const c = rendererClient('text/plain', 'computed');
  const textJson = await buildTokenMetadata(c, project(), token('0', [rendererField('description')]), 'http://node', 11155111);
  assert.equal(provOf(textJson, 'description').note, RENDERER_NOTE, 'text field (resolveText)');

  // `image`: the served VALUE is this node's route (the one documented resolver-endpoint exception),
  // but the route the bytes took is the same, so the note must be too.
  const imageJson = await buildTokenMetadata(c, project(), token('0', [rendererField('image')]), 'http://node', 11155111);
  assert.equal(provOf(imageJson, 'image').note, RENDERER_NOTE, 'image (resolveImage)');

  // A non-reserved field lands in the `artifacts` manifest and carries its own provenance row.
  const artifactJson = await buildTokenMetadata(c, project(), token('0', [rendererField('diagram')]), 'http://node', 11155111);
  assert.equal(provOf(artifactJson, 'diagram').note, RENDERER_NOTE, 'plane artifact (artifactFieldProv)');
});

test('a renderer-computed description WINS over the operator off-chain value (it no longer resolves as unset)', async () => {
  const json = await buildTokenMetadata(
    rendererClient('text/plain', 'the on-chain one'),
    project(),
    token('0', [rendererField('description')]),
    'http://node',
    11155111,
    {description: 'the operator off-chain one'},
  );
  assert.equal(json.description, 'the on-chain one');
  assert.equal(provOf(json, 'description').source, 'renderer');
});

test('a renderer-computed animation_url routes too, and the DECLARED contentType rides the listing', async () => {
  // The declared type is still honoured — it moved from the `data:` prefix (where it typed the value)
  // to the artifacts entry and the route's own Content-Type. It is never assumed to be HTML.
  const doc = '{"frames":[]}';
  const json = await buildTokenMetadata(
    rendererClient('application/json', doc),
    project(),
    token('0', [rendererField('animation_url')]),
    'http://node',
    11155111,
  );
  assert.equal(json.animation_url, dataRoute('animation_url'));
  assert.equal(provOf(json, 'animation_url').source, 'renderer');
  assert.deepEqual(json.artifacts, [{key: 'animation_url', mimeType: 'application/json', uri: dataRoute('animation_url')}]);
});

test('text/uri-list lands VERBATIM as the locator it is — never data-wrapped (RFC 2483)', async () => {
  const url = 'https://ipfs.io/ipfs/QmDir/index.html?abx=eyJ9';
  const json = await buildTokenMetadata(
    rendererClient('text/uri-list', `${url}\n`),
    project(),
    token('0', [rendererField('animation_url')]),
    'http://node',
    11155111,
  );
  assert.equal(json.animation_url, url); // trimmed, not wrapped
  const prov = provOf(json, 'animation_url');
  assert.equal(prov.source, 'renderer');
  // Provenance reports the ROUTE, not the destination: computed on chain, and the note makes no
  // claim about where `ipfs://` resolves — that is the reader's call, from the value itself.
  assert.match(prov.note, /computed on chain/);
  assert.equal('onChain' in (prov as object), false, 'no un-knowable on-chain boolean');
});

test('a reverting field renderer degrades ONE field and says so — it never takes the token down', async () => {
  const boom = {readContract: async () => { throw new Error('execution reverted'); }} as never;
  const json = await buildTokenMetadata(
    boom,
    project(),
    token('0', [rendererField('description')]),
    'http://node',
    11155111,
    {description: 'operator fallback'},
  );
  assert.equal(json.description, 'operator fallback'); // still served — better than nothing
  assert.match(provOf(json, 'description').note, /field renderer reverted/); // but NOT reported as a clean off-chain value
});

// ── the `name` fallback's provenance ──────────────────────────────────────────
// `state.name` is a HEAD read, so a failed read persists as null and is indistinguishable from a
// contract that genuinely has no name. The fallback then serves the raw address while the note
// still claimed `ERC-721 name()`. A hosted node served "0xb844…c35e56 #0" beside
// note: "on-chain (ERC-721 name() + #id)" while that contract's name() was "ABXdoku".
// Every parity fixture on both sides hardcoded a non-null name, which is why it drifted unseen.
// (The note itself dropped the `ERC-721` qualifier once ERC-1155 editions started exposing
// `name()` too, via the same `CollectionMetadataLib` — it was never 721-specific behavior.)

test('a named contract still reports the name() provenance', async () => {
  const json = await buildTokenMetadata(client, project(), token('0', []), 'http://node', 11155111);
  assert.equal(json.name, 'Cats #0');
  assert.match(provOf(json, 'name').note, /name\(\)/);
});

test('a null name serves the address and does NOT claim name() produced it', async () => {
  const json = await buildTokenMetadata(client, project([], {name: null}), token('0', []), 'http://node', 11155111);
  assert.equal(json.name, `${ADDR} #0`);
  const note = provOf(json, 'name').note;
  assert.match(note, /contract address/);
  assert.match(note, /returned no value/);
  // The whole point: provenance is the surface a creator audits, so it must not assert a read that
  // did not happen. It also must not adjudicate WHY — the projection cannot tell an unnamed
  // contract from a failed head read, and guessing is how the original note came to lie.
  assert.doesNotMatch(note, /on-chain \(name\(\)/);
});

test('the contract surface applies the same rule', async () => {
  const named = await buildContractMetadata(client, project(), 'http://node', 11155111, {});
  assert.match(provOf(named, 'name').note, /name\(\)/);
  const unnamed = await buildContractMetadata(client, project([], {name: null}), 'http://node', 11155111, {});
  assert.equal(unnamed.name, ADDR);
  assert.match(provOf(unnamed, 'name').note, /returned no value/);
});
