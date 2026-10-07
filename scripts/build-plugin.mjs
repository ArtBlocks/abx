// Regenerates the agent plugin bundle in plugin/ from the canonical skill, so the repo can be
// submitted to Anthropic's plugin directory as the `ArtBlocks/abx` repository + `plugin` folder.
//
// One bundle serves Claude, Codex, and Gemini CLI: all three read skills from skills/<name>/SKILL.md
// and want only `name`/`description` frontmatter, which the canonical skill already has. They differ
// solely in where the manifest lives, so the bundle carries three of them side by side. Claude's sits
// in .claude-plugin/ and the other two at the root, so nothing collides.
//
// Unlike the CLI's prepack bundle (packages/cli/scripts/bundle-skill.mjs, gitignored), this copy is
// committed: the directory identifies a listing by repository + folder, tracks a branch, and rescans
// each commit, so the files have to be in the tree at the commit it pins. That makes the copy
// publishable state rather than a build artifact — and makes a stale copy a silent product bug,
// since the directory would serve it to everyone who installed the plugin.
// packages/cli/test/plugin-bundle.test.ts fails the build when this output drifts from its sources.
//
// Runs right after stamp-skill-version.mjs in `ci:version`, so the stamped SKILL.md is what gets
// copied. Idempotent; safe to run by hand.
import {cpSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillSrc = join(repoRoot, '.claude', 'skills', 'abx');
const pluginRoot = join(repoRoot, 'plugin');
const manifestPaths = [
  join(pluginRoot, '.claude-plugin', 'plugin.json'), // Claude
  join(pluginRoot, 'plugin.json'), // Codex / OpenAI portable Agent Plugins
  join(pluginRoot, 'gemini-extension.json'), // Gemini CLI
];

if (!existsSync(skillSrc)) {
  console.error(`[build-plugin] canonical skill not found at ${skillSrc}`);
  process.exit(1);
}

// Same lockstep gate as bundle-skill.mjs: the skill is co-versioned with the CLI it drives, so refuse
// to publish a pair that has drifted. `ci:version` stamps SKILL.md; this catches a hand-edit.
const cliVersion = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')).version;
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(skillSrc, 'SKILL.md'), 'utf8'));
const skillVersion = fm && /(?:^|\n)\s*version:\s*["']?([\w.+-]+)["']?/.exec(fm[1])?.[1];
if (skillVersion !== cliVersion) {
  console.error(
    `[build-plugin] SKILL.md metadata.version (${skillVersion ?? 'missing'}) != CLI version (${cliVersion}). ` +
      `Run \`node scripts/stamp-skill-version.mjs\` (or \`pnpm ci:version\`) before building the plugin bundle.`,
  );
  process.exit(1);
}

// The directory requires skills at skills/<name>/SKILL.md, where the folder name matches the skill's
// frontmatter `name`. Only the abx skill ships: .claude/skills/ also holds dev-loop-test, which is
// contributor-only and whose steps all need this checkout, so publishing it would hand end users a
// skill that answers to "regression-test the CLI" and then issues commands that cannot run.
const skillDest = join(pluginRoot, 'skills', 'abx');
rmSync(join(pluginRoot, 'skills'), {recursive: true, force: true});
cpSync(skillSrc, skillDest, {recursive: true});

// The directory won't list a plugin without a license, and reads the manifest's version as the
// release number people see, so both track the CLI rather than being maintained by hand.
copyFileSync(join(repoRoot, 'LICENSE'), join(pluginRoot, 'LICENSE'));

for (const manifestPath of manifestPaths) {
  const raw = readFileSync(manifestPath, 'utf8');
  const stamped = raw.replace(/("version":\s*)"[^"]*"/, `$1"${cliVersion}"`);
  if (stamped !== raw) writeFileSync(manifestPath, stamped);
  if (JSON.parse(stamped).version !== cliVersion) {
    console.error(`[build-plugin] could not stamp a version into ${manifestPath}`);
    process.exit(1);
  }
}

console.log(
  `[build-plugin] bundled skill abx (v${skillVersion}) -> ${skillDest}; ` +
    `${manifestPaths.length} manifests at v${cliVersion}`,
);
