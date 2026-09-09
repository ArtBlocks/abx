/**
 * The CLI-only half of the on-chain-URI lane: the renderer spec-version lockstep gate
 * (`isCurrentRenderer`, in `@artblocks/abx-sdk`'s `anchors.ts`) and the end-to-end `--onchain-uri`
 * wiring through `abx deploy-code`. The
 * pure leg composition + verify-time reads (the bulk of the old file) moved to
 * `@artblocks/abx-sdk`'s `onchain-uri.ts` — see its test file.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const ANCHORS = resolve(dirname(fileURLToPath(import.meta.url)), '../../sdk/src/anchors.ts');

// ── the renderer spec gate stays in lockstep with the contract ────────────────
// `isCurrentRenderer` is what tells the toolkit a deployed renderer predates a projection this
// build emits. It's a plain exported SDK function now (anchors.ts), but the lockstep guarantee is
// the same one CLAUDE.md's rule makes executable: a SPEC_VERSION bump with no toolkit bump is the
// silent failure — this reads the SDK source rather than importing the function, so the assertion
// is against the literal gate in the file, not whatever a mock/stub might return.

test('isCurrentRenderer gates on the same SPEC_VERSION the renderer contract declares', () => {
  const sdk = readFileSync(ANCHORS, 'utf8');
  const gate = /return v === (\d+)n;/.exec(sdk);
  assert.ok(gate, 'isCurrentRenderer must gate on a literal spec version');
  // Snapshot of the current spec version. Line below is the durable invariant (the SDK gate and the
  // contract must move together); this one catches a bump nobody meant to make. v5 escaped the
  // `abx_provenance` note — a v4 renderer will forge provenance on request, so this gate is a
  // security floor, not just a feature floor. v11 projects `ipfs`/`arweave` through the
  // collection's preferred gateway; a v10 renderer serves the placeholder SVG for the same state.
  assert.equal(gate![1], '11');

  const sol = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/src/renderers/AbxMetadataRenderer.sol');
  const declared = /SPEC_VERSION\s*=\s*(\d+)\s*;/.exec(readFileSync(sol, 'utf8'));
  assert.ok(declared, 'AbxMetadataRenderer must declare SPEC_VERSION');
  assert.equal(gate![1], declared![1], 'the SDK gate and AbxMetadataRenderer.SPEC_VERSION must move together');
});

// ── the public-base-url requirement conditioning (spawned CLI, no RPC) ─────────

function runCli(args: string[]): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia'};
  delete env.ABX_PUBLIC_BASE_URL;
  delete env.ABX_DEV_ALLOW_LOCALHOST_URI;
  return new Promise((res) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', MAIN, ...args],
      {env, timeout: 60_000},
      (err, stdout, stderr) => {
        const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
        res({code, out: `${stdout}\n${stderr}`});
      },
    );
  });
}

test('deploy-code --onchain-uri: no --public-base-url needed — the localhost refusal is conditioned away', async () => {
  const {out} = await runCli(['deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run']);
  assert.doesNotMatch(out, /resolves for no one/i); // the guard never fires on the on-chain lane
  assert.match(out, /On-chain URI/); // the lane's resolution step ran (generator + renderer from the manifest)
  assert.match(out, /animation_url/i);
  assert.match(out, /ENOENT|no such file/i); // it proceeded to the content read (and failed there, before any RPC)
});

test('deploy-code without --onchain-uri: a missing public URL is still refused (and now offers the on-chain lane)', async () => {
  const {code, out} = await runCli(['deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX']);
  assert.notEqual(code, 0, `expected non-zero exit; got ${code}\n${out}`);
  assert.match(out, /resolves for no one/i);
  assert.match(out, /--onchain-uri/); // the refusal names the new escape
});
