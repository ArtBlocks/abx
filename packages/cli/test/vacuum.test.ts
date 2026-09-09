// `abx vacuum` — SQLite maintenance for the local reference store. The unit-level
// detection/reclamation logic is exercised in packages/indexer/test/vacuum.test.ts; this covers the
// CLI surface on top of it: subcommand dispatch, the pre-conversion fixture end to end (status →
// convert → incremental), and that a store already in incremental mode is left alone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '@artblocks/abx-indexer';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function runCli(args: string[], dataDir: string): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_NO_UPDATE_CHECK: '1', ABX_DATA_DIR: dataDir};
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 30_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code, out: stripAnsi(`${stdout}\n${stderr}`)});
    });
  });
}

function scratchDataDir(): {dataDir: string; cleanup: () => void} {
  const dataDir = mkdtempSync(join(tmpdir(), 'abx-cli-vacuum-'));
  return {dataDir, cleanup: () => rmSync(dataDir, {recursive: true, force: true})};
}

/** Same fixture idiom as packages/indexer/test/vacuum.test.ts: one throwaway table created on a
 *  bare connection before `SqliteStore` ever opens the file locks the WHOLE database at
 *  `auto_vacuum='none'` — reproducing every store created before this repo's fix, without
 *  hand-copying store.ts's SCHEMA into this test. */
function preConversionDataDir(): {dataDir: string; cleanup: () => void} {
  const {dataDir, cleanup} = scratchDataDir();
  const raw = new DatabaseSync(join(dataDir, 'index.db'));
  raw.exec(`CREATE TABLE __pre_fix_marker (x INTEGER)`);
  raw.close();
  return {dataDir, cleanup};
}

test('abx vacuum (bare, and status) reports a fresh store as already incremental, with nothing to reclaim', async () => {
  const {dataDir, cleanup} = scratchDataDir();
  try {
    // No pre-existing file at all — the CLI process itself creates a fresh store on first open.
    const bare = await runCli(['vacuum'], dataDir);
    assert.equal(bare.code, 0);
    assert.match(bare.out, /auto_vacuum\s+incremental/);
    assert.match(bare.out, /nothing to reclaim/);

    const status = await runCli(['vacuum', 'status'], dataDir);
    assert.equal(status.code, 0);
    assert.match(status.out, /auto_vacuum\s+incremental/);
  } finally {
    cleanup();
  }
});

test('abx vacuum detects a pre-conversion store and points at `abx vacuum convert`', async () => {
  const {dataDir, cleanup} = preConversionDataDir();
  try {
    const {code, out} = await runCli(['vacuum'], dataDir);
    assert.equal(code, 0);
    assert.match(out, /auto_vacuum\s+none/);
    assert.match(out, /needs a one-time conversion/);
    assert.match(out, /abx vacuum convert/);
  } finally {
    cleanup();
  }
});

test('abx vacuum incremental refuses to do anything on a none-mode store, then abx vacuum convert flips it and abx vacuum incremental works after', async () => {
  const {dataDir, cleanup} = preConversionDataDir();
  try {
    const before = await runCli(['vacuum', 'incremental'], dataDir);
    assert.equal(before.code, 0);
    assert.match(before.out, /has nothing to do until this store is converted/);

    const convert = await runCli(['vacuum', 'convert'], dataDir);
    assert.equal(convert.code, 0);
    assert.match(convert.out, /REWRITES THE ENTIRE FILE/);
    assert.match(convert.out, /auto_vacuum is now 'incremental'/);

    const status = await runCli(['vacuum'], dataDir);
    assert.match(status.out, /auto_vacuum\s+incremental/);

    // Converting an already-converted store a second time is a no-op, not a second full VACUUM.
    const again = await runCli(['vacuum', 'convert'], dataDir);
    assert.match(again.out, /already converted/);
  } finally {
    cleanup();
  }
});

test('abx vacuum incremental --pages reclaims real freed pages after conversion', async () => {
  const {dataDir, cleanup} = preConversionDataDir();
  try {
    await runCli(['vacuum', 'convert'], dataDir);

    // Churn freelist pages directly against the same on-disk file the CLI will open next — mirrors
    // packages/indexer/test/vacuum.test.ts's `churnFreelist`.
    const store = new SqliteStore(dataDir);
    const db = (store as unknown as {db: DatabaseSync}).db;
    db.exec(`CREATE TABLE __scratch (data BLOB)`);
    const insert = db.prepare(`INSERT INTO __scratch (data) VALUES (?)`);
    const blob = Buffer.alloc(256, 7);
    db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) insert.run(blob);
    db.exec('COMMIT');
    db.exec(`DELETE FROM __scratch`);
    const freelistBefore = store.vacuumStats().freelistPages;
    assert.ok(freelistBefore > 20, 'the churn must have produced free pages for this test to mean anything');
    db.close(); // close the connection WITHOUT store.destroy() — that would delete the file we just churned

    const {code, out} = await runCli(['vacuum', 'incremental', '--pages', '10'], dataDir);
    assert.equal(code, 0);
    assert.match(out, /reclaimed 10 page\(s\) \(bounded to 10 this pass\)/);

    const after = new SqliteStore(dataDir);
    assert.equal(after.vacuumStats().freelistPages, freelistBefore - 10, 'exactly the bounded amount must move');
    after.destroy();
  } finally {
    cleanup();
  }
});

test('abx vacuum <bogus subcommand> refuses with usage and a non-zero exit', async () => {
  const {dataDir, cleanup} = scratchDataDir();
  try {
    const {code, out} = await runCli(['vacuum', 'bogus'], dataDir);
    assert.notEqual(code, 0);
    assert.match(out, /usage: abx vacuum/);
  } finally {
    cleanup();
  }
});
