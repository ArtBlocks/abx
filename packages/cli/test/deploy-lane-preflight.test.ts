// A spend or a publish never precedes the check that the run can be signed at all.
//
// The signing lanes were only checked at SIGNING time, which is the end of a deploy. Off-chain
// custody (`--backend arweave|ipfs|cloud`) uploads the creator's art near the START, before any tx
// exists. So `abx deploy-series --backend arweave` with no key and no `--dry-run` minted an Arweave
// identity and pushed the art — and only then discovered it could never have deployed. Under Turbo's
// free tier that upload SUCCEEDS, so the art is published permanently by a run that was always going
// to fail. Reproduced in a keyless clean room: it reached "[3] Prepare 1 token(s) … storage: arweave"
// and attempted the upload with no `ABX_DEPLOYER_PK` anywhere.
//
// `--dry-run` guards every signing choke point; this is the same rule one step earlier.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {assertLaneCanSign} from '../src/riskgate.ts';
import type {Flags} from '../src/flags.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const DIR = mkdtempSync(join(tmpdir(), 'abx-lane-'));
const SVG = join(DIR, 'a.svg');
const SKETCH = join(DIR, 'sketch.js');
writeFileSync(SVG, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
writeFileSync(SKETCH, 'function setup(){createCanvas(400,400);}\nfunction draw(){background(0);}\n');
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Run the preflight with `ABX_DEPLOYER_PK` set to exactly `pk` ('' = absent) and restore it. */
function withKey<T>(pk: string, fn: () => T): T {
  const prior = process.env.ABX_DEPLOYER_PK;
  process.env.ABX_DEPLOYER_PK = pk; // '' reads as absent (envSigningKey returns undefined)
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.ABX_DEPLOYER_PK;
    else process.env.ABX_DEPLOYER_PK = prior;
  }
}

test('hot lane with no key is refused — and the message says nothing was spent yet', () => {
  withKey('', () => {
    assert.throws(() => assertLaneCanSign({} as Flags), /could not be sent/);
    assert.throws(() => assertLaneCanSign({} as Flags), /before it uploads or spends anything/);
    // It must name all three lanes plus the preview, or the refusal is a dead end.
    assert.throws(() => assertLaneCanSign({} as Flags), /--sign/);
    assert.throws(() => assertLaneCanSign({} as Flags), /--unsigned/);
    assert.throws(() => assertLaneCanSign({} as Flags), /ABX_DEPLOYER_PK/);
    assert.throws(() => assertLaneCanSign({} as Flags), /--dry-run/);
  });
});

test('the lanes that deliberately have no local key are NOT refused', () => {
  withKey('', () => {
    assertLaneCanSign({sign: true, for: WALLET} as unknown as Flags); // browser wallet
    assertLaneCanSign({unsigned: true} as unknown as Flags); // offline signer
    assertLaneCanSign({'dry-run': true, for: WALLET} as unknown as Flags); // preview spends nothing
  });
});

test('the hot lane WITH a key proceeds', () => {
  withKey(KEY, () => {
    assertLaneCanSign({} as Flags);
  });
});

// ── the wiring: all three deploy commands must route through it ──────────────
function run(args: string[]): Promise<{out: string; code: number}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'base-sepolia', ABX_NO_UPDATE_CHECK: '1', ABX_DEPLOYER_PK: ''};
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 120_000}, (err, stdout, stderr) => {
      res({out: `${stdout}${stderr}`, code: err && typeof err.code === 'number' ? err.code : 0});
    });
  });
}

// It sits at the SPEND, not at the front door. Placing it at the command entry point broke a
// deliberate property this repo tests for elsewhere: a *validation* refusal (e.g. an
// ipfs-shaped `--image-base`) must reach a creator who has no key at all, because it costs nothing
// to check and is the more specific answer. So the four image deploy bodies assert it just before
// their first byte leaves — `deploy-code` has no deploy-time upload and is untouched.
for (const args of [
  ['deploy', '--image', SVG, '--onchain-uri', '--backend', 'arweave', '--name', 'Lane Test', '--symbol', 'LANE'],
  ['deploy-series', '--dir', DIR, '--onchain-uri', '--backend', 'arweave', '--name', 'Lane Test', '--symbol', 'LANE'],
]) {
  test(`abx ${args[0]} refuses a keyless real run before touching storage`, async () => {
    const {out, code} = await run(args);
    assert.equal(code, 1, out);
    // Either wording is a pass: `deploy` (1/1) needs the deployer address to predict the clone, so
    // it already hit the SDK's own MissingSigningKeyError before any upload — that path was never
    // exposed. `deploy-series` uploads the folder first, and is the one this guard exists for.
    assert.match(out, /signing key|could not be sent/i, out);
    // The property both must hold: nothing was uploaded and no Turbo identity was minted.
    assert.doesNotMatch(out, /arweave-key\.json|uploaded \d/i, out);
  });
}

test('a keyless run still gets VALIDATION refusals, which cost nothing to check', async () => {
  // deploy-code's ipfs-shaped --image-base refusal is the case with a test of its own
  // (deploy-code.test.ts) — this asserts the preflight did not move in front of it.
  const {out} = await run(['deploy-code', '--script', SKETCH, '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'https://ipfs.io/ipfs/bafy.../{id}.png']);
  assert.match(out, /content-addressed/i, out);
  assert.doesNotMatch(out, /could not be sent/, out);
});
