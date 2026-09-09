// `abx storage upload <path>` uploads exactly one FILE and hands back a locator for it. Before this
// fix, a wrong path leaked a raw Node errno straight to the user — `EISDIR: illegal operation on a
// directory, read` for a folder, a bare ENOENT stack for a missing path — with no next step named.
// (The motivating failure — a pre-deploy directory upload silently not being
// reused — is unreachable, because the command never gets far enough to reuse anything; it crashes
// first. This is the real bug that surfaced: the crash itself is an unacceptable error surface.)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
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

test('abx storage upload <directory>: actionable error, no raw EISDIR, names deploy-series/deploy-code', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-storage-upload-dir-'));
  writeFileSync(resolve(dir, 'a.png'), 'not really a png');
  const {code, out} = await runCli(['storage', 'upload', dir]);
  assert.notEqual(code, 0, out);
  assert.doesNotMatch(out, /EISDIR/);
  assert.doesNotMatch(out, /illegal operation/);
  assert.match(out, /is a directory/);
  assert.match(out, /abx deploy-series --dir/);
  assert.match(out, /abx deploy-code --code-dir/);
});

test('abx storage upload <nested empty directory>: same actionable error, not a crash on an empty dir', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-storage-upload-emptydir-'));
  const nested = resolve(dir, 'nested');
  mkdirSync(nested);
  const {code, out} = await runCli(['storage', 'upload', nested]);
  assert.notEqual(code, 0, out);
  assert.doesNotMatch(out, /EISDIR/);
  assert.match(out, /is a directory/);
});

test('abx storage upload <missing path>: clear "no file at" message, no raw ENOENT stack', async () => {
  const missing = resolve(mkdtempSync(resolve(tmpdir(), 'abx-storage-upload-missing-')), 'does-not-exist.png');
  const {code, out} = await runCli(['storage', 'upload', missing]);
  assert.notEqual(code, 0, out);
  assert.doesNotMatch(out, /ENOENT/);
  assert.match(out, /no file at/);
  assert.match(out, /check the path/);
});
