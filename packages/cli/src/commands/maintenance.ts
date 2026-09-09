/**
 * `abx vacuum` — SQLite maintenance for the local reference store.
 *
 * Two halves, matching `SqliteStore`'s split in `packages/indexer/src/store.ts`:
 *  - `abx vacuum convert`     the one-time, EXPLICIT full `VACUUM` for a store stuck at
 *                             `auto_vacuum='none'` — every store created before this repo started
 *                             setting the pragma ahead of schema creation (and, until a pragma
 *                             ordering bug was fixed, every newer store too —
 *                             see the comment on `SCHEMA` in store.ts). A full VACUUM rewrites the
 *                             ENTIRE database file and can briefly need up to ~2x its on-disk size,
 *                             so it never runs on its own anywhere in this codebase — this command
 *                             is the only place it happens, and only when an operator asks for it.
 *  - `abx vacuum incremental` a manual, bounded `PRAGMA incremental_vacuum` pass — the SAME bounded
 *                             mechanism `abx serve` already runs automatically BETWEEN watch-loop
 *                             ticks (`SelfHostIndexer.startVacuumMaintenance`), exposed here for an
 *                             operator who wants one pass on demand (right after `convert`, or on a
 *                             node that isn't running `abx serve`'s watcher at all).
 *
 * `abx vacuum` (or `abx vacuum status`) alone is read-only: it just reports where the store stands,
 * so an operator can decide whether either half applies before running anything.
 */
import {DEFAULT_INCREMENTAL_VACUUM_PAGES, SqliteStore} from '@artblocks/abx-indexer';
import {localIndexer} from '../config.js';
import {type Flags} from '../flags.js';
import {bold, dim, g, info, ok, warn} from '../output.js';

/** Vacuuming is SQLite-specific (see store.ts's docstring on why these methods aren't on the
 *  generic `Store` interface) — a platform-scale Postgres deploy has its own manual VACUUM story
 *  outside this codebase, so this command has nothing to do there and says so plainly. */
function requireSqliteStore(): SqliteStore {
  const store = localIndexer().store;
  if (!(store instanceof SqliteStore)) {
    throw new Error(
      'abx vacuum applies to the local SQLite reference store only — this node is backed by something else, ' +
        'which owns its own maintenance story.',
    );
  }
  return store;
}

export async function cmdVacuum(rest: string[], flags: Flags): Promise<void> {
  const sub = rest[0];
  switch (sub) {
    case undefined:
    case 'status':
      return cmdVacuumStatus();
    case 'convert':
      return cmdVacuumConvert();
    case 'incremental':
      return cmdVacuumIncremental(flags);
    default:
      console.error(VACUUM_USAGE);
      process.exitCode = 1;
  }
}

function cmdVacuumStatus(): void {
  const store = requireSqliteStore();
  const stats = store.vacuumStats();
  console.log(`store        ${store.path}`);
  console.log(`auto_vacuum  ${bold(stats.mode)}`);
  console.log(`page_count   ${stats.pageCount}`);
  console.log(`freelist     ${stats.freelistPages} page(s)`);
  console.log('');
  if (stats.mode === 'none') {
    warn(
      `this store predates incremental auto-vacuum and needs a one-time conversion: ${g('abx vacuum convert')}`,
    );
  } else if (stats.freelistPages > 0) {
    info(
      `${stats.freelistPages} freed page(s) reclaimable — abx serve does this automatically between watch ticks; ` +
        `run one pass now with ${g('abx vacuum incremental')}`,
    );
  } else {
    ok('nothing to reclaim');
  }
}

function cmdVacuumConvert(): void {
  const store = requireSqliteStore();
  const before = store.vacuumStats();
  if (before.mode !== 'none') {
    ok(`already converted — auto_vacuum is '${before.mode}'; nothing to do.`);
    return;
  }
  console.log(
    `${bold('abx vacuum convert')} runs a full SQLite ${bold('VACUUM')} on ${store.path} to enable incremental ` +
      `auto-vacuum.\n` +
      `${dim(`this REWRITES THE ENTIRE FILE (currently ${before.pageCount} page(s)) and can briefly need up to`)}\n` +
      `${dim('~2x its on-disk size while it runs. This is a one-time operation — after it, freed pages reclaim')}\n` +
      `${dim(`incrementally instead (${g('abx vacuum incremental')}, or automatically between abx serve's watch ticks).`)}\n`,
  );
  console.log(`converting… (auto_vacuum: none → incremental)`);
  const mode = store.vacuumConvert();
  const after = store.vacuumStats();
  ok(`done — auto_vacuum is now '${mode}'; ${before.pageCount} → ${after.pageCount} page(s).`);
}

function cmdVacuumIncremental(flags: Flags): void {
  const store = requireSqliteStore();
  const maxPages = flags.pages !== undefined ? Number(flags.pages) : DEFAULT_INCREMENTAL_VACUUM_PAGES;
  if (!Number.isFinite(maxPages) || maxPages <= 0) {
    throw new Error(`--pages must be a positive number (got ${JSON.stringify(flags.pages)})`);
  }
  const mode = store.autoVacuumMode();
  if (mode !== 'incremental') {
    warn(`auto_vacuum is '${mode}' — incremental_vacuum has nothing to do until this store is converted: ${g('abx vacuum convert')}`);
    return;
  }
  const reclaimed = store.runIncrementalVacuum(maxPages);
  if (reclaimed > 0) ok(`reclaimed ${reclaimed} page(s) (bounded to ${maxPages} this pass)`);
  else info('nothing to reclaim');
}

const VACUUM_USAGE = `usage: abx vacuum [status|convert|incremental] [--pages <n>]`;

export const VACUUM_HELP = `
  ${bold('abx vacuum')} [status|convert|incremental] ${dim('— SQLite maintenance for the local reference store; read-only unless a write happens below')}
    ${g('abx vacuum')}              ${dim('(default: status)')} report auto_vacuum mode + page/freelist counts
    ${g('abx vacuum convert')}      one-time, EXPLICIT full VACUUM for a store stuck at auto_vacuum='none' — rewrites
                          the whole file; can briefly need up to ~2x its on-disk size. Never runs automatically.
    ${g('abx vacuum incremental')} [--pages <n>]  one bounded PRAGMA incremental_vacuum pass (default ${DEFAULT_INCREMENTAL_VACUUM_PAGES}
                          pages) — the same bounded reclaim \`abx serve\` already runs automatically BETWEEN watch
                          ticks; use this on demand (after \`convert\`, or on a node not running \`abx serve\`).
    ${dim('c.f. site/content/docs/using-abx/self-hosting.mdx → SQLite maintenance.')}`;
