#!/usr/bin/env node
/**
 * check-publish-drift — fail CI when a workspace package's source has moved past the version
 * already on npm, with no changeset to republish it.
 *
 * In-repo tests resolve `workspace:*` to source, so they cannot detect a package that changed without
 * being scheduled for publication. The published tarball is the comparison baseline.
 *
 * HOW. For each publishable package whose local version ALREADY EXISTS on npm, download that exact
 * published tarball and diff its shipped files against the local build. Identical → fine. Different
 * → the source has moved since publish, so either a changeset must republish it, or it is drift.
 *
 * Byte comparison rather than an API-surface heuristic: `tsc` output here is reproducible, so this
 * catches a changed function BODY as well as a missing export. Sourcemaps are excluded because they
 * embed absolute paths, and `package.json` because `publishConfig` rewrites `main`/`bin`/`exports` at
 * publish time by design.
 *
 * NOT A LINTER FOR "did you write a good changeset" — it only asks whether what is on npm still
 * matches the tree. A package whose version is not yet published is always fine: the next release
 * publishes whatever the source says.
 *
 * Run AFTER `pnpm build` because it compares built output. Registry failures are reported as a skip.
 */
import {readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

const REPO = resolve(import.meta.dirname, '..');
const REGISTRY = 'https://registry.npmjs.org';

/** Files in a tarball we deliberately do not compare. */
const IGNORED = (name) => name.endsWith('.map') || name === 'package.json';

/** Names npm never packs, so their presence locally is not drift. */
const NEVER_PACKED = new Set(['.gitignore', '.npmignore', '.DS_Store']);

/**
 * Everything git tracks, used to tell "a new file that would ship" from "a local build artifact".
 * This prevents local Foundry `cache/` and `out/` output under packaged assets from appearing as
 * unpublished files.
 */
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], {cwd: REPO}).toString().split('\0').filter(Boolean),
);

/**
 * Would this local file actually be published? `dist/` is generated build output (never tracked, but
 * always shipped), so it counts wholesale. Anything else has to be tracked by git to ship, since a
 * release builds from a clean checkout.
 */
function wouldShip(entry, absPath) {
  if (NEVER_PACKED.has(absPath.split('/').pop())) return false;
  if (entry === 'dist') return true;
  return tracked.has(relative(REPO, absPath));
}

/**
 * Where a tarball top-level entry lives in the working tree. Defaults to `packages/<pkg>/<entry>`;
 * the CLI's `skill/` is bundled from the canonical skill at prepack (see bundle-skill.mjs), so it
 * maps outside the package. Getting this right is what lets a SKILL.md edit with no changeset —
 * which would ship a stale skill to every agent — show up here too.
 */
function localPathFor(pkgDir, entry) {
  if (pkgDir === 'cli' && entry === 'skill') return join(REPO, '.claude', 'skills', 'abx');
  return join(REPO, 'packages', pkgDir, entry);
}

function publishablePackages() {
  const out = [];
  for (const dir of readdirSync(join(REPO, 'packages'))) {
    const manifest = join(REPO, 'packages', dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private || !pkg.name || !pkg.version) continue;
    out.push({dir, name: pkg.name, version: pkg.version});
  }
  return out;
}

/** The set of package names the pending changesets would release — cascades included, which matters:
 *  a package bumped only because a dependency bumped still republishes, so its drift is covered. */
/**
 * `changeset status` resolves its configured baseBranch ("main") as a LITERAL git ref. Git's
 * fallback resolution for a bare name checks `refs/remotes/main`, never `refs/remotes/origin/main`
 * — so a CI checkout (detached HEAD, full history, but zero local branches) still crashes status
 * even after fetch-depth: 0. Materialize the local ref from the remote-tracking one when it's
 * missing; a repo where the ref already resolves (every developer clone) is untouched.
 */
function ensureBaseRef() {
  const base =
    JSON.parse(readFileSync(join(REPO, '.changeset', 'config.json'), 'utf8')).baseBranch ?? 'main';
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', base], {cwd: REPO, stdio: 'pipe'});
    return; // resolves already — nothing to do
  } catch {}
  try {
    execFileSync('git', ['branch', base, `origin/${base}`], {cwd: REPO, stdio: 'pipe'});
  } catch {} // no origin/<base> either — let status fail and the caller report it loudly
}

function pendingReleases() {
  ensureBaseRef();
  const tmp = join(mkdtempSync(join(tmpdir(), 'abx-cs-')), 'status.json');
  try {
    execFileSync('pnpm', ['changeset', 'status', `--output=${tmp}`], {cwd: REPO, stdio: 'pipe'});
    return new Set(JSON.parse(readFileSync(tmp, 'utf8')).releases.map((r) => r.name));
  } catch (err) {
    // `status` exits non-zero BOTH when there are no changesets ("nothing pending" — fine) and when
    // it crashes outright (e.g. a shallow CI clone with no `main` ref for its baseBranch diff). The
    // two must not be conflated: treating a crash as "nothing pending" turns this guard into a false
    // red on every PR that legitimately carries changesets. Changeset files on disk are the tiebreak
    // — pre.json's `changesets` array lists the ones already consumed by the current pre cycle.
    const dir = join(REPO, '.changeset');
    const consumed = new Set(
      existsSync(join(dir, 'pre.json')) ? JSON.parse(readFileSync(join(dir, 'pre.json'), 'utf8')).changesets ?? [] : [],
    );
    const pendingFiles = readdirSync(dir).filter(
      (f) => f.endsWith('.md') && f !== 'README.md' && !consumed.has(f.replace(/\.md$/, '')),
    );
    if (pendingFiles.length === 0) return new Set(); // genuinely nothing pending
    throw new Error(
      `\`changeset status\` failed while ${pendingFiles.length} pending changeset file(s) exist ` +
        `(${pendingFiles.slice(0, 3).join(', ')}${pendingFiles.length > 3 ? ', …' : ''}). Refusing to treat that as ` +
        `"nothing pending" — fix the status invocation instead (in CI this is usually a shallow clone ` +
        `missing the \`main\` ref that changesets diffs against; checkout with fetch-depth: 0).\n` +
        `  underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function isPublished(name, version) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}/${version}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  return true;
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Download + unpack a published version. Returns the extracted `package/` dir. */
function fetchPublished(name, version, into) {
  execFileSync('npm', ['pack', `${name}@${version}`, '--silent', '--pack-destination', into], {cwd: into, stdio: 'pipe'});
  const tgz = readdirSync(into).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', tgz], {cwd: into, stdio: 'pipe'});
  return join(into, 'package');
}

/** Compare shipped files against the tree. Returns a list of human-readable differences. */
function diffAgainstTree(publishedDir, pkgDir) {
  const diffs = [];
  for (const entry of readdirSync(publishedDir)) {
    if (IGNORED(entry)) continue;
    const pubPath = join(publishedDir, entry);
    const localPath = localPathFor(pkgDir, entry);
    if (!existsSync(localPath)) {
      diffs.push(`${entry}/ is published but missing locally (did you run \`pnpm build\`?)`);
      continue;
    }
    if (statSync(pubPath).isFile()) {
      if (readFileSync(pubPath).compare(readFileSync(localPath)) !== 0) diffs.push(`${entry} differs`);
      continue;
    }
    const pubFiles = filesUnder(pubPath).filter((f) => !IGNORED(f));
    const localFiles = new Set(filesUnder(localPath).filter((f) => !IGNORED(f)));
    for (const f of pubFiles) {
      if (!localFiles.has(f)) {
        diffs.push(`${entry}/${f} was published but no longer exists locally`);
        continue;
      }
      if (readFileSync(join(pubPath, f)).compare(readFileSync(join(localPath, f))) !== 0) {
        diffs.push(`${entry}/${f} differs from the published copy`);
      }
    }
    for (const f of localFiles) {
      if (pubFiles.includes(f)) continue;
      if (!wouldShip(entry, join(localPath, f))) continue; // a build artifact, not a release file
      diffs.push(`${entry}/${f} is new locally (not in the published ${entry}/)`);
    }
  }
  return diffs;
}

const pending = pendingReleases();
const drifted = [];
let skipped = 0;
const strict = /^(?:1|true)$/i.test(process.env.CI ?? '') || process.argv.includes('--strict');

for (const {dir, name, version} of publishablePackages()) {
  let published;
  try {
    published = await isPublished(name, version);
  } catch (e) {
    console.log(`  ?  ${name}@${version} — could not reach the registry (${e.message}); skipping`);
    skipped += 1;
    continue;
  }
  if (!published) {
    console.log(`  ·  ${name}@${version} — not yet published; the next release ships current source`);
    continue;
  }
  const work = mkdtempSync(join(tmpdir(), 'abx-drift-'));
  try {
    const diffs = diffAgainstTree(fetchPublished(name, version, work), dir);
    if (diffs.length === 0) {
      console.log(`  ✓  ${name}@${version} — matches what is published`);
    } else if (pending.has(name)) {
      console.log(`  ✓  ${name}@${version} — changed, and a changeset republishes it (${diffs.length} file(s))`);
    } else {
      console.log(`  ✗  ${name}@${version} — CHANGED with no changeset to republish it:`);
      for (const d of diffs.slice(0, 8)) console.log(`       ${d}`);
      if (diffs.length > 8) console.log(`       … and ${diffs.length - 8} more`);
      drifted.push(name);
    }
  } catch (e) {
    console.log(`  ?  ${name}@${version} — could not compare (${e.message}); skipping`);
    skipped += 1;
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}

if (skipped) console.log(`\n  ${skipped} package(s) skipped — this guard did NOT verify them.`);

if (skipped && strict) {
  console.error('\n✗ publish drift could not be verified in strict/CI mode.\n');
  process.exit(1);
}

if (drifted.length) {
  console.error(
      `\n✗ publish drift: ${drifted.join(', ')}\n\n` +
      `  These packages' source differs from the version already on npm, and no changeset bumps them.\n` +
      `  Left alone, the release would publish nothing for them and consumers would retain old code.\n\n` +
      `  Fix: \`pnpm changeset\` and select ${drifted.length > 1 ? 'each package' : drifted[0]}.\n`,
  );
  process.exit(1);
}

console.log('\n✓ no publish drift — every published version matches the tree.\n');
