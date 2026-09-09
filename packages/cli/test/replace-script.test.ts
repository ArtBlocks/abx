// `abx replace-script` — the safe, first-class way to replace an UNLOCKED code project's
// on-chain program. Before this command the only writer of `setScriptChunk`/`removeLastScriptChunk`
// was `deploy-code` (initial setup, or its `--resume` leg for a setup that never landed); neither
// is "ship a fix to an already-live program".
//
// These spawn the real CLI against REAL, already-deployed fixtures (matching the established
// pattern in stray-flags.test.ts / edition-ownerops-live.test.ts — `detectTokenKind` and the chunk
// reads need a live chain, no injectable client in these command bodies) and run everything under
// `--dry-run`, which the CLI's own invariant guarantees sends nothing (see riskgate.ts's
// `assertLaneCanSign`/`gatedSend`) — every read here (owner, kind, scriptLocked, scriptChunkCount/
// scriptChunk) happens regardless of --dry-run, so the diff/refusal logic is exercised for real.
//
// The pure diff/verify logic (growing, shrinking/truncation, content-diff, half-applied
// verification failure) is pinned against a FAKE reader in packages/sdk/test/script-chunks.test.ts
// — no live fixture can safely exercise "shrink from 5 chunks to 2" or "half-applied" without a
// real send, which this tranche's rules forbid. What's pinned here is the command-level wiring:
// flag/file validation, the kind refusal, and a real content-diff against a fixture that genuinely
// holds an on-chain script.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const CLI = resolve(import.meta.dirname, '../src/main.ts');

// base-sepolia (the default chain — no ABX_CHAIN override needed), kind: code (SeriesCode),
// unlocked, exactly ONE on-chain script chunk — see edition-ownerops-live.test.ts's own note on
// this fixture ("ABX Code Fixture", maxInvocations 4, 2 minted). Its chunk 0 is a small (256-byte)
// p5.js sketch — reproduced verbatim below so a test can assert the NOOP path for real.
const CODE_FIXTURE = '0xC75761FBC5291014963B7FF45760326E7429C2Ee';
const CODE_FIXTURE_SOURCE =
  'function setup() {\n  createCanvas(400, 400);\n  noLoop();\n}\n' +
  'function draw() {\n  const h = (abx.tokenData.tokenId * 47) % 360;\n' +
  '  colorMode(HSB, 360, 100, 100);\n  background(h, 40, 12);\n  noStroke();\n' +
  '  fill((h + 40) % 360, 70, 90);\n  circle(200, 200, 220);\n}\n';

// The permanent OneOfOneEdition fixture ("ABX Edition Fixture" — edition-ownerops-live.test.ts's own
// note) on sepolia — an edition, but NOT a code kind (`paramHooks`/`scriptChunkCount` both revert),
// so it is the exact target `replace-script`'s kind guard exists to refuse.
const NOT_CODE_FIXTURE = '0x0a0AE8a00544654ca7848117E6DA9C44b39ebc08';

const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1', ...extraEnv},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

function tmpScript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'abx-replace-script-'));
  const p = join(dir, 'script.js');
  writeFileSync(p, content);
  return p;
}

// ── flag / file validation — fires before any chain read ─────────────────────

test('missing --script is refused with usage', () => {
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /missing --script/);
});

test('a --script path that does not exist is refused, naming the path', () => {
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', '/no/such/file.js', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /no file at \/no\/such\/file\.js/);
});

test('--chunk-size 0 is refused (must be a positive integer)', () => {
  const p = tmpScript(CODE_FIXTURE_SOURCE);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--chunk-size', '0', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /--chunk-size must be a positive integer/);
});

test('--chunk-size not-a-number is refused', () => {
  const p = tmpScript(CODE_FIXTURE_SOURCE);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--chunk-size', 'lots', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /--chunk-size must be a positive integer/);
});

test('an unparseable script is refused before any chain read (the deploy-code guard, reused)', () => {
  const p = tmpScript('function draw(){');
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /does not parse as JavaScript/);
});

// ── the kind guard: REFUSE, never warn, on a non-code target ──────────────────

test('refuses a non-code (OneOfOneEdition) target, naming its actual kind', () => {
  const p = tmpScript(CODE_FIXTURE_SOURCE);
  const {code, out} = run(['replace-script', NOT_CODE_FIXTURE, '--script', p, '--dry-run'], {ABX_CHAIN: 'sepolia'});
  assert.equal(code, 1);
  assert.match(out, /OneOfOneEdition/);
  assert.match(out, /no script to replace/);
});

// ── real content-diff against a live, unlocked, one-chunk fixture ────────────

test('byte-identical replacement is a NOOP — reports so and sends nothing', () => {
  const p = tmpScript(CODE_FIXTURE_SOURCE);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /1 chunk\(s\) on-chain → 1 chunk\(s\)/);
  assert.match(out, /no-op/);
  assert.doesNotMatch(out, /write \d+ chunk/);
});

test('changed content at the same chunk count queues exactly that one write', () => {
  const p = tmpScript(`${CODE_FIXTURE_SOURCE}\n// a deliberate change\n`);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /1 chunk\(s\) on-chain → 1 chunk\(s\)/);
  assert.match(out, /write 1 chunk\(s\): index 0/);
  assert.doesNotMatch(out, /no-op/);
});

test('a smaller --chunk-size that forces a 2-chunk split reports growth: 1 → 2, both indices queued', () => {
  // Same source, no content change — but a tighter chunk-size means the on-chain LAYOUT itself
  // (byte boundaries, not just content) is what's changing, so index 0 is queued too (it now holds
  // fewer bytes than the 256 stored on-chain) alongside the brand-new index 1.
  const p = tmpScript(CODE_FIXTURE_SOURCE);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--chunk-size', '150', '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /1 chunk\(s\) on-chain → 2 chunk\(s\)/);
  assert.match(out, /write 2 chunk\(s\): index 0, 1/);
});

test('an empty replacement script warns that it clears every on-chain chunk', () => {
  const p = tmpScript('');
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /is empty/);
  assert.match(out, /REMOVE every existing script chunk/);
  assert.match(out, /1 chunk\(s\) on-chain → 0 chunk\(s\)/);
  assert.match(out, /remove 1 trailing chunk/);
});

test('an unrecognized flag warns but does not block the run', () => {
  const p = tmpScript(CODE_FIXTURE_SOURCE);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--bogus-flag', 'x', '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /unrecognized flag|bogus-flag/i);
});

// ── gasFloor: a proven minimum, tightened after a funded sweep found the old (deposit-only) version
//    49% below what a real replace-script send needed — see replaceScriptGasFloor's own doc.
//    Recomputed here from the SAME real encoded calldata the CLI just produced (not a hardcoded
//    number tied to this fixture's exact byte count, which would break the moment the fixture's
//    source text changes), so this pins the FORMULA, not a fixture-specific constant.

test('--dry-run --json: gasFloor = 21,000 (base) + real calldata cost (EIP-2028) + 32,000×writes (CREATE) + 200×bytes (deposit)', () => {
  const p = tmpScript(`${CODE_FIXTURE_SOURCE}\n// a deliberate change\n`);
  const {code, out} = run(['replace-script', CODE_FIXTURE, '--script', p, '--dry-run', '--json']);
  assert.equal(code, 0, out);
  // `cmdReplaceScript` prints its own plain-text plan summary BEFORE `gatedSend`'s single JSON
  // payload (that narration isn't gated on --json) — take the output from the JSON's opening brace.
  const jsonStart = out.indexOf('{');
  assert.ok(jsonStart >= 0, `no JSON payload found in output:\n${out}`);
  const payload = JSON.parse(out.slice(jsonStart));
  const data: string = payload.transaction.data;
  assert.match(data, /^0x[0-9a-fA-F]*$/);
  const hexBody = data.slice(2);
  let calldataGas = 0n;
  for (let i = 0; i < hexBody.length; i += 2) {
    calldataGas += hexBody.slice(i, i + 2) === '00' ? 4n : 16n;
  }
  const depositedBytes = BigInt(payload.transaction.fields.bytes); // single write op (same chunk count)
  const expectedFloor = 21_000n + calldataGas + 32_000n * 1n + depositedBytes * 200n;
  assert.equal(BigInt(payload.transaction.gasFloor), expectedFloor);
  // And it must genuinely be higher than the old deposit-only floor would have been — the whole
  // point of the fix, not just a reformulation that happens to land on the same number.
  assert.ok(expectedFloor > depositedBytes * 200n);
});
