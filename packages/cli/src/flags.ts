/**
 * CLI flag parsing — `--k v` / `--k=v` / bare `--k` (→ 'true'). Extracted from main.ts so
 * the parse rules are unit-testable (importing main executes the CLI).
 *
 * Repeated flags normally overwrite (last one wins); the flags in {@link REPEATABLE_FLAGS}
 * instead ACCUMULATE comma-joined, so `--dep a --dep b` ≡ `--dep a,b` — order preserved
 * (load-bearing for dependencies: index 0 = the runtime). `--schema` accumulates too, so
 * `--schema a --schema b` ≡ `--schema a,b` — without this a second `--schema` silently drops
 * the first (a real footgun on a multi-param drop; a Select's options use `|` not `,`, so the
 * comma-join never collides with an option list).
 */
import {type Hex} from 'viem';
import {type ReconstructBlockTag} from '@artblocks/abx-sdk';
import {bold, info, warn} from './output.js';

export type Flags = Record<string, string | undefined>;

/** Flags where every occurrence counts (values comma-join, in argv order). */
export const REPEATABLE_FLAGS: ReadonlySet<string> = new Set(['dep', 'schema', 'param']);

/**
 * Flags valid on ANY command (handled centrally in main, not by a command handler), so
 * {@link unknownFlags} never flags them as unrecognized regardless of the per-command allowlist.
 * `no-update-check` opts out of the startup update nudge (see update-check.ts).
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set(['no-update-check']);

/** Whether `--dry-run` was passed. The one place that truthiness is decided — every write command
 *  (owner-op or deploy) reads it through here rather than hand-rolling `!!flags['dry-run']`, so a
 *  fresh command can't ship with a *slightly* different spelling of the same check (or skip it). */
export function isDryRun(flags: Flags): boolean {
  return !!flags['dry-run'];
}


export function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  const set = (k: string, v: string) => {
    out[k] = REPEATABLE_FLAGS.has(k) && out[k] !== undefined ? `${out[k]},${v}` : v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) set(a.slice(2, eq), a.slice(eq + 1));
    else if (args[i + 1] && !args[i + 1].startsWith('--')) set(a.slice(2), args[++i]);
    else set(a.slice(2), 'true');
  }
  return out;
}

/**
 * The bare (non-flag) arguments, with flag VALUES removed — the mirror of {@link parseFlags}, and
 * deliberately next to it: the two must consume argv by the same rule or a flag's value looks like a
 * positional. (Hand-rolling `args.filter(a => !a.startsWith('-'))` reads `--token 0` as a stray
 * positional `0`, which is exactly the bug a stray-positional check is meant to catch.)
 */
export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (a.indexOf('=') === -1 && args[i + 1] && !args[i + 1].startsWith('--')) i++; // this flag consumes the next token
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * The flag keys in `flags` that are NOT in `allowed` — for a non-fatal "unrecognized flag"
 * notice at a command's entry. {@link parseFlags} keeps any `--k` it sees, so a typo'd or
 * unsupported flag otherwise no-ops INVISIBLY (a creator who passes `--description` to a
 * command that doesn't take it walks away believing it worked). Warn, don't throw: the
 * allowlist could be incomplete, and a false warning on a valid flag must never break a
 * scripted deploy (owner's stateless/scriptable line — see cli-ux-decisions).
 */
export function unknownFlags(flags: Flags, allowed: Iterable<string>): string[] {
  const ok = new Set(allowed);
  return Object.keys(flags).filter((k) => !ok.has(k) && !GLOBAL_FLAGS.has(k));
}

/** Warn (never throw) on a flag the command doesn't recognize — a typo'd or unsupported flag
 *  otherwise no-ops INVISIBLY (the worst failure mode for a write-adjacent value like a mistyped
 *  --royalty-bps). Non-fatal, per the owner's scriptability line ([[cli-ux-decisions]]). */
// Targeted "did you mean" hints for the flags creators most often invent (seen across agent sessions).
// A stray flag is otherwise silently ignored, so a wrong-but-plausible one (a price/supply flag that
// doesn't exist) reads as "it worked." Command-aware so a flag valid elsewhere isn't mis-hinted.
export const FLAG_HINTS: Record<string, (cmd: string) => string | undefined> = {
  count: (cmd) => (cmd === 'deploy-code' ? 'did you mean --max <N> (the supply cap)?' : undefined),
  price: () => 'a sale price is NOT set at deploy — configure it after with `abx minter configure <addr> --price <eth>`.',
  supply: () => 'did you mean --max <N> (the supply cap)?',
  amount: () => 'a sale price/amount is set post-deploy via `abx minter configure`.',
};

/**
 * Unknown flags on a command that can SEND: refuse, don't warn.
 *
 * This used to warn and carry on, and `--chain sepolia` proved why that isn't enough — the warning was
 * accurate, it scrolled past, and the deploy ran on the DEFAULT chain. On a dry run that costs a
 * confused minute; on a funded send it is a wrong-chain deploy. "Prose that was ignored once will be
 * ignored again" is the standing rule here, so the tx-sending commands stop instead.
 *
 * Safe to refuse rather than warn because a flag absent from the allowlist is, by construction, one
 * the command never reads — verified per command by comparing every `flags.x` read in its body against
 * its allowlist. So refusal cannot break a working flag; it only makes an already-ignored one loud.
 *
 * `--dry-run` refuses identically. A preview that accepts what the real send rejects is its own trap:
 * you'd validate a command in preview and have it fail at the moment it matters.
 */
export function refuseStrayFlags(flags: Flags, allowed: ReadonlySet<string>, cmd: string): void {
  const stray = unknownFlags(flags, allowed);
  if (!stray.length) return;
  const hints = stray.map((f) => FLAG_HINTS[f]?.(cmd)).filter(Boolean) as string[];
  throw new Error(
    `unrecognized flag(s): ${stray.map((f) => '--' + f).join(', ')} — this command would have ignored them silently, so it is refusing instead.\n` +
      hints.map((h, i) => `    ↳ --${stray[i]}: ${h}`).join('\n') +
      (hints.length ? '\n' : '') +
      `    see \`abx help ${cmd}\` for the flags it accepts.`,
  );
}

/** Unknown flags on a READ-ONLY command: warn, don't refuse. Nothing can be mis-sent, and a stray
 *  flag on `preview`/`inspect` shouldn't stop a creator mid-iteration. */
export function warnStrayFlags(flags: Flags, allowed: ReadonlySet<string>, cmd: string): void {
  const stray = unknownFlags(flags, allowed);
  if (stray.length) {
    warn(`unrecognized flag(s), ignored: ${stray.map((f) => bold('--' + f)).join(', ')} — see \`abx help ${cmd}\`. (A misspelled or unsupported flag silently does nothing.)`);
    for (const f of stray) {
      const hint = FLAG_HINTS[f]?.(cmd);
      if (hint) info(`  ↳ --${f}: ${hint}`);
    }
  }
}

/** The wallet-lane owner-pinning guard: on `--sign` with no `--for`, whichever wallet connects
 *  becomes owner + royalty receiver + mint recipient (the launch-readiness "random wallet owns the
 *  collection" trap). Fires uniformly on deploy / deploy-series / deploy-code. */
export function warnSignWithoutFor(flags: Flags): void {
  if (flags.sign !== undefined && !flags.for) {
    warn(`--sign without --for: whichever wallet connects becomes ${bold('owner + royalty receiver + mint recipient')}. Pass ${bold('--for <your address>')} to PIN it — the sign page then refuses a mismatched wallet (the intended safety on the wallet lane).`);
  }
}

/** Validate `--to-block` for the index lane: only the two REORG-SAFE tags, never a raw block number.
 *  A number is deliberately refused — `abx index` is incremental and picks its own scan window, so a
 *  hand-pinned height would silently freeze the watermark somewhere the next run can't reason about;
 *  the tags are the only values that stay meaningful across runs. Undefined when absent. */
export function parseBlockTagFlag(raw: string | undefined): ReconstructBlockTag | undefined {
  if (raw === undefined || raw === 'true') return undefined;
  if (raw !== 'safe' && raw !== 'finalized') {
    throw new Error(
      `--to-block takes 'safe' or 'finalized' (got '${raw}'). These stop the scan at a boundary the chain won't ` +
        `reorg away; omit the flag for the default 'latest' head. A raw block number isn't accepted here — ` +
        `use the SDK's reconstruct options if you need to pin an exact height.`,
    );
  }
  return raw;
}

/** Validate an explicit --salt (a 32-byte hex). Undefined when absent. */
export function parseSaltFlag(raw: string | undefined): Hex | undefined {
  if (!raw || raw === 'true') return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`--salt must be a 32-byte hex (0x + 64 hex chars); got '${raw}'`);
  }
  // Warn here, at the one place every command parses the flag, rather than at the five places a
  // deploy derives an address from it.
  //
  // The factory reads a salt's leading 20 bytes as an access guard: the caller's own address means
  // only that signer may deploy with it; all-zero means anyone may. Omitting --salt gives you the
  // former. Only `abx predict` ever explained this, while the deploy commands took an explicit
  // --salt verbatim and said nothing — so a creator pinning a vanity salt with a zero prefix and
  // announcing the predicted address was handing it to whoever deployed there first, and the
  // front-runner becomes `owner()` (ownership is set by `initialize`, not by the prediction).
  // Warn rather than refuse: a zero prefix is the
  // correct choice for a deliberately shared, caller-independent deployment.
  if (/^0{40}$/.test(raw.slice(2, 42))) {
    warn(
      '--salt has an all-zero guard prefix, so ANYONE may deploy to the address it predicts. ' +
        'Publish that address before you deploy and someone else can take it — and own it. ' +
        'Drop --salt for a salt pinned to your signer, or keep this only if a shared, ' +
        'caller-independent address is the point.',
    );
  }
  return raw as Hex;
}

