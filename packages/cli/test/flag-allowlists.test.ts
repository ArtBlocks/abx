// Per-command flag allowlists, and the invariant that keeps them from lying.
//
// The failure mode being guarded is NOT "a typo slips through" (that's the bug this fixed). It's the
// opposite and worse one: an allowlist that OMITS a real flag, so the CLI warns about something valid.
// A notice people learn to distrust stops working for the real cases too — the same dynamic that made
// the unclearable skill-drift ✗ so expensive. So the load-bearing test here reads every flag the
// command's own `--help` documents and asserts the allowlist accepts it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {COMMAND_FLAGS, REMOTE, SHARED_WRITE, STORAGE_OVERRIDE, allowlistFor} from '../src/flag-allowlists.js';
import {GLOBAL_FLAGS} from '../src/flags.js';

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts');

/** `abx help <cmd>` text, with colour stripped. `--help` never executes, so this is always safe. */
function helpFor(cmd: string): string {
  const out = execFileSync('node', ['--import', 'tsx', CLI, 'help', cmd.split(' ')[0]], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });
  // eslint-disable-next-line no-control-regex
  return out.replace(/\[[0-9;]*m/g, '');
}

// Flags that appear in help text as prose/examples for OTHER commands, or as values rather than flags
// of the command being described. Excluded explicitly so the invariant stays honest rather than loose.
const HELP_TEXT_NOISE = new Set([
  'help',
  'chain', // deliberately does not exist — refused globally with a pointed message
]);

/**
 * Commands whose `abx help <cmd>` entry documents SEVERAL subcommands in one block (`abx help storage`
 * covers show/upload/status/balance/topup/backup-key). Scraping it per-subcommand would attribute one
 * subcommand's flags to another — `--primary-only` belongs to `storage status`, which has enforced its
 * own `STORAGE_STATUS_FLAGS` all along. Their coverage is asserted explicitly further down instead.
 */
const MULTI_SUBCOMMAND_HELP = new Set(['storage', 'skill', 'remote', 'auth']);

/**
 * The flags a help entry DEFINES, as opposed to mentions. A definition starts its line (optionally
 * after a bullet); a cross-reference to a sibling command's flag appears mid-sentence. Precision is
 * deliberately favored over recall here: a missed flag only weakens the check, while a false hit would
 * fail CI on prose and train everyone to skip this test — exactly the dynamic this guard avoids.
 */
function definedFlags(help: string): Set<string> {
  const out = new Set<string>();
  for (const line of help.split('\n')) {
    const m = /^\s*(?:[•·]\s*)?--([a-z][a-z0-9-]*)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

test('every command in the allowlist map has a non-empty name and a real Set', () => {
  for (const [cmd, allowed] of Object.entries(COMMAND_FLAGS)) {
    assert.ok(cmd.length > 0, 'empty command key');
    assert.ok(allowed instanceof Set, `${cmd}: allowlist is not a Set`);
  }
});

// THE invariant: a flag the command documents must be accepted by that command.
for (const cmd of Object.keys(COMMAND_FLAGS).filter((c) => !MULTI_SUBCOMMAND_HELP.has(c.split(' ')[0]))) {
  test(`${cmd}: every flag its own help documents is allowlisted`, () => {
    const allowed = allowlistFor(cmd.split(' ')[0], cmd.split(' ')[1]);
    assert.ok(allowed, `${cmd} resolved no allowlist`);
    const documented = definedFlags(helpFor(cmd));
    const missing = [...documented].filter(
      (f) => !allowed.has(f) && !GLOBAL_FLAGS.has(f) && !HELP_TEXT_NOISE.has(f),
    );
    // A miss here is either a real allowlist gap (fix the allowlist) or help text that mentions a
    // sibling command's flag (add it to HELP_TEXT_NOISE with a reason). Never silence it blindly.
    assert.deepEqual(
      missing,
      [],
      `${cmd}: help documents flag(s) the allowlist would warn about: ${missing.map((f) => '--' + f).join(', ')}`,
    );
  });
}

test('SHARED_WRITE covers the signing lane, the confirm gate, and the reindex nudge', () => {
  for (const f of ['send', 'sign', 'unsigned', 'dry-run', 'yes', 'confirm', 'port', 'sign-url-file', 'remote', 'remote-token', 'json']) {
    assert.ok((SHARED_WRITE as readonly string[]).includes(f), `SHARED_WRITE missing ${f}`);
  }
});

test('STORAGE_OVERRIDE matches what storageOverrides() reads — the set no usage string documents', () => {
  // Kept as an explicit list precisely BECAUSE it is undocumented per-command: deriving allowlists
  // from usage strings would have warned on every one of these for `add`/`render`/`effects`/`migrate`/
  // `storage upload`/`storage balance|topup`.
  assert.deepEqual([...STORAGE_OVERRIDE].sort(), [
    'api-url', 'backend', 'bucket', 'endpoint', 'gateway', 'mode', 'prefix', 'provider', 'public-base', 'region', 'storage-signer', 'upload-url',
  ]);
});

test('every command that resolves storage from flags accepts the whole STORAGE_OVERRIDE set', () => {
  for (const cmd of ['add', 'render', 'effects', 'migrate', 'storage upload', 'storage balance', 'storage topup']) {
    const allowed = allowlistFor(cmd.split(' ')[0], cmd.split(' ')[1]);
    assert.ok(allowed, `${cmd}: no allowlist`);
    for (const f of STORAGE_OVERRIDE) assert.ok(allowed.has(f), `${cmd} must accept --${f} (storageOverrides reads it)`);
  }
});

test('every command that resolves a remote accepts --remote-token, which no usage string documents', () => {
  for (const cmd of ['index', 'verify', 'forget', 'status', 'migrate', 'add', 'render', 'effects', 'feedback']) {
    const allowed = allowlistFor(cmd);
    assert.ok(allowed?.has('remote-token'), `${cmd} must accept --remote-token`);
  }
  assert.deepEqual([...REMOTE], ['remote', 'remote-token']);
});

test('refresh does NOT inherit the write flags — it sends no transaction', () => {
  const allowed = allowlistFor('refresh');
  assert.ok(allowed?.has('token'));
  for (const f of ['send', 'sign', 'unsigned', 'dry-run']) {
    assert.ok(!allowed?.has(f), `refresh should not accept --${f}: it never sends a tx`);
  }
});

test('the deploy commands are deliberately absent — they enforce their own exhaustive sets', () => {
  for (const cmd of ['deploy', 'deploy-series', 'deploy-code']) {
    assert.equal(allowlistFor(cmd), undefined, `${cmd} must not be double-checked here`);
  }
});

test('allowlistFor prefers a subcommand row, falling back to the bare command', () => {
  assert.ok(allowlistFor('storage', 'upload')?.has('key'));
  assert.ok(allowlistFor('storage', 'topup')?.has('usd'));
  // An unknown subcommand falls back to the bare `storage` row rather than resolving nothing.
  assert.ok(allowlistFor('storage', 'not-a-subcommand')?.has('check'));
  assert.equal(allowlistFor('definitely-not-a-command'), undefined);
});

test('auth subcommands accept only the flags their distinct flows consume', () => {
  assert.deepEqual([...allowlistFor('auth', 'login')!].sort(), ['force', 'no-open', 'remote']);
  assert.deepEqual([...allowlistFor('auth', 'logout')!], ['remote']);
});
