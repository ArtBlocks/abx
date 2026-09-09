/**
 * The CLI-local half of the deploy-time dependency lane: `--dep`/`--dep-registry` flag parsing
 * (`parseFlags`/`parseDepFlag`) and the end-to-end wiring through `abx deploy-code`. The pure
 * downstream logic (registry-pointer defaulting, setup-multicall leg composition, the
 * selection-time registry check) moved to `@artblocks/abx-sdk`'s `deps.ts` — see its test file.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {DEP_RESOLUTION} from '@artblocks/abx-sdk';
import {parseFlags} from '../src/flags.js';
import {parseDepFlag} from '../src/deps.js';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');

// ── flag parsing: --dep repeats accumulate (order-preserving) + comma-splits ──

test('parseFlags: repeated --dep accumulates comma-joined, in argv order', () => {
  const flags = parseFlags(['--dep', 'p5@1.0.0', '--name', 'X', '--dep', '0x1111111111111111111111111111111111111111']);
  assert.equal(flags.dep, 'p5@1.0.0,0x1111111111111111111111111111111111111111');
  assert.equal(flags.name, 'X');
});

test('parseFlags: --dep=a,b mixes with a repeated --dep c; other flags still overwrite', () => {
  const flags = parseFlags(['--dep=p5@1.0.0,three@0.124.0', '--dep', 'cannon-es@0.20.0', '--max', '4', '--max', '8']);
  assert.equal(flags.dep, 'p5@1.0.0,three@0.124.0,cannon-es@0.20.0');
  assert.equal(flags.max, '8'); // non-repeatable: last one wins, unchanged behavior
});

test('parseDepFlag: comma-split + ordered parse (index 0 = the runtime); empty/absent → []', () => {
  const deps = parseDepFlag('p5@1.0.0, 0x000000000000000000000000000000000000cafe');
  assert.equal(deps.length, 2);
  assert.equal(deps[0].display, 'p5@1.0.0');
  assert.equal(deps[0].resolution, DEP_RESOLUTION.registry);
  assert.equal(deps[1].resolution, DEP_RESOLUTION.onchain); // address auto-detected
  assert.deepEqual(parseDepFlag(undefined), []);
  assert.deepEqual(parseDepFlag(''), []);
  assert.throws(() => parseDepFlag('true'), /--dep needs a ref/); // bare --dep
  assert.throws(() => parseDepFlag('p5'), /exactly one '@'/);
});

// ── end-to-end wiring: a malformed --dep fails BEFORE any network / file read ──

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

test('deploy-code rejects a malformed --dep up front (before content read / any send)', async () => {
  const {code, out} = await runCli([
    'deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX',
    '--public-base-url', 'https://meta.example.com', '--dep', 'p5', '--dry-run',
  ]);
  assert.notEqual(code, 0, `expected non-zero exit; got ${code}\n${out}`);
  assert.match(out, /exactly one '@'/);
  assert.doesNotMatch(out, /ENOENT/); // dep validation precedes the script read
});

test('deploy-code rejects a malformed --dep-registry up front', async () => {
  const {code, out} = await runCli([
    'deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX',
    '--public-base-url', 'https://meta.example.com', '--dep', 'p5@1.0.0', '--dep-registry', 'nope', '--dry-run',
  ]);
  assert.notEqual(code, 0);
  assert.match(out, /--dep-registry must be an address/);
});
