// The off-chain half of renderer spec v11: `ipfs` / `arweave` fields project through the
// collection's preferred gateway.
//
// Every assertion here has a Solidity twin in `contracts/test/AbxMetadataRenderer.t.sol`'s v11
// block, and that is the point of the file. With `tokenURIRenderer` set the CHAIN assembles this
// document and a resolver merely re-serves it, so a difference between the two planes is a resolver
// contradicting the token's own `tokenURI` — the sibling-drift class that produced the
// computed-`image` wrapping bug and the `abx_params` duplication before it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stringToHex} from 'viem';
import type {MetadataField, ProjectState, TokenState} from '@artblocks/abx-sdk';
import {buildContractMetadata, buildTokenMetadata} from '../src/metadata.js';

const client = {} as never;
const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;
const NODE = 'http://node';
const CHAIN = 11155111;

const field = (name: string, representation: string, text: string): MetadataField =>
  ({field: name, representation, value: stringToHex(text)}) as never;

const token = (fields: MetadataField[] = [], tokenId = '0'): TokenState =>
  ({tokenId, lifecycle: 'live', owner: null, tokenURI: null, fields, lockedFields: []}) as never;

const project = (collectionFields: MetadataField[] = []): ProjectState =>
  ({address: ADDR, chainId: CHAIN, name: 'Drift', collectionFields, tokens: [], paramHooks: null, maxInvocations: '8'}) as never;

const build = (state: ProjectState, t: TokenState) => buildTokenMetadata(client, state, t, NODE, CHAIN);

const provOf = (json: Record<string, unknown>, f: string) =>
  (json.abx_provenance as Array<{field: string; source: string; status: string; note: string}>).find((p) => p.field === f)!;

/** Env must not leak between tests — it is the FLOOR, so a stray value changes an unrelated result. */
function withoutEnvGateways<T>(fn: () => T): T {
  const prev = [process.env.ABX_IPFS_GATEWAY, process.env.ABX_ARWEAVE_GATEWAY];
  delete process.env.ABX_IPFS_GATEWAY;
  delete process.env.ABX_ARWEAVE_GATEWAY;
  try {
    return fn();
  } finally {
    if (prev[0] === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prev[0];
    if (prev[1] === undefined) delete process.env.ABX_ARWEAVE_GATEWAY;
    else process.env.ABX_ARWEAVE_GATEWAY = prev[1];
  }
}

test('an ipfs/arweave image is served as https, not as the raw scheme no marketplace resolves', async () => {
  await withoutEnvGateways(async () => {
    const ipfs = await build(project(), token([field('image', 'ipfs', 'bafytestcid')]));
    assert.equal(ipfs.image, 'https://ipfs.io/ipfs/bafytestcid');
    assert.equal(provOf(ipfs, 'image').source, 'ipfs');
    assert.equal(provOf(ipfs, 'image').status, 'on-chain');

    const ar = await build(project(), token([field('image', 'arweave', 'ar://txidtxid')]));
    assert.equal(ar.image, 'https://arweave.net/txidtxid');
    assert.equal(provOf(ar, 'image').source, 'arweave');
  });
});

test('the collection gateway field overrides the floor, per scheme', async () => {
  await withoutEnvGateways(async () => {
    const state = project([
      field('abx_gateway_ipfs', 'inline', 'https://dedicated.mypinata.cloud/ipfs/'),
    ]);
    const ipfs = await build(state, token([field('image', 'ipfs', 'bafytestcid')]));
    assert.equal(ipfs.image, 'https://dedicated.mypinata.cloud/ipfs/bafytestcid');
    // an ipfs preference must not reach an arweave value — that is why there are two fields
    const ar = await build(state, token([field('image', 'arweave', 'txidtxid')]));
    assert.equal(ar.image, 'https://arweave.net/txidtxid');
  });
});

test('env is a FLOOR: it fills a silence and never overrides a stated preference', async () => {
  const prev = process.env.ABX_IPFS_GATEWAY;
  process.env.ABX_IPFS_GATEWAY = 'https://host.example';
  try {
    const silent = await build(project(), token([field('image', 'ipfs', 'bafytestcid')]));
    assert.equal(silent.image, 'https://host.example/ipfs/bafytestcid', 'a host default beats ipfs.io');

    // The determinism rule: two conforming resolvers, same chain, same `image`. A project that
    // stated a preference gets it from EVERY resolver, whatever the operator configured.
    const stated = project([field('abx_gateway_ipfs', 'inline', 'https://stated.example/ipfs/')]);
    const json = await build(stated, token([field('image', 'ipfs', 'bafytestcid')]));
    assert.equal(json.image, 'https://stated.example/ipfs/bafytestcid');
  } finally {
    if (prev === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prev;
  }
});

test('a collection-scope ipfs field addresses a whole pinned directory ({id} substituted)', async () => {
  await withoutEnvGateways(async () => {
    const state = project([field('image', 'ipfs', 'bafydircid/{id}.png')]);
    const json = await build(state, token([], '7'));
    assert.equal(json.image, 'https://ipfs.io/ipfs/bafydircid/7.png');
    assert.match(provOf(json, 'image').note, /\[collection\]$/);
  });
});

test('a value that already names its own host is never double-prefixed', async () => {
  await withoutEnvGateways(async () => {
    const json = await build(project(), token([field('image', 'arweave', 'https://arweave.net/txid')]));
    assert.equal(json.image, 'https://arweave.net/txid');
  });
});

test('a locator that locates nothing falls back rather than emitting a bare gateway prefix', async () => {
  await withoutEnvGateways(async () => {
    const json = await build(project(), token([field('image', 'ipfs', 'ipfs://')]));
    assert.equal(json.image, `${NODE}/t/${CHAIN}/${ADDR}/0/image`, 'the placeholder route, not https://ipfs.io/ipfs/');
    assert.equal(provOf(json, 'image').source, 'placeholder');
  });
});

test('optional text fields wrap too; a scheme-only value omits the key', async () => {
  await withoutEnvGateways(async () => {
    const json = await build(project(), token([field('animation_url', 'ipfs', 'bafyanim/index.html')]));
    assert.equal(json.animation_url, 'https://ipfs.io/ipfs/bafyanim/index.html');
    assert.equal(provOf(json, 'animation_url').source, 'ipfs');

    const empty = await build(project(), token([field('animation_url', 'arweave', 'ar://')]));
    assert.equal(empty.animation_url, undefined);
  });
});

test('contractURI wraps ipfs collection fields and leaves {id} alone (no token on that surface)', async () => {
  await withoutEnvGateways(async () => {
    const state = project([
      field('banner_image', 'ipfs', 'bafybanner'),
      field('featured_image', 'ipfs', 'bafyfeatured/{id}.png'),
    ]);
    const json = await buildContractMetadata(client, state, NODE, CHAIN);
    assert.equal(json.banner_image, 'https://ipfs.io/ipfs/bafybanner');
    assert.equal(json.featured_image, 'https://ipfs.io/ipfs/bafyfeatured/{id}.png');
  });
});

test('the gateway keys are a serving preference: they appear in NEITHER document, nor in artifacts', async () => {
  await withoutEnvGateways(async () => {
    const state = project([
      field('abx_gateway_ipfs', 'inline', 'https://dedicated.mypinata.cloud/ipfs/'),
      field('abx_gateway_arweave', 'inline', 'https://ar.example/'),
    ]);
    const tokenJson = JSON.stringify(await build(state, token([field('image', 'ipfs', 'bafytestcid')])));
    const collJson = JSON.stringify(await buildContractMetadata(client, state, NODE, CHAIN));
    assert.doesNotMatch(tokenJson, /abx_gateway/, 'not a token key and not an artifact');
    assert.doesNotMatch(collJson, /abx_gateway/, 'not a collection key and not an artifact');
    // present only where it belongs: inside the projected URL
    assert.match(tokenJson, /dedicated\.mypinata\.cloud\/ipfs\/bafytestcid/);
  });
});

test('provenance says "served through", never "verified" — the chain holds the locator, not the bytes', async () => {
  await withoutEnvGateways(async () => {
    const json = await build(project(), token([field('image', 'ipfs', 'bafytestcid')]));
    // byte-identical to AbxMetadataRenderer._sourceNote for ipfs/arweave
    assert.equal(
      provOf(json, 'image').note,
      "stored on chain; a content-addressed locator, served through the collection's preferred gateway",
    );
    assert.notEqual(provOf(json, 'image').status, 'verified');
  });
});
