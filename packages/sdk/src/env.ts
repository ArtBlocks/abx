import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

/**
 * Minimal, dependency-free .env loader. Walks up from `startDir` to the repo
 * root looking for a `.env`, and sets any keys not already present in the
 * environment. Deliberately tiny — the toolkit must run with `pnpm install`
 * and nothing else.
 *
 * Node-only (needs `node:fs` + `node:path`) — reached exclusively through the
 * `@artblocks/abx-sdk/node` subpath, never the package's main entry (which a browser
 * bundle must be able to import — see `test/browser-bundle.test.ts`). A host calls
 * {@link loadDotEnv} once at startup; the SDK core never calls it itself (it reads
 * whatever's already in `process.env` via `util.ts`'s `readEnv`). Because this module is
 * Node-subpath-only, `parseInto`'s `console.error` on a conflicting duplicate key is fine
 * to leave as a direct console write — there is no browser caller to surprise.
 */
let loaded = false;

export function loadDotEnv(startDir: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      parseInto(readFileSync(candidate, 'utf8'));
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * Parse `.env` text into ordered entries plus any keys the file sets MORE THAN ONCE (pure — the
 * testable half of {@link loadDotEnv}). LAST occurrence wins, matching conventional dotenv tooling
 * (and the expectation that an appended override actually takes effect). Duplicates are still returned rather
 * than swallowed, because a stale duplicate (two `ABX_RPC_URLS_SEPOLIA` lines, one pointing at a
 * different network) leaves every downstream check passing while the tool talks to somewhere
 * unintended — and the symptom surfaces far away as "no contract at that address".
 */
export function parseEnvContent(content: string): {entries: Array<[string, string]>; duplicates: string[]} {
  const entries: Array<[string, string]> = [];
  const seen = new Map<string, string>();
  const indexOf = new Map<string, number>();
  const duplicates: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (seen.has(key)) {
      // Only a duplicate with a DIFFERENT value is worth reporting. A repeated identical line is
      // harmless, and warning on it turns a real signal into per-invocation noise (every `abx`
      // command is its own process, so there is nowhere to throttle a genuine warning to "once").
      if (seen.get(key) !== value && !duplicates.includes(key)) duplicates.push(key);
      // LAST wins: overwrite the value in place (keeping the key's original position in `entries`,
      // since order otherwise doesn't matter for env application).
      seen.set(key, value);
      entries[indexOf.get(key)!] = [key, value];
      continue;
    }
    seen.set(key, value);
    indexOf.set(key, entries.length);
    entries.push([key, value]);
  }
  return {entries, duplicates};
}

function parseInto(content: string): void {
  const {entries, duplicates} = parseEnvContent(content);
  for (const [key, value] of entries) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  if (duplicates.length) {
    console.error(
      `⚠ .env sets ${duplicates.length === 1 ? 'this key' : 'these keys'} to CONFLICTING values: ${duplicates.join(', ')}. ` +
        `The LAST value wins and the earlier one is ignored — delete the stale line, or you may be pointed somewhere you didn't intend.`,
    );
  }
}
