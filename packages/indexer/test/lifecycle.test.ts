// The indexing lifecycle (queued | backfilling | live | stale | failed) and the coalescing
// catch-up entry point — the machinery behind the control plane's `status` route and `abx status`.
// No chain: `reindex` is overridden with a controllable stand-in, so what's under test is the
// lifecycle bookkeeping and `reindexShared`'s deduplication, not reconstruction.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Address, ProjectState} from '@artblocks/abx-sdk';
import {classifyIndexError} from '@artblocks/abx-sdk';
import {SelfHostIndexer, SqliteStore} from '../src/index.js';

const ADDR = '0x00085b0ED14297a15A07c9ECd840c3d42815Ca40' as Address;

function fresh(): {store: SqliteStore; indexer: SelfHostIndexer; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-lifecycle-'));
  const store = new SqliteStore(dir);
  return {store, indexer: new SelfHostIndexer(store), cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

const register = (indexer: SelfHostIndexer) =>
  indexer.register({address: ADDR, chainKey: 'sepolia', fromBlock: '100', factory: null});

/** Replace `reindex` with a controllable stand-in that stamps the lifecycle the way the real one
 *  does — so `reindexShared` (the thing under test) sees realistic behavior. */
function stubReindex(indexer: SelfHostIndexer, impl: (address: Address, opts: {full?: boolean}) => Promise<void>) {
  const calls: Array<{address: string; full: boolean}> = [];
  (indexer as unknown as {reindex: unknown}).reindex = async (address: Address, opts: {full?: boolean} = {}) => {
    calls.push({address, full: !!opts.full});
    await impl(address, opts);
    const now = new Date().toISOString();
    indexer.store.setIndexStatus(address, {status: 'live', error: null, attempts: 0, lastIndexedAt: now});
    return {state: {} as ProjectState, elapsedMs: 1, mode: 'full' as const};
  };
  return calls;
}

test('a first registration enters the lifecycle at queued; a re-add never resets it', () => {
  const {store, indexer, cleanup} = fresh();
  try {
    register(indexer);
    assert.equal(store.getIndexStatus(ADDR)?.status, 'queued');

    store.setIndexStatus(ADDR, {status: 'live', lastIndexedAt: 'then'});
    // register() is a full-column upsert on the registration row. The lifecycle must NOT ride along
    // (the clobber class): a re-add that reset `live` → `queued` would re-report a caught-up project
    // as pending and re-trigger catch-up on every nudge.
    register(indexer);
    assert.equal(store.getIndexStatus(ADDR)?.status, 'live');
    assert.equal(store.getIndexStatus(ADDR)?.lastIndexedAt, 'then');
  } finally {
    cleanup();
  }
});

test('setIndexStatus preserves omitted fields and clears on explicit null', () => {
  const {store, cleanup} = fresh();
  try {
    store.setIndexStatus(ADDR, {status: 'failed', error: {class: 'rpc_rate_limited', message: 'slow'}, attempts: 3, lastAttemptAt: 'a'});
    // A later patch that only names `status` must not erase the recorded cause or attempt count.
    const kept = store.setIndexStatus(ADDR, {status: 'stale'});
    assert.deepEqual(
      {status: kept.status, cls: kept.errorClass, attempts: kept.attempts, last: kept.lastAttemptAt},
      {status: 'stale', cls: 'rpc_rate_limited', attempts: 3, last: 'a'},
    );
    const cleared = store.setIndexStatus(ADDR, {status: 'live', error: null});
    assert.equal(cleared.errorClass, null);
    assert.equal(cleared.errorMessage, null);
    assert.equal(cleared.attempts, 3, 'attempts is a separate axis from the error — not cleared with it');
  } finally {
    cleanup();
  }
});

test('the lifecycle survives a projection wipe and dies with deregister', () => {
  const {store, indexer, cleanup} = fresh();
  try {
    register(indexer);
    store.setIndexStatus(ADDR, {status: 'live', lastIndexedAt: 'then'});
    // A replay must not lose where you were — the projection is disposable, this history is not.
    store.wipeProjections();
    assert.equal(store.getIndexStatus(ADDR)?.status, 'live');
    store.deregister(ADDR);
    assert.equal(store.getIndexStatus(ADDR), null);
  } finally {
    cleanup();
  }
});

test('a failed catch-up records a credential-free class + the attempt count, and rethrows', async () => {
  const {store, indexer, cleanup} = fresh();
  try {
    register(indexer);
    // The shape of a real viem failure: the message embeds the keyed endpoint URL.
    const err = new Error('HTTP request failed. URL: https://sepolia.example.dev/v2/SECRETKEY123 — 429 Too Many Requests');
    (indexer as unknown as {reindex: unknown}).reindex = async () => {
      store.setIndexStatus(ADDR, {status: 'failed', error: classifyIndexError(err), attempts: 1, lastAttemptAt: 'now'});
      throw err;
    };
    await assert.rejects(() => indexer.reindexShared(ADDR), /HTTP request failed/);
    const row = store.getIndexStatus(ADDR)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.errorClass, 'rpc_rate_limited');
    assert.equal(row.attempts, 1);
    assert.doesNotMatch(row.errorMessage ?? '', /SECRETKEY|https?:\/\//, 'the stored hint must never carry the endpoint URL');
  } finally {
    cleanup();
  }
});

test('reindexShared coalesces concurrent catch-ups for one project into a single run', async () => {
  const {indexer, cleanup} = fresh();
  try {
    register(indexer);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stubReindex(indexer, () => gate);

    const a = indexer.reindexShared(ADDR);
    const b = indexer.reindexShared(ADDR); // the re-POST landing mid-backfill
    assert.equal(indexer.isCatchingUp(ADDR), true);
    release();
    await Promise.all([a, b]);
    // One reconstruct, not two: the second caller joined the first run rather than doubling the load
    // on the RPC that is usually the bottleneck.
    assert.equal(calls.length, 1);
    assert.equal(indexer.isCatchingUp(ADDR), false);
  } finally {
    cleanup();
  }
});

test('a forced full replay requested during an incremental run is queued, never dropped', async () => {
  const {indexer, cleanup} = fresh();
  try {
    register(indexer);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const calls = stubReindex(indexer, async () => {
      if (first) {
        first = false;
        await gate;
      }
    });

    const incremental = indexer.reindexShared(ADDR);
    const forced = indexer.reindexShared(ADDR, {full: true});
    release();
    await Promise.all([incremental, forced]);
    assert.deepEqual(
      calls.map((c) => c.full),
      [false, true],
      'the full replay runs after the in-flight incremental — an incremental cannot satisfy it',
    );
  } finally {
    cleanup();
  }
});

test('a failing run clears the in-flight slot so the next trigger retries', async () => {
  const {indexer, cleanup} = fresh();
  try {
    register(indexer);
    (indexer as unknown as {reindex: unknown}).reindex = async () => {
      throw new Error('boom');
    };
    await assert.rejects(() => indexer.reindexShared(ADDR), /boom/);
    assert.equal(indexer.isCatchingUp(ADDR), false, 'a rejected run must not wedge the project as "catching up" forever');
  } finally {
    cleanup();
  }
});
