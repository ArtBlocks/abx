// Guards on how the CLI locates the files it SHIPS — the bundled agent skill and the Foundry
// renderer scaffold.
//
// `abx skill install` must resolve from the published package layout; the canonical
// way a user installs the agent skill, and the first thing our own quickstart tells them to run —
// failed on every fresh global npm install with "bundled skill not found". `abx scaffold-renderer`
// was broken by the same cause and nobody had reported it yet.
//
// The cause was arithmetic. Both functions computed the package root as
// `resolve(fileURLToPath(import.meta.url), '..', '..')`, which is correct for a module compiled to
// `dist/main.js` and off by one for a module compiled to `dist/commands/scaffold.js`. Both live in
// `src/commands/`, so both landed on `dist/` and looked for `<pkg>/dist/skill`.
//
// Nothing caught it because **dev never exercises the published layout**: running from source, both
// functions fall back to the canonical repo copies and work regardless of the arithmetic. The tests
// below therefore assert the two things that hold in BOTH layouts — resolution lands inside the
// package root, and no module computes that root by counting `..`.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {findCliPackageRoot, findRepoRoot, packageRootFrom} from '../src/output.ts';
import {archiveLegacySkillDir, resolveBundledSkill, resolveRendererScaffold} from '../src/commands/scaffold.ts';

test('findCliPackageRoot lands on the CLI package root, not on dist/ or src/', () => {
  const root = findCliPackageRoot();
  assert.ok(root, 'the CLI must be able to find its own package root');
  const pkg = JSON.parse(readFileSync(join(root!, 'package.json'), 'utf8')) as {name?: string};
  assert.equal(pkg.name, '@artblocks/abx-cli', 'must stop at OUR package.json, not a nested one');
  // The bug in one assertion: the resolved root is not the directory the code is compiled into.
  assert.notEqual(root!.split(sep).pop(), 'dist');
  assert.notEqual(root!.split(sep).pop(), 'src');
});

test('the renderer scaffold resolves under the package root (the sibling bug, unreported)', () => {
  const found = resolveRendererScaffold();
  assert.ok(found, 'scaffold-renderer needs its assets or the command is dead');
  assert.equal(found, join(findCliPackageRoot()!, 'assets', 'renderer-scaffold'));
  assert.ok(existsSync(join(found!, 'foundry.toml')));
});

test('the bundled skill resolves to a real SKILL.md', () => {
  const found = resolveBundledSkill();
  assert.ok(found, 'skill install is the canonical install path — it must resolve');
  assert.ok(existsSync(join(found!, 'SKILL.md')));
});

test('legacy skill migration archives custom bytes outside the discovery tree instead of deleting them', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-skill-migrate-'));
  const legacy = join(tmp, '.claude', 'skills', 'abx-self-host');
  const backups = join(tmp, '.abx-skill-backups');
  mkdirSync(join(legacy, 'reference'), {recursive: true});
  writeFileSync(join(legacy, 'SKILL.md'), '---\nname: abx-self-host\nmetadata:\n  version: "0.1.0-alpha.31"\n---\ncustom body\n');
  writeFileSync(join(legacy, 'reference', 'custom.md'), 'user customization\n');

  const archived = archiveLegacySkillDir(legacy, backups);
  assert.ok(archived);
  assert.equal(existsSync(legacy), false, 'the legacy trigger path must leave the discovery tree');
  assert.equal(readFileSync(join(archived!, 'reference', 'custom.md'), 'utf8'), 'user customization\n');
});

test('skill install --target migrates the legacy trigger and installs only the renamed abx skill', () => {
  const target = mkdtempSync(join(tmpdir(), 'abx-skill-target-'));
  const legacy = join(target, 'abx-self-host');
  mkdirSync(legacy, {recursive: true});
  writeFileSync(join(legacy, 'SKILL.md'), '---\nname: abx-self-host\nmetadata:\n  version: "0.1.0-alpha.31"\n---\ncustom body\n');
  writeFileSync(join(legacy, 'CUSTOM.txt'), 'preserve me\n');

  const cli = join(findRepoRoot()!, 'packages', 'cli', 'src', 'main.ts');
  const output = execFileSync('node', ['--import', 'tsx', cli, 'skill', 'install', '--target', target], {
    // Resolve the source-only tsx loader from the checkout; --target still keeps every write isolated.
    cwd: findRepoRoot()!,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });

  assert.match(output, /archived legacy .*abx-self-host.*\.abx-skill-backups/);
  assert.match(output, /installed the abx skill/);
  assert.ok(existsSync(join(target, 'abx', 'SKILL.md')));
  assert.equal(existsSync(legacy), false);
  const backups = join(target, '.abx-skill-backups');
  const archived = readdirSync(backups).find((name) => name.startsWith('abx-self-host-'));
  assert.ok(archived);
  assert.equal(readFileSync(join(backups, archived!, 'CUSTOM.txt'), 'utf8'), 'preserve me\n');
});

test('in a source checkout the skill resolves to the CANONICAL copy, never the prepack bundle', () => {
  // `<pkg>/skill` is gitignored prepack OUTPUT that may be arbitrarily old. Preferring it in a
  // checkout once overwrote the canonical skill with a copy eight versions behind, and the drift
  // check then reported the damage as if the user had caused it. A stale bundle may be sitting there
  // right now (any `npm pack` leaves one), so this asserts the precedence rather than the absence.
  const root = findRepoRoot();
  assert.ok(root, 'this test only means anything inside the working tree');
  assert.equal(resolveBundledSkill(), join(root!, '.claude', 'skills', 'abx'));
});

test('packageRootFrom walks correctly at EVERY nesting depth — the published layout dev never has', () => {
  // The test the original bug needed. A dev run always finds the canonical repo copies, so both
  // resolvers worked no matter what the arithmetic said; only a published install exposed it. Here the
  // published layout is built on disk and walked from each depth a compiled module can sit at.
  const tmp = mkdtempSync(join(tmpdir(), 'abx-pkgroot-'));
  const pkg = join(tmp, 'node_modules', '@artblocks', 'abx-cli');
  mkdirSync(join(pkg, 'dist', 'commands'), {recursive: true});
  mkdirSync(join(pkg, 'skill'), {recursive: true});
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({name: '@artblocks/abx-cli', version: '0.0.0'}));
  writeFileSync(join(pkg, 'skill', 'SKILL.md'), '---\nversion: 0.0.0\n---\n');

  // one level deep (dist/main.js) and two (dist/commands/scaffold.js) must give the SAME root —
  // that equality is precisely what a counted `'..','..'` gets wrong.
  assert.equal(packageRootFrom(join(pkg, 'dist', 'main.js')), pkg, 'one level deep');
  assert.equal(packageRootFrom(join(pkg, 'dist', 'commands', 'scaffold.js')), pkg, 'two levels deep');
  assert.equal(packageRootFrom(join(pkg, 'dist', 'a', 'b', 'c', 'deep.js')), pkg, 'arbitrarily deep');

  // and a `dist/package.json` (the ESM/CJS dual-publish trick) must not stop the walk short
  writeFileSync(join(pkg, 'dist', 'package.json'), JSON.stringify({type: 'module'}));
  assert.equal(
    packageRootFrom(join(pkg, 'dist', 'commands', 'scaffold.js')),
    pkg,
    'a nameless dist/package.json must not be mistaken for the root',
  );

  // no package.json anywhere above → null, never a wrong guess
  const orphan = mkdtempSync(join(tmpdir(), 'abx-orphan-'));
  mkdirSync(join(orphan, 'x'), {recursive: true});
  assert.equal(packageRootFrom(join(orphan, 'x', 'y.js')), null);

  rmSync(tmp, {recursive: true, force: true});
  rmSync(orphan, {recursive: true, force: true});
});

test('no module locates the package root by counting `..` — the whole bug class', () => {
  // The durable half of the fix. A fixed hop count is only correct for one nesting depth, so it
  // breaks silently the day a file moves between `src/` and `src/commands/` — which is exactly what
  // happened. `findCliPackageRoot()` walks up and is depth-independent; this keeps the counted form
  // from coming back.
  const srcDir = join(findCliPackageRoot()!, 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        // `resolve(fileURLToPath(import.meta.url), '..', '..', …)` in any spelling. One `..` is fine
        // — that is just "the directory holding this file", which no amount of nesting changes.
        // Catches BOTH spellings the bug was written in: inlined
        // (`resolvePath(fileURLToPath(import.meta.url), '..', '..')`) and via an intermediate
        // variable (`const here = fileURLToPath(...); resolvePath(here, '..', '..')`). The first
        // version of this guard only caught the inlined one and so could not fail — found by
        // mutation-testing it.
        const re = /resolve\w*\(\s*[^)]*?,\s*'\.\.'\s*,\s*'\.\.'/g;
        if (re.test(src)) offenders.push(p.slice(srcDir.length + 1));
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(
    offenders,
    [],
    `these compute a package root by counting '..' — use findCliPackageRoot() instead: ${offenders.join(', ')}`,
  );
});
