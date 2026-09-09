// listTokens' edition (ERC-1155) path: the ERC-165 probe branches into a parallel implementation
// that reads totalSupply(id)/maxSupply(id) instead of ownerOf, leaves `owner` null, and still
// supports params/seed on an EditionCode-shaped fixture. Mirrors tokens.test.ts's fakeClient idiom.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zeroAddress, type Address, type PublicClient} from 'viem';
import {encodeTag, listTokens} from '../src/index.js';

const TOKEN = '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294' as Address;
const SEED = '0xc6e79aedbc886c7dd90b541c7df9b9b37bb67c05e622ea78884574e13d94fbc2' as const;

interface Req {
  functionName: string;
  args?: readonly unknown[];
}

/** Same fake-chain idiom as tokens.test.ts: every read answered from a table; the ERC-165 probe
 *  (`supportsInterface`) is answered `true` here so `listTokens` takes the edition branch. */
function fakeEditionClient(table: Record<string, (args: readonly unknown[]) => unknown>) {
  const calls: string[] = [];
  const client = {
    getChainId: async () => 11155111,
    readContract: async (req: Req) => {
      calls.push(req.functionName);
      if (req.functionName === 'supportsInterface') return true; // ERC-1155: 0xd9b67a26
      const fn = table[req.functionName];
      if (!fn) throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
      const out = fn(req.args ?? []);
      if (out === undefined) throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
      return out;
    },
  } as unknown as PublicClient;
  return {client, calls};
}

test('listTokens: an edition with no maxInvocations (1/1 edition) lists a single id, owner null, no params', async () => {
  const {client} = fakeEditionClient({
    totalSupply: () => 4n,
    maxSupply: () => 0n, // open edition
  });
  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.nextTokenId, null);
  assert.equal(listing.totalSupply, null); // no unconditional whole-contract total on an edition
  assert.equal(listing.hasParams, false);
  assert.deepEqual(listing.tokens, [{tokenId: '0', owner: null, lifecycle: 'live', seed: null, params: {}, supply: '4', maxSupply: '0'}]);
});

test('listTokens: a multi-id edition (EditionImage) reads totalSupply(id)/maxSupply(id) per id, never ownerOf', async () => {
  const {client, calls} = fakeEditionClient({
    maxInvocations: () => 3n,
    totalSupply: (args) => (args[0] === 1n ? 0n : 5n), // id 1 never minted
    maxSupply: (args) => (args[0] === 2n ? 10n : 0n),
  });
  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.maxInvocations, 3);
  assert.deepEqual(listing.tokens.map((t) => t.tokenId), ['0', '1', '2']);
  assert.deepEqual(listing.tokens.map((t) => t.owner), [null, null, null]); // never chain-enumerable
  assert.deepEqual(listing.tokens.map((t) => t.supply), ['5', '0', '5']);
  assert.deepEqual(listing.tokens.map((t) => t.maxSupply), ['0', '0', '10']);
  assert.ok(!calls.includes('ownerOf'), 'the edition path must never call ownerOf');
});

test('listTokens: an EditionCode fixture still decodes params/seed per id (Params extension unchanged)', async () => {
  const uintSchema = [true, 2, 0, zeroAddress, 0, '0x' + '0'.repeat(64), '0x' + 'f'.repeat(64), []];
  const {client} = fakeEditionClient({
    maxInvocations: () => 2n,
    totalSupply: () => 1n,
    maxSupply: () => 0n,
    contractParamKeys: () => [],
    tokenParamKeys: (args) => (args[0] === 0n ? [encodeTag('density')] : []),
    tokenParam: (args) =>
      args[1] === encodeTag('seed')
        ? [SEED, false, true]
        : [`0x${(3n).toString(16).padStart(64, '0')}`, false, true],
    paramSchema: () => uintSchema,
  });
  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.hasParams, true);
  assert.equal(listing.hasParamEnumeration, true);
  assert.equal(listing.tokens[0].seed, SEED);
  assert.deepEqual(listing.tokens[0].params, {density: '3'});
  assert.deepEqual(listing.tokens[1].params, {}); // id 1 has no enumerated keys
});

test('listTokens: --from/--limit windows an edition id range the same way as the 721 path', async () => {
  const read: bigint[] = [];
  const {client} = fakeEditionClient({
    maxInvocations: () => 100n,
    totalSupply: (args) => {
      read.push(args[0] as bigint);
      return 1n;
    },
    maxSupply: () => 0n,
  });
  const listing = await listTokens(client, TOKEN, {from: 10, limit: 3});
  assert.deepEqual(listing.tokens.map((t) => t.tokenId), ['10', '11', '12']);
  assert.deepEqual([...read].sort((a, b) => Number(a - b)), [10n, 11n, 12n]);
});

// ── the 721 path stays untouched: the probe answers false, so listTokens falls through as before

test('listTokens: a 721 contract (supportsInterface(0xd9b67a26) → false) takes the unchanged ownerOf path', async () => {
  const OWNER = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as Address;
  const client = {
    getChainId: async () => 11155111,
    readContract: async (req: Req) => {
      if (req.functionName === 'supportsInterface') return false; // not an edition
      if (req.functionName === 'totalSupply') return 1n;
      if (req.functionName === 'ownerOf') return OWNER;
      throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
    },
  } as unknown as PublicClient;
  const listing = await listTokens(client, TOKEN);
  assert.deepEqual(listing.tokens, [{tokenId: '0', owner: OWNER, lifecycle: 'live', seed: null, params: {}}]);
});
