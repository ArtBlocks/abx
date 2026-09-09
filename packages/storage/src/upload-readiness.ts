import type {ResolveStorageOptions} from './resolve.js';
import {ARWEAVE_FREE_UPLOAD_LIMIT, arweaveFunding, turboBalanceForAddress, turboUploadCostUsd, turboUploadWinc, type ArweaveConfig} from './arweave.js';

/**
 * Deploy-time storage readiness — what a REAL upload needs, decided from local facts (and, for the
 * best-effort USD estimate, one price-API call) so "dry-run passes, then the real deploy fails at
 * upload" can't happen. Three questions, each pure aside from the one noted network call:
 *
 *  - {@link planTurboUpload} — is THIS ONE file free (Turbo's 100 KiB tier) or chargeable?
 *  - {@link assessStorageReadiness} — across every backend, what does a real upload of `sizes` need
 *    (Arweave credits, a Pinata JWT, a cloud public base)?
 *  - {@link assessTurboFunds} — does the resolved Turbo identity have ENOUGH prepaid credits for
 *    `sizes`, and (when it's short) does the creator's own wallet already hold some?
 *
 * None of this mints or spends anything — it only INTERROGATES the resolved provider. Identity
 * creation is the caller's job (the CLI's managed-key flow owns the key file location; see
 * `arweave-identity.ts` / `ArweaveConfig.ensureJwk`), so `assessTurboFunds` expects a config that
 * already has one.
 */

/** Whether `opts` resolves to Arweave via the Turbo (prepaid-credits) provider — the only provider
 *  with a free tier and a funds balance to check; `http-bundler` skips every readiness/funds
 *  question below (it has its own auth, not a balance this package knows how to read). */
export function isTurboArweave(opts: ResolveStorageOptions): boolean {
  return opts.backend === 'arweave' && (opts.arweave?.provider ?? 'turbo') === 'turbo';
}

export interface TurboUploadPlan {
  /** Whether this upload is over Turbo's 100 KiB free tier (so it draws on prepaid credits). */
  chargeable: boolean;
  /** `size` in KB, formatted to 1 decimal — for the free-vs-credit readout. */
  sizeKb: string;
}

/** The free-vs-credit decision for ONE Turbo upload of `size` bytes — from the local byte size
 *  alone, so it works under `--dry-run` too. Null when `opts` doesn't resolve to Turbo-Arweave
 *  (nothing to decide). */
export function planTurboUpload(opts: ResolveStorageOptions, size: number): TurboUploadPlan | null {
  if (!isTurboArweave(opts)) return null;
  return {chargeable: size >= ARWEAVE_FREE_UPLOAD_LIMIT, sizeKb: (size / 1024).toFixed(1)};
}

/** Per-backend readiness facts for a real upload of `sizes` (per-file byte counts). Each variant
 *  carries only what its backend needs checked; a backend with nothing to check (`fs`, or anything
 *  this package doesn't know about) reports `'other'` — a literal, not the resolved id, so the
 *  union stays a real discriminated union (a plain `string` member would swallow the other
 *  branches on narrowing) — callers that branch on `backend` never needed the id anyway. */
export type StorageReadinessReport =
  | {backend: 'arweave'; overCount: number; totalCount: number; totalKb: number; usd: number | null}
  | {backend: 'ipfs'; pinataMissingJwt: boolean}
  | {backend: 'cloud'; missingPublicBase: boolean}
  | {backend: 'other'};

/**
 * What a REAL deploy against `opts` needs, from `sizes` (per-file byte sizes) alone — Arweave
 * credit needs (plus a best-effort USD estimate for the chargeable bytes), a missing Pinata JWT, or
 * a missing cloud public base. The one network call (Turbo's price API) is best-effort: a failure
 * there degrades `usd` to `null` rather than failing the whole check.
 */
export async function assessStorageReadiness(opts: ResolveStorageOptions, sizes: number[]): Promise<StorageReadinessReport> {
  if (opts.backend === 'arweave') {
    const chargeable = sizes.filter((s) => s >= ARWEAVE_FREE_UPLOAD_LIMIT);
    const usd = chargeable.length ? await turboUploadCostUsd(chargeable.reduce((a, b) => a + b, 0)) : null;
    const totalKb = Math.round(sizes.reduce((a, b) => a + b, 0) / 1024);
    return {backend: 'arweave', overCount: chargeable.length, totalCount: sizes.length, totalKb, usd};
  }
  if (opts.backend === 'ipfs') {
    return {backend: 'ipfs', pinataMissingJwt: (opts.ipfs?.mode ?? 'pinata') === 'pinata' && !opts.ipfs?.pinataJwt};
  }
  if (opts.backend === 'cloud') {
    return {backend: 'cloud', missingPublicBase: !opts.cloud?.publicBase};
  }
  return {backend: 'other'};
}

export interface TurboFundsCheck {
  /** True when the resolved identity does NOT have enough prepaid credits for `sizes`. */
  short: boolean;
  address: string;
  /** Whether the identity is an EVM one (`.env` key or a remote wallet) rather than the CLI-managed
   *  Arweave key — decides which recovery message applies. */
  isEth: boolean;
  haveWinc: number;
  needWinc: number;
  /** How many of `sizes` are over the free tier (what this shortfall is actually for). */
  chargeableCount: number;
  /** Set only when checked (short, a non-eth identity, and a wallet address was given): the
   *  creator's OWN wallet's Turbo balance, queryable by address with no key — so "spend those
   *  instead of topping up again" can be recommended before ever proposing a top-up. Null if that
   *  wallet has never had a Turbo balance. */
  walletCredits?: {winc: number; credits: string} | null;
}

/**
 * The pre-upload funds decision for a Turbo (Arweave) upload of `sizes` (per-file byte sizes):
 * chargeable bytes → the Winston cost → compare against the identity's prepaid balance. `cfg` must
 * already have a resolved identity (`jwk`/`ethSignerKey`/`remoteEth`) — this module only
 * INTERROGATES the resolved provider, never mints one (see the module doc). Returns `null` when
 * nothing is chargeable (every file is free) or the provider can't be reached right now — a
 * best-effort check never false-blocks; the upload itself will surface any real error.
 */
export async function assessTurboFunds(cfg: ArweaveConfig, sizes: number[], walletAddr?: string): Promise<TurboFundsCheck | null> {
  const chargeable = sizes.filter((s) => s >= ARWEAVE_FREE_UPLOAD_LIMIT);
  if (chargeable.length === 0) return null; // all free
  const funding = await arweaveFunding(cfg);
  let address: string;
  let haveWinc: number;
  try {
    address = await funding.address();
    haveWinc = Number((await funding.balance()).winc) || 0;
  } catch {
    return null; // can't reach Turbo to check — don't false-block; the upload will surface any real error
  }
  const needWinc = (await turboUploadWinc(chargeable.reduce((a, b) => a + b, 0))) ?? 0;
  const short = needWinc > 0 ? haveWinc < needWinc : haveWinc <= 0;
  const isEth = !!(cfg.ethSignerKey || cfg.remoteEth);

  let walletCredits: TurboFundsCheck['walletCredits'];
  if (short && !isEth && walletAddr) {
    const wb = await turboBalanceForAddress(walletAddr, 'ethereum');
    walletCredits = wb ? {winc: Number(wb.winc) || 0, credits: wb.credits} : null;
  }

  return {short, address, isEth, haveWinc, needWinc, chargeableCount: chargeable.length, walletCredits};
}
