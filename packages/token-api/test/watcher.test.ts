// The chain watcher's load-bearing properties, no chain involved: the first tick initializes
// the watermark at head (no backfill surprise), a delta reindexes ONLY touched projects and
// coalesces to ONE notification per project (with a token hint when derivable), a quiet head
// costs nothing, and a failed reindex holds the watermark so the same window retries.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeAbiParameters, encodeEventTopics, type Log} from 'viem';
import {spineEventAbi} from '@artblocks/abx-sdk';
import {SqliteStore} from '@artblocks/abx-indexer';
import {startChainWatcher} from '../src/watcher.js';

const ADDR = '0x00085b0ED14297a15A07c9ECd840c3d42815Ca40';

/** A minimal fake of the SelfHostIndexer surface the watcher touches. Mirrors the real lifecycle
 *  stamping (`reindex` records `live`/`failed`), since the watcher's stale/queued handling reads it. */
function fakeIndexer(store: SqliteStore, chain: {head: bigint; logs: Log[]}) {
  const reindexed: string[] = [];
  let failReindex = false;
  const reindex = async (address: string) => {
    if (failReindex) {
      store.setIndexStatus(address, {status: 'failed', error: {class: 'internal'}, attempts: 1, lastAttemptAt: new Date().toISOString()});
      throw new Error('rpc exploded');
    }
    reindexed.push(address.toLowerCase());
    const now = new Date().toISOString();
    store.setIndexStatus(address, {status: 'live', error: null, attempts: 0, lastIndexedAt: now, lastAttemptAt: now});
    return {state: {eventCount: 1}, elapsedMs: 0, mode: 'incremental'};
  };
  return {
    indexer: {
      store,
      publicClient: () => ({
        getBlockNumber: async () => chain.head,
        getLogs: async () => chain.logs,
      }),
      reindex,
      reindexShared: reindex,
      isCatchingUp: () => false,
    } as never,
    reindexed,
    setFail: (v: boolean) => (failReindex = v),
  };
}

/** Run watcher ticks until `until()` holds (or time out) — timers stay real but tiny. */
async function withWatcher(
  indexer: never,
  notify: (address: string, tokenIds?: string[]) => void,
  until: () => boolean,
): Promise<void> {
  const w = startChainWatcher({indexer, intervalMs: 5, notify, log: () => {}});
  try {
    const deadline = Date.now() + 2_000;
    while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(until(), 'watcher never reached the expected state');
  } finally {
    w.stop();
  }
}

/** A real MetadataUpdate(_tokenId) log for ADDR — parseable by spineEventAbi (the hint path). */
function metadataUpdateLog(tokenId: bigint, blockNumber: bigint): Log {
  const [topic0] = encodeEventTopics({abi: spineEventAbi, eventName: 'MetadataUpdate'} as never) as [`0x${string}`];
  return {
    address: ADDR as `0x${string}`,
    topics: [topic0],
    data: encodeAbiParameters([{type: 'uint256'}], [tokenId]),
    blockNumber,
    logIndex: 0,
    transactionHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
  } as never;
}

function fresh(): {store: SqliteStore; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-watch-'));
  const store = new SqliteStore(dir);
  store.register({address: ADDR, chainKey: 'sepolia', fromBlock: '100', factory: null, registeredAt: 'now'});
  return {store, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

test('first tick initializes the watermark at head — no backfill, no notification', async () => {
  const {store, cleanup} = fresh();
  try {
    const chain = {head: 500n, logs: [] as Log[]};
    const {indexer, reindexed} = fakeIndexer(store, chain);
    const notified: string[] = [];
    await withWatcher(indexer, (a) => void notified.push(a), () => store.getMeta('watch:sepolia') === '500');
    assert.deepEqual(notified, []);
    assert.deepEqual(reindexed, []);
  } finally {
    cleanup();
  }
});

test('a delta reindexes the touched project and coalesces to ONE notification with a token hint', async () => {
  const {store, cleanup} = fresh();
  try {
    store.putMeta('watch:sepolia', '500'); // already watching
    // two logs for the same token in one window — must coalesce to one notify, hint [7]
    const chain = {head: 505n, logs: [metadataUpdateLog(7n, 501n), metadataUpdateLog(7n, 502n)]};
    const {indexer, reindexed} = fakeIndexer(store, chain);
    const notifications: Array<{address: string; tokenIds?: string[]}> = [];
    await withWatcher(
      indexer,
      (address, tokenIds) => void notifications.push({address, tokenIds}),
      () => store.getMeta('watch:sepolia') === '505',
    );
    assert.equal(reindexed.length >= 1, true);
    assert.equal(reindexed[0], ADDR.toLowerCase());
    assert.equal(notifications.length, 1); // coalesced — never one per event
    assert.deepEqual(notifications[0], {address: ADDR.toLowerCase(), tokenIds: ['7']});
  } finally {
    cleanup();
  }
});

test('a tick persists head + pollAt + lastDeltaAt — the /api/watch liveness the resolver serves', async () => {
  const {store, cleanup} = fresh();
  try {
    store.putMeta('watch:sepolia', '500');
    const chain = {head: 507n, logs: [metadataUpdateLog(2n, 501n)]};
    const {indexer} = fakeIndexer(store, chain);
    await withWatcher(indexer, () => {}, () => store.getMeta('watch:sepolia') === '507');
    assert.equal(store.getMeta('watch:sepolia:head'), '507'); // head tracked so /api/watch shows it advancing
    assert.ok(store.getMeta('watch:pollAt'), 'pollAt stamped each tick (proof-of-life for a hosted node)');
    assert.ok(store.getMeta('watch:lastDeltaAt'), 'lastDeltaAt set when a delta lands');
  } finally {
    cleanup();
  }
});

test('a quiet head advances the watermark with zero reindex/notify work', async () => {
  const {store, cleanup} = fresh();
  try {
    store.putMeta('watch:sepolia', '500');
    const chain = {head: 510n, logs: [] as Log[]};
    const {indexer, reindexed} = fakeIndexer(store, chain);
    const notified: string[] = [];
    await withWatcher(indexer, (a) => void notified.push(a), () => store.getMeta('watch:sepolia') === '510');
    assert.deepEqual(notified, []);
    assert.deepEqual(reindexed, []);
  } finally {
    cleanup();
  }
});

test('a failed reindex HOLDS the watermark — the same window retries instead of skipping a delta', async () => {
  const {store, cleanup} = fresh();
  try {
    store.putMeta('watch:sepolia', '500');
    const chain = {head: 505n, logs: [metadataUpdateLog(3n, 501n)]};
    const {indexer, reindexed, setFail} = fakeIndexer(store, chain);
    setFail(true);
    const notifications: string[] = [];
    const w = startChainWatcher({indexer, intervalMs: 5, notify: (a) => void notifications.push(a), log: () => {}});
    await new Promise((r) => setTimeout(r, 120)); // several failing ticks
    assert.equal(store.getMeta('watch:sepolia'), '500'); // held
    assert.deepEqual(notifications, []); // nothing announced for an unindexed delta
    setFail(false); // recovery: the SAME window now succeeds
    const deadline = Date.now() + 2_000;
    while (store.getMeta('watch:sepolia') !== '505' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    w.stop();
    assert.equal(store.getMeta('watch:sepolia'), '505');
    assert.equal(reindexed[0], ADDR.toLowerCase());
    assert.equal(notifications.length, 1);
  } finally {
    cleanup();
  }
});

// ── the indexing lifecycle the watcher owns: resume, drain, stale ────────────────────────────

test('a backfill interrupted by a restart is re-queued at startup and then drained to live', async () => {
  const {store, cleanup} = fresh();
  try {
    // The row a killed process leaves behind: catch-up ran in-process, so nothing would ever finish
    // it. Before this, an interrupted `add` left a registered project only a manual `abx index` fixed.
    store.setIndexStatus(ADDR, {status: 'backfilling', attempts: 1, lastAttemptAt: new Date(0).toISOString()});
    const chain = {head: 500n, logs: [] as Log[]};
    const {indexer, reindexed} = fakeIndexer(store, chain);
    await withWatcher(indexer, () => {}, () => store.getIndexStatus(ADDR)?.status === 'live');
    assert.deepEqual(reindexed, [ADDR.toLowerCase()]);
  } finally {
    cleanup();
  }
});

test('a queued registration is drained even with no chain delta — a deferred register still reaches live', async () => {
  const {store, cleanup} = fresh();
  try {
    store.setIndexStatus(ADDR, {status: 'queued'});
    store.putMeta('watch:sepolia', '500'); // already watching; nothing new on chain
    const chain = {head: 500n, logs: [] as Log[]};
    const {indexer, reindexed} = fakeIndexer(store, chain);
    const notified: string[] = [];
    await withWatcher(indexer, (a) => void notified.push(a), () => store.getIndexStatus(ADDR)?.status === 'live');
    assert.deepEqual(reindexed, [ADDR.toLowerCase()]);
    assert.deepEqual(notified, [ADDR.toLowerCase()], 'the effects layer hears about it when the catch-up lands, not at register');
  } finally {
    cleanup();
  }
});

test('a failed catch-up is retried on backoff, not every tick', async () => {
  const {store, cleanup} = fresh();
  try {
    // attempts=6 ⇒ the backoff window is far longer than this test runs, so it must NOT be retried.
    store.setIndexStatus(ADDR, {status: 'failed', error: {class: 'rpc_rate_limited'}, attempts: 6, lastAttemptAt: new Date().toISOString()});
    store.putMeta('watch:sepolia', '500');
    const chain = {head: 500n, logs: [] as Log[]};
    const {indexer, reindexed} = fakeIndexer(store, chain);
    const w = startChainWatcher({indexer, intervalMs: 5, notify: () => {}, log: () => {}});
    await new Promise((r) => setTimeout(r, 120));
    w.stop();
    assert.deepEqual(reindexed, [], 'hammering a rate-limited RPC every tick is how a transient throttle becomes permanent');
    assert.equal(store.getIndexStatus(ADDR)?.status, 'failed');
  } finally {
    cleanup();
  }
});

test('a watcher far behind head reports its projects stale — and live again once caught up', async () => {
  const {store, cleanup} = fresh();
  try {
    store.setIndexStatus(ADDR, {status: 'live', lastIndexedAt: 'then'});
    store.putMeta('watch:sepolia', '1000');
    // Lag is measured against the WATERMARK (which advances every tick), never a quiet project's own
    // toBlock — otherwise every idle project would drift into `stale`.
    const chain = {head: 100_000n, logs: [] as Log[]};
    const {indexer} = fakeIndexer(store, chain);
    const w = startChainWatcher({indexer, intervalMs: 5, notify: () => {}, log: () => {}});
    const deadline = Date.now() + 2_000;
    while (store.getIndexStatus(ADDR)?.status !== 'stale' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.getIndexStatus(ADDR)?.status, 'stale', 'a node that is not tracking head must say so on the project');
    // …and the watcher keeps closing the gap (5k blocks a tick), so it recovers on its own.
    while (store.getIndexStatus(ADDR)?.status !== 'live' && Date.now() < deadline + 4_000) await new Promise((r) => setTimeout(r, 5));
    w.stop();
    assert.equal(store.getIndexStatus(ADDR)?.status, 'live');
    assert.equal(store.getIndexStatus(ADDR)?.lastIndexedAt, 'then', 'recovering from stale is not a re-index — it must not claim a fresh one');
  } finally {
    cleanup();
  }
});

test('stale never overwrites a mid-lifecycle state (a recorded failure survives a lagging watcher)', async () => {
  const {store, cleanup} = fresh();
  try {
    store.setIndexStatus(ADDR, {status: 'failed', error: {class: 'not_abx_contract'}, attempts: 9, lastAttemptAt: new Date().toISOString()});
    store.putMeta('watch:sepolia', '1000');
    const chain = {head: 100_000n, logs: [] as Log[]};
    const {indexer} = fakeIndexer(store, chain);
    const w = startChainWatcher({indexer, intervalMs: 5, notify: () => {}, log: () => {}});
    await new Promise((r) => setTimeout(r, 60));
    w.stop();
    assert.equal(store.getIndexStatus(ADDR)?.status, 'failed');
    assert.equal(store.getIndexStatus(ADDR)?.errorClass, 'not_abx_contract', 'the recorded cause is the actionable part — never clobbered by lag');
  } finally {
    cleanup();
  }
});
