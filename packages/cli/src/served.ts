/**
 * What a URL-valued `tokenURI` **actually returns** — the served answer, not the pointer.
 *
 * `abx tokenuri` reads the chain, `abx verify` re-hashes bytes, and `abx status` reports the
 * indexing lifecycle — each a different slice, none of them the served JSON body. Fetching the
 * served JSON requires an explicit path.
 *
 * It also answers the question a *warning* couldn't. "Nothing tells you the provider you registered
 * with isn't the base baked on-chain" is real, but the obvious check — compare the remote's base URL
 * to the on-chain one — false-positives on the common custom-domain case (a baked `meta.creator.xyz`
 * fronting `api.provider.xyz`), and a warning that cries wolf on the correct setup is worse than none.
 * Fetching what the **baked** base serves makes the mismatch self-evident instead: you see the other
 * provider's 404, or another project's document.
 *
 * Lives in its own module because `main.ts` exports nothing (it runs `main()` unconditionally), so
 * anything that needs a test seam has to be extracted — the same reason `scaffold.ts` exists.
 */
import {parseDataUri} from '@artblocks/abx-sdk';

export interface ServedTokenUri {
  /** The URL followed, verbatim from the contract. `null` when the tokenURI isn't fetchable. */
  url: string | null;
  /** Why there was nothing to fetch, when there was nothing to fetch. */
  skipped: string | null;
  status: number | null;
  contentType: string | null;
  /** The response body as text, untruncated. `null` when the request never completed. */
  body: string | null;
  /** Transport-level failure (DNS, refused, timeout) — distinct from a served error status. */
  error?: string;
}

export interface FetchServedOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Follow a `tokenURI` and return what came back.
 *
 * A `data:` URI is **not** an error here — it IS the document, and a fully-on-chain project's whole
 * point is that there is no server to ask. Saying so plainly is the honest answer; reporting it as a
 * failure would punish the strongest configuration the protocol offers.
 */
export async function fetchServedTokenUri(uri: string, opts: FetchServedOptions = {}): Promise<ServedTokenUri> {
  if (!/^https?:\/\//i.test(uri)) {
    return {
      url: null,
      skipped: uri.startsWith('data:')
        ? 'the tokenURI IS the document (a data: URI) — it resolves on-chain, so there is no server to ask'
        : `the tokenURI is not an http(s) URL (${uri.slice(0, 40)}…) — nothing to fetch`,
      status: null,
      contentType: null,
      body: null,
    };
  }
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(uri, {signal: ctrl.signal, redirect: 'follow'});
    return {
      url: uri,
      skipped: null,
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: await res.text(),
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError' || ctrl.signal.aborted;
    return {
      url: uri,
      skipped: null,
      status: null,
      contentType: null,
      body: null,
      error: aborted ? `no response in ${timeoutMs}ms` : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the served answer is one a marketplace could actually use. */
export function servedOk(served: ServedTokenUri): boolean {
  return served.status !== null && served.status >= 200 && served.status < 300;
}

/** Pretty-print a served body when it is JSON, else return it unchanged. Never throws. */
export function prettyBody(body: string | null): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body; // not JSON — a provider's HTML error page is still worth seeing verbatim
  }
}

// Read tokenURI(id) STRAIGHT FROM THE CONTRACT on-chain (no server, no node) and decode
// the data: URI. For a fully on-chain token (`--onchain-uri`), this is the proof it
// self-resolves: the renderer assembles the JSON on-chain; any RPC returns it.
export function decodeOnChainJson(uri: string, verbatim = false): string | null {
  const parsed = parseDataUri(uri);
  if (!parsed || parsed.mime !== 'application/json') return null;
  const raw = parsed.base64 ? Buffer.from(parsed.body, 'base64').toString('utf8') : decodeURIComponent(parsed.body);
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    // `verbatim` (--json) returns the document EXACTLY as the chain assembled it. Everything below is
    // a courtesy for human eyes, and abbreviating for eyes is fine — abbreviating for a PROGRAM is
    // not. An integrator scraped this output, got a `data:` URI cut to 96 chars that still looked
    // valid, and stored it; the only way to read their own token was to reimplement `eth_call`.
    if (verbatim) return JSON.stringify(obj, null, 2);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      // Truncate only huge inline `data:` blobs (base64 SVGs/images); show plain locator URLs
      // (http/ipfs/ar) IN FULL so the creator can verify where the image actually resolves.
      if (typeof v === 'string' && v.startsWith('data:') && v.length > 96) obj[k] = `${v.slice(0, 96)}… (${v.length} chars)  [--json for the full value]`;
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return verbatim ? raw : raw.slice(0, 600);
  }
}
