import {randomBytes} from 'node:crypto';
import type {StorageBackend} from './backend.js';
import type {CloudStorageConfig} from './cloud.js';
import {arweaveFunding, turboIdentity, turboIdentityAddress, isEthIdentity, type ArweaveConfig} from './arweave.js';
import {resolveBackend, type ResolveStorageOptions} from './resolve.js';

/**
 * `abx storage show --check` / `abx doctor`'s storage section — go beyond "is this backend
 * CONFIGURED" (what {@link resolveBackend} plus each backend's own `health()` already answer) to
 * "does a write actually reach the URL a token would bake on-chain."
 *
 * The gap this closes is the R2/S3 endpoint-vs-public-base confusion: a backend's `health()` signs
 * a request against the API `endpoint` — proving credentials work — but never touches the SEPARATE
 * `publicBase` a marketplace would actually fetch from. Those can point at different buckets (or one
 * can simply be wrong) with `health()` reporting green the whole time. A PUT through the API,
 * fetched back over the PUBLIC base with a plain unsigned GET, is the only check that proves the two
 * agree.
 *
 * `fs` and `ipfs` are NOT reimplemented here — their existing `health()` already does exactly what's
 * asked (fs: writability; ipfs: gateway/API reachability, no upload) and duplicating that logic is
 * how the two copies drift. `arweave` layers a balance READ (never a paid upload) on top of its
 * existing identity check. `cloud` gets the new round trip.
 */
export interface StorageCheckResult {
  backend: string;
  ok: boolean;
  detail: string;
  /** Set on a `cloud` check — the API write target and the public read URL, so a mismatch between
   *  them (the R2/S3 endpoint-vs-public-base trap) is visible on failure rather than a bare
   *  "fetch failed". Equal in shape, not necessarily in host — that's exactly what's being checked. */
  putUrl?: string;
  publicUrl?: string;
}

export interface StorageCheckOptions {
  /** Bound on each network step. A backend method with no abort hook (cloud's `putObject`/
   *  `getObject`, arweave's balance read) is raced against this rather than truly cancelled — good
   *  enough to keep a caller (doctor) from hanging, not a guarantee the underlying request stopped. */
  timeoutMs?: number;
  /** Injectable for tests — used for the public-base GET only (the PUT/API side goes through the
   *  resolved backend, which owns its own signing). */
  fetchFn?: typeof fetch;
}

/** Matches readiness.ts's gateway-probe default — this module's other real-network default. */
const DEFAULT_CHECK_TIMEOUT_MS = 6000;

/** Race a call against a `ms` deadline, rejecting with `message` if it wins. Most methods probed
 *  here have no abort hook of their own, so this stops WAITING for a hung request rather than
 *  cancelling it — good enough to keep a caller (doctor) from hanging. Always clears its timer, so
 *  a fast call doesn't leave one pending. */
async function race<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** fs + ipfs (and any future backend with nothing more to add): delegate straight to the existing
 *  `health()` — see the module doc for why this is reuse, not a stand-in pending real logic. */
export async function checkViaHealth(backend: StorageBackend, opts: StorageCheckOptions = {}): Promise<StorageCheckResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  try {
    const h = await race(
      backend.health?.() ?? Promise.resolve({ok: true, detail: 'no check defined for this backend'}),
      timeoutMs,
      `timed out after ${timeoutMs}ms`,
    );
    return {backend: backend.id, ok: h.ok, detail: h.detail ?? ''};
  } catch (e) {
    return {backend: backend.id, ok: false, detail: (e as Error).message};
  }
}

/**
 * `cloud`: PUT a tiny probe object through the signed API, then GET it back with a plain,
 * UNSIGNED fetch against `publicBase` — the same request a marketplace/browser would make. Reuses
 * one well-known key (`abx-probe/check.txt`) rather than minting a new one per run, so repeated
 * checks don't litter the bucket. `cfg` (when given) names the API write target too — the R2/S3
 * endpoint-vs-public-base trap is only diagnosable if BOTH URLs are on screen, not just the one
 * that failed.
 */
export async function checkCloudBackend(backend: StorageBackend, cfg?: CloudStorageConfig, opts: StorageCheckOptions = {}): Promise<StorageCheckResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const key = 'abx-probe/check.txt';
  const putUrl = cfg ? `${cfg.endpoint.replace(/\/+$/, '')}/${cfg.bucket}/${key}` : undefined;
  if (!backend.publicBase) {
    return {
      backend: 'cloud',
      ok: false,
      detail: "no public read base configured — set ABX_S3_PUBLIC_BASE (or --public-base) to the bucket's public URL.",
      putUrl,
    };
  }
  if (!backend.putObject || !backend.getObject) {
    return {backend: 'cloud', ok: false, detail: 'this cloud backend has no putObject/getObject — cannot round-trip check it.', putUrl};
  }
  const publicUrl = `${backend.publicBase.replace(/\/+$/, '')}/${key}`;
  const token = randomBytes(8).toString('hex');
  const body = `abx storage check ${token}`;
  const bytes = new TextEncoder().encode(body);

  try {
    await race(backend.putObject(key, {bytes, contentType: 'text/plain'}), timeoutMs, `PUT timed out after ${timeoutMs}ms`);
  } catch (e) {
    return {backend: 'cloud', ok: false, detail: `PUT via the API failed: ${(e as Error).message}`, putUrl, publicUrl};
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(publicUrl, {signal: ctrl.signal});
    if (!res.ok) {
      return {
        backend: 'cloud',
        ok: false,
        detail: `GET via the public base failed (${res.status}) — the public base may point at a different bucket/endpoint than the write API.`,
        putUrl,
        publicUrl,
      };
    }
    const got = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    if (got !== body) {
      return {
        backend: 'cloud',
        ok: false,
        detail: 'GET via the public base returned different bytes than were PUT — check for a caching layer or a public base pointed at a different bucket.',
        putUrl,
        publicUrl,
      };
    }
    return {backend: 'cloud', ok: true, detail: `round-trip ok via ${publicUrl}`, putUrl, publicUrl};
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return {
      backend: 'cloud',
      ok: false,
      detail: aborted ? `GET via the public base timed out after ${timeoutMs}ms` : `GET via the public base failed: ${(e as Error).message}`,
      putUrl,
      publicUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `arweave`: the existing `health()` (gateway reachability + identity presence) plus a Turbo
 * BALANCE read when an identity already exists — never a paid upload (no identity yet is reported
 * as-is: it's created free on first real upload, so there's nothing to check).
 */
export async function checkArweaveBackend(backend: StorageBackend, cfg: ArweaveConfig | undefined, opts: StorageCheckOptions = {}): Promise<StorageCheckResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  let base: {ok: boolean; detail?: string};
  try {
    base = await race(backend.health?.() ?? Promise.resolve({ok: true, detail: ''}), timeoutMs, `timed out after ${timeoutMs}ms`);
  } catch (e) {
    base = {ok: false, detail: (e as Error).message};
  }
  if (!cfg) return {backend: 'arweave', ok: base.ok, detail: base.detail ?? ''};

  const id = turboIdentity(cfg);
  if (!id) {
    return {backend: 'arweave', ok: base.ok, detail: [base.detail, 'no identity yet — created free on first upload (nothing to check)'].filter(Boolean).join(' · ')};
  }
  try {
    const funding = await arweaveFunding(cfg);
    const {credits} = await race(funding.balance(), timeoutMs, `balance check timed out after ${timeoutMs}ms`);
    const address = turboIdentityAddress(id);
    return {
      backend: 'arweave',
      ok: base.ok,
      detail: [base.detail, `${credits} credits (identity ${address}${isEthIdentity(id) ? ', eth' : ''})`].filter(Boolean).join(' · '),
    };
  } catch (e) {
    return {backend: 'arweave', ok: base.ok, detail: [base.detail, `balance check failed: ${(e as Error).message}`].filter(Boolean).join(' · ')};
  }
}

/**
 * The one storage-config probe both `abx storage show --check` and `abx doctor` call — dispatches to
 * the right per-backend check above. Resolving the backend can throw (missing required config, e.g.
 * cloud with no endpoint/bucket) — same as every other `resolveBackend` call site, and the caller's
 * existing try/catch around it is the right place to handle that, not this function.
 */
export async function probeStorageBackend(opts: ResolveStorageOptions, checkOpts: StorageCheckOptions = {}): Promise<StorageCheckResult> {
  const backend = resolveBackend(opts);
  if (backend.id === 'cloud' || backend.id === 's3') return checkCloudBackend(backend, opts.cloud, checkOpts);
  if (backend.id === 'arweave') return checkArweaveBackend(backend, opts.arweave, checkOpts);
  return checkViaHealth(backend, checkOpts);
}
