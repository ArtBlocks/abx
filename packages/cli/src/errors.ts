/**
 * The one error type a command throws when it needs to abort with a specific exit code. No command
 * body calls `process.exit()` mid-flow: a local failure sets
 * `process.exitCode` and returns; a DEEP failure that needs to unwind through several calls throws).
 *
 * A plain `Error` still works everywhere (the top-level catch in main.ts prints `.message` with the
 * same `✗` prefix either way) — `CliError` adds two opt-ins:
 *   - `exitCode`, for the rare case that isn't 1.
 *   - `alreadyPrinted`, for a validation helper (e.g. ownerops.ts's `requireAddress`/`requireFlag`)
 *     that has a non-`void` return type and so can't just set `exitCode` and `return` — it has to
 *     `throw` to make the "unreachable after this" true to the type checker, but it already printed
 *     its own usage text via `console.error` BEFORE this existed and that text doesn't have (and must
 *     not gain) the generic catch's `✗` prefix. The top-level catch skips its own printing for these.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly alreadyPrinted: boolean;

  constructor(message: string, exitCode = 1, alreadyPrinted = false) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.alreadyPrinted = alreadyPrinted;
  }
}
