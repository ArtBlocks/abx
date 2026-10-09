import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import {ANSI, ansiBold, ansiEnabled, ansiGreen} from '../src/ansi.js';

const ESCAPE = /\x1b\[[0-9;]*m/;

test('ANSI helpers emit plain text when stdout is not a TTY', () => {
  assert.equal(ansiEnabled(undefined, undefined), false);
  assert.equal(ansiEnabled(false, undefined), false);
  assert.equal(ansiEnabled(true, '1'), false);
  assert.equal(ansiEnabled(true, undefined), true);
  if (!process.stdout.isTTY) {
    assert.equal(ANSI.green, '');
    assert.equal(ansiGreen('ready'), 'ready');
    assert.equal(ansiBold('abx'), 'abx');
  }
});

test('piped CLI help contains no ANSI escape bytes', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'main.ts');
  const run = spawnSync(process.execPath, ['--import', 'tsx', cli, 'help', 'deploy-series'], {
    encoding: 'utf8',
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, ESCAPE);
  assert.doesNotMatch(run.stderr, ESCAPE);
});
