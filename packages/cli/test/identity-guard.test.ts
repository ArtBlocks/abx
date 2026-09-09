// The placeholder-identity guard, pinned across ALL THREE deploy commands.
//
// `name`/`symbol` go on-chain as the permanent public identity, so a real send must never bake a
// tool default. The check was duplicated per command and drifted (deploy-code's copy even claimed to
// "mirror deploy/deploy-series"); it's one shared predicate now, and this test is what keeps a
// fourth command — or a refactor — from quietly dropping it again.
//
// Preview-vs-real is the load-bearing distinction: a `--dry-run` only warns (so an agent can preview
// before it has the creator's title), while a real send refuses. Both halves are asserted here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const SOME_ADDR = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C';

function run(args: string[]): Promise<{out: string; code: number}> {
  // No key and no .env of our own: the guard must fire before any signing/RPC concern.
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'base-sepolia'};
  delete env.ABX_DEPLOYER_PK;
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 120_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({out: `${stdout}\n${stderr}`, code});
    });
  });
}

/** A folder of one tiny SVG — enough for deploy-series to reach the guard. */
function tmpSeriesDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-identity-'));
  writeFileSync(resolve(dir, '0.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
  return dir;
}

function tmpSketch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-identity-code-'));
  const p = resolve(dir, 'sketch.js');
  writeFileSync(p, 'function setup(){createCanvas(9,9);noLoop();}\nfunction draw(){background(0);}\n');
  return p;
}

const REFUSAL = /refusing to write tool placeholders as your public on-chain identity/;

test('deploy: a REAL send with no --name/--symbol is refused', async () => {
  const {out} = await run(['deploy', '--onchain-uri']);
  assert.match(out, REFUSAL);
});

test('deploy-series: a REAL send with no --name/--symbol is refused (the copy this command never had)', async () => {
  const {out} = await run(['deploy-series', '--dir', tmpSeriesDir(), '--onchain-image']);
  assert.match(out, REFUSAL);
});

test('deploy-code: a REAL send with no --name/--symbol is refused', async () => {
  const {out} = await run(['deploy-code', '--script', tmpSketch(), '--onchain-uri']);
  assert.match(out, REFUSAL);
});

test('a --dry-run WARNS instead of refusing, and says so exactly once', async () => {
  const {out} = await run(['deploy-series', '--dir', tmpSeriesDir(), '--onchain-image', '--dry-run', '--for', SOME_ADDR]);
  assert.doesNotMatch(out, REFUSAL, 'a preview must still run without an identity');
  assert.match(out, /no --name → default "ABX Series"/);
  assert.match(out, /no --symbol → default "ABXS"/);
  assert.equal(out.match(/no --name → default/g)?.length, 1, 'the guard should run once, not once per copy');
});

test('--yes is the explicit opt-in: the defaults are accepted rather than refused', async () => {
  const {out} = await run(['deploy-series', '--dir', tmpSeriesDir(), '--onchain-image', '--yes']);
  assert.doesNotMatch(out, REFUSAL);
});
