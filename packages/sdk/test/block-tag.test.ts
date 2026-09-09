// Reconstruction can stop at the chain's `safe`/`finalized` block instead of head, so a
// hosted operator can serve state it's confident will never need to be walked back — without
// inventing a lookback-window policy of its own.
//
// Two invariants matter more than the happy path:
//   1. The tag is resolved to a CONCRETE block number BEFORE any `eth_getLogs` scan starts, and
//      that number — never the string `"safe"`/`"finalized"` — is what ends up in `state.toBlock`.
//      A stored watermark that could read back as a tag would silently redefine itself every time
//      the chain's finalized point moved.
//   2. An RPC that can't answer the tag fails LOUDLY (`BlockTagUnavailableError`), never falls back
//      to `latest` silently — a caller who asked for the reorg-safety guarantee must find out the
//      RPC can't honor it, not get a normal-looking reconstruction that scanned past the boundary.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Log, PublicClient} from 'viem';
import {reconstructIncremental, reconstructProject, resolveBlockTag} from '../src/reconstruct.js';
import {BlockTagUnavailableError} from '../src/errors.ts';
import type {ProjectState, SpineEvent} from '../src/types.js';

const CONTRACT = '0x1111111111111111111111111111111111111111' as const;

/** A mock node whose `safe`/`finalized` answers (and chain head) are configured per test, and which
 *  records every `eth_getLogs` call so a test can assert on the EXACT range scanned — the same idiom
 *  `watch-delta.test.ts`'s `trackingClient` uses. Head reads (`multicall`/`readContract`) always
 *  fail, matching `burn-fold.test.ts`'s `stateFromEvents`: these tests are about the scan boundary,
 *  not head-read values. */
function mockClient(opts: {
  head?: bigint;
  safe?: bigint | null;
  finalized?: bigint | null;
  getBlockError?: string;
  logsByRange?: (from: bigint, to: bigint) => Log[];
}): {client: PublicClient; logCalls: () => Array<{from: bigint; to: bigint}>; getBlockCalls: () => string[]} {
  const logCalls: Array<{from: bigint; to: bigint}> = [];
  const getBlockCalls: string[] = [];
  const client = {
    chain: {id: 11155111},
    transport: {},
    getBlockNumber: async () => opts.head ?? 1000n,
    getBlock: async ({blockTag}: {blockTag: string}) => {
      getBlockCalls.push(blockTag);
      if (opts.getBlockError) throw new Error(opts.getBlockError);
      if (blockTag === 'safe') return {number: opts.safe ?? null};
      if (blockTag === 'finalized') return {number: opts.finalized ?? null};
      throw new Error(`mock does not answer blockTag ${blockTag}`);
    },
    getLogs: async (args: {fromBlock: bigint; toBlock: bigint}) => {
      logCalls.push({from: args.fromBlock, to: args.toBlock});
      return opts.logsByRange?.(args.fromBlock, args.toBlock) ?? [];
    },
    multicall: async ({contracts}: {contracts: unknown[]}) =>
      contracts.map(() => ({status: 'failure' as const, error: new Error('not mocked')})),
    readContract: async () => {
      throw new Error('not mocked');
    },
  } as unknown as PublicClient;
  return {client, logCalls: () => logCalls, getBlockCalls: () => getBlockCalls};
}

// ── resolveBlockTag ──────────────────────────────────────────────────────────

test('resolveBlockTag("safe") returns the concrete number the node reports', async () => {
  const {client} = mockClient({safe: 42n});
  assert.equal(await resolveBlockTag(client, 'safe'), 42n);
});

test('resolveBlockTag("finalized") returns the concrete number the node reports', async () => {
  const {client} = mockClient({finalized: 999n});
  assert.equal(await resolveBlockTag(client, 'finalized'), 999n);
});

test('an RPC that rejects the tag throws BlockTagUnavailableError, not a generic crash', async () => {
  const {client} = mockClient({getBlockError: 'the method eth_getBlockByNumber does not exist/is not available'});
  await assert.rejects(
    () => resolveBlockTag(client, 'finalized'),
    (err: unknown) => {
      assert.ok(err instanceof BlockTagUnavailableError, `expected BlockTagUnavailableError, got ${(err as Error)?.name}`);
      assert.equal((err as BlockTagUnavailableError).tag, 'finalized');
      assert.match((err as Error).message, /finalized/);
      assert.match((err as Error).message, /does not exist/); // names the underlying cause, actionable
      return true;
    },
  );
});

test('an RPC that answers the call but with no block number is ALSO unavailable — never coerced to 0n or latest', async () => {
  const {client} = mockClient({safe: null});
  await assert.rejects(() => resolveBlockTag(client, 'safe'), BlockTagUnavailableError);
});

// ── reconstructProject: tag resolved BEFORE scanning, persisted as a number ──

test('reconstructProject("safe") resolves the tag before scanning, scans only up to it, and persists a NUMBER (never the tag) in state.toBlock', async () => {
  const {client, logCalls, getBlockCalls} = mockClient({head: 1000n, safe: 42n});
  const state = await reconstructProject(client, {address: CONTRACT, fromBlock: 1n, toBlock: 'safe'});
  assert.deepEqual(getBlockCalls(), ['safe']); // resolved once, up front
  assert.deepEqual(logCalls(), [{from: 1n, to: 42n}]); // the scan itself stopped at 42, never at head (1000)
  assert.equal(state.toBlock, '42');
  assert.notEqual(state.toBlock, 'safe');
});

test('reconstructProject("finalized") behaves the same way', async () => {
  const {client, logCalls} = mockClient({head: 1000n, finalized: 17n});
  const state = await reconstructProject(client, {address: CONTRACT, fromBlock: 1n, toBlock: 'finalized'});
  assert.deepEqual(logCalls(), [{from: 1n, to: 17n}]);
  assert.equal(state.toBlock, '17');
});

test('reconstructProject default (toBlock unset, and the explicit "latest") is unchanged: chain head via getBlockNumber, getBlock never called', async () => {
  const {client: clientA, logCalls: logCallsA, getBlockCalls: getBlockCallsA} = mockClient({head: 1000n});
  const stateA = await reconstructProject(clientA, {address: CONTRACT, fromBlock: 1n});
  assert.equal(stateA.toBlock, '1000');
  assert.deepEqual(logCallsA(), [{from: 1n, to: 1000n}]);
  assert.deepEqual(getBlockCallsA(), []); // existing callers must be unaffected

  const {client: clientB, getBlockCalls: getBlockCallsB} = mockClient({head: 1000n});
  const stateB = await reconstructProject(clientB, {address: CONTRACT, fromBlock: 1n, toBlock: 'latest'});
  assert.equal(stateB.toBlock, '1000');
  assert.deepEqual(getBlockCallsB(), []);
});

test('an unavailable tag surfaces through reconstructProject as BlockTagUnavailableError — no crash, no silent latest', async () => {
  const {client, logCalls} = mockClient({head: 1000n, getBlockError: 'safe/finalized not supported'});
  await assert.rejects(
    () => reconstructProject(client, {address: CONTRACT, fromBlock: 1n, toBlock: 'safe'}),
    BlockTagUnavailableError,
  );
  assert.deepEqual(logCalls(), []); // must fail BEFORE any getLogs call, not scan then discard
});

// ── reconstructIncremental: resuming from a prior watermark, bounded by the tag ──

function priorState(toBlock: string, events: SpineEvent[]): ProjectState {
  return {
    address: CONTRACT,
    chainId: 11155111,
    abxVersion: 5,
    deployBlock: '1',
    deployTx: ('0x' + '01'.repeat(32)) as `0x${string}`,
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
    events,
    fromBlock: '1',
    toBlock,
    eventCount: events.length,
    reconstructedAt: new Date(0).toISOString(),
  };
}

const deployEvent: SpineEvent = {
  name: 'AbxDeployed',
  register: 2,
  what: '',
  blockNumber: '1',
  logIndex: 0,
  txHash: '0x01' as const,
  args: {abxVersion: '5'},
};

test('reconstructIncremental("finalized") resumes strictly from priorTo + 1, scans only up to the resolved tag, and persists that concrete number', async () => {
  const prior = priorState('50', [deployEvent]);
  const {client, logCalls, getBlockCalls} = mockClient({head: 1000n, finalized: 80n});
  const state = await reconstructIncremental(client, prior, {toBlock: 'finalized'});
  assert.deepEqual(getBlockCalls(), ['finalized']); // resolved once, before the scan
  assert.deepEqual(logCalls(), [{from: 51n, to: 80n}]); // resumes from the watermark, stops at the tag — never head (1000)
  assert.equal(state.toBlock, '80');
  assert.equal(state.eventCount, prior.eventCount); // no new logs in this fixture; the fold itself is covered elsewhere
});

test('reconstructIncremental("safe") that resolves BEHIND the prior watermark scans nothing new and never regresses toBlock', async () => {
  // A prior full reconstruct already advanced past this chain's current "safe" tip (e.g. it ran
  // with the `latest` default). Asking for `safe` now must not walk the stored watermark backwards.
  const prior = priorState('90', [deployEvent]);
  const {client, logCalls} = mockClient({head: 1000n, safe: 60n});
  const state = await reconstructIncremental(client, prior, {toBlock: 'safe'});
  assert.deepEqual(logCalls(), []); // resolved boundary (60) is behind resumeFrom (91) — no scan needed
  assert.equal(state.toBlock, '90'); // clamped at the prior watermark, not walked back to 60
});

test('reconstructIncremental default (toBlock unset) is unchanged: chain head via getBlockNumber, no getBlock call', async () => {
  const prior = priorState('50', [deployEvent]);
  const {client, logCalls, getBlockCalls} = mockClient({head: 1000n});
  const state = await reconstructIncremental(client, prior, {});
  assert.deepEqual(logCalls(), [{from: 51n, to: 1000n}]);
  assert.equal(state.toBlock, '1000');
  assert.deepEqual(getBlockCalls(), []);
});

test('an unavailable tag surfaces through reconstructIncremental as BlockTagUnavailableError — no crash, no silent latest, no getLogs call', async () => {
  const prior = priorState('50', [deployEvent]);
  const {client, logCalls} = mockClient({head: 1000n, getBlockError: 'unsupported block tag'});
  await assert.rejects(() => reconstructIncremental(client, prior, {toBlock: 'safe'}), BlockTagUnavailableError);
  assert.deepEqual(logCalls(), []);
});
