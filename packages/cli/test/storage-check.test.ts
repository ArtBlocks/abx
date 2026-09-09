// `abx storage show --check` goes beyond "is this backend
// CONFIGURED" to "does a write actually reach the URL a token would bake on-chain" — a real
// read/write against the resolved config, with a meaningful exit code (0 ok / 1 any ✗).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function runCli(args: string[], overrides: Record<string, string | undefined> = {}): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {...process.env};
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 30_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code, out: stripAnsi(`${stdout}\n${stderr}`)});
    });
  });
}

test('abx storage show (no --check): unchanged — no probe line, no network beyond what show already does', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'abx-storage-check-'));
  const {code, out} = await runCli(['storage', 'show'], {ABX_STORAGE_BACKEND: 'fs', ABX_DATA_DIR: dataDir});
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /checking —/);
  assert.doesNotMatch(out, /writable:/);
});

test('abx storage show --check on fs: a REAL writability round-trip, exit 0', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'abx-storage-check-'));
  const {code, out} = await runCli(['storage', 'show', '--check'], {ABX_STORAGE_BACKEND: 'fs', ABX_DATA_DIR: dataDir});
  assert.equal(code, 0, out);
  assert.match(out, /checking —/);
  assert.match(out, /✓\s+fs:\s+writable:/);
});

test('abx storage show --check on cloud with NO config at all: a clear refusal, exit 1', async () => {
  const {code, out} = await runCli(['storage', 'show', '--check'], {
    ABX_STORAGE_BACKEND: 'cloud',
    ABX_S3_ENDPOINT: undefined,
    ABX_S3_BUCKET: undefined,
    ABX_S3_ACCESS_KEY_ID: undefined,
    ABX_S3_SECRET_ACCESS_KEY: undefined,
  });
  assert.notEqual(code, 0, out);
  assert.match(out, /checking —/);
  assert.match(out, /cloud:.*missing/i);
});

test('abx storage show --check on ipfs kubo mode with no local node running: refused, names the reachability failure', async () => {
  const {code, out} = await runCli(['storage', 'show', '--check'], {
    ABX_STORAGE_BACKEND: 'ipfs',
    ABX_IPFS_MODE: 'kubo',
    ABX_IPFS_API_URL: 'http://127.0.0.1:1', // a port nothing listens on — deterministically unreachable
    PINATA_JWT: undefined,
  });
  assert.notEqual(code, 0, out);
  assert.match(out, /ipfs:/);
});
