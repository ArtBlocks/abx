/**
 * No command body calls `process.exit()` mid-flow. A local failure
 * sets `process.exitCode` and returns; a failure that has to unwind through several calls throws
 * (a plain `Error`, or `CliError` from errors.ts when a non-void-returning helper needs to `throw`
 * to satisfy the type checker while reusing text it already printed itself).
 *
 * `process.exit(` itself is allowed in exactly four spots, each for a reason that ISN'T "a command
 * gave up mid-flow":
 *   - bin.ts's node:sqlite guard — the published binary's import-free shim, which runs BEFORE
 *     main.ts is even imported. There is no CLI yet to set an exit code on.
 *   - main.ts's `assertKnownChainEnv` — runs at MODULE LOAD, before `main()` (and its `.catch`) even
 *     exist; there is no promise chain yet to reject into.
 *   - main.ts's top-level `main().catch(...)` — the one place a rejected command actually ends the
 *     process; every thrown error converges here.
 *   - output.ts's `keepAlive()` — a SIGINT handler for a long-running `serve`/`preview`/deploy-with-
 *     serve process. Installing a `'SIGINT'` listener suppresses Node's default exit-on-SIGINT, so
 *     the handler has to call `process.exit()` itself or Ctrl-C would stop doing anything.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';

const SRC_DIR = resolve(import.meta.dirname, '../src');

/** {file (relative to src/): allowed process.exit( occurrences}. Everything not listed here must be 0. */
const ALLOWLIST: Record<string, number> = {
  'bin.ts': 1, // the node:sqlite guard, which runs before main.ts is imported
  'main.ts': 2, // assertKnownChainEnv + the top-level catch
  'output.ts': 1, // keepAlive's SIGINT handler
};

function allSourceFiles(): string[] {
  const top = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
  const cmds = readdirSync(resolve(SRC_DIR, 'commands'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `commands/${f}`);
  return [...top, ...cmds];
}

/** Strip block and line comments so a doc comment that MENTIONS `process.exit(` (as this very
 *  file's own module doc does, explaining the discipline) doesn't count as a violation. Good enough
 *  for this codebase's style — no comment delimiter inside a string literal that matters here. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('process.exit( appears only in the allowlisted entry-file + SIGINT-handler spots', () => {
  for (const file of allSourceFiles()) {
    const src = stripComments(readFileSync(resolve(SRC_DIR, file), 'utf8'));
    const count = (src.match(/process\.exit\(/g) ?? []).length;
    const allowed = ALLOWLIST[file] ?? 0;
    assert.equal(
      count,
      allowed,
      `${file} has ${count} process.exit( call(s), expected ${allowed} — a command body must set ` +
        `process.exitCode + return (local failure) or throw (deep failure), never process.exit() mid-flow.`,
    );
  }
});

// ── regression: no command body reaches for process.exit as a shortcut ────────
// The allowlist above is a ceiling, not a floor — pin the entry-file exceptions specifically so
// a refactor that moves main()'s dispatch elsewhere doesn't silently relax the check for everyone else.
test('errors.ts exports CliError (the one-exit-discipline\'s throw-with-exit-code type)', async () => {
  const {CliError} = await import('../src/errors.js');
  const err = new CliError('boom');
  assert.equal(err.message, 'boom');
  assert.equal(err.exitCode, 1);
  assert.equal(err.alreadyPrinted, false);
  const custom = new CliError('quiet', 3, true);
  assert.equal(custom.exitCode, 3);
  assert.equal(custom.alreadyPrinted, true);
});
