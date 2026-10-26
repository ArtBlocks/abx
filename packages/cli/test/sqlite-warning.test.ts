import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" to stderr on every abx
// command (#135). bin.ts filters exactly that warning. The preload emits it plus an unrelated
// ExperimentalWarning and a plain Error with a similar message, so this runs the same way on any
// supported Node.

const BIN = resolve(import.meta.dirname, '../src/bin.ts');
const EMIT = pathToFileURL(resolve(import.meta.dirname, 'fixtures/emit-sample-warnings.mjs')).href;

test('the SQLite ExperimentalWarning is dropped; unrelated warnings still print', () => {
  const r = spawnSync('node', ['--import', 'tsx', '--import', EMIT, BIN, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1', NO_COLOR: '1'},
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/m, 'the command itself still runs');
  assert.doesNotMatch(r.stderr, /ExperimentalWarning: SQLite is an experimental feature/);
  assert.match(r.stderr, /\[ABX_TEST_CODE\] DeprecationWarning: abx-test unrelated options warning/);
  assert.match(r.stderr, /ExperimentalWarning: abx-test unrelated experimental feature/);
  assert.match(r.stderr, /Error: SQLite is an experimental feature \(abx-test plain Error\)/);
  assert.doesNotMatch(r.stderr, /\x1b\[/, 'no ANSI escapes in piped stderr');
});
