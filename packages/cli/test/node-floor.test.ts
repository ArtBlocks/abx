import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// `npm i -g @artblocks/abx-cli && abx doctor` on Node 22.5 died with a raw
// `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` stack trace — no mention of
// abx, no remedy, on the first command we tell every user to run. The crash happens while ESM
// *links* main.ts's import graph (output.ts -> @artblocks/abx-indexer -> node:sqlite), before any
// of our code runs, so only an import-free shim can catch it. These pin the shim and the invariant
// that makes it work.
//
// Everything here runs the shim as a real subprocess. bin.ts is deliberately NOT importable —
// importing it would run the CLI — so the old Node is reproduced from outside instead: a loader
// that hides node:sqlite, plus an optional `process.versions.node` spoof.

const BIN = resolve(import.meta.dirname, '../src/bin.ts');
const HIDE = pathToFileURL(resolve(import.meta.dirname, 'fixtures/hide-node-sqlite-register.mjs')).href;
/** Strip ANSI so assertions match the words, not the colour codes. */
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

/** Run the shim on a Node that cannot load node:sqlite, optionally reporting `fakeVersion`. */
function runWithoutSqlite(fakeVersion?: string): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--no-warnings', '--import', 'tsx', '--import', HIDE, BIN, 'doctor'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ABX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        ...(fakeVersion ? {ABX_TEST_FAKE_NODE: fakeVersion} : {}),
      },
    });
    return {code: 0, out: plain(out)};
  } catch (err) {
    const e = err as {status: number; stdout: string; stderr: string};
    return {code: e.status, out: plain(`${e.stdout}${e.stderr}`)};
  }
}

test('a Node that cannot load node:sqlite gets a remedy, not a stack trace', () => {
  const {code, out} = runWithoutSqlite();
  assert.equal(code, 1, 'must exit nonzero so scripts and agents see the failure');
  assert.match(out, /abx needs Node's built-in SQLite/);
  assert.match(out, /v22\.13\.0 or newer/, 'names the real floor');
  assert.match(out, /nvm install 22/, 'names the remedy');
  assert.doesNotMatch(out, /ERR_UNKNOWN_BUILTIN_MODULE/, 'no raw builtin-module error');
  assert.doesNotMatch(out, /at ModuleLoader/, 'no stack trace');
});

test("the reporter's Node 22.5.1 is told its own version, and the flag that would unblock it", () => {
  const {out} = runWithoutSqlite('22.5.1');
  assert.match(out, /you have\s+v22\.5\.1/, 'reflects the running version back');
  assert.match(out, /NODE_OPTIONS=--experimental-sqlite/, '22.5–22.12 has SQLite, just flag-gated');
});

test('the NODE_OPTIONS escape hatch is not offered where the flag cannot help', () => {
  // node:sqlite shipped in v22.5.0 behind --experimental-sqlite and lost the flag in v22.13.0 /
  // v23.4.0. Below v22.5.0 the module does not exist at any flag, so offering it would be a lie.
  assert.match(runWithoutSqlite('22.12.0').out, /NODE_OPTIONS=--experimental-sqlite/);
  for (const old of ['20.11.0', '18.0.0']) {
    assert.doesNotMatch(runWithoutSqlite(old).out, /NODE_OPTIONS/, `${old} predates node:sqlite entirely`);
  }
});

test('bin.ts stays import-free — the whole reason it can run first', () => {
  // ESM hoists and links every static import before the first module body executes. One static
  // import of anything in the CLI drags @artblocks/abx-indexer -> node:sqlite back into the link
  // phase and the guard below it never runs. That is the invariant, so it gets a test.
  const src = readFileSync(BIN, 'utf8');
  const statics = src.match(/^\s*import\s.*$/gm) ?? [];
  assert.deepEqual(statics, [], `bin.ts must have no static imports, found: ${statics.join(' | ')}`);
});

test('every published package declares the same, real Node floor', () => {
  // The floor was `>=22.5.0` in seven package.json files — the version node:sqlite was ADDED, not
  // the version it became usable without a flag. npm therefore stayed silent while installing onto
  // a Node that could not run the result.
  const root = resolve(import.meta.dirname, '../../..');
  for (const pkg of ['', 'cli', 'sdk', 'indexer', 'storage', 'token-api', 'effects']) {
    const path = pkg ? `${root}/packages/${pkg}/package.json` : `${root}/package.json`;
    const {engines} = JSON.parse(readFileSync(path, 'utf8')) as {engines?: {node?: string}};
    assert.equal(engines?.node, '>=22.13.0', `${path} declares the wrong Node floor`);
  }
});

test('the published bin points at the shim, not straight at main', () => {
  // If publishConfig.bin regresses to dist/main.js the guard is bypassed on exactly the installs
  // it protects — a published global install, which is where the report came from.
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
    publishConfig?: {bin?: Record<string, string>};
  };
  assert.equal(pkg.publishConfig?.bin?.abx, './dist/bin.js');
});
