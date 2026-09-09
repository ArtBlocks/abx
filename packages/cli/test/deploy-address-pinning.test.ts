// A --dry-run without --salt must never print a predicted address: `saltFor` mixes in fresh
// entropy per call, so the address shown would NOT be the one a plain re-run lands on. The dry-run
// instead prints the salt itself, prominently, plus how to pin it (--salt <shown>, or `abx predict`).
// WITH --salt the address IS stable, so it prints exactly as before.
//
// Every deploy-family preview (dry-run and the --confirm summary) carries one uniform
// `approvals` line/clause — the count of WALLET TX SIGNATURES the real run will ask for (storage
// uploads are named separately, already).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const FOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const NO_KEY = {ABX_DEPLOYER_PK: ''};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');

function runCli(args: string[], overrides: Record<string, string> = {}): Promise<{code: number | null; out: string; stdout: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia'};
  delete env.ABX_PUBLIC_BASE_URL;
  delete env.ABX_DEV_ALLOW_LOCALHOST_URI;
  Object.assign(env, overrides);
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      // Narration goes to stderr under --json, so stdout is the JSON alone — no ANSI (--json
      // never colorizes its own payload) and no banner. Stripped ANSI everywhere else so a phrase
      // that spans a bold/dim wrap boundary (e.g. "…re-run with `--salt <bold>0x..</bold>` (same…")
      // still matches as one readable string.
      res({code, out: stripAnsi(`${stdout}\n${stderr}`), stdout: stdout.trim()});
    });
  });
}

function tmpImagesDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-series-imgs-'));
  writeFileSync(resolve(dir, '1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
  writeFileSync(resolve(dir, '2.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="blue"/></svg>');
  return dir;
}

function tmpSketch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-deploycode-pin-'));
  const p = resolve(dir, 'sketch.js');
  writeFileSync(p, 'function setup(){createCanvas(400,400);noLoop();}\nfunction draw(){background(0);}\n');
  return p;
}

// Extract the salt a no-salt preview printed, so a follow-up run can pin it.
function extractSalt(out: string): string {
  const m = out.match(/salt\s+(0x[0-9a-fA-F]{64})/);
  assert.ok(m, `expected a printed salt in:\n${out}`);
  return m![1];
}

test('deploy --dry-run WITHOUT --salt: no predicted address anywhere, salt is prominent, approvals is present', async () => {
  const {code, out} = await runCli(['deploy', '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /deterministic address:/);
  assert.match(out, /\bsalt\b\s+0x[0-9a-fA-F]{64}/);
  assert.match(out, /address: pinned by salt — re-run with --salt 0x[0-9a-fA-F]{64} \(same address\), or abx predict --salt 0x[0-9a-fA-F]{64} --for/);
  assert.match(out, /approvals {3}1 wallet approval\(s\)/);
  // No leftover "freshly-reserved" framing.
  assert.doesNotMatch(out, /freshly-reserved/);
});

test('deploy --dry-run WITH --salt: prints the address exactly as before, PLUS approvals', async () => {
  const preview = await runCli(['deploy', '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  const salt = extractSalt(preview.out);
  const pinned = await runCli(['deploy', '--onchain-uri', '--for', FOR, '--salt', salt, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  assert.equal(pinned.code, 0, pinned.out);
  assert.match(pinned.out, /deterministic address: 0x[0-9a-fA-F]{40}/);
  assert.match(pinned.out, /approvals {3}1 wallet approval\(s\)/);
  assert.doesNotMatch(pinned.out, /pinned by salt/); // that framing is the no-salt case only
});

test('deploy --dry-run --json WITHOUT --salt: address is null (not a real-looking, non-reproducible value)', async () => {
  const {code, out, stdout} = await runCli(['deploy', '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run', '--json'], NO_KEY);
  assert.equal(code, 0, out);
  const payload = JSON.parse(stdout);
  assert.equal(payload.address, null);
  assert.equal(payload.saltPinned, false);
  assert.match(payload.salt, /^0x[0-9a-fA-F]{64}$/);
});

test('deploy --dry-run --json WITH --salt: address matches the pinned prediction', async () => {
  const preview = await runCli(['deploy', '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run', '--json'], NO_KEY);
  const salt = JSON.parse(preview.stdout).salt as string;
  const pinned = await runCli(['deploy', '--onchain-uri', '--for', FOR, '--salt', salt, '--name', 'X', '--symbol', 'XX', '--dry-run', '--json'], NO_KEY);
  const payload = JSON.parse(pinned.stdout);
  assert.equal(payload.saltPinned, true);
  assert.match(payload.address, /^0x[0-9a-fA-F]{40}$/);
});

test('deploy-series --dry-run WITHOUT --salt: no predicted address, salt prominent, approvals present', async () => {
  const dir = tmpImagesDir();
  const {code, out} = await runCli(['deploy-series', '--dir', dir, '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /deterministic address:/);
  assert.match(out, /\bsalt\b\s+0x[0-9a-fA-F]{64}/);
  assert.match(out, /address: pinned by salt/);
  assert.match(out, /abx predict --dir .* --salt 0x[0-9a-fA-F]{64} --for/);
  assert.match(out, /approvals {3}1 wallet approval\(s\)/);
});

test('deploy-series --dry-run WITH --salt: address prints as before, plus approvals', async () => {
  const dir = tmpImagesDir();
  const preview = await runCli(['deploy-series', '--dir', dir, '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  const salt = extractSalt(preview.out);
  const pinned = await runCli(['deploy-series', '--dir', dir, '--onchain-uri', '--for', FOR, '--salt', salt, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  assert.equal(pinned.code, 0, pinned.out);
  assert.match(pinned.out, /deterministic address: 0x[0-9a-fA-F]{40}/);
  assert.match(pinned.out, /approvals {3}1 wallet approval\(s\)/);
});

test('deploy-code --dry-run WITHOUT --salt: no predicted address anywhere (incl. the Surfaces block\'s example commands), salt prominent', async () => {
  const script = tmpSketch();
  const {code, out} = await runCli(['deploy-code', '--script', script, '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /deterministic address:/);
  // The Surfaces block's runner/verify example commands must degrade to the placeholder too.
  assert.match(out, /<address>/);
  assert.doesNotMatch(out, /abx render 0x[0-9a-fA-F]{40}/);
  assert.doesNotMatch(out, /abx verify 0x[0-9a-fA-F]{40}/);
  assert.match(out, /\bsalt\b\s+0x[0-9a-fA-F]{64}/);
  assert.match(out, /address: pinned by salt/);
  assert.match(out, /abx predict --script .* --salt 0x[0-9a-fA-F]{64} --for/);
  // on-chain-uri with a program → the setup multicall rides too → 2 approvals.
  assert.match(out, /approvals {3}2 wallet approval\(s\)/);
});

test('deploy-code --dry-run WITH --salt: address prints as before everywhere it appeared, plus approvals', async () => {
  const script = tmpSketch();
  const preview = await runCli(['deploy-code', '--script', script, '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  const salt = extractSalt(preview.out);
  const pinned = await runCli(['deploy-code', '--script', script, '--onchain-uri', '--for', FOR, '--salt', salt, '--name', 'X', '--symbol', 'XX', '--dry-run'], NO_KEY);
  assert.equal(pinned.code, 0, pinned.out);
  assert.match(pinned.out, /deterministic address: 0x[0-9a-fA-F]{40}/);
  assert.match(pinned.out, /abx render 0x[0-9a-fA-F]{40} --remote|nothing to render/);
  assert.match(pinned.out, /approvals {3}2 wallet approval\(s\)/);
});

// The renderer-only fold (mirrors the existing "folds into 1 tx (no schema) / 2 tx (with schema)"
// test below) is the exact scenario where `approvals` and the existing `transactions:` line can
// diverge if either is computed independently; the hoist makes them share one `setupLen`.
test('deploy-code --dry-run renderer-only, no schema (folds into init): approvals is 1', async () => {
  const {code, out} = await runCli(
    [
      'deploy-code', '--image-renderer', '0x000000000000000000000000000000000000dEaD',
      '--attributes-renderer', '0x000000000000000000000000000000000000bEEf', '--onchain-uri',
      '--for', FOR, '--name', 'X', '--symbol', 'XX', '--mint-count', '1', '--dry-run',
    ],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /transactions:\s*1\b/i);
  assert.match(out, /approvals {3}1 wallet approval\(s\)/);
});

test('deploy-code --dry-run renderer-only, WITH a --schema: approvals is 2 — deploy + the setup multicall that enables it', async () => {
  const {code, out} = await runCli(
    [
      'deploy-code', '--image-renderer', '0x000000000000000000000000000000000000dEaD',
      '--attributes-renderer', '0x000000000000000000000000000000000000bEEf', '--onchain-uri',
      '--schema', 'palette:HexColor:TokenOwner', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--mint-count', '1', '--dry-run',
    ],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /transactions:\s*2\b/i);
  assert.match(out, /approvals {3}2 wallet approval\(s\)/);
});
