#!/usr/bin/env node
/**
 * abx — the published binary's entry point, and nothing else.
 *
 * This file exists for one reason: **ESM links the entire static import graph before any module
 * body runs.** `main.ts` reaches `@artblocks/abx-indexer` → `node:sqlite` through `output.ts` and
 * `config.ts`, so on a Node that cannot load `node:sqlite` the process dies during *linking* —
 * before a single line of our code executes. A guard at the top of `main.ts` could never fire. The
 * only place a check can run first is a module that imports nothing statically and reaches the rest
 * of the CLI through a dynamic `import()`.
 *
 * What that bought before this file existed: `npm i -g @artblocks/abx-cli && abx doctor` on Node
 * 22.5 printed a raw `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` stack trace.
 * No mention of abx, Node versions, or what to do — on the first command we tell every user to run.
 *
 * We probe the *capability*, not the version number. `node:sqlite` shipped in v22.5.0 behind
 * `--experimental-sqlite` and lost the flag in v22.13.0 / v23.4.0, so an old Node run with
 * `NODE_OPTIONS=--experimental-sqlite` genuinely works — refusing it on a version comparison would
 * be a false negative on a setup the reporter proved out. `engines` states what we *support*; this
 * guard blocks only what is actually broken.
 *
 * KEEP THIS FILE IMPORT-FREE. A single static `import` of anything in the CLI reintroduces the
 * crash it exists to prevent.
 */

/** Unflagged `node:sqlite`: v22.13.0 on the 22.x line, v23.4.0 on 23.x (nodejs/node#55890). */
const NODE_FLOOR = '22.13.0';

const color = !process.env.NO_COLOR && process.stderr.isTTY;
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);

/**
 * True when this Node has `node:sqlite` but only behind `--experimental-sqlite` — i.e. the
 * v22.5.0–v22.12.x window (and v23.0–v23.3, which is EOL and not worth naming). Only then is the
 * NODE_OPTIONS escape hatch real; below v22.5.0 the module does not exist at any flag.
 */
function flagWouldWork(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (major === 22) return minor >= 5 && minor < 13;
  return major === 23;
}

function nodeSqliteMessage(version: string): string {
  const escape = flagWouldWork(version)
    ? `\n  Need to stay on this Node? It has SQLite, just flag-gated — but abx is untested there:\n    ${green(`NODE_OPTIONS=--experimental-sqlite abx ${process.argv[2] ?? 'doctor'}`)}\n`
    : '';
  return (
    `\n${red('✗')} abx needs Node's built-in SQLite (${dim('node:sqlite')}), and this Node can't load it.\n\n` +
    `    you have   ${red(`v${version}`)}\n` +
    `    abx needs  ${green(`v${NODE_FLOOR}`)} or newer\n\n` +
    `  Upgrade Node, then re-run:\n` +
    `    ${green('nvm install 22 && nvm use 22')}   ${dim('# or: brew upgrade node')}\n` +
    `    ${green('abx doctor')}\n` +
    escape
  );
}

try {
  await import('node:sqlite');
} catch {
  process.stderr.write(nodeSqliteMessage(process.versions.node));
  process.exit(1);
}

await import('./main.js');
