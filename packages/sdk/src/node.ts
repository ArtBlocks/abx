/**
 * `@artblocks/abx-sdk/node` — the ONE Node-only subpath. Everything reachable from the
 * package's main entry (`.`) has to run in a browser bundle (see `test/browser-bundle.test.ts`),
 * so `.env` loading — which needs `node:fs` + `node:path` — lives here instead, behind an
 * explicit import a host opts into.
 *
 * A host calls `loadDotEnv()` exactly ONCE, at startup, before anything reads `process.env`
 * (the CLI's `main()`, the effects runner's `main()`). The SDK core never calls it itself —
 * see `clients.ts` / `chains.ts` / `deployments.ts`'s `readEnv`, which just reads whatever is
 * already in `process.env` (or nothing, in a browser) and leaves loading it to the host.
 */
import {existsSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';

export {loadDotEnv, parseEnvContent} from './env.js';

/** The directory name every self-hosted node's local state (SQLite projection, managed Arweave
 *  key, content index) lives under. One literal, everywhere — see {@link resolveDataDir}. */
export const ABX_DATA_DIR_NAME = '.abx-self-host';

export interface DataDirResolution {
  /** Absolute path to use as this invocation's data directory. */
  dir: string;
  /**
   * Where `dir` came from:
   *  - `'env'`        — `ABX_DATA_DIR` was set; it always wins and discovery never ran.
   *  - `'cwd'`        — the ordinary default, `<cwd>/${ABX_DATA_DIR_NAME}` (whether or not it
   *    exists yet — a write command creates it there on first use, same as always).
   *  - `'discovered'` — an EXISTING `${ABX_DATA_DIR_NAME}` found by walking up from cwd. Never
   *    the write-path outcome — see {@link ResolveDataDirOptions.allowUpwardDiscovery}.
   */
  source: 'env' | 'cwd' | 'discovered';
}

export interface ResolveDataDirOptions {
  /** Defaults to `process.cwd()`. Exposed so callers (and tests) don't have to `chdir`. */
  cwd?: string;
  /** Defaults to `process.env`. Exposed for tests — never mutate the real environment to test this. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir()`. Exposed so a test can exercise the home-directory boundary
   *  without depending on (or touching) the real account running the test. */
  home?: string;
  /**
   * Walk up from `cwd`, git-style, for an ALREADY-EXISTING `${ABX_DATA_DIR_NAME}` before falling
   * back to `<cwd>/${ABX_DATA_DIR_NAME}`. Opt in per-invocation for READ paths ONLY — see
   * {@link resolveDataDir}'s doc comment for the full rationale and the bound on how far it looks.
   */
  allowUpwardDiscovery?: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // missing, or a file where a directory is expected — either way, not a hit
  }
}

/**
 * The ONE place a self-hosted node's data directory gets located. Every consumer — the CLI, the
 * indexer's SQLite store, the storage package's local-disk backend, content index, and managed
 * Arweave key — used to carry an INDEPENDENT copy of `ABX_DATA_DIR ?? cwd/.abx-self-host`, which is
 * exactly the setup that silently splits one project's SQLite projection from its managed Arweave
 * key into two different directories the moment any single copy drifts from the others. To keep
 * managed Arweave key and projection locations coherent, every one of those call sites now
 * resolves through here instead.
 *
 * `ABX_DATA_DIR` always wins outright — set it and discovery never runs, full stop. That isolation
 * is load-bearing (tests rely on it to run concurrently against disposable temp dirs; an operator
 * relies on it to pin a specific node) and this function must never weaken it.
 *
 * Without it, the default is `<cwd>/.abx-self-host` — unchanged from before this existed. With
 * {@link ResolveDataDirOptions.allowUpwardDiscovery} (a READ-only opt-in; see the CLI's
 * per-command allowlist in `config.ts`), and only when nothing already exists at cwd, this walks
 * UP the directory tree looking for an EXISTING `.abx-self-host`, so (say) `abx status` run from a
 * project subdirectory finds the same node a run from the project root would — instead of quietly
 * opening a second, empty one.
 *
 * The search is BOUNDED, git-style — it stops at (but still checks) the user's home directory, a
 * directory containing `.git` (a repository root), or the filesystem root, so it can never wander
 * into an unrelated ancestor tree. And it never merges two directories: the first EXISTING
 * `.abx-self-host` found wins outright, and `source: 'discovered'` tells the caller to say so — a
 * discovered node is not the one a human just `cd`-ed into; that distinction must stay visible
 * rather than silently answering from the wrong place.
 */
export function resolveDataDir(options: ResolveDataDirOptions = {}): DataDirResolution {
  const env = options.env ?? process.env;
  const explicit = env.ABX_DATA_DIR;
  if (explicit) return {dir: resolve(explicit), source: 'env'};

  const startCwd = resolve(options.cwd ?? process.cwd());
  const cwdDir = resolve(startCwd, ABX_DATA_DIR_NAME);
  if (!options.allowUpwardDiscovery || isDirectory(cwdDir)) {
    return {dir: cwdDir, source: 'cwd'};
  }

  const home = resolve(options.home ?? homedir());
  let dir = startCwd;
  for (;;) {
    if (dir !== startCwd) {
      const candidate = resolve(dir, ABX_DATA_DIR_NAME);
      if (isDirectory(candidate)) return {dir: candidate, source: 'discovered'};
    }
    if (dir === home || existsSync(join(dir, '.git'))) break; // boundary: checked, never crossed
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return {dir: cwdDir, source: 'cwd'};
}

/**
 * The registry-dependency family's injected `inflate` (deps.ts: `resolveRegistryDep` /
 * `dependencyScriptTags`), pre-wired for a Node host: `node:zlib`'s `gunzipSync`, one line. SDK
 * core takes `inflate` as a parameter rather than importing `node:zlib` directly so it stays
 * reachable from a browser bundle — a Node host (the token-api resolver, the CLI) passes this;
 * a browser host passes a `DecompressionStream`-based implementation instead.
 */
export function nodeInflate(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(bytes));
}
