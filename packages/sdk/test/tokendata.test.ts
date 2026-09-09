// Canonical tokenData assembly + the effect seam primitives: sorted-key serialization,
// schema'd vs schema-less decode, token-wins merge, inputsHash determinism, artifact keys.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTokenData,
  canonicalTokenDataJson,
  contentDigestOf,
  inputsHash,
  isCodeProject,
  renderArtifactKey,
} from '../src/tokendata.js';
import type {ParamValue, ProjectState, TokenState} from '../src/types.js';

const ADDR = '0xAbCd000000000000000000000000000000000001' as `0x${string}`;

function pv(key: string, value: string, valueIsHash = false): ParamValue {
  return {key, value: value as `0x${string}`, valueIsHash, updatedBy: ADDR};
}
const b32 = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

function state(over: Partial<ProjectState> = {}): ProjectState {
  return {
    address: ADDR,
    chainId: 31337,
    abxVersion: 1,
    deployBlock: '1',
    deployTx: '0x00',
    factory: null,
    implementation: null,
    isCanonical: null,
    name: 'Waves',
    symbol: 'WAV',
    owner: null,
    contractURI: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: null,
    collectionFields: [],
    lockedCollectionFields: [],
    extensions: [],
    tokens: [],
    events: [],
    fromBlock: '1',
    toBlock: '2',
    eventCount: 0,
    reconstructedAt: 'now',
    ...over,
  } as ProjectState;
}

const token: TokenState = {
  tokenId: '7',
  lifecycle: 'live',
  owner: null,
  tokenURI: null,
  fields: [],
  lockedFields: [],
  params: [pv('seed', b32(0xabcdn)), pv('palette', b32(0x0e1a40n))],
};

test('tokenData: coordinates + schema decode + token-wins merge, canonically sorted', async () => {
  const s = state({
    contractParams: [pv('palette', b32(0xffffffn)), pv('density', b32(8_500_000_000n))],
    paramSchemas: [
      {key: 'palette', paramType: 'HexColor', auth: 'TokenOwner', authAddress: null, lockAfter: '0', min: '0x0', max: '0x0', selectOptions: []},
      {key: 'density', paramType: 'DecimalRange', auth: 'TokenOwner', authAddress: null, lockAfter: '0', min: '0x0', max: '0x0', selectOptions: []},
    ],
    paramHooks: null,
  });
  const {data, json} = await buildTokenData(null, s, token);
  assert.equal(data.chainId, 31337);
  assert.equal(data.contractAddress, ADDR.toLowerCase());
  assert.equal(data.tokenId, '7');
  assert.equal(data.palette, '#0e1a40'); // token scope wins over contract's 0xffffff
  assert.equal(data.density, '0.85'); // DecimalRange ÷ 1e10
  assert.equal(data.seed, b32(0xabcdn)); // schema-less literal = raw bytes32 hex
  assert.equal(json, canonicalTokenDataJson(data));
  assert.deepEqual(Object.keys(JSON.parse(json)), Object.keys(JSON.parse(json)).slice().sort());
});

test('inputsHash is deterministic and re-addresses on any input change', () => {
  const a = inputsHash('0x' + '11'.repeat(32) as `0x${string}`, '{"tokenId":"7"}');
  const b = inputsHash('0x' + '11'.repeat(32) as `0x${string}`, '{"tokenId":"7"}');
  const c = inputsHash('0x' + '11'.repeat(32) as `0x${string}`, '{"tokenId":"8"}');
  const d = inputsHash('0x' + '22'.repeat(32) as `0x${string}`, '{"tokenId":"7"}');
  assert.equal(a, b);
  assert.notEqual(a, c); // param change ⇒ new address (self-invalidating)
  assert.notEqual(a, d); // content change ⇒ new address
});

test('artifact keys are path-deterministic over the hash-keyed custody interface', () => {
  const h = inputsHash(null, '{}');
  const img = renderArtifactKey(1, ADDR, '7', h, 'image');
  assert.equal(img, renderArtifactKey(1, ADDR.toLowerCase() as `0x${string}`, '7', h, 'image')); // case-insensitive address
  assert.notEqual(img, renderArtifactKey(1, ADDR, '7', h, 'traits'));
});

test('code detection: code field or script chunks', () => {
  assert.equal(isCodeProject(state()), false);
  assert.equal(
    isCodeProject(state({collectionFields: [{field: 'code', representation: 'ipfs', value: '0x1234' as `0x${string}`}]})),
    true,
  );
  assert.equal(isCodeProject(state({script: {chunkCount: 2, locked: false}})), true);
  assert.equal(contentDigestOf(state()), null);
  assert.notEqual(contentDigestOf(state({script: {chunkCount: 1, locked: false, digest: ('0x' + 'aa'.repeat(32)) as `0x${string}`}})), null);
});

test('settled vs full: augment-hook live data feeds full tokenData but never the settled form (render addressing)', async () => {
  // A fake client whose augment hook injects a "live" value (think block timestamp / oracle).
  const liveKey = ('0x' + Buffer.from('now').toString('hex').padEnd(64, '0')) as `0x${string}`;
  let reads = 0;
  const fakeClient = {
    readContract: async () => {
      reads += 1;
      return [{key: liveKey, value: String(1000 + reads)}]; // changes every call — maximally volatile
    },
  } as unknown as import('viem').PublicClient;
  const s = state({
    paramHooks: {configureHook: null, augmentHook: ADDR, transferHook: null},
  });

  // FULL (default): the live entry is present, and being volatile it changes per call.
  const full1 = await buildTokenData(fakeClient, s, token);
  const full2 = await buildTokenData(fakeClient, s, token);
  assert.equal(full1.data.now, '1001');
  assert.equal(full2.data.now, '1002');
  assert.notEqual(full1.json, full2.json); // live data churns the full form — fine for the live view

  // SETTLED (augment: false): the hook is never read; the form is stable across calls.
  const readsBefore = reads;
  const settled1 = await buildTokenData(fakeClient, s, token, {augment: false});
  const settled2 = await buildTokenData(fakeClient, s, token, {augment: false});
  assert.equal(reads, readsBefore); // zero live reads
  assert.equal(settled1.data.now, undefined);
  assert.equal(settled1.json, settled2.json);

  // Which is the whole point: the render address (inputsHash over SETTLED) stays hot under
  // volatile live data, while the full form (what the live view injects) stays current.
  const h1 = inputsHash(null, settled1.json);
  const h2 = inputsHash(null, settled2.json);
  assert.equal(h1, h2);
  assert.notEqual(inputsHash(null, full1.json), inputsHash(null, full2.json));
});
