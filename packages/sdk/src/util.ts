/**
 * Small, environment-neutral helpers shared across the SDK core. Nothing here imports
 * `node:*` or references a Node-only global (`Buffer`, `process` unguarded) — this module
 * is reachable from the browser bundle (see `test/browser-bundle.test.ts`), so it has to
 * run identically wherever a caller (Node, a bundler, a browser tab) loads it.
 */
import type {Address, PublicClient} from 'viem';

/** `process.env[name]`, or `undefined` — safe to call even where `process` doesn't exist
 *  (a browser bundle). The SDK core never assumes Node; a host (the CLI, the effects
 *  runner) is where `process.env` is actually meaningful. */
export function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  return process.env[name];
}

/** Wait `ms` milliseconds. The one place the SDK debounces/retries, so every caller shares
 *  the same primitive instead of re-declaring `new Promise((r) => setTimeout(r, ms))`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The delay before retry `attempt` (1-indexed) under a LINEAR backoff: `attempt * baseMs`.
 *  Matches the shape `service.ts`'s request ladder already used (`retryDelayMs * attempt`) —
 *  pulled out here so every linear-backoff retry loop (the service client, the effects
 *  runner's resolver poll) computes the same delay the same way. */
export function linearBackoffDelay(attempt: number, baseMs: number): number {
  return attempt * baseMs;
}

/**
 * The delay before retry `attempt` (1-indexed) under an EXPONENTIAL backoff, capped:
 * `min(baseMs * 2^(attempt-1), capMs)`. Attempt 1 waits `baseMs`, attempt 2 waits `2*baseMs`,
 * attempt 3 `4*baseMs`, and so on until the cap takes over.
 *
 * Prefer this over {@link linearBackoffDelay} for a SUSTAINED rate limit or an overloaded
 * upstream, where a caller wants each retry to back off faster than the last so a burst of
 * callers doesn't keep landing on the same wall-clock second (linear backoff's delays grow by a
 * constant step, which under sustained pressure just re-synchronizes the retry storm at a lower
 * frequency instead of spreading it out). Prefer `linearBackoffDelay` for a transient/one-off
 * failure (a dropped connection, a single flaky read) where the retry ladder just needs to not
 * hammer immediately — exponential growth there overshoots into multi-minute waits for what was
 * likely a one-time blip.
 */
export function exponentialBackoffDelay(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

/**
 * A parsed `data:` URI (RFC 2397) — the most permissive of the three ad hoc parses this
 * replaces (a bare `data:,...`, a `;base64` flag anywhere in the parameter list, and an
 * arbitrary `;charset=...` alongside it). `mime` is empty-string-normalized to `text/plain`
 * (RFC 2397's own default); `body` is returned VERBATIM — still percent-encoded for a
 * non-base64 URI, still base64 text for one that is — so the caller decodes it exactly the
 * way it always did (`decodeURIComponent` vs a base64 decode).
 */
export interface ParsedDataUri {
  mime: string;
  base64: boolean;
  body: string;
}

const DATA_URI_RE = /^data:([^;,]*)((?:;[^,]*)?),([\s\S]*)$/;

/** Parse a `data:` URI, or `null` if `uri` isn't one. */
export function parseDataUri(uri: string): ParsedDataUri | null {
  const m = DATA_URI_RE.exec(uri);
  if (!m) return null;
  const params = m[2] ?? '';
  return {
    mime: m[1] || 'text/plain',
    base64: /(^|;)base64(;|$)/.test(params),
    body: m[3],
  };
}

/**
 * Read a contract, swallowing any failure ("no data" from a codeless address, a revert on
 * an extension the target doesn't compose) into `undefined` rather than a throw — the shape
 * every "does this getter exist / is there even a contract here" caller wants. Replaces the
 * three near-identical try/catch wrappers this SDK's callers each hand-rolled (a resume
 * planner's field-by-field read, a state dump's per-getter read, an owner-op's diagnostic
 * read) with one implementation.
 *
 * A caller that wants to DISTINGUISH "no contract at all" from "contract exists but this
 * call reverted" (the CLI's `assertContractExists` diagnostic) still does that itself — this
 * helper only knows "did the read come back", not why it didn't.
 */
export async function tryReadContract<T>(
  client: PublicClient,
  args: {address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]},
): Promise<T | undefined> {
  try {
    return (await client.readContract(args as never)) as T;
  } catch {
    return undefined;
  }
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes → base64 (RFC 4648). No `Buffer`, no `btoa` — both are runtime-conditional (Node
 *  lacks the latter, and a stricter embedder than a browser can lack the former too), and the
 *  SDK core needs exactly one behavior everywhere it runs. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

/** base64 → bytes — the inverse of {@link bytesToBase64}. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]);
    const c1 = BASE64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 3]);
    out[p++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[p++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0) out[p++] = ((c2 & 0x03) << 6) | c3;
  }
  return out;
}
