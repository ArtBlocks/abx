// SQLite maintenance for existing and long-running stores.
//
// Two halves, tested separately:
//  - detection + the one-time EXPLICIT full-VACUUM conversion for a store created before this repo
//    started setting `PRAGMA auto_vacuum = INCREMENTAL` ahead of its first `CREATE TABLE` (every
//    store on disk before that fix — see store.ts's SCHEMA comment).
//  - the bounded, automatic `PRAGMA incremental_vacuum` policy — both the raw store method and the
//    indexer's own timer that's meant to run it BETWEEN watch-loop ticks, never inline with a
//    request.
//
// White-box like store.test.ts's `rawDb` helper: this reaches past the `Store` contract on purpose
// (`autoVacuumMode`/`vacuumConvert`/`runIncrementalVacuum`/`vacuumStats` are deliberately NOT on that
// interface — vacuuming is SQLite-specific — so a test of them has to talk to `SqliteStore` and its
// underlying `DatabaseSync` directly).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DEFAULT_INCREMENTAL_VACUUM_PAGES, SelfHostIndexer, SqliteStore, type Store} from '../src/index.js';

const rawDb = (store: SqliteStore) => (store as unknown as {db: DatabaseSync}).db;

/**
 * A data directory whose `index.db` already has ONE table before `SqliteStore` ever opens it —
 * reproducing every store created before this repo's fix, without hand-copying `store.ts`'s real
 * `SCHEMA` string into this test. SQLite only honors a changed `auto_vacuum` pragma on a database
 * with NO tables/indexes/views/triggers yet, for the file as a whole — it doesn't matter which table
 * got there first. So opening one throwaway table on a bare connection locks the WHOLE FILE at
 * `auto_vacuum='none'` (SQLite's default) before `SqliteStore`'s own `SCHEMA` — which asks for
 * INCREMENTAL — ever runs, exactly the historical bug: real tables get created, but under a mode
 * that pragma can no longer change.
 */
function preConversionDataDir(): {dir: string; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-vacuum-'));
  const path = join(dir, 'index.db');
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE __pre_fix_marker (x INTEGER)`);
  raw.close();
  return {dir, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

function freshDataDir(): {dir: string; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-vacuum-fresh-'));
  return {dir, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

/** Write `rows` throwaway blobs into a scratch table, then delete every one of them — churn that
 *  leaves real freed pages on the freelist without needing to construct a `ProjectState` (this
 *  file's fixtures are about page accounting, not projection shape). */
function churnFreelist(store: SqliteStore, rows = 3000): void {
  const db = rawDb(store);
  db.exec(`CREATE TABLE IF NOT EXISTS __scratch (data BLOB)`);
  const insert = db.prepare(`INSERT INTO __scratch (data) VALUES (?)`);
  const blob = Buffer.alloc(256, 7);
  db.exec('BEGIN');
  for (let i = 0; i < rows; i++) insert.run(blob);
  db.exec('COMMIT');
  db.exec(`DELETE FROM __scratch`);
}

// ── detection + one-time conversion ──────────────────────────────────────────

test('a fresh store is already in incremental mode (the existing fix, unchanged)', () => {
  const {dir, cleanup} = freshDataDir();
  try {
    const store = new SqliteStore(dir);
    assert.equal(store.autoVacuumMode(), 'incremental');
  } finally {
    cleanup();
  }
});

test('autoVacuumMode detects a pre-existing store stuck at none', () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    assert.equal(
      store.autoVacuumMode(),
      'none',
      'a store whose file already had a table before SqliteStore first opened it must be detected as needing conversion',
    );
    assert.equal(store.vacuumStats().mode, 'none');
  } finally {
    cleanup();
  }
});

test('vacuumConvert flips a none-mode store to incremental, and is idempotent', () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    assert.equal(store.autoVacuumMode(), 'none');

    assert.equal(store.vacuumConvert(), 'incremental');
    assert.equal(store.autoVacuumMode(), 'incremental');

    // A second call on an already-converted store is a no-op, not a second full VACUUM.
    assert.equal(store.vacuumConvert(), 'incremental');
  } finally {
    cleanup();
  }
});

test('the one-time conversion actually reclaims space: freelist pages accrued before conversion are gone after', () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    churnFreelist(store, 3000);
    const before = store.vacuumStats();
    assert.ok(before.freelistPages > 0, 'the churn must have produced free pages for this test to mean anything');

    store.vacuumConvert();
    const after = store.vacuumStats();
    assert.equal(after.mode, 'incremental');
    assert.equal(after.freelistPages, 0, 'a full VACUUM rebuilds the file with no dead pages left');
    assert.ok(after.pageCount < before.pageCount, 'the rebuilt file must be smaller, not just re-flagged');
  } finally {
    cleanup();
  }
});

// ── bounded automatic reclamation ────────────────────────────────────────────

test('runIncrementalVacuum is a no-op before conversion, even with pages to reclaim', () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    churnFreelist(store, 3000);
    const before = store.vacuumStats();
    assert.ok(before.freelistPages > 0);

    assert.equal(
      store.runIncrementalVacuum(50),
      0,
      'incremental_vacuum only does anything in incremental mode — a none-mode store must be left untouched',
    );
    assert.equal(store.vacuumStats().freelistPages, before.freelistPages);
  } finally {
    cleanup();
  }
});

test('runIncrementalVacuum reclaims at most maxPages per call, and repeated bounded passes fully drain the freelist', () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    store.vacuumConvert();
    churnFreelist(store, 3000);

    const before = store.vacuumStats();
    assert.ok(before.freelistPages > 20, 'need enough freed pages for a bounded pass to be a strict subset of the freelist');

    const bound = 10;
    const reclaimed = store.runIncrementalVacuum(bound);
    assert.equal(reclaimed, bound, 'a call bounded well under the freelist size reclaims exactly maxPages');
    const mid = store.vacuumStats();
    assert.equal(mid.freelistPages, before.freelistPages - bound, 'exactly the bounded amount must move, never the whole freelist at once');

    // Drain the remainder with one large pass — proves boundedness isn't a permanent cap, just a
    // per-call one: asking for more than remains reclaims exactly what remains.
    const rest = store.runIncrementalVacuum(before.freelistPages);
    assert.equal(rest, mid.freelistPages);
    assert.equal(store.vacuumStats().freelistPages, 0);

    // Fully drained: another pass has nothing to do.
    assert.equal(store.runIncrementalVacuum(50), 0);
  } finally {
    cleanup();
  }
});

test('DEFAULT_INCREMENTAL_VACUUM_PAGES is a small, sane per-pass bound', () => {
  // Regression guard on the constant itself: this is what makes a pass cheap enough to run
  // unattended between watch ticks (see indexer.ts's docstring) — a future edit that quietly
  // widened it to "reclaim everything" would defeat the whole point.
  assert.ok(DEFAULT_INCREMENTAL_VACUUM_PAGES > 0 && DEFAULT_INCREMENTAL_VACUUM_PAGES <= 1000);
});

// ── SelfHostIndexer wiring ───────────────────────────────────────────────────

test('SelfHostIndexer.runIncrementalVacuum delegates to the SqliteStore', () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    store.vacuumConvert();
    churnFreelist(store, 3000);
    const indexer = new SelfHostIndexer(store);

    const before = store.vacuumStats().freelistPages;
    assert.ok(before > 0);
    const reclaimed = indexer.runIncrementalVacuum(5);
    assert.equal(reclaimed, 5);
    assert.equal(store.vacuumStats().freelistPages, before - 5);
  } finally {
    cleanup();
  }
});

test('SelfHostIndexer.runIncrementalVacuum is a no-op for a Store backend that is not SqliteStore', () => {
  // A platform-scale Postgres-backed Store (mentioned in store.ts's docstring) has its own manual
  // VACUUM story outside this codebase — this must never throw trying to treat it like SQLite.
  const fakeStore = {} as unknown as Store;
  const indexer = new SelfHostIndexer(fakeStore);
  assert.equal(indexer.runIncrementalVacuum(10), 0);
});

test('startVacuumMaintenance runs bounded passes on its own timer, between calls rather than inline, and stop() halts them', async () => {
  const {dir, cleanup} = preConversionDataDir();
  try {
    const store = new SqliteStore(dir);
    store.vacuumConvert();
    churnFreelist(store, 6000);
    const indexer = new SelfHostIndexer(store);

    const before = store.vacuumStats().freelistPages;
    assert.ok(before > 0);

    const lines: string[] = [];
    const handle = indexer.startVacuumMaintenance({intervalMs: 15, maxPages: 20, log: (l) => lines.push(l)});
    try {
      // Several 15ms ticks — enough for at least one bounded pass to have run.
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      handle.stop();
    }

    const afterRunning = store.vacuumStats().freelistPages;
    assert.ok(afterRunning < before, 'at least one bounded pass must have run on the timer');
    assert.ok(afterRunning > 0, 'each pass is bounded to maxPages — it must not have drained the whole freelist in one go');
    assert.ok(lines.some((l) => l.includes('reclaimed')), 'a successful pass logs what it reclaimed');

    // stop() must actually stop it: churn more and confirm nothing moves without the timer running.
    churnFreelist(store, 500);
    const afterStop = store.vacuumStats().freelistPages;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(store.vacuumStats().freelistPages, afterStop, 'stop() must halt further passes');
  } finally {
    cleanup();
  }
});
