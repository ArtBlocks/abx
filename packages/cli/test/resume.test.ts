/**
 * The CLI-only half of `abx deploy-code --resume` — the end-to-end refusals through the real
 * binary. The pure diff logic (`planResume`) moved to `@artblocks/abx-sdk`'s `resume.ts` — see
 * its test file for the diff-behavior coverage.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

// ── the refusals, through the real binary ─────────────────────────────────────

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1', ABX_CHAIN: 'sepolia'},
    });
    return {code: 0, out: strip(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: strip((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

const SCRIPT = resolve(import.meta.dirname, '../../../fixtures/code-drop-rehearsal/directory-build/drift.js');
const LIVE = '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294';

test('--resume refuses --721c: enrollment is deploy-time-only and PERMANENT', () => {
  // Accepting the flag here would imply 721C can be added to an existing collection. It cannot, ever.
  const {code, out} = run(['deploy-code', '--resume', LIVE, '--script', SCRIPT, '--721c', 'recommended', '--onchain-uri', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /cannot be combined with --721c/);
  assert.match(out, /deploy-time-only and PERMANENT/);
});

test('--resume refuses --salt: the address already exists, so no salt is used', () => {
  const {code, out} = run(['deploy-code', '--resume', LIVE, '--script', SCRIPT, '--salt', `0x${'1'.repeat(64)}`, '--onchain-uri', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /cannot be combined with --salt/);
});

test('--resume on an address with no code refuses, and says to deploy instead', () => {
  const {code, out} = run(['deploy-code', '--resume', `0x${'2'.repeat(40)}`, '--script', SCRIPT, '--onchain-uri', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /no contract at that address/);
  assert.match(out, /run a normal deploy instead/);
});

test('--resume --dry-run previews the REPAIR, never a fresh deploy', () => {
  // The bug this pins: the deploy dry-run returns before the resume branch, so an unguarded
  // `--resume … --dry-run` printed a fresh-deploy plan with a newly-reserved salt and a DIFFERENT
  // predicted address — a preview of the exact thing the flag exists not to do.
  const {out} = run(['deploy-code', '--resume', LIVE, '--script', SCRIPT, '--onchain-uri', '--schema', 'palette:HexColor:TokenOwner', '--dry-run']);
  assert.match(out, /Resume — read what is missing/);
  assert.match(out, /Finish setup/);
  assert.match(out, new RegExp(LIVE));
  assert.doesNotMatch(out, /freshly-reserved salt/);
  assert.doesNotMatch(out, /nothing sent, no bytes stored\. Re-run without --dry-run to deploy/);
});

// ── EditionCode resume — the CLI-only guards; the diff itself is `planEditionResume`,
// covered exhaustively at the SDK level (packages/sdk/test/resume.test.ts). LIVE here is a 721
// SeriesCode fixture, so these two pin the --mint-amount misuse guards without needing a live
// EditionCode contract on chain.

test('--mint-amount refuses without --resume — the flag only means anything on an EditionCode resume', () => {
  const {code, out} = run(['deploy-code', '--script', SCRIPT, '--onchain-uri', '--mint-amount', '2', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /--mint-amount only applies to `abx deploy-code --resume <address>`/);
});

test('--resume + --mint-amount against a 721 target refuses — no per-id amount to address', () => {
  const {code, out} = run(['deploy-code', '--resume', LIVE, '--script', SCRIPT, '--onchain-uri', '--mint-amount', '2', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /this is a 721 SeriesCode contract, so --mint-amount has nothing to address/);
});
