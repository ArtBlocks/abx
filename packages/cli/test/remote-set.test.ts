// `abx remote set` — the third-party twin of `abx auth login`. `installRemoteToken` is the testable
// core: no stdin, no console.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {installRemoteToken} from '../src/commands/service.js';

function tempEnvDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], {cwd: dir});
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  return dir;
}

test('installRemoteToken: writes both vars, uppercased/underscored name', () => {
  const dir = tempEnvDir('abx-remote-set-');
  const envPath = join(dir, '.env');
  const {urlVar, tokenVar} = installRemoteToken('meridian', 'https://meta.provider.xyz/', 'sk_test_123', envPath);
  assert.equal(urlVar, 'ABX_REMOTE_MERIDIAN_URL');
  assert.equal(tokenVar, 'ABX_REMOTE_MERIDIAN_TOKEN');
  const content = readFileSync(envPath, 'utf8');
  assert.match(content, /ABX_REMOTE_MERIDIAN_URL=https:\/\/meta\.provider\.xyz\n/); // trailing slash stripped
  assert.match(content, /ABX_REMOTE_MERIDIAN_TOKEN=sk_test_123\n/);
});

test('installRemoteToken: a hyphenated name has one canonical env spelling', () => {
  const dir = tempEnvDir('abx-remote-set-');
  const {urlVar, tokenVar} = installRemoteToken('my-provider-two', 'https://host.example', 't', join(dir, '.env'));
  assert.equal(urlVar, 'ABX_REMOTE_MY_PROVIDER_TWO_URL');
  assert.equal(tokenVar, 'ABX_REMOTE_MY_PROVIDER_TWO_TOKEN');
});

test('installRemoteToken: rejects lossy or flag-conflicting names', () => {
  const dir = tempEnvDir('abx-remote-set-');
  const envPath = join(dir, '.env');
  for (const name of ['my.provider', 'my_provider', '-provider', 'provider--two', 'true']) {
    assert.throws(() => installRemoteToken(name, 'https://host.example', 't', envPath), /remote names|reserved/);
  }
});

test('installRemoteToken: re-running REPLACES in place, never duplicates or grows the file', () => {
  const dir = tempEnvDir('abx-remote-set-');
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'KEEP=this\n', {mode: 0o600});
  installRemoteToken('meridian', 'https://meta.provider.xyz', 'old-token', envPath);
  installRemoteToken('meridian', 'https://meta.provider.xyz/v2', 'new-token', envPath);
  const content = readFileSync(envPath, 'utf8');
  // Exactly one line per key (no duplicate from the second call), holding the NEW value.
  assert.equal((content.match(/^ABX_REMOTE_MERIDIAN_URL=/gm) ?? []).length, 1);
  assert.equal((content.match(/^ABX_REMOTE_MERIDIAN_TOKEN=/gm) ?? []).length, 1);
  assert.match(content, /^ABX_REMOTE_MERIDIAN_URL=https:\/\/meta\.provider\.xyz\/v2$/m);
  assert.match(content, /^ABX_REMOTE_MERIDIAN_TOKEN=new-token$/m);
  assert.doesNotMatch(content, /old-token/);
});

test('installRemoteToken: refuses the reserved "abx" name — that is auth login\'s job', () => {
  const dir = tempEnvDir('abx-remote-set-');
  assert.throws(() => installRemoteToken('abx', 'https://services.abx.io', 't', join(dir, '.env')), /auth login/);
  assert.throws(() => installRemoteToken('ABX', 'https://services.abx.io', 't', join(dir, '.env')), /auth login/, 'case-insensitive');
});

test('installRemoteToken: refuses a missing/schemeless/whitespace-bearing url', () => {
  const dir = tempEnvDir('abx-remote-set-');
  const envPath = join(dir, '.env');
  assert.throws(() => installRemoteToken('meridian', '', 't', envPath), /--url/);
  assert.throws(() => installRemoteToken('meridian', 'meta.provider.xyz', 't', envPath), /--url/, 'no scheme');
  assert.throws(() => installRemoteToken('meridian', 'https://host with spaces', 't', envPath), /--url/);
  assert.throws(() => installRemoteToken('meridian', 'https://?token=x', 't', envPath), /--url/, 'no host');
  assert.throws(() => installRemoteToken('meridian', 'https://user:pass@host.example', 't', envPath), /--url/, 'credentials');
});

test('installRemoteToken: refuses an empty token before ever touching the file', () => {
  const dir = tempEnvDir('abx-remote-set-');
  const envPath = join(dir, '.env');
  assert.throws(() => installRemoteToken('meridian', 'https://meta.provider.xyz', '', envPath), /no token/);
});

test('installRemoteToken: still refuses writing into a tracked (non-gitignored) .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-remote-set-tracked-'));
  execFileSync('git', ['init', '-q'], {cwd: dir});
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  execFileSync('git', ['add', '.env'], {cwd: dir});
  assert.throws(() => installRemoteToken('meridian', 'https://meta.provider.xyz', 't', envPath), /tracked/);
});
