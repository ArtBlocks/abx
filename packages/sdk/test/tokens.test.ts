import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import {encodeTag, listTokens} from '../src/index.js';

const TOKEN = '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294' as Address;
const OWNER = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as Address;
const SEED = '0xc6e79aedbc886c7dd90b541c7df9b9b37bb67c05e622ea78884574e13d94fbc2' as Hex;

interface Req {
  functionName: string;
  args?: readonly unknown[];
}

/** A fake chain: every read answered from a table, anything unlisted reverts the way a token type
 *  that doesn't compose the extension does. `calls` records the fan-out so a test can assert we
 *  didn't read the same schema once per token. */
function fakeClient(table: Record<string, (args: readonly unknown[]) => unknown>) {
  const calls: string[] = [];
  const client = {
    getChainId: async () => 11155111,
    readContract: async (req: Req) => {
      calls.push(req.functionName);
      const fn = table[req.functionName];
      if (!fn) throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
      const out = fn(req.args ?? []);
      if (out === undefined) throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
      return out;
    },
  } as unknown as PublicClient;
  return {client, calls};
}

/** `paramSchema` returns the raw 8-tuple. A HexColor (type index 5) governed by TokenOwner (auth
 *  index 1), and a Uint256Range (index 2) governed by Creator (index 0). */
const hexColorSchema = [true, 5, 1, zeroAddress, 0, '0x' + '0'.repeat(64), '0x' + 'f'.repeat(64), []];
const uintSchema = [true, 2, 0, zeroAddress, 0, '0x' + '0'.repeat(64), '0x' + 'f'.repeat(64), []];
const noSchema = [false, 0, 0, zeroAddress, 0, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64), []];

// ── the headline: the seed is read BY NAME, never from a key list ──────────────
// `seed` is deliberately excluded from tokenParamKeys (every consumer reads it as a tokenData
// coordinate), so a listing built only from the enumerable keys would silently omit the one value
// this command exists for. This test fails if that regresses.

test('listTokens: the seed reads by name even though it is absent from tokenParamKeys', async () => {
  const {client} = fakeClient({
    nextTokenId: () => 1n,
    totalSupply: () => 1n,
    ownerOf: () => OWNER,
    tokenParamKeys: () => [], // seed is NOT here, by protocol design
    contractParamKeys: () => [],
    tokenParam: (args) => (args[1] === encodeTag('seed') ? [SEED, false, true] : [`0x${'0'.repeat(64)}`, false, false]),
  });

  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.tokens.length, 1);
  assert.equal(listing.tokens[0].seed, SEED);
  assert.equal(listing.tokens[0].owner, OWNER);
  assert.deepEqual(listing.tokens[0].params, {});
  assert.equal(listing.hasParams, true);
  assert.equal(listing.hasParamEnumeration, true);
});

test('listTokens: token-scope params decode per schema; contract-scope listed once, not per row', async () => {
  const {client, calls} = fakeClient({
    nextTokenId: () => 3n,
    totalSupply: () => 3n,
    maxInvocations: () => 3n,
    ownerOf: () => OWNER,
    contractParamKeys: () => [encodeTag('density')],
    contractParam: () => [`0x${(7n).toString(16).padStart(64, '0')}`, false, true],
    tokenParamKeys: () => [encodeTag('palette')],
    tokenParam: (args) =>
      args[1] === encodeTag('seed')
        ? [SEED, false, true]
        : [`0x${(0xff8800).toString(16).padStart(64, '0')}`, false, true],
    paramSchema: (args) =>
      args[0] === encodeTag('palette') ? hexColorSchema : args[0] === encodeTag('density') ? uintSchema : noSchema,
  });

  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.maxInvocations, 3);
  // HexColor decodes to #rrggbb — the canonical string, not the raw bytes32.
  for (const row of listing.tokens) assert.deepEqual(row.params, {palette: '#ff8800'});
  // Contract scope lives on the parent, NOT copied into all 3 rows.
  assert.deepEqual(listing.contractParams, {density: '7'});
  // Each schema is read ONCE PER KEY and shared across every token. Two distinct keys ⇒ 2 reads;
  // without the cache this is 4 (palette on each of 3 tokens + density), and on a 1000-token
  // collection it is 1001 — which is the whole reason the cache exists.
  assert.equal(calls.filter((c) => c === 'paramSchema').length, 2);
});

test('listTokens: an unminted/burned id reports owner null rather than claiming "not minted"', async () => {
  const {client} = fakeClient({
    nextTokenId: () => 2n,
    totalSupply: () => 1n, // one was burned, so ownerOf reverts for one live id
    ownerOf: (args) => (args[0] === 0n ? OWNER : undefined),
    tokenParamKeys: () => [],
    contractParamKeys: () => [],
    tokenParam: () => [SEED, false, true],
  });

  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.tokens.length, 2);
  assert.equal(listing.tokens[0].owner, OWNER);
  assert.equal(listing.tokens[1].owner, null);
});

// ── the token types that have no params at all ────────────────────────────────
// A 1/1 composes neither Params nor a mint frontier. Every params read reverts, and that is a
// correct answer about the contract — not a failure to report.

test('listTokens: a 1/1 (no params, no nextTokenId) lists owners and says so honestly', async () => {
  const {client} = fakeClient({
    totalSupply: () => 1n,
    ownerOf: () => OWNER,
  });

  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.hasParams, false);
  assert.equal(listing.hasParamEnumeration, false);
  assert.equal(listing.nextTokenId, null);
  assert.deepEqual(listing.tokens, [{tokenId: '0', owner: OWNER, lifecycle: 'live', seed: null, params: {}}]);
});

test('listTokens: a legacy project (no enumeration) still reports seeds, and flags the gap', async () => {
  const {client} = fakeClient({
    nextTokenId: () => 1n,
    ownerOf: () => OWNER,
    tokenParam: () => [SEED, false, true], // params exist…
    // …but tokenParamKeys/contractParamKeys are absent (pre-enumeration implementation)
  });

  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.hasParams, true);
  assert.equal(listing.hasParamEnumeration, false);
  assert.equal(listing.tokens[0].seed, SEED);
});

test('listTokens: --from/--limit window the id range without re-reading the whole collection', async () => {
  const read: bigint[] = [];
  const {client} = fakeClient({
    nextTokenId: () => 100n,
    ownerOf: (args) => {
      read.push(args[0] as bigint);
      return OWNER;
    },
    tokenParamKeys: () => [],
    contractParamKeys: () => [],
    tokenParam: () => [SEED, false, true],
  });

  const listing = await listTokens(client, TOKEN, {from: 10, limit: 3});
  assert.deepEqual(listing.tokens.map((t) => t.tokenId), ['10', '11', '12']);
  assert.deepEqual([...read].sort((a, b) => Number(a - b)), [10n, 11n, 12n]);
});

// ── burned, from head reads alone ─────────────────────────────────────────────
// `nextTokenId` is a mint frontier that only ever rises; `ownerOf` starts reverting the moment a
// token is destroyed. So BELOW the frontier, "no owner" is not ambiguous — it is a burn. This lane
// used to report `owner: null` and refuse to say why, on the documented grounds that a past-frontier
// id and a burned id revert identically; inside a listing that only enumerates `0 … nextTokenId-1`
// that reasoning does not apply.

test('listTokens: an id below the mint frontier with no owner is `burned`, and the count is exact', async () => {
  const {client} = fakeClient({
    nextTokenId: () => 3n, // ids 0,1,2 were minted
    totalSupply: () => 2n, // one of them is gone
    ownerOf: (args) => (args[0] === 1n ? undefined : OWNER), // id 1 reverts → destroyed
    tokenParamKeys: () => [],
    contractParamKeys: () => [],
    tokenParam: () => [`0x${'0'.repeat(64)}`, false, false],
  });

  const listing = await listTokens(client, TOKEN);
  assert.deepEqual(
    listing.tokens.map((t) => [t.tokenId, t.lifecycle, t.owner]),
    [
      ['0', 'live', OWNER],
      ['1', 'burned', null],
      ['2', 'live', OWNER],
    ],
  );
  assert.equal(listing.burnedCount, 1); // nextTokenId − totalSupply, both kept by the contract
});

test('listTokens: a 1/1 has no frontier, so a missing owner stays `unknown` — never guessed', async () => {
  // The honest case, and the reason the enum has a fourth member: with no `nextTokenId` there is no
  // evidence either way, and "unminted" and "burned" would both be inventions.
  // No `nextTokenId` and no `totalSupply` — the 1/1 shape, which lists id 0 alone. `ownerOf`
  // reverts, which on this token type is exactly as consistent with "not minted yet" as with "burned".
  const {client} = fakeClient({
    tokenParamKeys: () => [],
    contractParamKeys: () => [],
  });
  const listing = await listTokens(client, TOKEN);
  assert.equal(listing.tokens[0].lifecycle, 'unknown');
  assert.equal(listing.burnedCount, null);
});
