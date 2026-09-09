// An incremental fold that would REDUCE eventCount relative to what's already
// stored must never be written as-is. `reindex()` catches it, discards the bad fold, and repairs
// with exactly one full reconstruct from the deploy block — never a loop.
//
// Unlike lifecycle.test.ts (which stubs `reindex` entirely to test the coalescing layer above it),
// this exercises the REAL `reindex()` — including the real SDK `reconstructIncremental` /
// `reconstructProject` — against a mock `PublicClient`, the same idiom `head-reads.test.ts` uses at
// the SDK layer. `client()` is swapped out (a plain instance method, not a module import, so no
// module-mocking flag is needed) so no network call is ever made.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeEventTopics, getAddress, type Address, type Log, type PublicClient} from 'viem';
import {spineEventAbi, type ProjectState, type SpineEvent} from '@artblocks/abx-sdk';
import {SelfHostIndexer, SqliteStore} from '../src/index.js';

const ADDR = getAddress('0x00085b0ed14297a15a07c9ecd840c3d42815ca40') as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function fresh(): {store: SqliteStore; indexer: SelfHostIndexer; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-eventcount-guard-'));
  const store = new SqliteStore(dir);
  return {store, indexer: new SelfHostIndexer(store), cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

/** A real, viem-decodable `Transfer` log — Solady's ERC-721 event names the id param `id`, not
 *  `tokenId`. All three args are indexed, so `data` is empty. */
function transferLog(blockNumber: bigint, logIndex: number, to: Address, id: bigint): Log {
  const topics = encodeEventTopics({abi: spineEventAbi, eventName: 'Transfer', args: {from: ZERO, to, id}});
  return {
    address: ADDR,
    topics,
    data: '0x',
    blockNumber,
    blockHash: `0x${'aa'.repeat(32)}`,
    transactionHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    logIndex,
    removed: false,
  } as unknown as Log;
}

/** Minimal-but-complete `ProjectState`, matching the type's required fields. */
function baseState(over: Partial<ProjectState> = {}): ProjectState {
  return {
    address: ADDR,
    chainId: 11155111,
    abxVersion: 1,
    deployBlock: '100',
    deployTx: '0xdead' as `0x${string}`,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: 'Test Project',
    symbol: 'TEST',
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
    events: [],
    fromBlock: '90',
    toBlock: '105',
    eventCount: 0,
    reconstructedAt: new Date(0).toISOString(),
    ...over,
  };
}

/** A client that answers `getBlockNumber`/`multicall` generically, and `getLogs` per-call-order —
 *  first call is the incremental attempt's narrow range, second (if it happens) is the full
 *  reconstruct's fallback range from the registration's `fromBlock`. */
function mockClient(logsByCall: Log[][]): {client: PublicClient; getLogsCalls: Array<{fromBlock: bigint; toBlock: bigint}>} {
  const getLogsCalls: Array<{fromBlock: bigint; toBlock: bigint}> = [];
  const client = {
    chain: {id: 11155111},
    getBlockNumber: async () => 200n,
    getLogs: async ({fromBlock, toBlock}: {fromBlock: bigint; toBlock: bigint}) => {
      const idx = getLogsCalls.length;
      getLogsCalls.push({fromBlock, toBlock});
      return logsByCall[idx] ?? [];
    },
    // The cheap fixed-size head-read batch always runs (readUriDocuments is off by default here) —
    // answer every leg successfully with a harmless null so `applyHeadReads` doesn't throw.
    multicall: async ({contracts}: {contracts: Array<unknown>}) =>
      contracts.map(() => ({status: 'success' as const, result: null})),
  } as unknown as PublicClient;
  return {client, getLogsCalls};
}

test('an incremental fold that would REDUCE eventCount is discarded, and exactly one full reconstruct repairs it', async () => {
  const {store, indexer, cleanup} = fresh();
  try {
    indexer.register({address: ADDR, chainKey: 'sepolia', fromBlock: '90', factory: null});

    // Simulate a corrupted/stale stored projection: it CLAIMS 5 events (`eventCount`), but only
    // carries 2 in its `events` array, at the same (block, logIndex) as the first two of the six
    // REAL chain events the mock below serves — so the append-only store's dedupe-by-seq later
    // recognizes them as the same rows rather than phantom ones the real chain never produced. This
    // covers the damaged-projection shape: the stored count and stored log disagree.
    const priorEvents: SpineEvent[] = [
      {name: 'Transfer', register: 1, what: 'mint', blockNumber: '110', logIndex: 0, txHash: '0x01' as `0x${string}`, args: {from: ZERO, to: ADDR, id: '0'}},
      {name: 'Transfer', register: 1, what: 'mint', blockNumber: '111', logIndex: 0, txHash: '0x02' as `0x${string}`, args: {from: ZERO, to: ADDR, id: '1'}},
    ];
    store.putProject(baseState({events: priorEvents, eventCount: 5, deployBlock: '100', toBlock: '111'}));

    // Attempt #1 (incremental, resuming from 112): no new logs — reproduces exactly the 2 stored
    // events, `state.eventCount = 2 < prior.eventCount = 5` ⇒ guard fires.
    // Attempt #2 (the guard's fallback, full replay from the registration's fromBlock=90): the real
    // chain has 6 genuine events (blocks 110–115) — self-heal recovers the true, larger count.
    const fullLogs = [0n, 1n, 2n, 3n, 4n, 5n].map((i) => transferLog(110n + i, 0, ADDR, i));
    const {client, getLogsCalls} = mockClient([[], fullLogs]);
    (indexer as unknown as {client: unknown}).client = () => client;

    const result = await indexer.reindex(ADDR);

    assert.equal(result.mode, 'full', 'the guard escalated to a full reconstruct, not the bad incremental result');
    assert.equal(result.state.eventCount, 6, 'the repaired state carries the recovered (larger, correct) history');
    assert.equal(getLogsCalls.length, 2, 'exactly one fallback — no loop');
    assert.equal(getLogsCalls[0].fromBlock, 112n, 'attempt #1 resumed from the stored checkpoint');
    assert.equal(getLogsCalls[1].fromBlock, 90n, 'attempt #2 replayed from the registration fromBlock, not the checkpoint');

    // The bad (2-event) fold was never persisted as the PROJECT row's count — the repaired,
    // recovered 6-event count was. And the append-only `events` table lands at exactly 6 rows too:
    // the two already-stored rows (blocks 110/111) conflict-skip against the fresh replay's
    // identical (block, logIndex) pair rather than duplicating, so only the four truly-new rows
    // (112–115) get appended.
    const stored = store.getProject(ADDR);
    assert.equal(stored?.eventCount, 6);
    assert.equal(stored?.events.length, 6);
  } finally {
    cleanup();
  }
});

test('an incremental fold that GROWS (or holds) eventCount is written normally — no false-positive fallback', async () => {
  const {store, indexer, cleanup} = fresh();
  try {
    indexer.register({address: ADDR, chainKey: 'sepolia', fromBlock: '90', factory: null});
    const priorEvents: SpineEvent[] = [
      {name: 'Transfer', register: 1, what: 'mint', blockNumber: '101', logIndex: 0, txHash: '0x01' as `0x${string}`, args: {from: ZERO, to: ADDR, id: '0'}},
    ];
    store.putProject(baseState({events: priorEvents, eventCount: 1, toBlock: '105'}));

    // One genuinely new event arrives — the honest case.
    const {client, getLogsCalls} = mockClient([[transferLog(110n, 0, ADDR, 1n)]]);
    (indexer as unknown as {client: unknown}).client = () => client;

    const result = await indexer.reindex(ADDR);

    assert.equal(result.mode, 'incremental', 'no fallback — the fold was never a regression');
    assert.equal(result.state.eventCount, 2);
    assert.equal(getLogsCalls.length, 1, 'no second (fallback) getLogs call');
    assert.equal(store.getProject(ADDR)?.eventCount, 2);
  } finally {
    cleanup();
  }
});
