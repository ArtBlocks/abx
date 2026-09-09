import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {binaryProvenance, compareVersions, installedLegacySkillCopies, installedSkillCopies, installedSkillVersions, isNewer, newestOf, prereleaseChannel, readCliVersion, readSkillName, readSkillVersion, skillRefreshCommands} from '../src/update-check.js';

test('compareVersions: numeric major/minor/patch ordering', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
});

test('compareVersions: a prerelease is LOWER than the same release', () => {
  // The core semver rule our own versions depend on (0.1.0-alpha.0 < 0.1.0).
  assert.equal(compareVersions('0.1.0-alpha.0', '0.1.0'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0-alpha.0'), 1);
});

test('compareVersions: prerelease identifiers compare left-to-right', () => {
  assert.equal(compareVersions('0.1.0-alpha.1', '0.1.0-alpha.0'), 1);
  assert.equal(compareVersions('0.1.0-alpha.0', '0.1.0-alpha.1'), -1);
  assert.equal(compareVersions('0.1.0-beta.0', '0.1.0-alpha.9'), 1); // alphanumeric ASCII: beta > alpha
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1); // a shorter prerelease set is smaller
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1); // numeric ranks below alphanumeric
});

test('compareVersions: tolerant of a leading v and build metadata', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3+build.9'), 0); // build metadata ignored
});

test('isNewer: strictly-newer only', () => {
  assert.equal(isNewer('0.2.0', '0.1.0-alpha.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0-alpha.0'), true);
  assert.equal(isNewer('0.1.0-alpha.1', '0.1.0-alpha.0'), true);
  assert.equal(isNewer('0.1.0-alpha.0', '0.1.0-alpha.0'), false);
  assert.equal(isNewer('0.1.0-alpha.0', '0.2.0'), false); // running ahead of latest → no nudge
});

test('prereleaseChannel: the dist-tag a version belongs to', () => {
  assert.equal(prereleaseChannel('0.1.0-alpha.5'), 'alpha');
  assert.equal(prereleaseChannel('1.0.0-beta.2'), 'beta');
  assert.equal(prereleaseChannel('v2.0.0-next'), 'next'); // no counter, leading v
  assert.equal(prereleaseChannel('0.1.0'), null); // stable → only `latest` matters
  assert.equal(prereleaseChannel('1.0.0-5'), null); // a bare numeric identifier is not a channel
});

test('newestOf: greatest version wins, nulls skipped', () => {
  assert.equal(newestOf([]), null);
  assert.equal(newestOf([null, undefined, '']), null);
  assert.equal(newestOf(['0.1.0-alpha.3', null]), '0.1.0-alpha.3'); // one tag unset (404) is fine
  assert.equal(newestOf(['0.1.0-alpha.2', '0.1.0-alpha.10']), '0.1.0-alpha.10');
});

test('newestOf: resolves the post-stable era, where `latest` alone would go silent', () => {
  // Once a stable ships and prereleases move to `--tag alpha`, `latest`=0.1.0 while the alpha
  // channel runs ahead. Consulting both is what keeps an alpha user's nudge alive.
  assert.equal(newestOf(['0.1.0', '0.2.0-alpha.3']), '0.2.0-alpha.3');
  // And the reverse: an alpha user should still be told when a NEWER stable supersedes their line.
  assert.equal(newestOf(['0.2.0', '0.2.0-alpha.9']), '0.2.0');
});

test('readCliVersion: reads a real semver from the CLI package.json', () => {
  const v = readCliVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('readSkillVersion: reads metadata.version from frontmatter, ignoring the body', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'abx-skill-')), 'SKILL.md');
  writeFileSync(
    p,
    ['---', 'name: abx', 'description: x', 'metadata:', '  version: "0.1.0-alpha.1"', '---', '', '# body', 'version: not-this', ''].join('\n'),
  );
  assert.equal(readSkillVersion(p), '0.1.0-alpha.1');
});

test('readSkillVersion: tolerates an unquoted version', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'abx-skill-')), 'SKILL.md');
  writeFileSync(p, ['---', 'name: x', 'metadata:', '  version: 1.2.3', '---', ''].join('\n'));
  assert.equal(readSkillVersion(p), '1.2.3');
});

test('readSkillVersion: null when no version line or file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-skill-'));
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, ['---', 'name: x', 'description: y', '---', ''].join('\n'));
  assert.equal(readSkillVersion(p), null);
  assert.equal(readSkillVersion(join(dir, 'does-not-exist.md')), null);
});

test('readSkillName: reads only the required frontmatter name', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'abx-skill-')), 'SKILL.md');
  writeFileSync(p, '---\nname: abx\ndescription: x\n---\nname: not-this\n');
  assert.equal(readSkillName(p), 'abx');
});

test('the canonical repo SKILL.md carries a version matching the CLI (co-versioning invariant)', () => {
  // The publish gate (bundle-skill.mjs) and `ci:version` stamping both rely on this holding.
  const skillMd = join(import.meta.dirname, '..', '..', '..', '.claude', 'skills', 'abx', 'SKILL.md');
  assert.equal(readSkillVersion(skillMd), readCliVersion());
});

// binaryProvenance — doctor's "which of the 3-class drift ladder is this" check. Params are
// injectable so every branch is exercised without touching the real filesystem/env (a bare call,
// exercised elsewhere, always resolves 'source' in THIS repo's own test run).
test('binaryProvenance: a repo checkout (pnpm-workspace.yaml above the CLI) is always source, regardless of path/env', () => {
  assert.equal(binaryProvenance({isSourceCheckout: true, here: '/anything', env: {npm_command: 'exec'}}), 'source');
});

test("binaryProvenance: npm's isolated npx cache dir (`_npx`) is detected by path, not source", () => {
  assert.equal(
    binaryProvenance({isSourceCheckout: false, here: '/Users/x/.npm/_npx/abc123/node_modules/@artblocks/abx-cli/dist/main.js', env: {}}),
    'npx',
  );
});

test('binaryProvenance: npm_command=exec (what `npx` sets today) is detected even off a plain-looking path', () => {
  assert.equal(binaryProvenance({isSourceCheckout: false, here: '/tmp/whatever/main.js', env: {npm_command: 'exec'}}), 'npx');
});

test('binaryProvenance: neither signal present, not a source checkout ⇒ a plain npm install (global or local)', () => {
  assert.equal(
    binaryProvenance({isSourceCheckout: false, here: '/usr/local/lib/node_modules/@artblocks/abx-cli/dist/main.js', env: {}}),
    'npm',
  );
});

// ── which skill copy is stale, and the command that actually refreshes THAT copy ────────────────
//
// Regression: the drift notice reported only a version ("installed abx skill is vX") and always
// prescribed `abx skill install`, which writes the PROJECT-local copy. When the stale copy was the
// GLOBAL one, following the instruction changed nothing and the ✗ returned forever. The notice must
// name the stale copy and give a command that refreshes that scope.
test('skillRefreshCommands: a stale PROJECT copy → plain install', () => {
  const cmds = skillRefreshCommands([{version: '0.1.0', path: '/p/.claude/skills/abx/SKILL.md', scope: 'project'}]);
  assert.deepEqual(cmds, ['abx skill install']);
});

test('skillRefreshCommands: a stale GLOBAL copy → --global, the only command that reaches it', () => {
  const cmds = skillRefreshCommands([{version: '0.1.0', path: '/h/.claude/skills/abx/SKILL.md', scope: 'global'}]);
  assert.deepEqual(cmds, ['abx skill install --global']);
});

test('skillRefreshCommands: both stale → both commands, so one run clears the ✗', () => {
  const cmds = skillRefreshCommands([
    {version: '0.1.0', path: '/p/.claude/skills/abx/SKILL.md', scope: 'project'},
    {version: '0.1.0', path: '/h/.claude/skills/abx/SKILL.md', scope: 'global'},
  ]);
  assert.deepEqual(cmds, ['abx skill install', 'abx skill install --global']);
});

test('installedSkillCopies: reports a project-local copy with its path and scope', () => {
  // realpath: on macOS the temp dir is under /var → /private/var, and `installedSkillCopies` reads
  // `process.cwd()` (already resolved), so a raw mkdtemp path would never prefix-match.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abx-skillscope-')));
  mkdirSync(join(dir, '.claude', 'skills', 'abx'), {recursive: true});
  const path = join(dir, '.claude', 'skills', 'abx', 'SKILL.md');
  writeFileSync(path, '---\nname: abx\nmetadata:\n  version: "0.9.9"\n---\nbody\n');
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const mine = installedSkillCopies().filter((c) => c.path.startsWith(dir));
    assert.equal(mine.length, 1, `expected exactly one copy under the temp dir, got ${JSON.stringify(mine)}`);
    assert.equal(mine[0].version, '0.9.9');
    assert.equal(mine[0].scope, 'project');
  } finally {
    process.chdir(cwd);
  }
});

test('installedLegacySkillCopies reports abx-self-host separately from the canonical abx skill', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abx-legacy-skill-')));
  mkdirSync(join(dir, '.claude', 'skills', 'abx-self-host'), {recursive: true});
  writeFileSync(
    join(dir, '.claude', 'skills', 'abx-self-host', 'SKILL.md'),
    '---\nname: abx-self-host\nmetadata:\n  version: "0.9.9"\n---\nbody\n',
  );
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(installedSkillCopies().filter((copy) => copy.path.startsWith(dir)).length, 0);
    const legacy = installedLegacySkillCopies().filter((copy) => copy.path.startsWith(dir));
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].scope, 'project');
  } finally {
    process.chdir(cwd);
  }
});

test('installedSkillVersions stays the de-duplicated version list it always was', () => {
  const versions = installedSkillVersions();
  assert.deepEqual(versions, [...new Set(versions)]);
});
