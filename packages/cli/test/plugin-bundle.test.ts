import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import {resolve, join, relative} from 'node:path';

// plugin/ is the bundle submitted to Anthropic's plugin directory as repository `ArtBlocks/abx` +
// folder `plugin`. The directory tracks a branch and rescans each commit, so unlike every other copy
// of the skill (packages/cli/skill/, .agents/skills/abx/ — both gitignored) this one is committed.
//
// That inverts the usual stakes for a generated file. A stale copy here isn't a broken build; it is
// the directory serving an out-of-date skill to everyone who installed the plugin, with nothing to
// notice it. These tests are what makes `scripts/build-plugin.mjs` non-optional.

const repoRoot = resolve(import.meta.dirname, '../../..');
const canonical = join(repoRoot, '.claude', 'skills', 'abx');
const pluginRoot = join(repoRoot, 'plugin');
const bundled = join(pluginRoot, 'skills', 'abx');

// One bundle, three agents. They share skills/<name>/SKILL.md and differ only in manifest location,
// so a drifted manifest means one agent ships a different name or version than the others.
const manifestPaths = {
  claude: join(pluginRoot, '.claude-plugin', 'plugin.json'),
  codex: join(pluginRoot, 'plugin.json'),
  gemini: join(pluginRoot, 'gemini-extension.json'),
};
const manifests = Object.fromEntries(
  Object.entries(manifestPaths).map(([agent, p]) => [agent, JSON.parse(readFileSync(p, 'utf8'))]),
) as Record<keyof typeof manifestPaths, {name: string; version: string; license?: string}>;
const manifest = manifests.claude;

function walk(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true})
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();
}

test('the published skill copy has not drifted from the canonical one', () => {
  const rel = (root: string) => walk(root).map((f) => relative(root, f));
  assert.deepEqual(
    rel(bundled),
    rel(canonical),
    'plugin/skills/abx/ and .claude/skills/abx/ hold different files; run `node scripts/build-plugin.mjs`',
  );
  for (const f of rel(canonical)) {
    assert.equal(
      readFileSync(join(bundled, f), 'utf8'),
      readFileSync(join(canonical, f), 'utf8'),
      `${f} differs between the canonical skill and the published copy; run \`node scripts/build-plugin.mjs\``,
    );
  }
});

test('only the end-user skill ships — dev-loop-test is contributor-only', () => {
  // Its steps all need this checkout (pnpm sandbox, contributor/agent-eval/), but its description
  // answers to things a creator might plausibly say, so shipping it would get it loaded and then
  // issue commands that cannot run.
  assert.deepEqual(readdirSync(join(pluginRoot, 'skills')), ['abx']);
  assert.ok(existsSync(join(repoRoot, '.claude', 'skills', 'dev-loop-test')), 'guarding the right path');
});

test('the plugin, the skill, and the CLI stay co-versioned', () => {
  const cliVersion = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
  ).version;
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(bundled, 'SKILL.md'), 'utf8'))?.[1] ?? '';
  const skillVersion = /(?:^|\n)\s*version:\s*["']?([\w.+-]+)["']?/.exec(front)?.[1];
  assert.equal(skillVersion, cliVersion, 'SKILL.md metadata.version must match the CLI');
  for (const [agent, m] of Object.entries(manifests)) {
    assert.equal(m.version, cliVersion, `${agent} manifest version must match the CLI; it is the release number people see`);
  }
});

test('the manifest name matches the skill it carries — the directory keys the listing on it', () => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(bundled, 'SKILL.md'), 'utf8'))?.[1] ?? '';
  assert.equal(/(?:^|\n)name:\s*([^\n]+)/.exec(front)?.[1].trim(), 'abx');
  for (const [agent, m] of Object.entries(manifests)) {
    assert.equal(m.name, 'abx', `${agent} plugin name is permanent after release; never change it`);
  }
});

test('the bundle satisfies what the directory requires to list it', () => {
  assert.ok(existsSync(join(pluginRoot, 'LICENSE')) || manifest.license, 'needs a LICENSE file or a license field');

  // The directory shows the README as the listing description and requires at least 40 words,
  // not counting words inside code blocks.
  const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8');
  const prose = readme.replace(/```[\s\S]*?```/g, ' ');
  const words = prose.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 40, `README has ${words} words outside code blocks; the directory requires 40`);

  // A top-level bin/ stops claude.ai and Cowork from installing the plugin at all.
  assert.ok(!existsSync(join(pluginRoot, 'bin')), 'a top-level bin/ blocks installation on claude.ai and Cowork');

  // Each agent finds the bundle only through its own manifest, so a missing one is a silent
  // "plugin doesn't exist" for that agent rather than an error anybody sees.
  for (const [agent, p] of Object.entries(manifestPaths)) {
    assert.ok(existsSync(p), `${agent} has no manifest at ${relative(pluginRoot, p)}`);
  }

  // Only the manifest belongs in .claude-plugin/; everything else sits at the plugin root.
  assert.deepEqual(readdirSync(join(pluginRoot, '.claude-plugin')), ['plugin.json']);
  assert.ok(statSync(join(pluginRoot, 'skills', 'abx', 'SKILL.md')).isFile(), 'skills/<name>/SKILL.md is the required layout');
});
