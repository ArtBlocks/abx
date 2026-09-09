// Live-fixture regression guards for the edition owner-ops refusal matrix (mint/transfer/
// set-max-supply/ping-uri/minter). `detectTokenKind` needs a REAL chain read (no injectable client
// in these command bodies), so — matching the established pattern in stray-flags.test.ts — these
// spawn the real CLI against a REAL, already-deployed 721 fixture on the default chain
// (base-sepolia): a SeriesCode project ("ABX Code Fixture", maxInvocations 4, 2 minted, tokenURI
// on-chain). Nothing here reads its supply or its hooks — every assertion is about the CLI refusing
// an edition-only flag on a 721 — so the fixture only has to BE a canonical SeriesCode.
//
// The POSITIVE edition path runs against a permanent Sepolia fixture: a 50-copy OneOfOneEdition
// ("ABX Edition Fixture") with a configured 1155-minter sale, an assigned minter, and a primary
// payee — see the EDITION_FIXTURE tests at the bottom. The refusal-matrix half ("refused on a 721
// target") keeps using the SeriesCode fixture.
//
// BOTH fixtures are re-cut whenever a redeploy moves the anchor they came from, rather than having
// their assertions relaxed — see the note above EDITION_FIXTURE for why that is the whole point.
//
// Every refusal here fires BEFORE `gatedSend` — detectTokenKind + the owner read happen first — so
// `--dry-run` changes nothing about whether it fires (the same "dry-run refuses identically to a
// real send" invariant stray-flags.test.ts locks for the generic stray-flag case).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const SERIES_CODE_FIXTURE = '0xC75761FBC5291014963B7FF45760326E7429C2Ee'; // base-sepolia, kind: code

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

test('mint: --token-id is refused on a 721 (SeriesCode) target, naming the kind', () => {
  const {code, out} = run(['mint', SERIES_CODE_FIXTURE, '--token-id', '0', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /--token-id\/--amount are edition-only/);
  assert.match(out, /SeriesCode/);
});

test('mint: --amount is refused on a 721 target the same way as --token-id', () => {
  const {code, out} = run(['mint', SERIES_CODE_FIXTURE, '--amount', '3', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /--token-id\/--amount are edition-only/);
});

test('transfer: --amount is refused on a 721 target ("a token transfers as a whole")', () => {
  const {code, out} = run(['transfer', SERIES_CODE_FIXTURE, '--to', '0x000000000000000000000000000000000000dEaD', '--amount', '2', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /--amount is edition-only/);
  assert.match(out, /transfers as a whole/);
});

test('set-max-supply: refused outright on a 721 target, points at set-max-invocations', () => {
  const {code, out} = run(['set-max-supply', SERIES_CODE_FIXTURE, '--token-id', '0', '--cap', '10', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /set-max-supply is edition-only/);
  assert.match(out, /set-max-invocations/);
});

test('set-max-supply: --cap open is refused REGARDLESS of target kind (checked before the kind guard’s outcome matters)', () => {
  // Even against a 721 (which refuses on kind first), the message identifies which guard actually
  // fired — this asserts the KIND refusal wins (it runs first), not the --cap-open refusal.
  const {code, out} = run(['set-max-supply', SERIES_CODE_FIXTURE, '--token-id', '0', '--cap', 'open', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /set-max-supply is edition-only/);
});

test('ping-uri: refused outright on a 721 target (721 has ERC-4906 instead)', () => {
  const {code, out} = run(['ping-uri', SERIES_CODE_FIXTURE, '--token-ids', '0,1,2', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /ping-uri is edition-only/);
  assert.match(out, /ERC-4906/);
});

test('minter configure: --token-id is refused on a 721 target', () => {
  const {code, out} = run(['minter', 'configure', SERIES_CODE_FIXTURE, '--price', '0.01', '--allocation', '5', '--token-id', '0', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /--token-id is edition-only/);
});

test('minter show: --token-id is refused on a 721 target', () => {
  const {code, out} = run(['minter', 'show', SERIES_CODE_FIXTURE, '--token-id', '0']);
  assert.notEqual(code, 0);
  assert.match(out, /--token-id is edition-only/);
});

test('minter buy: --token-id/--quantity are refused on a 721 target', () => {
  const {code, out} = run(['minter', 'buy', SERIES_CODE_FIXTURE, '--token-id', '0', '--quantity', '2', '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /--token-id\/--quantity are edition-only/);
});

test('the 721 lane is unchanged: a bare mint dry-run on the fixture never mentions "edition-only"', () => {
  // Regression check — no --token-id/--amount at all, so the new branch must not fire (byte-identical
  // 721 behavior). Tolerant of the underlying read failing for an unrelated reason (RPC hiccup); the
  // one thing that must NEVER happen is the edition guard firing on a plain mint.
  const {out} = run(['mint', SERIES_CODE_FIXTURE, '--dry-run']);
  assert.doesNotMatch(out, /edition-only/);
});

// ── positive edition path: the permanent Sepolia OneOfOneEdition fixture ─────────
// Live facts asserted here are OWNER-CONTROLLED and permanent (assigned minter, primary payee,
// per-id cap); anything the public can move (copies sold on the open sale) is matched loosely.
// Re-cut on every greenfield redeploy that moves the edition anchors — five times so far, most
// recently when widening the configure hook with its blob arguments moved `AbxParamsLib`, and with it
// `AbxEditionLib` and the four token types that compose `ConfigurableParams`. Every time, the old fixture stayed FUNCTIONAL but stopped being
// canonical (`isAbxClone` on the current factory returns false for it) and kept pointing at the
// superseded shared 1155 minter — so it correctly read "assigned on token: no" against the new
// manifest, which is exactly what a creator sees if they don't redeploy. Replaced rather than
// relaxed, every time: the assertion is the point of the test. This one is a 50-copy
// on-chain-SVG OneOfOneEdition from the current OneOfOneEditionFactory, with the shared minter
// assigned, a payee set, and an allocation of 10 on the open sale.
const EDITION_FIXTURE = '0x0a0AE8a00544654ca7848117E6DA9C44b39ebc08'; // sepolia, OneOfOneEdition
const EDITION_MINTER = '0x8FcC37dCb00A02367838Fa5B37347dCEec060981'; // canonical AbxFixedPriceMinter1155
const FIXTURE_OWNER = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C';

function runSepolia(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1', ABX_CHAIN: 'sepolia'},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

test('minter show (edition): reads assignment/payee through the EDITION ABI — regression for the false "not assigned" bug', () => {
  // The bug: minter()/primaryPayee() were read via the 721 1/1 ABI, whose client-side throw was
  // swallowed into zeroAddress — every correctly-configured edition read as "no — set-minter …".
  const {code, out} = runSepolia(['minter', 'show', EDITION_FIXTURE, '--token-id', '0']);
  assert.equal(code, 0);
  assert.match(out, /assigned on token: yes/);
  assert.match(out, new RegExp(FIXTURE_OWNER, 'i')); // primary payee = the fixture owner, printed verbatim
  assert.doesNotMatch(out, /primary payee:\s+none/);
  assert.match(out, /\/10 sold/); // allocation is owner-set; sold moves only toward 10
});

test('minter configure (edition, dry-run): the readiness footer reads through the EDITION ABI too', () => {
  // The SAME false "not assigned" bug as the show path above, which survived in `minter configure`
  // because only `show` used the edition ABI. An edition that already had its minter assigned and
  // its payee set still printed BOTH warnings,
  // because the footer read minter()/primaryPayee() through the 721 ABI and swallowed the throw.
  // --dry-run sends nothing but still reaches the footer, so this asserts the real reads.
  const {code, out} = runSepolia([
    'minter', 'configure', EDITION_FIXTURE, '--token-id', '0', '--price', '0.001', '--allocation', '10', '--dry-run',
  ]);
  assert.equal(code, 0);
  assert.match(out, /minter is assigned on the token/);
  assert.doesNotMatch(out, /assign this minter on the token/); // the warning form, not the ✓ form
  assert.doesNotMatch(out, /set a primary payee/);
  assert.match(out, new RegExp(`proceeds → ${FIXTURE_OWNER}`, 'i'));
});

test('state (edition): shows the per-id supply readout and no 721 supply line', () => {
  const {code, out} = runSepolia(['state', EDITION_FIXTURE]);
  assert.equal(code, 0);
  assert.match(out, /copies of #0/);
  assert.match(out, /\(50 cap\)/); // set-max-supply 50 is owner-only and monotonic — permanent ceiling
});
