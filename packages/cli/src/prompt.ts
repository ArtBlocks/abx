/**
 * Interactive-prompt helpers.
 *
 * These live outside `main.ts` on purpose: `main.ts` calls `main()` at module scope, so importing it
 * from a test RUNS the CLI. Anything worth unit-testing belongs in a module that only defines things.
 */

/**
 * Does this answer to a `[Y/n]` prompt mean "no"?
 *
 * Used by `abx doctor`'s offer to install/resync the agent skill, which defaults to YES so the
 * documented flow (`npm i -g @artblocks/abx-cli` → `abx doctor`) sets the agent up in one pass. Since
 * Enter accepts, the exact refusal set is what matters: an over-eager match would refuse a "yes", and
 * a sloppy `/^n/i` would swallow anything starting with n. Only the explicit forms decline; the caller
 * maps EOF (Ctrl-D) to `'n'` so a closed stream never writes files.
 */
export function declinesSkillInstall(answer: string): boolean {
  return /^n(o|ope)?$/i.test(answer.trim());
}
