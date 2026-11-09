import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {hexToString} from 'viem';
import {planOnChainScript} from '../src/script-chunks.js';

const MAIN = resolve(import.meta.dirname, '../src/main.ts');
const SOURCE = 'var td=(window.abx&&abx.tokenData)||{};\nvar s="<!--<script>";';

test('shared preparation warns without changing chunks or rejecting valid JavaScript', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const chunks = planOnChainScript(SOURCE);
  assert.equal(chunks.length, 1);
  assert.equal(hexToString(chunks[0]), SOURCE);
  const warning = error.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(warning, /Inline HTML compatibility \(line 2, column 8\)/);
  assert.match(warning, /browser never runs the program/);
  assert.match(warning, /ordinary string literal/);
  assert.doesNotMatch(warning, /add a matching/);
});

test('ordinary closing tags and a lone opener do not produce a compatibility warning', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  for (const source of ['var s="</SCRIPT>";', 'var s="<!--";', 'var s="<!--<script>-->";']) {
    assert.equal(hexToString(planOnChainScript(source)[0]), source);
  }
  assert.equal(error.mock.callCount(), 0);
});

function run(args: string[], cwd: string): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise((done) => {
    execFile(process.execPath, ['--import', import.meta.resolve('tsx'), MAIN, ...args], {
      cwd,
      // Deliberately no inherited credentials, remote/provider selection, or signing configuration.
      env: {PATH: process.env.PATH, TMPDIR: tmpdir(), ABX_CHAIN: args[0] === 'replace-script' ? 'base-sepolia' : 'sepolia', ABX_DEPLOYER_PK: '', ABX_NO_UPDATE_CHECK: '1', NO_COLOR: '1', ABX_DATA_DIR: join(cwd, 'data')},
      timeout: 60_000,
    }, (err, stdout, stderr) => done({code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr}));
  });
}

for (const [label, args] of [
  ['inspect', ['inspect', 'script.js']],
  ['SeriesCode deployment', ['deploy-code', '--script', 'script.js', '--name', 'HTML compatibility', '--symbol', 'HTML', '--onchain-uri', '--dry-run']],
  ['EditionCode deployment', ['deploy-code', '--script', 'script.js', '--copies', '10', '--max', '1', '--name', 'HTML compatibility', '--symbol', 'HTML', '--onchain-uri', '--dry-run']],
  ['script replacement', ['replace-script', '0xC75761FBC5291014963B7FF45760326E7429C2Ee', '--script', 'script.js', '--dry-run']],
] as const) {
  test(`${label}: CLI emits the diagnostic and leaves the source file unchanged`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abx-inline-html-'));
    try {
      writeFileSync(join(dir, 'script.js'), SOURCE);
      const result = await run([...args], dir);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /Inline HTML compatibility/);
      assert.doesNotMatch(result.stdout, /Inline HTML compatibility/);
      assert.equal(readFileSync(join(dir, 'script.js'), 'utf8'), SOURCE);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
}
