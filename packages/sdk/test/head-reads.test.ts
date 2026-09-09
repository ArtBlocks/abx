import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PublicClient} from 'viem';
import {multicallChunked, reconstructIncremental} from '../src/reconstruct.js';
import type {ProjectState, SpineEvent} from '../src/types.js';

/**
 * A multicall is ONE `eth_call`. If the aggregate exceeds the node's gas or response budget, the
 * WHOLE batch fails and every leg reports failure — including legs that answer fine alone. So
 * batching a cheap read beside an expensive one converts the expensive one's cost into the cheap
 * one's failure, and nothing in the results distinguishes that from "the call reverted".
 *
 * This is not hypothetical. `applyHeadReads` batched `name`/`symbol`/`contractURI`/`isAbxClone`/
 * `tokenURIRenderer` together with one `tokenURI` per token — and on the flagship on-chain lane
 * `tokenURI(id)` assembles the whole metadata document on-chain, tens of KB each. Measured against
 * Base Sepolia `0xB844F4D2137a8Ce785Cbc80D281A36DBD1c35E56` (a 32-token chain-complete project):
 * 0 or 1 tokenURI legs → every leg succeeded; **4 legs → 0 of 8 succeeded**, while `name()` on its
 * own returned `"ABXdoku"`. A resolver therefore believed that collection had no name, no symbol,
 * no canonical proof, and — worst — **no `tokenURIRenderer`, i.e. was not in the on-chain-URI lane
 * at all.**
 */

/** A node that refuses any aggregate wider than `cap` legs — the real failure mode, where the
 *  batch dies whole rather than per-leg. `readContract` always works here (this node has no
 *  multicall3 problem, only an over-budget-aggregate one), so it stands in for the fallback path
 *  the retry now goes through. */
function cappedClient(cap: number, answers: (fn: string, i: number) => unknown) {
  let aggregates = 0;
  const client = {
    multicall: async ({contracts}: {contracts: Array<{functionName: string}>}) => {
      aggregates++;
      if (contracts.length > cap) throw new Error('out of gas');
      return contracts.map((c, i) => ({status: 'success' as const, result: answers(c.functionName, i)}));
    },
    readContract: async ({functionName}: {functionName: string}) => {
      const result = answers(functionName, 0);
      if (result === null) throw new Error('execution reverted');
      return result;
    },
  } as unknown as PublicClient;
  return {client, aggregates: () => aggregates};
}

const legs = (...fns: string[]) => fns.map((functionName) => ({functionName}));

test('an over-budget chunk is re-asked one leg at a time, so nothing is falsely reported as unreadable', async () => {
  // cap 1: any batch of 2+ dies whole. Every value must still come back.
  const {client} = cappedClient(1, (fn) => `${fn}-value`);
  const out = await multicallChunked(client, legs('name', 'symbol', 'contractURI', 'tokenURI'), 4);
  assert.deepEqual(out, ['name-value', 'symbol-value', 'contractURI-value', 'tokenURI-value']);
});

test('a leg that genuinely cannot be read is null — and does not drag its batch-mates down', async () => {
  const {client} = cappedClient(8, (fn) => (fn === 'tokenURI' ? null : `${fn}-value`));
  const out = await multicallChunked(client, legs('name', 'tokenURI', 'symbol'), 8);
  assert.deepEqual(out, ['name-value', null, 'symbol-value']);
});

test('the happy path stays ONE aggregate — the retry is a fallback, not the normal cost', async () => {
  const {client, aggregates} = cappedClient(100, (fn) => `${fn}-value`);
  await multicallChunked(client, legs('name', 'symbol', 'owner', 'tokenURIRenderer'), 4);
  assert.equal(aggregates(), 1);
});

test('chunking splits by the requested width', async () => {
  const {client, aggregates} = cappedClient(100, (fn, i) => `${fn}:${i}`);
  const out = await multicallChunked(client, legs('a', 'b', 'c', 'd', 'e'), 2);
  assert.equal(aggregates(), 3); // 2 + 2 + 1
  // Index mapping must survive chunking — the whole state fold is positional, so an off-by-one here
  // would silently assign one field's value to another.
  assert.deepEqual(out, ['a:0', 'b:1', 'c:0', 'd:1', 'e:0']);
});

test('an RPC with neither multicall nor single reads degrades to all-null rather than rejecting', async () => {
  // Models a fully dead node: no `multicall`, and (implicitly, via the mock's missing method) no
  // fallback either. Both call shapes fail, so all-null is the honest answer.
  const client = {multicall: async () => { throw new Error('node down'); }} as unknown as PublicClient;
  const out = await multicallChunked(client, legs('name', 'symbol'), 2);
  assert.deepEqual(out, [null, null]); // a reconstruct must survive a dead RPC for head reads
});

test('no multicall3 on this chain: the aggregate always throws, but readContract answers fine — the retry must recover, not repeat the same failing call', async () => {
  // This is the reported degradation: a chain with no multicall3 deployment fails EVERY multicall,
  // including a single-leg one, so re-asking via multicall again just reproduces the same failure
  // and callers can't tell "nothing answered" from "no multicall3 here". The retry must go through
  // a call shape that doesn't depend on multicall3 at all.
  let reads = 0;
  const client = {
    multicall: async () => {
      throw new Error('no multicall3 contract deployed on this chain');
    },
    readContract: async ({functionName}: {functionName: string}) => {
      reads++;
      return `${functionName}-value`;
    },
  } as unknown as PublicClient;
  const out = await multicallChunked(client, legs('name', 'symbol', 'contractURI', 'tokenURI'), 4);
  assert.deepEqual(out, ['name-value', 'symbol-value', 'contractURI-value', 'tokenURI-value']);
  assert.equal(reads, 4); // every leg recovered through a direct read, not a retried aggregate
});

test('a lone leg in a width-1 chunk still falls back to readContract — no multicall3 doesn\'t spare it just because it was never batched', async () => {
  // Chunking can land a single leg on its own (e.g. the last chunk of an odd-length list). That leg
  // is exactly as exposed to "no multicall3 on this chain" as any multi-leg chunk, so the retry must
  // not skip it just because there was nothing to batch it with.
  let reads = 0;
  const client = {
    multicall: async () => {
      throw new Error('no multicall3 contract deployed on this chain');
    },
    readContract: async ({functionName}: {functionName: string}) => {
      reads++;
      return `${functionName}-value`;
    },
  } as unknown as PublicClient;
  const out = await multicallChunked(client, legs('tokenURI'), 1);
  assert.deepEqual(out, ['tokenURI-value']);
  assert.equal(reads, 1);
});

test('a leg that genuinely reverts still yields null through the readContract fallback, not a thrown rejection', async () => {
  // `readContract` throws on revert where multicall's `allowFailure` would have returned a
  // `status: 'failure'` result instead. The fallback must swallow that per-leg throw back into
  // `null` so the allowFailure contract holds regardless of which call shape actually answered.
  const client = {
    multicall: async () => {
      throw new Error('no multicall3 contract deployed on this chain');
    },
    readContract: async ({functionName}: {functionName: string}) => {
      if (functionName === 'tokenURI') throw new Error('execution reverted');
      return `${functionName}-value`;
    },
  } as unknown as PublicClient;
  const out = await multicallChunked(client, legs('name', 'tokenURI', 'symbol'), 4);
  assert.deepEqual(out, ['name-value', null, 'symbol-value']);
});

test('an empty read list makes no calls', async () => {
  const {client, aggregates} = cappedClient(1, () => null);
  assert.deepEqual(await multicallChunked(client, [], 4), []);
  assert.equal(aggregates(), 0);
});

// ── readUriDocuments: the heavy batch is opt-in, off by default ───────────────────
//
// A `contractURI`/`tokenURI` document has no settled value (a renderer can change it with no log at
// all) and, on the on-chain lane, can be hundreds of KB per token — so it's read at head only when a
// caller explicitly asks. Default `false` must mean the ENTIRE heavy leg is never requested, not
// requested-then-discarded: these tests assert on the actual `contracts` handed to `multicall`, not
// just the resulting state, so a regression that fetches-and-drops would still fail here.
const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const ALICE = '0x2222222222222222222222222222222222222222' as const;
const ZERO = '0x0000000000000000000000000000000000000000';

/** One minted token (`Transfer` from the zero address), via `reconstructIncremental`'s no-new-logs
 *  branch (`prior.toBlock` already at the mocked head, so it never calls `getLogs`) — the same
 *  idiom `edition-fold.test.ts`'s `stateFromEvents` uses to drive the full `assembleState` pipeline
 *  without a chain. `multicall` tracks every batch of `functionName`s it was asked for, and answers
 *  `contractURI`/`tokenURI` with recognizable values so a leaked read would be obvious in the result. */
function mockClientTrackingLegs(): {client: PublicClient; legsRequested: () => string[]} {
  const allLegs: string[] = [];
  const client = {
    chain: {id: 11155111},
    transport: {},
    getBlockNumber: async () => 100n,
    multicall: async ({contracts}: {contracts: Array<{functionName: string; args?: readonly unknown[]}>}) => {
      allLegs.push(...contracts.map((c) => c.functionName));
      return contracts.map((c) => {
        if (c.functionName === 'contractURI') return {status: 'success' as const, result: 'CONTRACT-DOCUMENT'};
        if (c.functionName === 'tokenURI') return {status: 'success' as const, result: `TOKEN-DOCUMENT-${c.args?.[0]}`};
        return {status: 'success' as const, result: null};
      });
    },
  } as unknown as PublicClient;
  return {client, legsRequested: () => allLegs};
}

function priorWithOneToken(): ProjectState {
  const mint: SpineEvent = {name: 'Transfer', register: 1, what: 'mint', blockNumber: '1', logIndex: 0, txHash: '0x01' as const, args: {from: ZERO, to: ALICE, tokenId: '0'}};
  return {
    address: CONTRACT,
    chainId: 11155111,
    abxVersion: null,
    deployBlock: null,
    deployTx: null,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: null,
    symbol: null,
    owner: null,
    contractURI: null,
    royalty: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    collectionFields: [],
    lockedCollectionFields: [],
    extensions: [],
    tokens: [],
    events: [mint],
    fromBlock: '1',
    toBlock: '100', // === the mock's head, so reconstructIncremental never calls getLogs
    eventCount: 1,
    reconstructedAt: new Date(0).toISOString(),
  };
}

test('default reconstruct (readUriDocuments unset) leaves contractURI/tokenURI null and never asks for either leg', async () => {
  const {client, legsRequested} = mockClientTrackingLegs();
  const state = await reconstructIncremental(client, priorWithOneToken(), {});
  assert.equal(state.contractURI, null);
  assert.equal(state.tokens.length, 1);
  assert.equal(state.tokens[0]?.tokenURI, null);
  assert.equal(legsRequested().includes('contractURI'), false, 'the heavy batch must not be requested at all, not requested-and-discarded');
  assert.equal(legsRequested().includes('tokenURI'), false);
  // the cheap batch (identity/trust/URI-lane) still runs — this isn't "skip all head reads"
  assert.equal(legsRequested().includes('name'), true);
});

test('readUriDocuments: false is identical to leaving it unset (the explicit form of the default)', async () => {
  const {client, legsRequested} = mockClientTrackingLegs();
  const state = await reconstructIncremental(client, priorWithOneToken(), {readUriDocuments: false});
  assert.equal(state.contractURI, null);
  assert.equal(state.tokens[0]?.tokenURI, null);
  assert.equal(legsRequested().includes('contractURI'), false);
  assert.equal(legsRequested().includes('tokenURI'), false);
});

test('readUriDocuments: true populates both the collection and per-token composed documents', async () => {
  const {client, legsRequested} = mockClientTrackingLegs();
  const state = await reconstructIncremental(client, priorWithOneToken(), {readUriDocuments: true});
  assert.equal(state.contractURI, 'CONTRACT-DOCUMENT');
  assert.equal(state.tokens[0]?.tokenURI, 'TOKEN-DOCUMENT-0');
  assert.equal(legsRequested().includes('contractURI'), true);
  assert.equal(legsRequested().includes('tokenURI'), true);
});
