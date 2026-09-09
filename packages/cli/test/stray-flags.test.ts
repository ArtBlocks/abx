import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

// `abx deploy-code … --chain sepolia` ran to completion on the DEFAULT chain (base-sepolia). There is
// no --chain flag — the chain is ABX_CHAIN — and the generic stray-flag WARNING said so, accurately,
// and then the command carried on. On a dry run that is a confused minute; on a funded send it is a
// wrong-chain deploy with real artifacts at an address nobody expects. These lock the refusal in.
//
// Run the real binary: what is under test is the exit code and the message a human/agent sees, which
// is exactly what a unit-level call would skip.

const CLI = resolve(import.meta.dirname, '../src/main.ts');

/** Strip ANSI so assertions match the words, not the colour codes. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

test('--chain is refused on every command, naming ABX_CHAIN and the active chain', () => {
  const {code, out} = run(['deploy-code', '--script', '/dev/null', '--chain', 'sepolia', '--dry-run']);
  assert.notEqual(code, 0, 'must exit nonzero');
  assert.match(out, /no --chain flag/);
  assert.match(out, /ABX_CHAIN/);
  assert.match(out, /base-sepolia/); // the chain it WOULD have used
  assert.match(out, /ABX_CHAIN=sepolia abx deploy-code/); // the corrected invocation
});

test('--chain is refused on a read-only command too (it must not teach the wrong model)', () => {
  const {code, out} = run(['state', '0x0000000000000000000000000000000000000001', '--chain', 'sepolia']);
  assert.notEqual(code, 0);
  assert.match(out, /ABX_CHAIN/);
});

test('an unknown flag on a tx-sending command REFUSES, and says why', () => {
  const {code, out} = run(['deploy', '--image', '/dev/null', '--name', 'T', '--symbol', 'T', '--bogus', 'x', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /unrecognized flag\(s\): --bogus/);
  assert.match(out, /refusing instead/);
});

test('the dry-run lane refuses identically to a real send', () => {
  // A preview that accepts what the send rejects would let you validate a command and have it fail at
  // the one moment it matters.
  const withDry = run(['deploy-series', '--dir', '/tmp', '--bogus', 'x', '--dry-run']);
  const without = run(['deploy-series', '--dir', '/tmp', '--bogus', 'x']);
  assert.notEqual(withDry.code, 0);
  assert.notEqual(without.code, 0);
  for (const r of [withDry, without]) assert.match(r.out, /unrecognized flag\(s\): --bogus/);
});

test('no false refusals: the documented deploy flags all pass the gate', () => {
  const {out} = run([
    'deploy', '--image', '/dev/null', '--name', 'T', '--symbol', 'T',
    '--onchain-uri', '--royalty-bps', '500', '--description-onchain',
    '--external-url', 'https://x.test', '--for', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    '--no-mint', '--dry-run',
  ]);
  assert.doesNotMatch(out, /unrecognized flag/);
});

// `abx tokenuri <addr> 0` silently ignored the `0` (the token id is `--token`) and printed token 0 —
// a coincidentally-correct answer, so the dropped argument was undetectable. `… <addr> 7` would have
// printed token 0 just as confidently, with exit 0.
test('tokenuri refuses a stray positional and names --token', () => {
  const {code, out} = run(['tokenuri', '0xC75761FBC5291014963B7FF45760326E7429C2Ee', '7']);
  assert.notEqual(code, 0, 'must not answer about a different token than asked');
  assert.match(out, /unexpected extra argument '7'/);
  assert.match(out, /--token 7/); // the corrected invocation
});

test('tokenuri does NOT mistake a flag value for a positional', () => {
  // The regression this guard can cause: `--token 0` parsed as a stray positional `0`. Both forms of
  // flag syntax must survive. (Exits nonzero only on network failure, never on argument parsing.)
  for (const args of [['--token', '0'], ['--token=0']]) {
    const {out} = run(['tokenuri', '0xC75761FBC5291014963B7FF45760326E7429C2Ee', ...args, '--json']);
    assert.doesNotMatch(out, /unexpected extra argument/, `${args.join(' ')} must parse cleanly`);
  }
});
