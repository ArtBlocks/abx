import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {ABX_CAPABILITIES} from '../src/capabilities.js';

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const env = {...process.env, ABX_NO_UPDATE_CHECK: '1'};
function run(args: string[], cwd?: string): string {
  return execFileSync('node', ['--import', 'tsx', CLI, ...args], {encoding: 'utf8', env, cwd, stdio: ['ignore', 'pipe', 'pipe']});
}

test('utility list, detail, and capability output share one descriptor without utility dependencies', () => {
  const list = JSON.parse(run(['utils', '--json']));
  assert.equal(list.schemaVersion, 1);
  assert.deepEqual(list.utilities, ABX_CAPABILITIES.utilities);
  assert.deepEqual(JSON.parse(run(['utils', 'abxfs', '--json'])), list.utilities[0]);
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.ok(!Object.keys(pkg.dependencies).some((name) => name.startsWith('@artblocks/abxfs')));
});

test('discovery does not require project configuration or a working remote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-utils-'));
  try {
    // Resolve tsx from the checkout even with a creator directory as cwd.
    const tsx = import.meta.resolve('tsx');
    const text = execFileSync('node', ['--import', tsx, CLI, 'utils', 'abxfs', '--json'], {encoding: 'utf8', env: {...env, ABX_RPC_REMOTE: 'utility-discovery-has-no-remote'}, cwd: dir});
    assert.equal(JSON.parse(text).optional, true);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('unknown utility fails instead of trying an executable or install', () => {
  const result = spawnSync('node', ['--import', 'tsx', CLI, 'utils', 'unknown-util'], {encoding: 'utf8', env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown ABX utility/);
});

test('help and public descriptor state optional operations and independent signing', () => {
  assert.match(run(['help', 'utils']), /no installation/);
  assert.match(run(['utils', '--help']), /abx utils/);
  assert.match(run(['help']), /abx utils/);
  assert.match(run(['utils', 'abxfs']), /signing lanes do not automatically carry over/);
});
