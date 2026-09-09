/**
 * Update check — a notify-only "you're behind" nudge, extracted from main.ts so the
 * version comparison and cache logic are unit-testable (importing main executes the CLI).
 *
 * Policy (owner's call): NOTIFY, never self-mutate. The CLI checks npm at most once per
 * {@link TTL_MS} (cached to disk), prints an upgrade one-liner to STDERR (so it never
 * corrupts machine-readable stdout an agent may be parsing), and is a hard no-op when
 * offline, in CI, or opted out (ABX_NO_UPDATE_CHECK / --no-update-check — see main.ts).
 * The check lives in the CLI binary, so it fires no matter which agent (Claude, Codex,
 * Cursor, …) drives `abx` — one implementation, every agent covered.
 *
 * What it asks npm: the `latest` dist-tag AND (when the running version is a prerelease) that
 * version's own channel tag, taking whichever is newer. Deliberately NOT just `latest` — see
 * {@link prereleaseChannel} for the silent-failure mode that would otherwise arrive the day a
 * stable release ships.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {findCliPackageRoot, findRepoRoot} from './output.js';

const REGISTRY = 'https://registry.npmjs.org';
const PKG = '@artblocks/abx-cli';
// How long a check is cached. 6h rather than a day because releases land fast in the alpha line: a
// 24h cache let someone work a whole session — deploys included — against a CLI that had been
// superseded that morning and never hear about it. 6h caps that at roughly one sitting.
const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500; // never hang a command on a slow/offline network

/** Read the running CLI's own version from its package.json. Resolves the same in dev
 *  (src/update-check.ts → packages/cli/package.json) and published (dist/update-check.js →
 *  <pkg>/package.json) — npm always ships package.json regardless of the `files` allowlist.
 *  Returns '0.0.0' if unreadable, so callers never throw on a self-version read. */
export function readCliVersion(): string {
  try {
    // `findCliPackageRoot()` rather than a counted `..`. This module compiles to `dist/update-check.js`,
    // one level deep, so `'..','..'` happened to be RIGHT here — and that accident is the point: the
    // identical expression in `src/commands/` was wrong, and this one becomes wrong the day the file
    // moves. The `catch` below would then silently report '0.0.0' and disable the update check.
    const pkgDir = findCliPackageRoot();
    if (!pkgDir) return '0.0.0';
    const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {version?: string};
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The version of the `@artblocks/abx-sdk` this CLI actually runs against, read from the
 *  resolved dependency's own package.json (exported via its `./package.json` entry). NOT the
 *  CLI's version: under changesets' prerelease mode each package's alpha counter increments
 *  independently, so pinning a scaffold's sdk dependency to the CLI's number can produce a
 *  range no published sdk satisfies. Falls back to the CLI's version only if resolution fails
 *  (dev-tree oddities) — better a near-right pin than '0.0.0'. */
export function readSdkVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const raw = JSON.parse(readFileSync(req.resolve('@artblocks/abx-sdk/package.json'), 'utf8')) as {version?: string};
    if (typeof raw.version === 'string') return raw.version;
  } catch {
    // fall through to the CLI's own version
  }
  return readCliVersion();
}

/**
 * Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b. Handles the
 * prerelease rule (1.0.0-alpha < 1.0.0) since our own versions are prereleases today
 * (0.1.0-alpha.0). Build metadata (+…) is ignored per semver. Tolerant of a leading `v`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1;
  }
  // A version WITH a prerelease is lower than the same version without one.
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // a shorter prerelease set is smaller (1.0.0-a < 1.0.0-a.1)
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xn) {
      return -1; // numeric identifiers rank below alphanumeric ones
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True when `latest` is a strictly newer release than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * How the currently-running `abx` got onto this machine — the 3-class drift ladder the skill has
 * long taught in prose (`SKILL.md` → "Resolve the CLI before you install anything"), now something
 * `doctor` can just check:
 *   - `source`  a repo checkout (`pnpm abx`, dev) — detected the SAME way {@link findRepoRoot} does
 *              (a `pnpm-workspace.yaml` above the running CLI), since the published package never
 *              ships one.
 *   - `npx`     an npx fetch/run — a temp/cache copy npm never puts on PATH, so it can silently keep
 *              serving a stale build after an upgrade (npm's isolated cache dir contains a telltale
 *              `_npx` path segment; `npm exec` — what `npx` is today — also sets `npm_command=exec`).
 *   - `npm`     a plain `npm install`, global (`-g`) or a project's local `node_modules` — same fix
 *              either way, so this doesn't split them further.
 * Params are injectable so a test can drive every branch without touching the real filesystem/env.
 */
export type BinaryProvenance = 'source' | 'npx' | 'npm';
export function binaryProvenance(opts: {isSourceCheckout?: boolean; here?: string; env?: NodeJS.ProcessEnv} = {}): BinaryProvenance {
  const isSourceCheckout = opts.isSourceCheckout ?? !!findRepoRoot();
  if (isSourceCheckout) return 'source';
  const here = opts.here ?? fileURLToPath(import.meta.url);
  const env = opts.env ?? process.env;
  if (/[/\\]_npx[/\\]/.test(here) || env.npm_command === 'exec') return 'npx';
  return 'npm';
}

function parseSemver(v: string): {main: [number, number, number]; pre: string[]} {
  const clean = String(v).trim().replace(/^v/, '').split('+')[0];
  const dash = clean.indexOf('-');
  const mainStr = dash === -1 ? clean : clean.slice(0, dash);
  const preStr = dash === -1 ? '' : clean.slice(dash + 1);
  const parts = mainStr.split('.').map((n) => {
    const d = Number(n);
    return Number.isFinite(d) ? d : 0;
  });
  return {
    main: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
    pre: preStr ? preStr.split('.') : [],
  };
}

/**
 * The npm dist-tag channel a version belongs to, or null for a stable release.
 * `0.1.0-alpha.5` → `alpha`; `0.1.0` → null; `1.0.0-5` → null (a bare numeric prerelease
 * identifier is a version counter, not a channel name).
 *
 * Why this exists: the update check must not depend on prereleases living under `latest`.
 * Today they do — `ci:publish` runs `pnpm -r publish` with no `--tag`, so npm points `latest`
 * at each new alpha and asking for `/latest` happens to find it. That breaks the moment a
 * stable release ships and the pipeline starts publishing prereleases under `--tag alpha`:
 * `/latest` would only ever report the stable, and the nudge would go SILENT for every alpha
 * user with nothing erroring. Resolving the running version's own channel alongside `latest`
 * makes the check correct in both eras, whichever tag the pipeline uses.
 */
export function prereleaseChannel(version: string): string | null {
  const first = parseSemver(version).pre[0];
  if (!first || /^\d+$/.test(first)) return null;
  return first;
}

/** GET the version a dist-tag currently points at. Aborts after {@link TIMEOUT_MS}; returns null
 *  on any failure (offline, timeout, 404 for a tag that was never set, malformed body) — never throws. */
export async function fetchDistTagVersion(tag: string, pkg = PKG): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Scoped packages encode the '/' as %2F; the /<tag> endpoint returns that version's document.
    const res = await fetch(`${REGISTRY}/${pkg.replace('/', '%2F')}/${encodeURIComponent(tag)}`, {signal: ctrl.signal});
    if (!res.ok) return null;
    const body = (await res.json()) as {version?: string};
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The greatest of a set of semver strings, skipping nulls; null if none are usable. */
export function newestOf(versions: Array<string | null | undefined>): string | null {
  const found = versions.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (!found.length) return null;
  return found.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max));
}

/**
 * The newest version published on any dist-tag relevant to `current`: `latest`, plus the running
 * version's own prerelease channel when it has one ({@link prereleaseChannel}). Both are requested
 * in parallel, so the wall clock stays one {@link TIMEOUT_MS} rather than two. Null when every
 * request fails.
 */
export async function fetchNewestPublished(current: string, pkg = PKG): Promise<string | null> {
  const channel = prereleaseChannel(current);
  const tags = channel ? ['latest', channel] : ['latest'];
  return newestOf(await Promise.all(tags.map((t) => fetchDistTagVersion(t, pkg))));
}

function cachePath(): string {
  return join(homedir(), '.cache', 'abx', 'update-check.json');
}

/**
 * Resolve the newest published version IF it is newer than `current`, else null. Reads a disk
 * cache first and only hits the network when the cache is older than {@link TTL_MS}. On a network
 * failure it still stamps the cache (backing off a full TTL instead of retrying every command).
 * Swallows every error — the update check must never break or slow a real command.
 *
 * The cache is keyed by release channel as well as time: which dist-tags matter depends on the
 * running version, so an entry computed on another channel (an alpha → stable upgrade, or back) is
 * a miss rather than a day-stale answer. Entries written before this key existed simply miss once.
 *
 * `now` is injectable so tests can drive TTL behavior deterministically.
 */
export async function checkForCliUpdate(current: string, now: number = Date.now()): Promise<string | null> {
  let latest: string | null = null;
  const channel = prereleaseChannel(current) ?? '';
  try {
    const path = cachePath();
    let cache: {checkedAt?: number; latest?: string | null; channel?: string} = {};
    try {
      if (existsSync(path)) cache = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      cache = {};
    }
    const sameChannel = (cache.channel ?? '') === channel;
    const fresh = sameChannel && typeof cache.checkedAt === 'number' && now - cache.checkedAt < TTL_MS;
    if (fresh) {
      latest = typeof cache.latest === 'string' ? cache.latest : null;
    } else {
      const fetched = await fetchNewestPublished(current);
      latest = fetched ?? (sameChannel && typeof cache.latest === 'string' ? cache.latest : null);
      try {
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, JSON.stringify({checkedAt: now, latest, channel}));
      } catch {
        /* a read-only HOME just means we re-check next run */
      }
    }
  } catch {
    return null;
  }
  if (!latest) return null;
  return isNewer(latest, current) ? latest : null;
}

/** The skill's folder name — matches SKILL.md `name`, per the Agent Skills rule that a skill
 *  directory must be named for its `name` field. */
export const SKILL_DIR_NAME = 'abx';
export const LEGACY_SKILL_DIR_NAMES = ['abx-self-host'] as const;

/**
 * Every skills PARENT directory an ABX-capable agent scans for a `SKILL.md`, keyed by agent.
 * These are the discovery locations the agents actually read (verified against each agent's docs):
 *   • `.claude/skills`  — Claude Code (and Copilot also reads it)
 *   • `.agents/skills`  — the near-universal neutral dir: Cursor, Codex, Gemini, and Copilot all
 *                         read it (Gemini/Cursor treat it as the canonical alias over their own dir)
 * `abx skill install` writes the version-locked bundle into these; the drift check reads it back.
 */
export const AGENT_SKILL_PARENTS: Record<string, string> = {
  claude: '.claude/skills',
  cursor: '.agents/skills',
  codex: '.agents/skills',
  gemini: '.agents/skills',
  copilot: '.agents/skills',
};

/** Distinct skills-parent dirs to scan for a possibly-installed copy — the union of every agent's
 *  discovery dirs (including a few per-agent aliases), so drift detection finds the skill no matter
 *  which agent (or install route) put it there. Missing dirs are simply skipped. */
export const ALL_SKILL_PARENTS = [
  '.claude/skills',
  '.agents/skills',
  '.cursor/skills',
  '.gemini/skills',
  '.github/skills',
  '.copilot/skills',
];

/**
 * Parse `metadata.version` from a `SKILL.md`'s YAML frontmatter. Dependency-free on purpose: the
 * frontmatter is the small, controlled block between the leading `---` fences, and the version is
 * the only `version:` key we write there. Returns null if the file is missing/unreadable or
 * declares no version.
 */
export function readSkillVersion(skillMdPath: string): string | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const front = fm ? fm[1] : '';
    const vm = /(?:^|\n)\s*version:\s*["']?([\w.+-]+)["']?/.exec(front);
    return vm ? vm[1] : null;
  } catch {
    return null;
  }
}

/** Parse the required top-level skill name from YAML frontmatter. */
export function readSkillName(skillMdPath: string): string | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const front = fm ? fm[1] : '';
    const nm = /(?:^|\n)name:\s*["']?([a-z0-9-]+)["']?\s*(?:\n|$)/.exec(front);
    return nm ? nm[1] : null;
  } catch {
    return null;
  }
}

/**
 * Versions of any locally-installed skill copy (project-local under CWD, and global under HOME),
 * read from each copy's own `SKILL.md` frontmatter. The skill and CLI are co-versioned, but a
 * separately-installed skill copy does NOT move when the CLI upgrades — this lets the notifier
 * catch that drift. Because the version travels INSIDE `SKILL.md`, this works for every install
 * route (bundled `abx skill install`, git-based `npx skills add`, or a manual copy) — not just
 * the CLI's own installer.
 */
export function installedSkillVersions(): string[] {
  return [...new Set(installedSkillCopies().map((c) => c.version))];
}

/** One installed skill copy: its version, where it lives, and whether it's project-local or global. */
export interface InstalledSkillCopy {
  version: string;
  path: string;
  /** `project` = under the CWD (fixed by `abx skill install`); `global` = under HOME (needs `--global`). */
  scope: 'project' | 'global';
}

function installedSkillCopiesNamed(names: readonly string[]): InstalledSkillCopy[] {
  const out: InstalledSkillCopy[] = [];
  const home = homedir();
  const cwd = process.cwd();
  for (const [root, scope] of [
    [cwd, 'project'],
    [home, 'global'],
  ] as Array<[string, 'project' | 'global']>) {
    for (const parent of ALL_SKILL_PARENTS) {
      for (const name of names) {
        const path = join(root, parent, name, 'SKILL.md');
        const version = readSkillVersion(path);
        // A project dir that IS the home dir would otherwise report the same copy twice.
        if (version && !out.some((c) => c.path === path)) out.push({version, path, scope});
      }
    }
  }
  return out;
}

/**
 * Every installed skill copy found, WITH its path and scope — not just the version set.
 *
 * The scope is the whole point. A stale copy anywhere used to raise a ✗ that said only "installed abx
 * skill is vX — refresh it: `abx skill install`", and that command writes the PROJECT-local copy only.
 * So whenever the stale copy was the GLOBAL one, following the instruction changed nothing and the ✗
 * came back forever. The reported path and scope make the remedy actionable.
 */
export function installedSkillCopies(): InstalledSkillCopy[] {
  return installedSkillCopiesNamed([SKILL_DIR_NAME]);
}

/** Legacy copies still trigger independently and can compete with the renamed `abx` skill. */
export function installedLegacySkillCopies(): InstalledSkillCopy[] {
  return installedSkillCopiesNamed(LEGACY_SKILL_DIR_NAMES);
}

/**
 * The exact `abx skill install` invocation that would refresh the given stale copies — `--global`
 * when a stale copy lives under HOME, plain when it's project-local, both when both are stale.
 * Returned as the literal command string so a readout can print something that actually works.
 */
export function skillRefreshCommands(stale: InstalledSkillCopy[]): string[] {
  const cmds: string[] = [];
  if (stale.some((c) => c.scope === 'project')) cmds.push('abx skill install');
  if (stale.some((c) => c.scope === 'global')) cmds.push('abx skill install --global');
  return cmds.length ? cmds : ['abx skill install'];
}
