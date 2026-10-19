import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installSkillTo} from '../src/commands/scaffold.js';

function fixture(): {root: string; real: string; link: string} {
  const root = mkdtempSync(join(tmpdir(), 'abx-skill-install-'));
  const real = join(root, 'plugin', 'skills', 'abx');
  mkdirSync(join(real, 'reference'), {recursive: true});
  writeFileSync(join(real, 'SKILL.md'), '---\nname: abx\n---\n');
  writeFileSync(join(real, 'reference', 'setup.md'), 'setup\n');
  mkdirSync(join(root, '.claude', 'skills'), {recursive: true});
  const link = join(root, '.claude', 'skills', 'abx');
  symlinkSync('../../plugin/skills/abx', link);
  return {root, real, link};
}

test('installing from a symlinked canonical skill writes real files, not a link into the checkout', () => {
  const {root, link} = fixture();
  try {
    const dest = join(root, 'project', '.agents', 'skills', 'abx');
    assert.equal(installSkillTo(link, dest), 'installed');
    assert.ok(!lstatSync(dest).isSymbolicLink(), 'installed skill must be a standalone directory');
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), '---\nname: abx\n---\n');

    rmSync(join(root, 'plugin'), {recursive: true, force: true});
    assert.ok(existsSync(join(dest, 'reference', 'setup.md')), 'install must survive the source checkout going away');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('a destination that resolves to the source through a symlink is left alone', () => {
  const {root, real, link} = fixture();
  try {
    assert.equal(installSkillTo(real, link), 'already-canonical');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.ok(existsSync(join(real, 'SKILL.md')));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
