// Stamp the canonical agent skill's version to match the abx CLI's package version, so the skill
// stays strictly co-versioned with the CLI it drives. Runs right after `changeset version` (see the
// root `ci:version` script), so the "Version Packages" PR carries the bumped SKILL.md alongside the
// package bumps. Idempotent. The version lives in SKILL.md frontmatter `metadata.version` — the
// single source of truth the CLI's drift check reads back (see packages/cli/src/update-check.ts).
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPkgPath = join(repoRoot, 'packages', 'cli', 'package.json');
const skillPath = join(repoRoot, '.claude', 'skills', 'abx', 'SKILL.md');

const version = JSON.parse(readFileSync(cliPkgPath, 'utf8')).version;
if (typeof version !== 'string' || !version) {
  console.error(`[stamp-skill-version] could not read a version from ${cliPkgPath}`);
  process.exit(1);
}

const raw = readFileSync(skillPath, 'utf8');
const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
if (!fm) {
  console.error(`[stamp-skill-version] no YAML frontmatter found in ${skillPath}`);
  process.exit(1);
}
if (!/^\s*version:\s*/m.test(fm[2])) {
  console.error(`[stamp-skill-version] no metadata.version line in ${skillPath} frontmatter`);
  process.exit(1);
}

const front = fm[2].replace(/^(\s*version:\s*).*$/m, `$1"${version}"`);
const updated = raw.slice(0, fm.index) + fm[1] + front + fm[3] + raw.slice(fm.index + fm[0].length);
if (updated !== raw) writeFileSync(skillPath, updated);
console.log(`[stamp-skill-version] SKILL.md metadata.version → ${version}`);
