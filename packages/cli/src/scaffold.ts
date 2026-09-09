/**
 * Copying the bundled renderer scaffold onto a creator's disk.
 *
 * This lives in its own module because the inline version of it shipped broken for six releases
 * (alpha.9 → alpha.14) and could not be reproduced in a dev checkout. `abx scaffold-renderer`
 * created the directory, printed the whole success walkthrough, exited 0, and wrote **zero files** —
 * for every user, on every invocation form, while working perfectly for us.
 *
 * The cause was a path filter that judged absolute paths:
 *
 *     filter: (s) => !/(^|\/)(out|cache|dependencies|broadcast|node_modules)(\/|$)/.test(s)
 *
 * `cpSync` hands `filter` ABSOLUTE source paths. An installed CLI lives at
 * `…/node_modules/@artblocks/abx-cli/assets/renderer-scaffold`, so that pattern matched the source
 * ROOT — `cpSync` skips a directory's entire subtree when the directory itself is filtered out, and
 * silently copies nothing rather than erroring. A dev checkout's path
 * (`…/plan/abx/packages/cli/assets/…`) contains no `node_modules`, so every test we ran passed.
 *
 * Two rules follow, and the tests in `test/scaffold.test.ts` pin both:
 *   1. Judge paths RELATIVE to the source root, never the absolute string.
 *   2. Never report success without asserting the output actually landed.
 */
import {cpSync, existsSync, mkdirSync} from 'node:fs';
import {join, relative} from 'node:path';

/** Build/dependency dirs that must never ride along into a fresh scaffold. Matched against the
 *  path RELATIVE to the scaffold root — see the module note. */
const SKIP_DIR = /^(out|cache|dependencies|broadcast|node_modules)(\/|$)/;

/** The file whose presence means the renderer copy genuinely happened (not just `mkdir`). */
export const SCAFFOLD_ANCHOR = join('src', 'MyRenderer.sol');

/**
 * Copy the scaffold at `src` into `dir`, omitting build/dependency dirs.
 *
 * Throws if the copy produced no files — the caller must not print a success banner over an empty
 * directory. Returns nothing on success; `anchor` is guaranteed to exist relative to `dir`.
 */
export function copyScaffold(src: string, dir: string, anchor: string): void {
  mkdirSync(dir, {recursive: true});
  cpSync(src, dir, {
    recursive: true,
    filter: (s) => {
      // Normalise separators so the same pattern holds on Windows.
      const rel = relative(src, s).split(/[/\\]/).join('/');
      return rel === '' || !SKIP_DIR.test(rel);
    },
  });
  if (!existsSync(join(dir, anchor))) {
    throw new Error(
      `scaffold copy wrote no files into ${dir} (expected ${anchor}) — nothing was written, ` +
        `so don't build here. Scaffold source: ${src}. ` +
        `Please report this along with your install path: https://docs.abx.io`,
    );
  }
}

/** @deprecated thin wrapper kept for the existing call sites/tests — prefer {@link copyScaffold}. */
export function copyRendererScaffold(src: string, dir: string): void {
  copyScaffold(src, dir, SCAFFOLD_ANCHOR);
}
