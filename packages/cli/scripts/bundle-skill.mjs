// Bundles the abx agent skill into the CLI package so it ships inside the
// published tarball (packages/cli/skill/). Runs at `prepack` time — never in the dev loop.
// The published `abx skill install` copies this bundled folder into the user's agent dir;
// in dev the same command reads the canonical skill straight from the repo instead.
import {cpSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = resolve(here, '..'); // packages/cli
const repoRoot = resolve(cliRoot, '..', '..');
const src = join(repoRoot, '.claude', 'skills', 'abx');
const dest = join(cliRoot, 'skill');

if (!existsSync(src)) {
  console.error(`[bundle-skill] canonical skill not found at ${src}`);
  process.exit(1);
}

// Publish-time lockstep gate: the skill and CLI are co-versioned, so refuse to bundle a skill whose
// declared version (SKILL.md frontmatter `metadata.version`) has drifted from the CLI's package
// version. `ci:version` stamps SKILL.md at release; this catches any hand-edit or missed stamp
// before a mismatched pair can ship. (prepack runs on `npm publish`/`pack`.)
const cliVersion = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version;
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(src, 'SKILL.md'), 'utf8'));
const vm = fm && /(?:^|\n)\s*version:\s*["']?([\w.+-]+)["']?/.exec(fm[1]);
const skillVersion = vm ? vm[1] : null;
if (skillVersion !== cliVersion) {
  console.error(
    `[bundle-skill] SKILL.md metadata.version (${skillVersion ?? 'missing'}) != CLI version (${cliVersion}). ` +
      `Run \`node scripts/stamp-skill-version.mjs\` (or \`pnpm ci:version\`) so the skill stays co-versioned before publishing.`,
  );
  process.exit(1);
}

rmSync(dest, {recursive: true, force: true});
cpSync(src, dest, {recursive: true});
console.log(`[bundle-skill] bundled ${src} (v${skillVersion}) -> ${dest}`);
