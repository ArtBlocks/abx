/**
 * The transfer hook is a VETO, and `abx lock-param-hooks` is the answer to it.
 *
 * Two things are being locked down here, and both are about what a human or an agent is TOLD:
 *
 *  1. No surface may still describe the transfer hook as best-effort. It used to swallow its own
 *     revert and promise the param lifecycle "must never block a transfer"; that promise was not
 *     keepable (Solady runs the ERC-721/1155 receiver acceptance check AFTER the hook, so on the
 *     `safe*` variants a marketplace fill wraps, a hook that is cheap at estimation and expensive at
 *     execution starved it regardless of any gas cap). Now the revert bubbles and the transfer — or
 *     the mint — fails. A stale "never blocks" sentence in help text is worse than no sentence: it
 *     is the exact false guarantee the withdrawal exists to retract.
 *  2. The new lock has to READ like its siblings (`lock-script`, `lock-uri`, `lock-field`,
 *     `lock-dependencies`): permanent, irreversible, and explicit about what is given up.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {allowlistFor} from '../src/flag-allowlists.js';
import {SHARED_WRITE} from '../src/flag-allowlists.js';

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts');

/** `abx help <cmd>`, colour stripped. `help` never executes a command, so this is always safe. */
function helpFor(cmd: string): string {
  const out = execFileSync('node', ['--import', 'tsx', CLI, 'help', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x1b\[[0-9;]*m/g, '');
}

test('help lock-param-hooks: names the veto, the permanence, and what is given up', () => {
  const help = helpFor('lock-param-hooks');
  assert.match(help, /abx lock-param-hooks <address>/);
  assert.match(help, /VETO/);
  assert.match(help, /FOREVER|permanent/i);
  assert.match(help, /irreversible|no way back/i);
  assert.match(help, /give up|giving up/i);
  // The reason a buyer cares, in the help itself: a transfer hook can stop a sale.
  assert.match(help, /transfer/i);
});

test('help set-param-hooks: the --transfer flag is a veto over transfers AND mints', () => {
  const help = helpFor('set-param-hooks');
  assert.match(help, /--transfer/);
  assert.match(help, /VETO/);
  assert.match(help, /mint/i);
  // The withdrawn promise must not survive anywhere in this entry.
  assert.doesNotMatch(help, /best-effort/i);
  assert.doesNotMatch(help, /never blocks the transfer/i);
});

test('no CLI source still promises a swallowed / non-blocking transfer hook', () => {
  // Scoped deliberately to the two files that describe the hooks to a user. A repo-wide grep would
  // trip over unrelated legitimate uses of "best-effort" (an RPC probe, a name() read).
  for (const rel of ['ownerops.ts', 'main.ts']) {
    const src = readFileSync(resolve(import.meta.dirname, '../src', rel), 'utf8');
    const hookLines = src.split('\n').filter((l) => /transferHook|--transfer\b|transfer hook/i.test(l));
    for (const line of hookLines) {
      assert.doesNotMatch(line, /best-effort/i, `${rel}: stale best-effort claim → ${line.trim()}`);
      assert.doesNotMatch(line, /revert (here )?never blocks|swallow/i, `${rel}: stale swallow claim → ${line.trim()}`);
    }
  }
});

test('lock-param-hooks takes no flags of its own beyond the shared write set', () => {
  const allowed = allowlistFor('lock-param-hooks');
  assert.ok(allowed, 'lock-param-hooks must have an allowlist entry (an unlisted command warns on every flag)');
  for (const f of SHARED_WRITE) assert.ok(allowed!.has(f), `signing flag --${f} must be accepted`);
  // Same shape as its siblings: a lock has nothing to configure.
  const shared = new Set<string>(SHARED_WRITE);
  const own = [...allowed!].filter((f) => !shared.has(f));
  assert.deepEqual(own, [], `lock-param-hooks should own no flags, got ${own.join(', ')}`);
});

test('lock-param-hooks with no address prints usage and exits non-zero', () => {
  let status = 0;
  let out = '';
  try {
    out = execFileSync('node', ['--import', 'tsx', CLI, 'lock-param-hooks'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
    });
  } catch (err) {
    const e = err as {status?: number; stdout?: string; stderr?: string};
    status = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert.notEqual(status, 0, 'a missing address must not exit 0');
  assert.match(out, /lock-param-hooks <address>/);
});

test('help set-schema / configure-param: SeriesCode/EditionCode only, before signing', () => {
  const schema = helpFor('set-schema');
  assert.match(schema, /SeriesCode\/EditionCode only/);
  const configure = helpFor('configure-param');
  assert.match(configure, /SeriesCode\/EditionCode only/);
});

test('help attach: URI pairs and --file are mutually exclusive', () => {
  const help = helpFor('attach');
  assert.match(help, /Mutually exclusive with URI pairs/);
});

test('help deploy-code: Select/Range examples are quoted for the shell', () => {
  const help = helpFor('deploy-code');
  assert.match(help, /'mood:Select\[Calm\|Wild\|Chaotic\]:TokenOwner'/);
  assert.match(help, /'density:Uint256Range\[0\.\.100\]:TokenOwner'/);
});
