import type {Flags} from './flags.js';

/**
 * `--json`: make **stdout a machine channel**.
 *
 * The rule this enforces, from an integrator who drove the CLI from a server: *a value a program
 * needs must be obtainable without parsing prose.* They had to regex-scrape ANSI-coloured stdout for
 * every value — and an escape code ended up inside a locator, was written into a stored player URL,
 * and 404'd in production. The cause was found only by inspecting stored bytes.
 *
 * So under `--json`, stdout carries exactly one JSON document and nothing else. Every narration line
 * the command would print for a human goes to **stderr** instead — not suppressed, because a human
 * watching a deploy still wants to see it, and a program redirecting stdout still gets a clean parse.
 * The update-check already wrote to stderr for precisely this reason; this carries that instinct
 * through to the values themselves.
 *
 * It works by swapping `console.log` for the duration rather than threading a `quiet` flag through
 * every command body. That is deliberate: the alternative is touching dozens of call sites, where the
 * one that gets missed is a stray line that corrupts a parse — the exact failure mode being fixed.
 * `console.error`/`console.warn` are untouched (already stderr), and the payload is written through a
 * captured reference to the real `console.log`, so nothing can intercept it back.
 */
export function jsonMode(flags: Flags): boolean {
  return flags.json !== undefined;
}

/**
 * Run `body` and, under `--json`, print whatever it returns as the sole contents of stdout.
 *
 * `body` receives an `emit` it may call to contribute the payload incrementally — for a command that
 * discovers its value midway (a deploy learning its address) and would otherwise have to restructure
 * to return it at the end. The last `emit` wins; a returned value overrides both.
 *
 * Without `--json` this is a plain pass-through: zero behaviour change on the human path.
 */
export async function withJson<T extends Record<string, unknown>>(
  flags: Flags,
  body: (emit: (payload: T) => void) => Promise<T | void>,
): Promise<void> {
  let payload: T | undefined;
  const emit = (p: T) => {
    payload = p;
  };
  if (!jsonMode(flags)) {
    await body(emit);
    return;
  }
  const realLog = console.log;
  // Route human narration to stderr. Mirrors console.log's own formatting closely enough for
  // progress text; nothing structured goes through here.
  console.log = (...args: unknown[]) => process.stderr.write(args.map((a) => String(a)).join(' ') + '\n');
  try {
    const returned = await body(emit);
    const out = (returned as T | undefined) ?? payload;
    // A command that emitted nothing is a bug in that command, not a silent empty object — say so on
    // stderr and leave stdout empty rather than writing `{}` that a caller would trust.
    if (out === undefined) {
      process.stderr.write('abx: --json produced no payload for this command (please report it)\n');
      process.exitCode = 1;
      return;
    }
    realLog(JSON.stringify(out, null, 2));
  } catch (err) {
    // A command that already called `emit()` for a fact it established (a minted token id) before a
    // LATER step throws must not leave a `--json` caller with NOTHING on stdout — that fact is real
    // and the caller may have no other way to recover it (e.g. the id assigned by a mint the command
    // cannot safely repeat). Print whatever was emitted, then rethrow unchanged: main.ts's top-level
    // catch still reports the error on stderr and sets the exit code exactly as it does today — this
    // only ADDS a partial payload to stdout, it never swallows or reshapes the failure.
    if (payload !== undefined) realLog(JSON.stringify(payload, null, 2));
    throw err;
  } finally {
    console.log = realLog;
  }
}

/** BigInt-safe JSON: bigints become decimal strings rather than throwing. Every on-chain number a
 *  payload carries (supply, a token id, a block) arrives as a bigint, and `JSON.stringify` refuses
 *  them outright — so a payload builder that forgets one would fail at the last line of a deploy. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
}
