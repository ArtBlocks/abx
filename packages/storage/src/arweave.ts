import {existsSync, readFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';
import type {Hex} from 'viem';
import {resolveDataDir} from '@artblocks/abx-sdk/node';
import {privateKeyToAccount} from 'viem/accounts';
import type {DirEntry, StorageBackend, StoredContent} from './backend.js';
import {ContentIndex} from './content-index.js';
import {arweaveAddress, type ArweaveJwk} from './arweave-identity.js';

/**
 * Arweave byte custody — **pay-once permanent** storage, the strongest fit for "custody never
 * lapsable": a single upfront payment, then the bytes are kept for centuries by Arweave's
 * storage endowment — no recurring fee, nothing to re-pin. Retrieval is dep-free: any gateway
 * serves the bytes at `{gateway}/{txid}`.
 *
 * Upload must go through a bundler that signs an ANS-104 data item, so the uploader is a
 * **swappable provider** behind {@link ArweaveUploader}:
 *
 *  - **`turbo`** (default, recommended) — backed by ArDrive Turbo. Uploads under 100 KiB are
 *    **free with no setup**; larger uploads draw on prepaid credits you top up with a card (or
 *    crypto). The actual Turbo/arbundles implementation lives in the SEPARATE, OPTIONAL
 *    `@artblocks/abx-storage-arweave` package — `@ardrive/turbo-sdk` depends on
 *    `x402-fetch` -> `x402` -> `wagmi`, which drags in the entire browser wallet-connector
 *    ecosystem, so a default CLI/SDK install must never pull it in. `buildUploader` below
 *    `await import()`s it only when an upload/balance/top-up actually runs — never for retrieval
 *    (get/locator/health) and never merely because `arweave` is the configured backend — and
 *    throws a clear "install this package" error if it isn't present. `npm install
 *    @artblocks/abx-storage-arweave` to use it.
 *  - **`http-bundler`** — {@link HttpBundlerUploader}, a dep-free token-authenticated POST to a
 *    managed endpoint you run/point at (the escape hatch / bring-your-own-bundler).
 *
 * Funding is an **optional capability** ({@link ArweaveFunding}) a provider may expose — Turbo does
 * (prepaid credits); a provider funded another way omits it and the CLI says so, rather than
 * pretending every provider tops up the same way.
 *
 * Like IPFS, Arweave addresses by its own id (the txid), so it keeps an off-chain `keccak → txid`
 * index until a pointer commitment lives on-chain. The on-chain keccak256 stays the integrity
 * anchor — verify any gateway's bytes against it; the txid is just the locator.
 */
export interface ArweaveUploader {
  upload(bytes: Uint8Array, contentType: string): Promise<{id: string}>;
  /** Optional: providers backed by PREPAID CREDITS (e.g. Turbo) expose balance + fiat top-up. */
  readonly funding?: ArweaveFunding;
}

/** Funding capability for a credits-backed Arweave provider. */
export interface ArweaveFunding {
  /** The wallet that HOLDS the credits (an Arweave address) — what a top-up funds. */
  address(): Promise<string>;
  /** Remaining prepaid balance: raw `winc` (Winston credits) + a `credits` ≈ winc/1e12 display. */
  balance(): Promise<{winc: string; credits: string}>;
  /**
   * Open a fiat (card, via Stripe) top-up of `usd` dollars onto {@link address}; returns the
   * checkout URL to hand the user. One-time payment — Arweave storage has no recurring fee, and
   * leftover credits persist on the address for future uploads.
   */
  topup(opts: {usd: number}): Promise<{url: string; winc: string}>;
}

export type ArweaveProvider = 'turbo' | 'http-bundler';

/**
 * Best-effort USD estimate for a Turbo (Arweave) upload of `bytes`, from Turbo's PUBLIC price API
 * (no key, no SDK). Returns null on ANY failure (offline, timeout, API change) — callers treat it
 * as a bonus and carry on. Rough by design: linear in bytes, current rates.
 */
export async function turboUploadCostUsd(bytes: number): Promise<number | null> {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const base = 'https://payment.ardrive.io/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const [priceRes, ratesRes] = await Promise.all([
      fetch(`${base}/price/bytes/${Math.floor(bytes)}`, {signal: ctrl.signal}),
      fetch(`${base}/rates`, {signal: ctrl.signal}),
    ]);
    if (!priceRes.ok || !ratesRes.ok) return null;
    const price = (await priceRes.json()) as {winc?: string};
    const rates = (await ratesRes.json()) as {winc?: string; fiat?: {usd?: number}};
    const uploadWinc = Number(price.winc);
    const refWinc = Number(rates.winc);
    const usdPerRef = rates.fiat?.usd;
    if (!uploadWinc || !refWinc || !usdPerRef) return null;
    return (uploadWinc / refWinc) * usdPerRef;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Winston-credit (winc) cost of a Turbo upload of `bytes`, from the PUBLIC price API (no key,
 * no SDK). Returns null on any failure — callers treat null as "couldn't check". For the pre-upload
 * funds guard: compare against the identity's balance winc. 1 credit = 1e12 winc.
 */
export async function turboUploadWinc(bytes: number): Promise<number | null> {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://payment.ardrive.io/v1/price/bytes/${Math.floor(bytes)}`, {signal: ctrl.signal});
    if (!res.ok) return null;
    const price = (await res.json()) as {winc?: string};
    return Number(price.winc) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Turbo credit balance of ANY address, from the PUBLIC payment API — **no key, no signature**.
 * So the CLI can check whether a creator's *Ethereum wallet* holds Turbo credits (to recommend
 * `--storage-signer eth`) before ever suggesting a top-up. `token` is the address's chain
 * (`ethereum` for an EVM wallet, `arweave` for a JWK address). Returns null on any failure
 * (offline, unknown address) — callers treat it as "couldn't check". 1 credit = 1e12 winc.
 */
export async function turboBalanceForAddress(address: string, token: 'ethereum' | 'arweave' | 'solana' = 'ethereum'): Promise<{winc: string; credits: string} | null> {
  if (!address) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://payment.ardrive.io/v1/account/balance/${token}?address=${encodeURIComponent(address)}`, {signal: ctrl.signal});
    if (!res.ok) return null; // 404 = address has never had a Turbo balance
    const winc = (((await res.json()) as {winc?: unknown}).winc ?? '').toString();
    if (!/^\d+$/.test(winc)) return null;
    return {winc, credits: wincToCredits(winc)};
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Turbo's free-upload ceiling: data items under 100 KiB upload for free — no credits, no prior
 *  top-up, no setup. Most single 1/1 SVGs/PNGs fall under it. */
export const ARWEAVE_FREE_UPLOAD_LIMIT = 100 * 1024;

export interface ArweaveConfig {
  /** Gateway base for retrieval. Default `https://arweave.net`. */
  gateway: string;
  /** Upload route. Default `turbo` (or `http-bundler` when an `uploadUrl` is set). */
  provider?: ArweaveProvider;
  /** Managed bundler upload endpoint — the `http-bundler` provider only. */
  uploadUrl?: string;
  /** `http-bundler` auth token — secret, from env, never persisted to config. */
  token?: string;
  /**
   * `turbo` identity (Arweave JWK) — signs uploads AND holds the prepaid credits. Secret, from a
   * key file or env, never persisted to a tool-written config file. The CLI manages one at
   * `.abx-self-host/arweave-key.json`.
   */
  jwk?: ArweaveJwk;
  /**
   * Alternative `turbo` identity: an **Ethereum** private key (hex). Turbo is multi-chain, so an
   * EVM key is a first-class Turbo identity — its **ETH address** holds the prepaid credits and
   * signs uploads. This is the ".env hot lane" for storage: a user who funded their wallet's Turbo
   * balance reuses it here. Secret, env/flag only, never persisted. Takes precedence over `jwk`.
   */
  ethSignerKey?: string;
  /**
   * Alternative `turbo` identity: a **remote** Ethereum wallet (the browser `--sign` lane). The key
   * never leaves the wallet; `signMessage` round-trips each EIP-191 signature to it and returns the
   * `0x`-prefixed 65-byte signature hex (what `personal_sign` yields). `address` is the ETH address
   * (for funding/display). Takes precedence over `ethSignerKey`/`jwk`. Not representable in env —
   * the CLI injects it when driving a wallet session.
   */
  remoteEth?: {address: string; signMessage: (message: Uint8Array) => Promise<string>};
  /**
   * Mint-on-first-write hook for the **managed** Turbo identity. When Turbo is selected and no
   * identity is otherwise available (no `jwk`/eth/remote), the backend calls this — but ONLY on an
   * actual upload (`put`/`putDirectory`), never on a read/probe — to lazily create + persist the
   * managed key. The CLI injects `() => ensureArweaveJwk().jwk` (it owns the key file location);
   * a bare library consumer omits it and gets the "needs an identity" error instead. Creating an
   * RSA keypair is free + local, and Turbo's <100 KiB free tier means the upload then just works.
   */
  ensureJwk?: () => ArweaveJwk;
}

/**
 * A Turbo signing identity: what signs uploads AND (for the prepaid Turbo path) whose credits pay.
 * Turbo is multi-chain, so an identity is one of:
 *  - **arweave** — the CLI-managed JWK (default); address = `base64url(sha256(n))`.
 *  - **ethereum** — an EVM private key (the `.env` hot lane); address = the `0x…` account.
 *  - **ethereum-remote** — a browser wallet reached via a `signMessage` callback (the `--sign`
 *    lane); same ETH identity, key never leaves the wallet.
 */
export type TurboIdentity =
  | {kind: 'arweave'; jwk: ArweaveJwk}
  | {kind: 'ethereum'; privateKey: string}
  | {kind: 'ethereum-remote'; address: string; signMessage: (message: Uint8Array) => Promise<string>};

/** The Turbo identity a config selects (precedence: remote → eth key → arweave jwk), or null if
 *  none is available yet (e.g. Turbo before its managed key is created). */
export function turboIdentity(cfg: ArweaveConfig): TurboIdentity | null {
  if (cfg.remoteEth) return {kind: 'ethereum-remote', ...cfg.remoteEth};
  if (cfg.ethSignerKey) return {kind: 'ethereum', privateKey: cfg.ethSignerKey};
  if (cfg.jwk) return {kind: 'arweave', jwk: cfg.jwk};
  return null;
}

/**
 * The Turbo identity for an operation — {@link turboIdentity}, but when it would be null and this is
 * a WRITE (`opts.mint`), lazily mint the managed key via `cfg.ensureJwk` (creating + persisting it).
 * This is the ONLY implicit key-creation path, and it's gated on `mint` so reads/probes never mint.
 * Pure aside from the injected `ensureJwk` side effect — the write/read distinction is the caller's.
 */
export function resolveTurboIdentity(cfg: ArweaveConfig, opts: {mint?: boolean} = {}): TurboIdentity | null {
  const existing = turboIdentity(cfg);
  if (existing) return existing;
  if (opts.mint && cfg.ensureJwk) return {kind: 'arweave', jwk: cfg.ensureJwk()};
  return null;
}

/** Whether an identity is an Ethereum one (local key or remote wallet) — its address is `0x…`. */
export function isEthIdentity(id: TurboIdentity): id is Extract<TurboIdentity, {kind: `ethereum${string}`}> {
  return id.kind === 'ethereum' || id.kind === 'ethereum-remote';
}

const withHexPrefix = (k: string): `0x${string}` => (k.startsWith('0x') ? (k as `0x${string}`) : (`0x${k}` as `0x${string}`));

/** The credit-holding / signing address for an identity — Arweave `base64url(sha256(n))` or an
 *  EVM `0x…`. Pure derivation, no network. Its balance is what `abx storage balance` reports. */
export function turboIdentityAddress(id: TurboIdentity): string {
  switch (id.kind) {
    case 'arweave':
      return arweaveAddress(id.jwk);
    case 'ethereum':
      return privateKeyToAccount(withHexPrefix(id.privateKey)).address;
    case 'ethereum-remote':
      return id.address;
  }
}

const trim = (u: string): string => u.replace(/\/+$/, '');

/** The optional package carrying the Turbo/arbundles implementation — loaded lazily
 *  via an INDIRECT specifier (a variable, not a string literal) so TypeScript resolves the
 *  `import()` below as `any` instead of trying to resolve real types for a package this file
 *  deliberately has no build-time dependency on (see the module doc and {@link buildUploader}). */
const TURBO_ARWEAVE_PACKAGE = '@artblocks/abx-storage-arweave';
const WINC_PER_CREDIT = 1e12;
const wincToCredits = (winc: unknown): string => {
  const n = Number(winc) / WINC_PER_CREDIT;
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
};

/** Dep-free uploader for token-authenticated managed Arweave upload endpoints. */
export class HttpBundlerUploader implements ArweaveUploader {
  constructor(private readonly cfg: {uploadUrl?: string; token?: string}) {}

  async upload(bytes: Uint8Array, contentType: string): Promise<{id: string}> {
    if (!this.cfg.uploadUrl) {
      throw new Error('Arweave http-bundler needs an upload endpoint — pass `--backend arweave --provider http-bundler --upload-url <bundler>` (or set ABX_ARWEAVE_UPLOAD_URL), or use the default `turbo` provider.');
    }
    const headers: Record<string, string> = {'content-type': contentType};
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    const res = await fetch(this.cfg.uploadUrl, {method: 'POST', headers, body: bytes});
    if (!res.ok) throw new Error(`Arweave upload failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as Record<string, unknown>;
    const id = json.id ?? json.txId ?? json.transactionId ?? json.arweaveTxId;
    if (!id) throw new Error('Arweave upload returned no transaction id');
    return {id: String(id)};
  }
}

/** The upload route for a config: explicit `provider`, else `http-bundler` when an `uploadUrl`
 *  is set, else the recommended `turbo`. */
export function arweaveProvider(cfg: ArweaveConfig): ArweaveProvider {
  return cfg.provider ?? (cfg.uploadUrl ? 'http-bundler' : 'turbo');
}

/**
 * Loads the optional `@artblocks/abx-storage-arweave` package and constructs its `TurboUploader`
 * for `id` — the ONLY place this file reaches for that package, and only on this call path (never
 * for retrieval/health). A clean install of `@artblocks/abx-cli` / `@artblocks/abx-storage` never
 * installs it; this throws the actionable "install it, or switch provider" error the
 * unavailable-adapter case needs.
 *
 * `TURBO_ARWEAVE_PACKAGE` is a variable, not a string literal, specifically so TypeScript types the
 * `import()` result as `any` instead of trying (and failing) to resolve real declarations for a
 * package this file has no build-time dependency on — this package's build/typecheck/test never
 * needs `@artblocks/abx-storage-arweave` to be installed at all.
 */
async function loadTurboUploader(id: TurboIdentity): Promise<ArweaveUploader> {
  let mod: {TurboUploader: new (identity: TurboIdentity) => ArweaveUploader};
  try {
    mod = await import(/* @vite-ignore */ TURBO_ARWEAVE_PACKAGE);
  } catch {
    throw new Error("The Turbo provider needs the optional '@artblocks/abx-storage-arweave' package — install it (`npm install @artblocks/abx-storage-arweave`), or switch with `--backend arweave --provider http-bundler --upload-url <bundler>`.");
  }
  return new mod.TurboUploader(id);
}

async function buildUploader(cfg: ArweaveConfig, opts: {mint?: boolean} = {}): Promise<ArweaveUploader> {
  if (arweaveProvider(cfg) === 'http-bundler') {
    return new HttpBundlerUploader({uploadUrl: cfg.uploadUrl, token: cfg.token});
  }
  // On a WRITE (opts.mint), a managed default with no key yet is minted here (cfg.ensureJwk); on a
  // read/probe (no mint) an absent identity stays null → the throw below. So the managed default
  // "just works" for an upload without a prior setup step, and reads never create a key.
  const id = resolveTurboIdentity(cfg, opts);
  if (!id) {
    throw new Error('Arweave via Turbo needs an identity. Run an upload through the CLI (it creates a managed key at `.abx-self-host/arweave-key.json`), set ARWEAVE_JWK, sign with an EVM key/wallet (`--storage-signer eth`), or use `--provider http-bundler --upload-url <bundler>`.');
  }
  return loadTurboUploader(id);
}

/**
 * The funding capability for a config's provider, or throw a clear reason if that provider has
 * none — capability negotiation, so `abx storage topup`/`balance` dispatch through one verb and
 * a crypto-only provider says "fund the wallet directly" rather than pretending.
 */
export async function arweaveFunding(cfg: ArweaveConfig): Promise<ArweaveFunding> {
  const f = (await buildUploader(cfg)).funding;
  if (!f) throw new Error(`The '${arweaveProvider(cfg)}' Arweave provider has no prepaid balance — fund its wallet directly.`);
  return f;
}

export class ArweaveBackend implements StorageBackend {
  readonly id = 'arweave';
  private readonly index: ContentIndex;
  private uploaderInstance?: ArweaveUploader;
  private readonly injectedUploader?: ArweaveUploader;

  constructor(private readonly cfg: ArweaveConfig, dataDir?: string, uploader?: ArweaveUploader) {
    this.index = new ContentIndex(dataDir);
    this.injectedUploader = uploader;
  }

  /** Built lazily on first use — retrieval (get/locator/health, the resolver path) needs only the
   *  gateway, never an upload identity or the optional Turbo package. `mint` (passed by the write
   *  ops) lets a managed default create its key here; reads/probes pass false so they never mint.
   *  `??=` short-circuits on an already-built or explicitly injected uploader, so the `turbo` path
   *  never awaits (and so never triggers) `buildUploader`'s `@artblocks/abx-storage-arweave` import
   *  unless one is actually needed. */
  private async uploader(mint = false): Promise<ArweaveUploader> {
    return (this.uploaderInstance ??= this.injectedUploader ?? (await buildUploader(this.cfg, {mint})));
  }

  /** Funding capability of the active provider, or null if it has none (e.g. http-bundler) or
   *  can't yet be built (e.g. Turbo without an identity key, or the optional package not installed).
   *  The CLI uses {@link arweaveFunding} directly for an actionable error; this accessor is the safe
   *  boolean-ish capability probe. */
  async funding(): Promise<ArweaveFunding | null> {
    try {
      return (await this.uploader(false)).funding ?? null;
    } catch {
      return null;
    }
  }

  async put(hash: Hex, content: StoredContent): Promise<void> {
    const uploader = await this.uploader(true);
    const {id} = await uploader.upload(content.bytes, content.contentType);
    this.index.set(hash, {pointer: id, contentType: content.contentType});
  }

  async get(hash: Hex): Promise<StoredContent | null> {
    const entry = this.index.get(hash);
    if (!entry) return null;
    const res = await fetch(`${trim(this.cfg.gateway)}/${entry.pointer}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Arweave gateway GET failed (${res.status})`);
    return {bytes: new Uint8Array(await res.arrayBuffer()), contentType: entry.contentType};
  }

  async has(hash: Hex): Promise<boolean> {
    return this.index.has(hash);
  }

  /** The gateway HTTPS URL for the bytes (`<gateway>/<txid>`) — the production-safe form an NFT
   *  `image` needs (a raw `ar://` doesn't render in browsers/most wallets). The txid is permanent,
   *  so the bytes resolve through any Arweave gateway and verify against the on-chain keccak256;
   *  we serve a concrete reachable one. Null until the bytes are uploaded. */
  async locator(hash: Hex): Promise<string | null> {
    const entry = this.index.get(hash);
    return entry ? `${trim(this.cfg.gateway)}/${entry.pointer}` : null;
  }

  /**
   * Upload a directory of files as an Arweave **path manifest**: each file is uploaded to its own
   * txid, then a manifest (`arweave/paths`) mapping `name → txid` is uploaded, and its txid is the
   * directory root. `<gateway>/<manifestTxid>/0.png` then resolves. The manifest txid is a
   * permanent, content-addressed root → integrity for the whole set, no per-file keccak needed.
   */
  async putDirectory(entries: DirEntry[]): Promise<{base: string}> {
    const up = await this.uploader(true);
    const paths: Record<string, {id: string}> = {};
    for (const e of entries) {
      const {id} = await up.upload(e.bytes, e.contentType);
      paths[e.name] = {id};
    }
    const manifest = {
      manifest: 'arweave/paths',
      version: '0.1.0',
      index: entries[0] ? {path: entries[0].name} : undefined,
      paths,
    };
    const {id: manifestId} = await up.upload(new TextEncoder().encode(JSON.stringify(manifest)), 'application/x.arweave-manifest+json');
    return {base: `${trim(this.cfg.gateway)}/${manifestId}`};
  }

  async health(): Promise<{ok: boolean; detail?: string}> {
    const provider = arweaveProvider(this.cfg);
    try {
      const res = await fetch(trim(this.cfg.gateway), {method: 'HEAD'});
      const reachable = res.status < 500;
      let detail = `provider ${provider} · gateway ${this.cfg.gateway}`;
      if (provider === 'http-bundler') {
        if (!this.cfg.uploadUrl) {
          return {ok: false, detail: `${detail} · no upload endpoint — set --upload-url <bundler> (or use --provider turbo)`};
        }
        detail += ` · upload ${this.cfg.uploadUrl}${this.cfg.token ? ' (token set)' : ' (no token)'}`;
      } else {
        const id = turboIdentity(this.cfg);
        detail += id
          ? ` · identity ${isEthIdentity(id) ? 'eth' : 'arweave'} ${turboIdentityAddress(id)}`
          : ' · identity created on first upload (free under 100 KiB)';
      }
      return {ok: reachable, detail};
    } catch (e) {
      return {ok: false, detail: (e as Error).message};
    }
  }
}

/** Build an Arweave config from the environment (non-secret values; the token/JWK/eth-key are
 *  secrets). `ABX_ARWEAVE_ETH_SIGNER_KEY` selects an EVM Turbo identity (the CLI usually sets this
 *  from the resolved signing key instead). */
export function arweaveConfigFromEnv(): ArweaveConfig {
  return {
    gateway: process.env.ABX_ARWEAVE_GATEWAY ?? 'https://arweave.net',
    provider: process.env.ABX_ARWEAVE_PROVIDER as ArweaveProvider | undefined,
    uploadUrl: process.env.ABX_ARWEAVE_UPLOAD_URL,
    token: process.env.ARWEAVE_UPLOAD_TOKEN,
    jwk: resolveArweaveJwk(),
    ethSignerKey: process.env.ABX_ARWEAVE_ETH_SIGNER_KEY,
  };
}

/**
 * Where the CLI keeps the Turbo identity it creates and manages on first upload.
 *
 * `dataDir`, when given, is the CALLER'S already-resolved data directory (the CLI passes its own
 * `dataDir()` — see `config.ts`) — pass it whenever one is available so this can't disagree with
 * wherever the caller's SQLite projection / content index live (the data-directory coherence
 * criterion). Omit it only for a caller with no data-dir context of its own (e.g. an SDK
 * integrator reading `arweaveConfigFromEnv()` directly), which falls back to the same centralized
 * `resolveDataDir()` every other unparameterized call site uses.
 */
export function arweaveKeyFilePath(dataDir?: string): string {
  const dir = dataDir ?? resolveDataDir().dir;
  return process.env.ABX_ARWEAVE_KEY_FILE ?? resolvePath(dir, 'arweave-key.json');
}

/**
 * The ONE place either layer resolves an Arweave identity: `ARWEAVE_JWK` (an explicit, inline
 * secret) if set, else the CLI-managed key file.
 *
 * That fallback is the whole point. The CLI mints and manages `.abx-self-host/arweave-key.json` on
 * first upload, but this function used to read `ARWEAVE_JWK` and nothing else — so an integrator
 * porting a working CLI flow to the SDK, on the same machine, minutes later, had every upload fail
 * with "Arweave via Turbo needs an identity". The message said storage was never configured; the
 * truth was that two layers disagreed about where the identity lives, and it named neither the file
 * nor the mismatch. They reimplemented this lookup themselves to get moving.
 *
 * `dataDir` forwards straight to {@link arweaveKeyFilePath} — see its doc comment.
 */
export function resolveArweaveJwk(dataDir?: string): ArweaveJwk | undefined {
  const fromEnv = parseJwkEnv(process.env.ARWEAVE_JWK);
  if (fromEnv) return fromEnv;
  const file = arweaveKeyFilePath(dataDir);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, 'utf8');
  if (raw.trim() === '') {
    // An empty key file is a real state (an interrupted first upload), and the bare parser error it
    // used to produce — "Unexpected end of JSON input" from `abx doctor` — pointed at a parser
    // rather than the file or the remedy.
    throw new Error(`Arweave key file ${file} is empty — delete it and re-run; the CLI mints a fresh managed identity on the next upload.`);
  }
  try {
    return JSON.parse(raw) as ArweaveJwk;
  } catch {
    throw new Error(`Arweave key file ${file} is not valid JSON — delete it to regenerate, or point ABX_ARWEAVE_KEY_FILE at a valid JWK.`);
  }
}

function parseJwkEnv(raw?: string): ArweaveJwk | undefined {
  if (!raw) return undefined;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    return JSON.parse(text) as ArweaveJwk;
  } catch {
    throw new Error('ARWEAVE_JWK is not valid JSON (or base64 of JSON).');
  }
}
