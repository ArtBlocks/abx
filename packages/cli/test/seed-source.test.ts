// The seed-source membrane: the `--seed-source` flag grammar it shares with `abx set-seed-source`,
// the contradiction refusal, and the prose each probe verdict turns into.
//
// The stake: we tell creators (in the docs, in the contract's own NatSpec, and in `deploy-code
// --help`) that the answer to "the canonical seed isn't strong enough for my drop" is to point
// `seedSource` at their own IAbxSeedSource. That is only true if the flag exists, defaults to the
// canonical source, and refuses an address that would brick every mint. Membrane rule: enforce,
// don't warn — every bad input below is a REFUSAL naming the way out.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {getAddress, zeroAddress} from 'viem';
import {canonicalSeedSource, parseSeedSourceValue, refuseUnusableSeedSource} from '../src/ownerops.js';
import {DEPLOY_CODE_FLAGS, DEPLOY_CODE_EDITION_FLAGS} from '../src/commands/deploy.js';
import {DEPLOYMENTS, predictSeedSource, type SeedSourceProbe} from '@artblocks/abx-sdk';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const SEPOLIA = {chainId: 11155111};
const BASE_SEPOLIA = {chainId: 84532};
const UNSHIPPED = {chainId: 8453};
const CUSTOM = '0xa1B2c3d4E5f60718293a4B5C6d7E8F9012345678'; // EIP-55 checksummed

function runCli(args: string[], overrides: Record<string, string> = {}): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia'};
  delete env.ABX_PUBLIC_BASE_URL;
  delete env.ABX_DEV_ALLOW_LOCALHOST_URI;
  delete env.ABX_SEED_SOURCE;
  Object.assign(env, overrides);
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code, out: `${stdout}\n${stderr}`});
    });
  });
}

// ── the grammar ──────────────────────────────────────────────────────────────

// `canonical` must mean the shipped AbxSeedSource, and MUST NOT read ABX_SEED_SOURCE: that env var
// names the source you already configured, which is the exact thing `canonical` exists to name the
// alternative to. Asking for the canonical one and silently getting your override back would be the
// worst available answer.
test('canonical resolves to the manifest AbxSeedSource, and ignores ABX_SEED_SOURCE entirely', () => {
  const shipped = DEPLOYMENTS[SEPOLIA.chainId].seedSource!;
  assert.equal(canonicalSeedSource(SEPOLIA.chainId), shipped);
  assert.equal(parseSeedSourceValue('canonical', SEPOLIA), shipped);
  assert.equal(parseSeedSourceValue('Canonical', SEPOLIA), shipped); // case-insensitive
  assert.equal(parseSeedSourceValue('true', SEPOLIA), shipped); // a bare `--seed-source`
  assert.equal(parseSeedSourceValue('default', SEPOLIA), shipped); // the word a creator reaches for
  const before = process.env.ABX_SEED_SOURCE;
  try {
    process.env.ABX_SEED_SOURCE = CUSTOM;
    assert.equal(parseSeedSourceValue('canonical', SEPOLIA), shipped, 'env must not hijack `canonical`');
  } finally {
    if (before === undefined) delete process.env.ABX_SEED_SOURCE;
    else process.env.ABX_SEED_SOURCE = before;
  }
});

// The canonical singleton is CREATE2 + a fixed salt, so its address is identical on every chain —
// which is what lets an unshipped chain still resolve `canonical` to the right address rather than
// refusing (the deploy lane bootstraps it there).
test('canonical is cross-chain-identical, and an unshipped chain falls back to the prediction', () => {
  assert.equal(canonicalSeedSource(SEPOLIA.chainId), canonicalSeedSource(BASE_SEPOLIA.chainId));
  assert.equal(canonicalSeedSource(UNSHIPPED.chainId), predictSeedSource());
});

test('an explicit address is EIP-55 checksum-validated and canonicalized', () => {
  const lower = CUSTOM.toLowerCase();
  assert.equal(parseSeedSourceValue(lower, SEPOLIA), getAddress(lower)); // all-lowercase carries no checksum
  assert.equal(parseSeedSourceValue(CUSTOM, SEPOLIA), getAddress(CUSTOM));
  // A one-nibble transposition is a seed source that bricks every mint — refuse the mis-cased paste.
  const misCased = '0xA1B2c3d4E5f60718293a4B5C6d7E8F9012345678';
  assert.throws(() => parseSeedSourceValue(misCased, SEPOLIA), /checksum/);
  assert.throws(() => parseSeedSourceValue('0xnope', SEPOLIA), /0x address/);
  assert.throws(() => parseSeedSourceValue('vrf', SEPOLIA), /0x address/);
});

// One meaning, one spelling. `--no-seed` already means "no mint-time seed"; a second way to say it
// is how a creator ends up unsure which they used.
test('none at DEPLOY is refused and points at --no-seed; for the OWNER OP it clears', () => {
  for (const z of ['none', 'zero', '0', '0x0', zeroAddress]) {
    assert.throws(
      () => parseSeedSourceValue(z, SEPOLIA),
      (e: Error) => {
        assert.match(e.message, /--no-seed/);
        return true;
      },
      `expected deploy-side "${z}" to be refused`,
    );
    assert.equal(parseSeedSourceValue(z, {...SEPOLIA, allowNone: true}), zeroAddress, `"${z}" should clear`);
  }
});

// ── the probe's prose ────────────────────────────────────────────────────────

const probe = (p: Partial<SeedSourceProbe>): SeedSourceProbe =>
  ({verdict: 'ok', address: CUSTOM as `0x${string}`, ...p}) as SeedSourceProbe;

// Every verdict must throw (never warn-and-proceed), name the address, and state the actual contract
// requirement — a creator reading the refusal has to learn what a seed source IS, not just that
// theirs was rejected.
test('every unusable verdict throws, names the 32-byte requirement, and never merely warns', () => {
  const verdicts = ['no-code', 'empty-return', 'short-return', 'reverted', 'unreachable'] as const;
  for (const verdict of verdicts) {
    assert.throws(
      () => refuseUnusableSeedSource(probe({verdict, returnedBytes: 4, error: 'boom'}), {flag: '--seed-source', chainLabel: 'sepolia'}),
      (e: Error) => {
        assert.match(e.message, /--seed-source/, verdict);
        assert.match(e.message, new RegExp(CUSTOM, 'i'), verdict);
        assert.match(e.message, /sepolia/, verdict);
        if (verdict !== 'unreachable') assert.match(e.message, /32 bytes/, verdict);
        return true;
      },
      verdict,
    );
  }
});

// The two verdicts whose CAUSE a creator cannot guess get named causes: the permissive-fallback
// shape (pasting your own Safe is the common way in) and a gated/unarmed real source.
test('empty-return names the Safe/proxy/7702 shape; reverted names both the wrong-address and the not-yet-armed case', () => {
  assert.throws(
    () => refuseUnusableSeedSource(probe({verdict: 'empty-return', returnedBytes: 0}), {flag: '--seed-source', chainLabel: 'sepolia'}),
    /Safe/,
  );
  assert.throws(
    () => refuseUnusableSeedSource(probe({verdict: 'reverted', error: 'NotArmed()'}), {flag: 'set-seed-source', chainLabel: 'sepolia'}),
    (e: Error) => {
      assert.match(e.message, /NotArmed/); // the revert reason survives
      assert.match(e.message, /not yet armed|not a seed source at all/i);
      return true;
    },
  );
});

// An RPC failure is not a verdict about the address — the message must not accuse the contract.
test('unreachable refuses without blaming the address', () => {
  assert.throws(
    () => refuseUnusableSeedSource(probe({verdict: 'unreachable', error: 'ECONNREFUSED'}), {flag: '--seed-source', chainLabel: 'sepolia'}),
    (e: Error) => {
      assert.match(e.message, /RPC|blind|retry/i);
      return true;
    },
  );
});

// ── the CLI membrane ─────────────────────────────────────────────────────────

// Two flags, one InitParams field. Picking a winner betrays half of whoever passed both.
test('deploy-code refuses --no-seed together with --seed-source, before any network call', async () => {
  const {code, out} = await runCli([
    'deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX',
    '--onchain-uri', '--no-seed', '--seed-source', CUSTOM, '--dry-run',
  ]);
  assert.notEqual(code, 0, `expected non-zero exit; got ${code}\n${out}`);
  assert.match(out, /--no-seed and --seed-source contradict/i);
});

// Both code lanes must ACCEPT the flag. The 721 lane and the `--copies` edition lane keep separate
// allowlists, and a flag added to only one is the exact drift that shipped `deploy-code` without the
// localhost guard — so assert the allowlists directly, then assert the CLI doesn't complain.
test('--seed-source is on BOTH code-lane allowlists, and neither lane calls it a stray flag', async () => {
  assert.ok(DEPLOY_CODE_FLAGS.has('seed-source'), '721 code lane');
  assert.ok(DEPLOY_CODE_EDITION_FLAGS.has('seed-source'), 'edition (--copies) code lane');
  for (const extra of [[], ['--copies', '5']]) {
    const {out} = await runCli([
      'deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX',
      '--onchain-uri', '--seed-source', 'canonical', '--dry-run', ...extra,
    ]);
    assert.doesNotMatch(out, /unrecognized|unsupported flag|did you mean/i, `--copies:${extra.length > 0}\n${out}`);
  }
});

// A bad address is caught by the GRAMMAR before any RPC — the cheapest possible refusal, and the one
// that works with no network at all.
test('deploy-code refuses a checksum-broken --seed-source without touching the chain', async () => {
  const {code, out} = await runCli([
    'deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX',
    '--onchain-uri', '--seed-source', '0xA1B2c3d4E5f60718293a4B5C6d7E8F9012345678', '--dry-run',
  ]);
  assert.notEqual(code, 0);
  assert.match(out, /checksum/i);
});

// `--resume` replays the SETUP transaction of an existing contract; the seed source is an InitParams
// field, fixed at creation. So the flag has nothing to write — but `--resume`'s own contract is "pass
// the same content flags", so refusing it would break a documented workflow. Say so instead, and name
// the verb that CAN change it. (Silently resolving it was the old behaviour, and on a non-dry-run
// resume that even lazily deployed the canonical singleton for nothing.)
test('--resume + --seed-source: not refused, but says the source is read from chain, not written', async () => {
  const {out} = await runCli([
    'deploy-code', '--resume', '0x00000000000000000000000000000000DeaDBeef',
    '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX', '--onchain-uri',
    '--seed-source', 'canonical',
  ]);
  assert.match(out, /--resume: the seed source was fixed when/);
  assert.match(out, /abx set-seed-source/);
  // …and it must NOT have gone on to probe or deploy a seed source.
  assert.doesNotMatch(out, /not a usable seed source/);
});

// The owner op's own guards, both reachable with no chain: a missing value arg, and the grammar.
test('set-seed-source without a value prints usage and exits non-zero', async () => {
  const {code, out} = await runCli(['set-seed-source', '0x1111111111111111111111111111111111111111']);
  assert.notEqual(code, 0);
  assert.match(out, /usage: abx set-seed-source .*canonical\|none/);
});

test('set-seed-source has a help entry that names the probe and the future-mints-only rule', async () => {
  const {out} = await runCli(['help', 'set-seed-source']);
  assert.match(out, /abx set-seed-source/);
  assert.match(out, /seed\(uint256,address\)/);
  assert.match(out, /FUTURE MINTS ONLY/i);
  assert.match(out, /Code projects only/i);
});
