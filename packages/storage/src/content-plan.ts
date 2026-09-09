/**
 * Deploy-time image content planning — the pure "which representation" decision behind
 * `--onchain-uri`'s image handling (see reference/hosting.md): the bytes inline directly (SVG),
 * a direct-URL backend hosts them and its URL rides on-chain, or they fall back to off-chain
 * custody anchored by a keccak256 commitment. No I/O, no network — every input is a fact the
 * caller already has in hand (the file's sniffed bytes, the resolved backend id).
 */

/** Backends that can hand back a PUBLIC direct URL for uploaded bytes — content-addressed and
 *  permanent (ipfs, arweave) or a mutable host with a configured public base (cloud/S3) — the set
 *  that makes "image off-chain, on-chain JSON pointing at it, no server" possible. `fs` custody
 *  (this machine only) is deliberately excluded: its bytes are never reachable off the machine
 *  that stored them. */
export const DIRECT_URL_BACKENDS: ReadonlySet<string> = new Set(['ipfs', 'arweave', 'cloud']);

export type ImageContentLane =
  | 'inline-svg' // SVG text, inlined directly on-chain (self-resolving, no custody)
  | 'onchain-url' // a direct-URL backend hosts the bytes; its public URL is baked on-chain
  | 'keccak-custody'; // off-chain custody, anchored by keccak256 (a PLACEHOLDER if `onChain` was requested)

export interface ImageContentDecision {
  lane: ImageContentLane;
  /** True when `onChain` was requested but neither inline-SVG nor a direct-URL backend could
   *  honor it, so the on-chain image ends up a placeholder — the caller's cue to warn. */
  onchainFallback: boolean;
}

/**
 * Which representation an image's on-chain field takes — purely from local facts already in the
 * caller's hand, in priority order: inline SVG > a direct-URL backend's hosted image > keccak
 * custody. `isSvg` must come from sniffing the file's actual bytes (never inferred from the
 * extension alone — a mislabeled raster must not be inlined as SVG, which is why every call site
 * reads the file's head before deciding); `backendId` is the already-resolved storage backend.
 */
export function decideImageContentLane(input: {onChain: boolean; isSvg: boolean; backendId: string}): ImageContentDecision {
  if (!input.onChain) return {lane: 'keccak-custody', onchainFallback: false};
  if (input.isSvg) return {lane: 'inline-svg', onchainFallback: false};
  if (DIRECT_URL_BACKENDS.has(input.backendId)) return {lane: 'onchain-url', onchainFallback: false};
  return {lane: 'keccak-custody', onchainFallback: true};
}

export type RenderStorageResult = {ok: true} | {ok: false; reason: string};

/** Recognizable ipfs/arweave gateway shapes — the same hosts {@link parseLocator}
 *  (readiness.ts) treats as content-addressed networks, kept in sync deliberately: a locator this
 *  toolkit itself would classify as ipfs/arweave is exactly what `--image-base` can't use either. */
const CONTENT_ADDRESSED_URL_PATTERN = /ipfs:\/\/|ar:\/\/|\/ipfs\/|\.ipfs\.|ipfs\.io|dweb\.link|w3s\.link|arweave\.net|permagate\.io|vilenarios\.com|ar-io\.dev/i;

/**
 * Facts about a deploy/render configuration `validateRenderStorageCombo` decides from — every value
 * a caller already has in hand (the raw `--image-base` URL, the resolved storage backend id,
 * whether this operation publishes to a resolver it doesn't share a disk with). No I/O.
 */
export interface RenderStorageCombo {
  /** The raw `--image-base <url>` value, if one was given — checked against ITS OWN shape (an
   *  ipfs/arweave gateway vs. anything else). This is deliberately unrelated to `backendId` below:
   *  `--image-base` names where the EFFECT RUNNER later overwrites a still (its own `ABX_S3_*`
   *  config), not where this deploy's own uploads go. */
  imageBaseUrl?: string;
  /** The resolved storage backend id (`fs` · `cloud`/`s3` · `ipfs` · `arweave` · …) — this deploy's
   *  OWN upload target, relevant only to {@link RenderStorageCombo.publishesToRemoteResolver} below.
   *  Omit when only checking the `imageBaseUrl` combo. */
  backendId?: string;
  /** Only meaningful when `backendId` is `cloud`/`s3`: whether a public read base is configured
   *  (`ABX_S3_PUBLIC_BASE` / `--public-base`). Without one, `cloud` can hold bytes but can't hand
   *  back a URL for them — same failure mode as a content-addressed backend, for a different reason. */
  cloudHasPublicBase?: boolean;
  /** This operation publishes rendered output to a resolver that may not share this machine's disk
   *  (`abx deploy-effects`, `abx render --remote`, `abx effects` against a remote token) — the ONLY
   *  case a backend needs to hand back a public URL at all. A co-located runner (`abx effects` on
   *  the same host as `abx serve`) never needs one, so omit/false there. */
  publishesToRemoteResolver?: boolean;
}

/**
 * The one source of truth for "does this render × storage combination actually work" — encodes the
 * known-bad combos so a deploy's real run can refuse them and its `--dry-run` can flag the same
 * reason, from the SAME check (see `deploy-code`'s `--image-base` guard and the render/storage
 * dry-run row, and `requirePublishableBackend`'s render/effects refusal, which all call this).
 *
 * Checked in order (a config can only be wrong for one reason at a time — the first match wins):
 *   1. `--image-base` needs a MUTABLE, path-addressed URL (it names a key the effect runner
 *      overwrites in place) — a content-addressed gateway URL (ipfs/arweave) can't back a *fixed*
 *      per-token address, no matter what this deploy's OWN `--backend` happens to be.
 *   2. Publishing to a resolver that doesn't share this disk needs a backend that can hand back a
 *      public URL for what it stores at all — `fs` (and `cloud` with no public base) can't.
 */
export function validateRenderStorageCombo(combo: RenderStorageCombo): RenderStorageResult {
  if (combo.imageBaseUrl && CONTENT_ADDRESSED_URL_PATTERN.test(combo.imageBaseUrl)) {
    return {
      ok: false,
      reason:
        `--image-base '${combo.imageBaseUrl}' looks like a content-addressed (ipfs/arweave) gateway URL — a new upload there gets a NEW ` +
        `address, so it can't back the SAME per-token URL the effect runner overwrites in place. Use a mutable bucket/CDN URL instead (S3/R2 — a --backend cloud upload target with ABX_S3_PUBLIC_BASE).`,
    };
  }
  if (combo.publishesToRemoteResolver) {
    const hasLocator =
      !!combo.backendId && DIRECT_URL_BACKENDS.has(combo.backendId) && (combo.backendId !== 'cloud' || combo.cloudHasPublicBase);
    if (!hasLocator) {
      return {
        ok: false,
        reason:
          combo.backendId === 'cloud'
            ? `'cloud' has no public read base configured (ABX_S3_PUBLIC_BASE) — a resolver on another machine would have nothing to fetch.`
            : `'${combo.backendId}' can't produce a URL for what it stores — a resolver on another machine would have nothing to serve. Use --backend cloud/ipfs/arweave, or render co-located with the resolver.`,
      };
    }
  }
  return {ok: true};
}
