import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planOnChainScript} from '../src/script-chunks.js';
import {refusePrewrappedImage} from '../src/ownerops.js';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');

test('planOnChainScript: a valid small script is one chunk', () => {
  const hex = planOnChainScript('const mass = 1;\nfunction draw(){}\n');
  assert.equal(hex.length, 1);
  assert.match(hex[0], /^0x/);
});

test('planOnChainScript: refuses a SyntaxError before any deploy', () => {
  assert.throws(() => planOnChainScript('function draw(){'), /does not parse as JavaScript/);
});

test('planOnChainScript: refuses a 22 kB+ line with no newline (the mass-split class)', () => {
  const src = `${'x'.repeat(22_000)}mass`;
  assert.throws(() => planOnChainScript(src), /no newline/);
});

// `replace-script` needs to force a smaller-than-default split so its diff/growth behaviour
// is exercisable against a small fixture — planOnChainScript's optional chunkSize is that knob.
test('planOnChainScript: an explicit chunkSize overrides the default split window', () => {
  const src = `${'a'.repeat(80)}\n${'b'.repeat(80)}\n`;
  assert.equal(planOnChainScript(src).length, 1); // fits in one chunk at the default size
  assert.equal(planOnChainScript(src, 90).length, 2); // forced to split at a 90-byte window
});

test('refusePrewrappedImage: a data URI is refused', () => {
  assert.throws(
    () => refusePrewrappedImage('data:image/svg+xml;base64,PHN2Zz4=', 'inline image'),
    /already a data URI/,
  );
  refusePrewrappedImage('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'inline image');
});

test('deploy-code --dry-run refuses an unparseable script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-script-parse-'));
  const p = join(dir, 'broken.js');
  writeFileSync(p, 'function draw(){');
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia', ABX_DEPLOYER_PK: ''};
  delete env.ABX_PUBLIC_BASE_URL;
  const {code, out} = await new Promise<{code: number | null; out: string}>((res) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', MAIN, 'deploy-code', '--script', p, '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
      {env, timeout: 60_000},
      (err, stdout, stderr) => {
        const c = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
        res({code: c, out: `${stdout}\n${stderr}`});
      },
    );
  });
  assert.notEqual(code, 0, out);
  assert.match(out, /does not parse as JavaScript/);
});
