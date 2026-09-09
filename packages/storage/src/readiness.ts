import {
  gatewayConfigFromEnv,
  gatewayUrlFor,
  linearBackoffDelay,
  resolveGatewayBase as sdkResolveGatewayBase,
  sleep,
  type LocatorNetwork,
} from '@artblocks/abx-sdk';

// Re-export the SDK gateway types and helpers unchanged so this package's public API remains stable.
export {gatewayUrlFor} from '@artblocks/abx-sdk';
export type {LocatorNetwork} from '@artblocks/abx-sdk';

/**
 * Is a locator **retrievable** yet — not just accepted?
 *
 * An upload service answers "accepted" the moment it has your bytes; a gateway answers "serving"
 * only once they have propagated to it, and on Arweave that gap runs to minutes. Nothing in the
 * upload result distinguishes the two, so the natural implementation — upload during a mint, write
 * the locator into the token — mints a token that renders broken for the first minutes of its life.
 *
 * Two independent integrators hit this eight days apart. The first rebuilt this layer themselves
 * (ranged GETs, a propagating/ready model, retry ladders lengthened after measuring real times) and
 * concluded "every serious integrator will rebuild some version of this." The second published 32
 * renders and found **32/32 404ing on `arweave.net` while 22/32 already served from `permagate.io`
 * and `vilenarios.com`**, with the uploader reporting `CONFIRMED` throughout. That second
 * observation is why this probes several gateways rather than one: propagation is per-gateway, so
 * "your gateway doesn't have it" and "the network doesn't have it" are different answers, and only
 * one of them means something is wrong.
 */

export type Readiness =
  /** The gateway this toolkit would actually use serves the bytes. Safe to reference. */
  | 'ready'
  /** Another gateway serves it, so the data provably exists on the network — yours hasn't caught
   *  up. Waiting is the fix. */
  | 'propagating'
  /** No probed gateway serves it. Deliberately NOT called "propagating": from outside, a locator
   *  that is still settling and one that is simply wrong look identical, and claiming the friendlier
   *  of the two is how a tool teaches someone to ignore it. */
  | 'unreachable';

export interface GatewayProbe {
  /** The exact URL asked. */
  url: string;
  /** Host only — what a human recognises. */
  gateway: string;
  /** Whether this gateway served the bytes. */
  serving: boolean;
  /** HTTP status, or null when the request never completed (timeout, DNS, refused). */
  status: number | null;
  contentType: string | null;
  /** Total size when the gateway reported one, else null. A ranged request is used, so this comes
   *  from `content-range`'s total rather than `content-length` (which is 1 byte on a 206). */
  bytes: number | null;
  ms: number;
  /** Why the request didn't complete. Absent when it did, whatever the status. */
  error?: string;
}

export interface LocatorStatus {
  /** The locator as given. */
  locator: string;
  network: LocatorNetwork;
  /** The txid / CID / absolute URL the locator resolves to. */
  id: string;
  readiness: Readiness;
  /** The gateway a baked locator would actually resolve through — the one that decides whether a
   *  marketplace can render this today. */
  primary: GatewayProbe;
  /** Well-known others for the same network. Their whole job is to tell propagation from a bad id. */
  alternates: GatewayProbe[];
}

/**
 * Gateways probed as alternates, per network. Kept short on purpose — this is a diagnosis, not a
 * survey, and each entry is a request someone waits on. The Arweave pair is the one the second
 * report actually measured serving ahead of `arweave.net`, so they are evidence rather than taste.
 */
const ALTERNATE_GATEWAYS: Record<'arweave' | 'ipfs', string[]> = {
  arweave: ['https://permagate.io', 'https://vilenarios.com'],
  ipfs: ['https://dweb.link', 'https://w3s.link'],
};

const DEFAULT_TIMEOUT_MS = 6000;

export interface LocatorStatusOptions {
  /** The gateway to treat as primary — normally the one the active backend is configured with, so
   *  the verdict is about the gateway that will really be used. Defaults per network. */
  gateway?: string;
  /** Skip the alternates (one request instead of three). The cost is the `propagating` verdict:
   *  without them, a locator that hasn't reached your gateway is indistinguishable from a bad one. */
  primaryOnly?: boolean;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** Parse any accepted locator form into its network + id. */
export function parseLocator(locator: string): {network: LocatorNetwork; id: string} {
  const raw = locator.trim();
  if (/^ar:\/\//i.test(raw)) return {network: 'arweave', id: raw.slice(5).replace(/^\/+/, '')};
  if (/^ipfs:\/\//i.test(raw)) return {network: 'ipfs', id: raw.slice(7).replace(/^\/+/, '')};
  if (/^https?:\/\//i.test(raw)) {
    // A gateway URL already names its own gateway; keep it whole and ask exactly it. Detecting the
    // network from the shape lets the alternates still apply (that is the point of the whole probe).
    if (/\/ipfs\//.test(raw) || /\.ipfs\./.test(raw)) return {network: 'ipfs', id: raw};
    if (/arweave\.net|permagate\.io|vilenarios\.com|ar-io\.dev/.test(raw)) return {network: 'arweave', id: raw};
    return {network: 'http', id: raw};
  }
  // Bare ids: an Arweave txid is 43 chars of base64url; a CIDv0 starts Qm…, a CIDv1 b…/f…
  if (/^[A-Za-z0-9_-]{43}$/.test(raw)) return {network: 'arweave', id: raw};
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|f[0-9a-f]{20,})/.test(raw)) return {network: 'ipfs', id: raw};
  throw new Error(
    `'${locator}' isn't a recognisable locator. Expected ar://<txid>, ipfs://<cid>, an https:// gateway URL, or a bare txid/CID.`,
  );
}

/**
 * The gateway BASE for a locator network — **override → env → generic public default**
 * (`ABX_IPFS_GATEWAY`/`ABX_ARWEAVE_GATEWAY`, then `ipfs.io`/`arweave.net`). This is the READ-TIME
 * default for resolving an arbitrary on-chain locator whose upload backend is unknown to the
 * resolver — distinct from {@link ipfsConfigFromEnv}/{@link arweaveConfigFromEnv}'s MODE-aware
 * defaults for a backend this toolkit itself configured to write through (e.g. a `kubo` IPFS
 * gateway defaults to `127.0.0.1:8080`, a locator resolver has no such context and must default
 * to something that resolves for anyone). `http` locators carry their own base (they are already
 * an absolute URL) and never reach here — callers return them verbatim before consulting a gateway.
 *
 * A thin compose over the SDK's split: {@link resolveGatewayBase} used to own the
 * `override ?? env ?? default` line itself (`process.env` read inline); now the pure decision
 * lives in `@artblocks/abx-sdk`'s `resolveGatewayBase` (src/gateways.ts) and the env read in its
 * `gatewayConfigFromEnv`, so this function's whole body is just wiring override → (env or
 * nothing) → the SDK's pure default. Kept here, under this same name and signature, because
 * every existing caller (this package's own `locatorStatus`, token-api's `resolveLocatorUrl`)
 * still wants exactly this three-rung precedence with one call.
 */
export function resolveGatewayBase(network: LocatorNetwork, override?: string): string {
  if (network === 'http') return '';
  if (override) return sdkResolveGatewayBase(network, network === 'ipfs' ? {ipfs: override} : {arweave: override});
  return sdkResolveGatewayBase(network, gatewayConfigFromEnv());
}

/**
 * Ask one gateway whether it serves these bytes, reading **headers only**.
 *
 * A ranged request (`Range: bytes=0-0`) is what keeps this cheap: the content in question can be tens of
 * megabytes and the question is only whether it is there. Gateways that ignore `Range` answer 200
 * with the whole body, so the body is cancelled rather than read — without that, checking a large
 * locator would download it.
 */
export async function probeGateway(
  url: string,
  opts: {timeoutMs?: number; fetchFn?: typeof fetch} = {},
): Promise<GatewayProbe> {
  const doFetch = opts.fetchFn ?? fetch;
  const gateway = safeHost(url);
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {headers: {range: 'bytes=0-0'}, signal: ctrl.signal, redirect: 'follow'});
    // Never read the body: a Range-ignoring gateway would otherwise stream the whole asset.
    try {
      await res.body?.cancel();
    } catch {
      /* already consumed or unsupported — nothing to release */
    }
    return {
      url,
      gateway,
      serving: res.status >= 200 && res.status < 300,
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: totalBytesFrom(res.headers.get('content-range'), res.headers.get('content-length'), res.status),
      ms: Date.now() - started,
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError' || ctrl.signal.aborted;
    return {
      url,
      gateway,
      serving: false,
      status: null,
      contentType: null,
      bytes: null,
      ms: Date.now() - started,
      error: aborted ? `no response in ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Accepted-vs-retrievable for one locator, across the gateway that matters and a couple of others. */
export async function locatorStatus(locator: string, opts: LocatorStatusOptions = {}): Promise<LocatorStatus> {
  const {network, id} = parseLocator(locator);
  const primaryGateway = resolveGatewayBase(network, opts.gateway);
  const primaryUrl = gatewayUrlFor(network, id, primaryGateway);

  // `http` locators have no notion of an alternate — the URL IS the address, so a second host would
  // be answering about different bytes.
  const alternateBases = opts.primaryOnly || network === 'http' ? [] : ALTERNATE_GATEWAYS[network];
  const alternateUrls = alternateBases
    .map((base) => gatewayUrlFor(network, id, base))
    .filter((u) => u !== primaryUrl);

  const probe = (u: string) => probeGateway(u, {timeoutMs: opts.timeoutMs, fetchFn: opts.fetchFn});
  const [primary, ...alternates] = await Promise.all([probe(primaryUrl), ...alternateUrls.map(probe)]);

  const readiness: Readiness = primary.serving
    ? 'ready'
    : alternates.some((a) => a.serving)
      ? 'propagating'
      : 'unreachable';

  return {locator, network, id, readiness, primary, alternates};
}

/** One poll attempt from {@link awaitLocatorReady} — lets a caller narrate progress (a CLI spinner,
 *  a log line) without this module printing anything itself (the SDK/storage layers never print). */
export interface AwaitLocatorReadyEvent {
  /** 1-indexed poll attempt. */
  attempt: number;
  /** Milliseconds since {@link awaitLocatorReady} was called. */
  elapsedMs: number;
  status: LocatorStatus;
}

export interface AwaitLocatorReadyOptions {
  /** Forwarded to every {@link locatorStatus} probe. */
  gateway?: string;
  primaryOnly?: boolean;
  /** Per-probe network timeout, forwarded as {@link LocatorStatusOptions.timeoutMs} (NOT the
   *  poll's overall deadline — see `timeoutMs` below). Default 6000ms, same as `locatorStatus`. */
  probeTimeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Give up polling once this much total time has elapsed, returning the last status with
   *  `ready: false` rather than throwing — a caller decides what "still not ready" means for its
   *  own flow. Default 5 minutes: long enough for typical Arweave propagation (this module's whole
   *  reason to exist — see the module doc, "the gap runs to minutes"). */
  timeoutMs?: number;
  /** Base delay for the linear backoff between polls (`attempt * pollBaseMs`, via the SDK's
   *  {@link linearBackoffDelay} — the same primitive `service.ts`'s retry ladder uses). Default
   *  3000ms, so the very first re-poll is quick and later ones back off. */
  pollBaseMs?: number;
  onEvent?: (e: AwaitLocatorReadyEvent) => void;
}

export interface AwaitLocatorReadyResult {
  /** The last status observed — `'ready'` iff {@link ready} is true. */
  status: LocatorStatus;
  attempts: number;
  elapsedMs: number;
  /** False when the deadline was hit before `status.readiness` reached `'ready'`. */
  ready: boolean;
}

const DEFAULT_AWAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_BASE_MS = 3000;

/**
 * Poll {@link locatorStatus} until it reports `'ready'` or the deadline passes.
 *
 * `locatorStatus` alone answers "right now" — the natural next question, for a caller that would
 * otherwise upload during a mint and write the locator into a token that renders broken for its
 * first minutes of life (see the module doc), is "wait until it's actually there." This is that,
 * factored out once so a caller doesn't hand-roll its own poll/backoff loop around a one-shot check.
 *
 * `'propagating'` is treated the same as `'unreachable'` here — both mean "not yet what THIS caller
 * can rely on" — but every intermediate status still reaches `onEvent`, so a caller that wants to
 * distinguish "provably on the network, just behind" from "no evidence yet" can from the events.
 */
export async function awaitLocatorReady(locator: string, opts: AwaitLocatorReadyOptions = {}): Promise<AwaitLocatorReadyResult> {
  const deadlineMs = opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const pollBaseMs = opts.pollBaseMs ?? DEFAULT_POLL_BASE_MS;
  const started = Date.now();
  const probeOpts: LocatorStatusOptions = {gateway: opts.gateway, primaryOnly: opts.primaryOnly, timeoutMs: opts.probeTimeoutMs, fetchFn: opts.fetchFn};
  let attempt = 0;
  for (;;) {
    attempt++;
    const status = await locatorStatus(locator, probeOpts);
    const elapsedMs = Date.now() - started;
    opts.onEvent?.({attempt, elapsedMs, status});
    if (status.readiness === 'ready') return {status, attempts: attempt, elapsedMs, ready: true};
    const delay = linearBackoffDelay(attempt, pollBaseMs);
    if (elapsedMs + delay >= deadlineMs) return {status, attempts: attempt, elapsedMs, ready: false};
    await sleep(delay);
  }
}

/** Total size from a ranged response's `content-range` (`bytes 0-0/12345`), else `content-length`
 *  when the gateway ignored the range and answered 200 with the whole thing. */
function totalBytesFrom(contentRange: string | null, contentLength: string | null, status: number): number | null {
  const m = contentRange?.match(/\/\s*(\d+)\s*$/);
  if (m) return Number(m[1]);
  if (status === 200 && contentLength && /^\d+$/.test(contentLength)) return Number(contentLength);
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
