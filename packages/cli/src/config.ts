import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {type Hex} from 'viem';
import {loadDotEnv, resolveDataDir, type DataDirResolution} from '@artblocks/abx-sdk/node';
import {
  arweaveAddress,
  generateArweaveJwk,
  resolveArweaveJwk,
  assessStorageReadiness,
  assessTurboFunds,
  isTurboArweave,
  planTurboUpload,
  resolveBackend,
  type ArweaveJwk,
  type ResolveStorageOptions,
  type StorageBackend,
} from '@artblocks/abx-storage';
import {
  resolveChain,
  DEFAULT_CHAIN_KEY,
  resolveFactory,
  resolveSeriesFactory,
  resolveRenderer,
  resolveChunkStore,
  resolveFixedPriceMinter,
  resolveOneOfOneEditionFactory,
  resolveEditionFactory,
  resolveEditionCodeFactory,
  resolveFixedPriceMinter1155,
  envSigningKey,
  explorerUrl,
  METADATA_REPRESENTATION as R,
  type Address,
  type ProjectState,
} from '@artblocks/abx-sdk';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';
import {type Flags} from './flags.js';
import {bold, dim, g, info, warn} from './output.js';

/**
 * Runtime resolution for the CLI — deliberately **stateless about decisions**. There is no
 * tool-written config file: every choice is resolved fresh per invocation from explicit flags,
 * the operator's environment, and shipped constants, so a command's behavior is a pure function
 * of its inputs (nothing a previous command silently mutated feeds a later one).
 *
 *  - Canonical infra (factory / renderer / chunk store): resolved from the SDK's shipped
 *    {@link resolveFactory} manifest, overridable by flag or env. See `@artblocks/abx-sdk` deployments.
 *  - Storage backend + non-secret settings: resolved here as **override → env → default**.
 *  - Secrets (signing keys, S3 creds, the Pinata JWT, the Arweave key): env / the key file only.
 *
 * The only thing that persists on disk is the project-local, chain-rebuildable projection
 * (the indexer's SQLite store under the data dir) — that's DATA, not config.
 */

// `.env` MUST be loaded before the line below, and this is the only place that can guarantee it.
//
// `CHAIN` is a module-level const, so it evaluates when this module is first imported — which
// happens while the import graph loads, BEFORE `main()` runs and calls `loadDotEnv()`. So
// `ABX_CHAIN=sepolia` in a `.env` was read too late and silently lost: the CLI announced
// `base-sepolia` and acted on it. Every other setting escaped this because it is read lazily inside
// a function (`storageOptions()`, the signing key at send time), by which point `.env` is loaded —
// `ABX_CHAIN` was the one eager read, and the highest-stakes one to get wrong. On a funded send, an
// ignored value can cause a wrong-chain deploy with real artifacts at an
// address nobody meant — the same consequence that made the swallowed `--chain` flag a bug worth
// fixing (see main.ts), reached by a different route.
//
// `loadDotEnv` is idempotent, so main.ts's call stays as the entry-point safety net for any path
// that does not import this module first.
loadDotEnv();

/**
 * The active chain key — the ONE place it's derived (`ABX_CHAIN` → the shipped default). main.ts
 * and ownerops.ts each used to carry their own identical `process.env.ABX_CHAIN ?? DEFAULT_CHAIN_KEY`
 * (one flagged "MUST match main.ts/config.ts" in its own comment) — two copies whose only job was
 * to agree with each other, which is exactly the setup a future edit drifts out of. Both import it
 * from here now.
 */
export const CHAIN = process.env.ABX_CHAIN ?? DEFAULT_CHAIN_KEY;
export const chainId = (): number => resolveChain(CHAIN).id;

// Block explorer base for the tx/address links the CLI prints. Derived from viem's chain metadata via
// the SDK (see explorerUrl) rather than a local table — this used to be a hand-maintained map, which is
// the same shape of bug that had the token-api dashboard sending every Base Sepolia link to Etherscan.
//
// LAZY (a function, not a top-level const): main.ts's `assertKnownChainEnv` has to run BEFORE any
// chain-derived value is computed, so an unknown ABX_CHAIN gets its graceful "not a chain this
// toolkit ships" message instead of a raw `resolveChain` stack trace. That guard runs at module
// load, before main.ts's own body — but config.ts is imported (and fully evaluated) even earlier,
// as part of loading main.ts's imports. An eager `const EXPLORER = explorerUrl(resolveChain(CHAIN).id)`
// here would evaluate on a bad ABX_CHAIN before the guard ever gets a turn, exactly the crash it
// exists to prevent (see that function's doc comment) — so this is a getter, resolved lazily on
// each read, the same pattern `chainId()` above already uses.
export const explorerBase = (): string => explorerUrl(resolveChain(CHAIN).id);

/**
 * Commands where finding an ALREADY-EXISTING `.abx-self-host` in an ancestor directory is worth
 * the search: pure reads/reports where opening the wrong (empty) node produces a *silently wrong*
 * answer rather than a refusal — for example, `abx status` run one directory away from where a
 * project was deployed reporting an empty node instead of the real one.
 *
 * Deliberately narrow, and every write command (deploy, mint, add, index, set-…) is deliberately
 * ABSENT: a write must never land in a directory the operator didn't `cd` into, so those always
 * resolve strictly to cwd (see {@link dataDir}'s call to {@link resolveDataDir} below). Growing
 * this set is a real decision (it changes which commands can print the "found in a parent
 * directory" notice), not a place to reflexively add a new read command.
 */
const DATA_DIR_DISCOVERY_COMMANDS = new Set([
  'status',
  'state',
  'verify',
  'doctor',
  'capabilities',
  'tokens',
  'tokenuri',
  'contracturi',
  'inspect',
]);

/** Whether the ACTIVE command (this process's `abx <cmd>`) is one of the read paths that may
 *  discover a parent directory's data dir — see {@link DATA_DIR_DISCOVERY_COMMANDS}. Reads
 *  `process.argv` directly (matching main.ts's own `const [cmd, ...rest] = process.argv.slice(2)`)
 *  rather than taking a parameter, so every call site (`dataDir`, `localIndexer`, `loadArweaveJwk`,
 *  …) agrees on the SAME answer for the lifetime of one invocation without threading a flag through
 *  each of them. `abx minter show <token>` is the one two-word exception: `minter`'s other
 *  subcommands (`configure`, `buy`) sign transactions and must not discover. */
function allowUpwardDataDirDiscovery(): boolean {
  const [cmd, sub] = process.argv.slice(2);
  if (cmd === 'minter') return sub === 'show';
  return cmd !== undefined && DATA_DIR_DISCOVERY_COMMANDS.has(cmd);
}

let _dataDirResolution: DataDirResolution | undefined;

/**
 * The ONE place the CLI resolves its data directory — every other function in this file that
 * touches disk (`localIndexer`, `storageOptions`, `arweaveKeyFile`, `loadArweaveJwk`) calls this
 * rather than deriving its own path, so a single invocation always agrees with itself about which
 * node it's operating on (keeping the managed Arweave key location and projection location
 * coherent" criterion — the two used to be independently resolved and could silently diverge).
 *
 * Memoized per process (like `CHAIN` above): resolved once, so a "found in a parent directory"
 * notice prints exactly once no matter how many call sites ask, and a discovery decision made at
 * the top of a run can't flip partway through it.
 */
export function dataDir(): string {
  if (!_dataDirResolution) {
    _dataDirResolution = resolveDataDir({allowUpwardDiscovery: allowUpwardDataDirDiscovery()});
    // NEVER silently merge two data directories — when a read answers from a
    // discovered parent instead of cwd, say so, so a user two directories deep is never confused
    // about which node just answered.
    if (_dataDirResolution.source === 'discovered') {
      info(`using the data directory found in a parent directory — ${bold(_dataDirResolution.dir)} ${dim('(set ABX_DATA_DIR to pin one explicitly)')}`);
    }
  }
  return _dataDirResolution.dir;
}

/**
 * Make the data dir ignore itself, before anything sensitive lands in it.
 *
 * `.abx-self-host/` holds this node's projection AND the managed Arweave key — a real, signing-capable
 * credential that also holds prepaid upload credits. The toolkit's own repo gitignores the directory,
 * and the skill said so; a *creator's* repo does not, so a first `--backend arweave` run could leave a
 * key staged for commit with nothing having said a word. A `.gitignore` containing `*` INSIDE the
 * directory ignores the whole tree regardless of the enclosing repo's config, needs no edit to a file
 * we don't own, and is inert outside git.
 *
 * Never overwrites an existing one — a creator who tightened or loosened it made a decision.
 */
export function guardDataDirFromGit(): void {
  const dir = dataDir();
  const marker = resolve(dir, '.gitignore');
  if (existsSync(marker)) return;
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    marker,
    '# Written by abx. Local node state, and (for the arweave backend) a signing-capable key that\n' +
      '# holds your prepaid upload credits. Do not commit any of it.\n*\n',
  );
}

// ── the local indexer: one instance per process ───────────────────────────────
// `new SelfHostIndexer()` opens (and premigrate/schema-execs) the SAME on-disk SQLite db every
// time — a dozen call sites across main.ts/ownerops.ts each constructed their own, so a single CLI
// invocation that touches several of them (e.g. a deploy that also registers + reindexes) paid that
// open/migrate cost repeatedly for what is, within one process, always the same store. Memoized here
// so every call site shares one instance instead.
let _localIndexer: SelfHostIndexer | undefined;

/** The process-lifetime local indexer (this node's own SQLite-backed projection). Never pass a
 *  chain-varying argument through here — it's a bare singleton, constructed once on first use.
 *  Passes `dataDir()` explicitly rather than letting `SqliteStore` fall back on its own — that
 *  fallback exists for a caller with no data-dir context of its own, and this call site has one:
 *  passing it is what keeps a discovered parent directory (see `dataDir` above) actually reaching
 *  the projection, instead of the store quietly reopening at plain cwd behind its back. */
export function localIndexer(): SelfHostIndexer {
  if (!_localIndexer) guardDataDirFromGit(); // the projection is about to be created (or already lives) at dataDir()
  return (_localIndexer ??= new SelfHostIndexer(new SqliteStore(dataDir())));
}

/**
 * Whether `baseUrl` is a localhost/loopback address — a URL that, once baked into an on-chain
 * `tokenURI`/`contractURI`, resolves for NO ONE off this machine. The single source of truth for
 * the off-chain-deploy refusal shared by `deploy`, `deploy-series`, and `deploy-code` (previously
 * duplicated inline — that drift is exactly how `deploy-code` shipped without the guard).
 */
export function loopbackBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/]|$)/i.test(baseUrl);
}

/**
 * A short faucet pointer for a testnet — a 0-balance signer's #1 next step. A known URL plus a
 * search hint (URLs rot; the search always works), so "fund it" is never a dead end.
 *
 * Lives here rather than in main.ts because the browser-wallet signing prompt needs it too, and
 * importing main.ts would execute the CLI. That prompt is the one funding surface `warnUnfunded`
 * can't cover: on the `--sign` lane without `--for` we don't learn the address until the wallet
 * connects, so the up-front balance check never runs and the only warning a creator would get is
 * a failed transaction.
 */
export function faucetHint(chainKey: string): string {
  const url: Record<string, string> = {
    'base-sepolia': 'https://portal.cdp.coinbase.com/products/faucet',
    sepolia: 'https://www.alchemy.com/faucets/ethereum-sepolia',
  };
  return url[chainKey]
    ? `get free test ETH from a ${chainKey} faucet (${url[chainKey]} — or search "${chainKey} faucet"), usually ≤1 min`
    : `get test ETH from a "${chainKey}" faucet`;
}

// ── canonical infrastructure (shipped manifest → env → flag) ─────────────────
// Thin CLI wrappers over the SDK resolvers, pinned to the active chain. Return null (not
// undefined) to read cleanly at call sites (`factoryAddress() ?? 'none'`). `null` means the
// chain isn't shipped and nothing was declared — the deploy/owner-ops path deploys + prints one.

/** Canonical clone factory for the active chain — flag override → `ABX_FACTORY` → manifest. */
export function factoryAddress(override?: string): Address | null {
  return resolveFactory(chainId(), override) ?? null;
}

/** Canonical Series clone factory — flag override → `ABX_SERIES_FACTORY` → manifest. */
export function seriesFactoryAddress(override?: string): Address | null {
  return resolveSeriesFactory(chainId(), override) ?? null;
}

/** Canonical on-chain metadata renderer — flag override → `ABX_RENDERER` → manifest. */
export function rendererAddress(override?: string): Address | null {
  return resolveRenderer(chainId(), override) ?? null;
}

/** Canonical multi-chunk on-chain content store — flag override → `ABX_CHUNK_STORE` → manifest. */
export function chunkStoreAddress(override?: string): Address | null {
  return resolveChunkStore(chainId(), override) ?? null;
}

/** Canonical shared fixed-price minter — flag override → `ABX_FIXED_PRICE_MINTER` → manifest. */
export function fixedPriceMinterAddress(override?: string): Address | null {
  return resolveFixedPriceMinter(chainId(), override) ?? null;
}

// ── ERC-1155 editions — the same override → env → manifest resolution, one rung finer ────────────

/** Canonical 1/1-edition clone factory — flag override → `ABX_ONE_OF_ONE_EDITION_FACTORY` → manifest. */
export function oneOfOneEditionFactoryAddress(override?: string): Address | null {
  return resolveOneOfOneEditionFactory(chainId(), override) ?? null;
}

/** Canonical multi-work edition clone factory — flag override → `ABX_EDITION_FACTORY` → manifest. */
export function editionFactoryAddress(override?: string): Address | null {
  return resolveEditionFactory(chainId(), override) ?? null;
}

/** Canonical code-project edition clone factory — flag override → `ABX_EDITION_CODE_FACTORY` → manifest. */
export function editionCodeFactoryAddress(override?: string): Address | null {
  return resolveEditionCodeFactory(chainId(), override) ?? null;
}

/** Canonical shared fixed-price EDITION minter — flag override → `ABX_FIXED_PRICE_MINTER_1155` → manifest. */
export function fixedPriceMinter1155Address(override?: string): Address | null {
  return resolveFixedPriceMinter1155(chainId(), override) ?? null;
}

// ── storage backend resolution (override → env → default) ────────────────────

/** Per-invocation storage overrides parsed from flags (e.g. `abx deploy --backend cloud --bucket …`). */
export interface StorageOverrides {
  backend?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  publicBase?: string;
  gateway?: string;
  mode?: 'kubo' | 'pinata';
  apiUrl?: string;
  uploadUrl?: string;
  provider?: 'turbo' | 'http-bundler';
  /** Which identity signs Turbo (arweave) uploads + holds the credits: the CLI-managed Arweave key
   *  (default) or the `.env` EVM signing key (`eth`). The browser-wallet identity is injected by
   *  the deploy path, not chosen here. */
  storageSigner?: 'arweave' | 'eth';
}

/** Resolve the storage-signer lane: flag → `ABX_STORAGE_SIGNER` → default `arweave`. */
export function storageSignerChoice(ov: StorageOverrides = {}): 'arweave' | 'eth' {
  const v = ov.storageSigner ?? process.env.ABX_STORAGE_SIGNER;
  return v === 'eth' ? 'eth' : 'arweave';
}

/**
 * Build the storage backend options the SDK needs, resolving **explicit override → env →
 * default** for non-secret values; secrets come from env only. No persisted config layer — a
 * flag or a declared env var is the only way to choose a backend, so nothing is hidden.
 */
export function storageOptions(ov: StorageOverrides = {}): ResolveStorageOptions {
  const backend = ov.backend ?? process.env.ABX_STORAGE_BACKEND ?? 'fs';
  const opts: ResolveStorageOptions = {backend, dataDir: dataDir()};

  if (backend === 'cloud' || backend === 's3') {
    opts.cloud = {
      endpoint: ov.endpoint ?? process.env.ABX_S3_ENDPOINT ?? '',
      bucket: ov.bucket ?? process.env.ABX_S3_BUCKET ?? '',
      region: ov.region ?? process.env.ABX_S3_REGION ?? 'auto',
      prefix: ov.prefix ?? process.env.ABX_S3_PREFIX ?? 'abx/content/',
      accessKeyId: process.env.ABX_S3_ACCESS_KEY_ID ?? '', // secret: env only
      secretAccessKey: process.env.ABX_S3_SECRET_ACCESS_KEY ?? '', // secret: env only
      service: 's3',
      publicBase: ov.publicBase ?? process.env.ABX_S3_PUBLIC_BASE,
    };
  } else if (backend === 'ipfs') {
    const mode = (ov.mode ?? process.env.ABX_IPFS_MODE ?? (process.env.PINATA_JWT ? 'pinata' : 'kubo')) as 'kubo' | 'pinata';
    opts.ipfs = {
      mode,
      gateway: ov.gateway ?? process.env.ABX_IPFS_GATEWAY ?? (mode === 'pinata' ? 'https://gateway.pinata.cloud' : 'http://127.0.0.1:8080'),
      apiUrl: ov.apiUrl ?? process.env.ABX_IPFS_API_URL ?? 'http://127.0.0.1:5001',
      pinataEndpoint: process.env.ABX_PINATA_ENDPOINT ?? 'https://api.pinata.cloud',
      pinataJwt: process.env.PINATA_JWT, // secret: env only
    };
  } else if (backend === 'arweave') {
    const uploadUrl = ov.uploadUrl ?? process.env.ABX_ARWEAVE_UPLOAD_URL;
    // Default to Turbo (free <100 KiB, fiat top-up above); an explicit upload endpoint implies
    // the http-bundler escape hatch. Explicit --provider always wins.
    const provider = (ov.provider ?? process.env.ABX_ARWEAVE_PROVIDER ?? (uploadUrl ? 'http-bundler' : 'turbo')) as 'turbo' | 'http-bundler';
    // Turbo identity: default the CLI-managed Arweave key; `--storage-signer eth` reuses the .env
    // EVM signing key so credits funded on that wallet's Turbo balance are spendable here. The eth
    // key takes precedence in the storage layer, so only set it when that lane is chosen.
    const useEth = provider === 'turbo' && storageSignerChoice(ov) === 'eth';
    const managedTurbo = provider === 'turbo' && !useEth;
    opts.arweave = {
      provider,
      gateway: ov.gateway ?? process.env.ABX_ARWEAVE_GATEWAY ?? 'https://arweave.net',
      uploadUrl,
      token: process.env.ARWEAVE_UPLOAD_TOKEN, // secret: env only (http-bundler)
      jwk: managedTurbo ? loadArweaveJwk() : undefined, // secret: LOAD-only (reads/serve must never mint a key)
      // Mint-on-first-WRITE: the backend invokes this ONLY when an upload actually runs and no key
      // exists yet — so `deploy-code --backend arweave` (and any upload) "just works" with no setup
      // step, while serve/verify/doctor never create a key. Prints one notice on creation.
      ensureJwk: managedTurbo ? ensureManagedArweaveJwk : undefined,
      ethSignerKey: useEth ? envSigningKey() : undefined, // secret: env only (the hot signing key)
    };
  }
  return opts;
}

/** The active backend id, for display (no secrets, no construction). */
export function activeBackendId(): string {
  return process.env.ABX_STORAGE_BACKEND ?? 'fs';
}

/** Resolve the active backend id + where it came from — for transparent readouts. */
export function backendResolution(ov: StorageOverrides = {}): {backend: string; source: 'flag' | 'env' | 'default'} {
  if (ov.backend) return {backend: ov.backend, source: 'flag'};
  if (process.env.ABX_STORAGE_BACKEND) return {backend: process.env.ABX_STORAGE_BACKEND, source: 'env'};
  return {backend: 'fs', source: 'default'};
}

// ── Arweave (Turbo) identity ─────────────────────────────────────────────────
// The Turbo provider signs uploads with — and holds prepaid credits on — a single persistent
// Arweave key. It's the one wallet reused across every upload and project, so leftover credits
// are always there next time. We keep it next to the projection (gitignored), never collected in
// chat. A managed key is the default; bring your own with ARWEAVE_JWK (inline secret) or
// ABX_ARWEAVE_KEY_FILE (a path to your own JWK).

function arweaveKeyFile(): string {
  return process.env.ABX_ARWEAVE_KEY_FILE ?? resolve(dataDir(), 'arweave-key.json');
}

/** Where the managed Turbo identity lives — for display ("back this up"). */
export function arweaveKeyFilePath(): string {
  return arweaveKeyFile();
}

function parseJwk(raw: string): ArweaveJwk {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text) as ArweaveJwk;
}

/**
 * Load the Turbo identity if one exists — env inline secret, an explicit key-file path, or the
 * managed location. **Never creates** (read-only paths like `serve`/`status` must not mint a key)
 * and **never silently replaces** a corrupt key (that would strand its credits) — a bad key throws.
 */
export function loadArweaveJwk(): ArweaveJwk | undefined {
  // Delegate to the storage package's resolver so the CLI and the SDK cannot disagree about where
  // the identity lives — they did, and porting a working CLI flow to the SDK broke every upload with
  // "Arweave via Turbo needs an identity". It also owns the diagnostics: a bare `JSON.parse` here
  // reported an empty key file as "Unexpected end of JSON input", naming a parser instead of the
  // file or the remedy.
  //
  // Pass THIS process's `dataDir()` explicitly — without it, `resolveArweaveJwk`
  // falls back to its own unparameterized `resolveDataDir()` (always strict cwd), which could
  // read from a different directory than `ensureArweaveJwk` below writes to, or than this
  // invocation's SQLite projection lives in, keeping the two locations coherent.
  return resolveArweaveJwk(dataDir());
}

/** Load or CREATE the managed Turbo identity, persisting a fresh key (0600) to the data dir. */
export function ensureArweaveJwk(): {jwk: ArweaveJwk; address: string; created: boolean; path: string} {
  const p = arweaveKeyFile();
  const existing = loadArweaveJwk();
  if (existing) return {jwk: existing, address: arweaveAddress(existing), created: false, path: p};
  const jwk = generateArweaveJwk();
  mkdirSync(dirname(p), {recursive: true});
  guardDataDirFromGit(); // a key is about to land here — make the directory self-ignoring first
  writeFileSync(p, JSON.stringify(jwk), {mode: 0o600});
  return {jwk, address: arweaveAddress(jwk), created: true, path: p};
}

/**
 * The write-path mint hook the Arweave backend calls on a first upload with no identity yet (wired
 * into {@link storageOptions} as `arweave.ensureJwk`). Mints + persists the managed key and prints
 * ONE notice on creation — the key holds the prepaid Turbo upload credits, so it's worth backing up.
 * Read paths (serve/verify/doctor) never reach this — the backend only calls it inside `put`.
 */
function ensureManagedArweaveJwk(): ArweaveJwk {
  const r = ensureArweaveJwk();
  if (r.created) {
    console.log(
      `  created a managed Arweave upload identity ${r.address}\n` +
        `    ${r.path} — it holds your Turbo upload credits; back it up: \`abx storage backup-key --out <path>\``,
    );
  }
  return r.jwk;
}

/** Per-invocation storage overrides parsed from deploy flags (the hybrid: config, overridable). */
export function storageOverrides(flags: Flags): StorageOverrides {
  return {
    backend: flags.backend,
    endpoint: flags.endpoint,
    bucket: flags.bucket,
    region: flags.region,
    prefix: flags.prefix,
    publicBase: flags['public-base'],
    gateway: flags.gateway,
    mode: flags.mode as 'kubo' | 'pinata' | undefined,
    apiUrl: flags['api-url'],
    uploadUrl: flags['upload-url'],
    provider: flags.provider as 'turbo' | 'http-bundler' | undefined,
    storageSigner: flags['storage-signer'] as 'arweave' | 'eth' | undefined,
  };
}

/** Surface the free-vs-credit decision for a Turbo upload from the LOCAL byte size — no network,
 *  so it works in `--dry-run` too. Under 100 KiB is free; above, it draws on prepaid credits. The
 *  decision itself (`isTurboArweave` + the size threshold) is the storage package's
 *  {@link planTurboUpload}; this is just its narration. */
export function noteArweavePlan(opts: ResolveStorageOptions, size: number): void {
  const plan = planTurboUpload(opts, size);
  if (!plan) return;
  if (!plan.chargeable) {
    info(`Turbo: ${plan.sizeKb} KB is under the 100 KB free tier → permanent upload is FREE — no credits, no setup.`);
  } else {
    info(`Turbo: ${plan.sizeKb} KB exceeds the 100 KB free tier → draws on prepaid credits. Check \`abx storage balance\`; top up with \`abx storage topup --usd <n>\` if short.`);
  }
}

/**
 * Dry-run storage-readiness: surface what a REAL off-chain deploy needs, from local info only, so
 * "dry-run passes → deploy fails at upload" can't happen. Covers Arweave credit needs, a missing
 * Pinata JWT, and a missing cloud public base. `sizes` are the per-file byte sizes. The readiness
 * FACTS (chargeable-bytes accounting, the USD estimate, the missing-JWT/public-base checks) are the
 * storage package's {@link assessStorageReadiness}; this is just its narration.
 */
export async function noteStorageReadiness(opts: ResolveStorageOptions, sizes: number[]): Promise<void> {
  const report = await assessStorageReadiness(opts, sizes);
  if (report.backend === 'arweave') {
    if (report.overCount === 0) {
      info(`Turbo: all ${report.totalCount} file(s) under the 100 KB free tier → FREE permanent upload, no setup.`);
    } else {
      // Best-effort real-rate USD estimate; silently omitted if the price API isn't reachable.
      const cost = report.usd === null ? '' : ` ≈ ${report.usd < 0.01 ? '<$0.01' : '$' + report.usd.toFixed(2)} at current Turbo rates`;
      info(`Turbo: ${report.overCount}/${report.totalCount} file(s) exceed the 100 KB free tier (~${report.totalKb} KB total)${cost} → draw on prepaid credits. Check \`abx storage balance --backend arweave\`; top up with \`abx storage topup --usd <n> --backend arweave\` if short.`);
    }
  } else if (report.backend === 'ipfs' && report.pinataMissingJwt) {
    warn('IPFS pinata mode but PINATA_JWT is not set — a real deploy will FAIL at upload. Set PINATA_JWT in .env (or --mode kubo with a local node).');
  } else if (report.backend === 'cloud' && report.missingPublicBase) {
    warn('cloud/S3 has no public read base — a real deploy will FAIL. Set ABX_S3_PUBLIC_BASE or pass --public-base <bucket-or-cdn-url> (it is baked on-chain).');
  }
}

/** Create + announce the managed Turbo identity right before the first upload that needs it.
 *  Mutates `opts.arweave.jwk` so the resolved backend can sign. No-op for non-Turbo custody, or
 *  when an ETH identity (`.env` key or a wallet-session remote signer) is already selected — that
 *  identity pays, so we don't mint an unused managed key. */
export function ensureArweaveIdentityForUpload(opts: ResolveStorageOptions): void {
  if (!isTurboArweave(opts)) return;
  if (opts.arweave?.jwk || opts.arweave?.ethSignerKey || opts.arweave?.remoteEth) return; // identity already chosen
  const {jwk, address, created, path} = ensureArweaveJwk();
  opts.arweave!.jwk = jwk;
  if (created) {
    warn(`created an Arweave identity for Turbo uploads → ${dim(path)}`);
    info(`  address ${g(address)} — BACK THIS UP (\`abx storage backup-key --out <path>\`). It signs uploads and holds any credits you buy; lose it and leftover credits are stranded.`);
  }
}

/**
 * Pre-upload FUNDS guard for Turbo (arweave). Runs before a real off-chain deploy so a credit
 * shortfall stops *here* — with the exact address + fund options — instead of failing mid-deploy
 * after some txs already landed. Only fires for chargeable files (≥100 KB); free-tier uploads skip
 * it. Best-effort: if the price/balance APIs are unreachable it degrades to a warning, never a false
 * block. `sizes` are per-file byte sizes. The funds decision itself is the storage package's
 * {@link assessTurboFunds}; this is the narration + the throw messages built from its report.
 */
export async function assertTurboFundsForUpload(opts: ResolveStorageOptions, sizes: number[], walletAddr?: string): Promise<void> {
  if (!isTurboArweave(opts)) return;
  ensureArweaveIdentityForUpload(opts); // so there's an address to check
  const check = await assessTurboFunds(opts.arweave!, sizes, walletAddr);
  if (!check || !check.short) return;
  const {address, isEth, haveWinc, needWinc, walletCredits} = check;

  // Managed-key lane is short → BEFORE proposing a top-up, check whether the creator's OWN wallet
  // already holds Turbo credits (public balance-by-address, no key). If so, spending those via
  // `--storage-signer eth` beats paying again. This is the "check my wallet too" the flow needs.
  if (!isEth && walletAddr && walletCredits && walletCredits.winc > 0 && (needWinc ? walletCredits.winc >= needWinc : true)) {
    throw new Error(
      [
        `The managed Arweave key has no credits — but your wallet ${g(walletAddr)} already holds ${bold(walletCredits.credits)} Turbo credits.`,
        `  Use those instead of paying again — re-run with:`,
        `    • ${bold('--storage-signer eth --sign')}  ${dim('(your browser wallet signs the uploads; its credits pay — no key in .env)')}`,
        `    • or ${bold('--storage-signer eth')}  ${dim('(if that wallet’s key is already in .env)')}`,
        `  ${dim('No top-up needed.')}`,
      ].join('\n'),
    );
  }

  const lines = [
    `Turbo credits look insufficient for this upload (${check.chargeableCount} file(s) over the 100 KB free tier).`,
    `  identity ${g(address)} ${dim(isEth ? '(your EVM wallet — an ETH Turbo identity)' : '(the CLI-managed Arweave key, NOT your ETH wallet)')}`,
    `  balance  ${(haveWinc / 1e12).toFixed(4)} credits${needWinc ? dim(` · need ~${(needWinc / 1e12).toFixed(4)}`) : ''}`,
    ...(walletAddr && !isEth ? [`  ${dim(`(checked your wallet ${walletAddr} too — no Turbo credits there either.)`)}`] : []),
    ...(isEth ? [] : [`  ${dim('First back up the managed key — `abx storage backup-key --out <path>` — it will hold the credits you buy.')}`]),
    `  Then fund + re-run:`,
    `    • ${bold('abx storage topup --usd <n> --backend arweave')}  ${dim('(card checkout, credits the address above)')}`,
    `    • or paste ${g(address)} at ${bold('https://turbo-topup.com')} ${dim('— fund THIS address; do NOT connect a different wallet')}`,
    isEth
      ? `    • already funded a different identity? that's a different address — fund the one above`
      : `    • funded your ETH wallet's Turbo balance instead? re-run with ${bold('--storage-signer eth')} (key in .env) or ${bold('--storage-signer eth --sign')} (browser wallet)`,
  ];
  throw new Error(lines.join('\n'));
}

/**
 * Resolve durable locators (`ipfs://<cid>` / `ar://<txid>`) for a project's off-chain-by-hash
 * fields, from THIS machine's content index via the backend. This is the bridge a remote resolver
 * needs: the on-chain commitment is a keccak256, but the CID/txid that addresses the bytes lives in
 * the deployer's local index — ship it so the resolver can point `image` at IPFS without the bytes.
 * Returns `{ "0x<hash>": "ipfs://<cid>" }` (lowercased), empty when nothing is locatable here.
 */
export async function collectContentLocators(state: ProjectState, backend: StorageBackend): Promise<Record<string, string>> {
  if (!backend.locator) return {};
  const out: Record<string, string> = {};
  const hashFields = [...state.tokens.flatMap((t) => t.fields), ...state.collectionFields].filter(
    (f) => f.representation === R.keccak256 || f.representation === R.sha256,
  );
  for (const f of hashFields) {
    const key = f.value.toLowerCase();
    if (out[key]) continue;
    try {
      const loc = await backend.locator(f.value as Hex);
      if (loc) out[key] = loc;
    } catch {
      /* backend can't locate this hash — skip; the resolver falls back to its own image route */
    }
  }
  return out;
}

/** Locators to bridge to a remote resolver: the ones the local deploy already stored, else freshly
 *  resolved from this machine's local projection + content index (e.g. `abx add <addr> --remote`
 *  for a contract deployed elsewhere on this same machine). */
export async function remoteLocators(address: Address, stored: string | undefined, flags: Flags): Promise<Record<string, string>> {
  if (stored) {
    try {
      const obj = JSON.parse(stored) as Record<string, string>;
      if (Object.keys(obj).length) return obj;
    } catch {
      /* fall through to recompute */
    }
  }
  const local = localIndexer().getProject(address);
  if (!local) return {};
  return collectContentLocators(local, resolveBackend(storageOptions(storageOverrides(flags))));
}
