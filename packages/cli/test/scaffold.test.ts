import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {copyRendererScaffold, SCAFFOLD_ANCHOR} from '../src/scaffold.js';

// `abx scaffold-renderer` printed its full success walkthrough and exited 0 while writing ZERO files,
// for installed users while working in a development checkout.
//
// The cause was a cpSync filter that matched `node_modules` anywhere in the ABSOLUTE source path, so
// an installed CLI (…/node_modules/@artblocks/abx-cli/assets/renderer-scaffold) had its source root
// filtered out and cpSync silently copied nothing. The first test below is the one that was missing:
// it copies FROM a path containing `node_modules`, which is the only layout users have.

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

test('the generated workspace pins the canonical Solidity package version', () => {
  const version = readFileSync(resolve(import.meta.dirname, '../../../contracts/VERSION'), 'utf8').trim();
  const foundry = readFileSync(resolve(import.meta.dirname, '../assets/renderer-scaffold/foundry.toml'), 'utf8');
  assert.match(foundry, new RegExp(`abx-contracts\\s*=\\s*"${version.replaceAll('.', '\\.')}"`));
});

/** A minimal stand-in for assets/renderer-scaffold, including dirs that must NOT be copied. */
function fakeScaffold(root: string): string {
  const src = join(root, 'assets', 'renderer-scaffold');
  mkdirSync(join(src, 'src', 'interfaces'), {recursive: true});
  mkdirSync(join(src, 'script'), {recursive: true});
  mkdirSync(join(src, 'out', 'build-info'), {recursive: true}); // build junk — must be skipped
  mkdirSync(join(src, 'cache'), {recursive: true}); //              build junk — must be skipped
  writeFileSync(join(src, 'foundry.toml'), '[profile.default]\n');
  writeFileSync(join(src, 'src', 'MyRenderer.sol'), '// renderer\n');
  writeFileSync(join(src, 'src', 'interfaces', 'IAbxParams.sol'), '// iface\n');
  writeFileSync(join(src, 'script', 'Deploy.s.sol'), '// deploy\n');
  writeFileSync(join(src, 'out', 'build-info', 'x.json'), '{}');
  writeFileSync(join(src, 'cache', 'solidity-files-cache.json'), '{}');
  return src;
}

test('copies from a published node_modules path — the alpha.9→.14 empty-scaffold regression', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-scaffold-'));
  try {
    // The exact shape of every real install: the scaffold lives UNDER a `node_modules` segment.
    const src = fakeScaffold(join(tmp, 'node_modules', '@artblocks', 'abx-cli'));
    const dest = join(tmp, 'my-renderer');
    copyRendererScaffold(src, dest);

    assert.ok(existsSync(join(dest, SCAFFOLD_ANCHOR)), 'src/MyRenderer.sol must be written');
    assert.ok(existsSync(join(dest, 'foundry.toml')), 'foundry.toml must be written');
    assert.ok(existsSync(join(dest, 'script', 'Deploy.s.sol')), 'script/Deploy.s.sol must be written');
    assert.ok(existsSync(join(dest, 'src', 'interfaces', 'IAbxParams.sol')), 'interfaces must be written');
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('build/dependency dirs are still skipped (relative match, not substring)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-scaffold-'));
  try {
    const src = fakeScaffold(join(tmp, 'node_modules', '@artblocks', 'abx-cli'));
    const dest = join(tmp, 'my-renderer');
    copyRendererScaffold(src, dest);
    assert.ok(!existsSync(join(dest, 'out')), 'out/ must not be copied');
    assert.ok(!existsSync(join(dest, 'cache')), 'cache/ must not be copied');
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('a copy that writes nothing throws instead of reporting success', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-scaffold-'));
  try {
    const src = join(tmp, 'empty-source');
    mkdirSync(src, {recursive: true});
    const dest = join(tmp, 'my-renderer');
    assert.throws(() => copyRendererScaffold(src, dest), /wrote no files/);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('end to end: scaffold-renderer compatibility alias writes the shared workspace', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-scaffold-e2e-'));
  try {
    const dest = join(tmp, 'renderer');
    const out = plain(
      execFileSync('node', ['--import', 'tsx', CLI, 'scaffold-renderer', dest], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      }),
    );
    // The success banner is only honest if these exist — the pairing that was missing.
    assert.match(out, /ABX Solidity workspace/);
    assert.ok(readdirSync(dest).length > 0, 'scaffold dir must not be empty');
    for (const f of ['foundry.toml', 'README.md', SCAFFOLD_ANCHOR, join('src', 'MyTraits.sol'), join('script', 'Deploy.s.sol')]) {
      assert.ok(existsSync(join(dest, f)), `${f} must exist`);
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('end to end: scaffold solidity writes the shared role-separated workspace', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-scaffold-e2e-'));
  try {
    const dest = join(tmp, 'solidity');
    const out = plain(
      execFileSync('node', ['--import', 'tsx', CLI, 'scaffold', 'solidity', dest], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      }),
    );
    assert.match(out, /ABX Solidity workspace/);
    assert.ok(readdirSync(dest).length > 0, 'scaffold dir must not be empty');
    for (const f of [
      'foundry.toml',
      'README.md',
      SCAFFOLD_ANCHOR,
      join('src', 'MyHooks.sol'),
      join('test', 'MyRenderer.t.sol'),
      join('script', 'DeployHooks.s.sol'),
      join('script', 'Deploy.s.sol'),
    ]) {
      assert.ok(existsSync(join(dest, f)), `${f} must exist`);
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});
