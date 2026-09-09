/**
 * Shared CLI plumbing used by more than one command domain: the tiny ANSI color/narration helpers
 * every command prints through, the
 * trust-anchor "ensure*" bootstrap wrappers (narrating the SDK's anchors.ts for the factory /
 * renderer / seed-source singletons), and a handful of small cross-domain utilities (port checks,
 * the post-deploy reindex retry, `printServing`, `findRepoRoot`, `keepAlive`, optional-dependency
 * loading for effects). Nothing here is domain-specific — a helper that only ONE command domain
 * used stayed in that domain's `commands/*.ts` file instead.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join as joinPath, resolve as resolvePath} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SelfHostIndexer, type IndexResult} from '@artblocks/abx-indexer';
import {
  type Address,
  type AnchorEvent,
  AnchorUnavailableError,
  type OpenSeaAttribute,
  type ProjectState,
  type PublicClient,
  type ScanFloorEvent,
  type SendTx,
  makeHotSender,
  makePublicClient,
  makeWalletClient,
  normalizeAttributes,
  parseTraitPairs,
  probeHistoryAt,
  redactRpcUrl,
  resolveChain,
  resolveRpcUrls,
  rpcEnvVar,
  detectCanonicalFactory as sdkDetectCanonicalFactory,
  ensureFactory as sdkEnsureFactory,
  ensureRenderer as sdkEnsureRenderer,
  ensureSeedSource as sdkEnsureSeedSource,
  ensureSeriesCodeFactory as sdkEnsureSeriesCodeFactory,
  ensureSeriesFactory as sdkEnsureSeriesFactory,
  ensureOneOfOneEditionFactory as sdkEnsureOneOfOneEditionFactory,
  ensureEditionFactory as sdkEnsureEditionFactory,
  ensureEditionCodeFactory as sdkEnsureEditionCodeFactory,
  resolveScanFloor as sdkResolveScanFloor,
  sleep,
} from '@artblocks/abx-sdk';
import {resolveBackend, validateRenderStorageCombo} from '@artblocks/abx-storage';
import {CHAIN, explorerBase, activeBackendId, backendResolution, collectContentLocators, localIndexer, storageOptions, storageOverrides} from './config.js';
import {type Flags} from './flags.js';
import {looksPerTokenAttributes, parseSeriesTraitsById} from './series-traits.js';

// ── tiny ANSI helpers ───────────────────────────────────────────────────────
export const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[38;5;115m', purple: '\x1b[38;5;141m', orange: '\x1b[38;5;215m', red: '\x1b[31m',
};
export const g = (s: string) => `${c.green}${s}${c.reset}`;
export const p = (s: string) => `${c.purple}${s}${c.reset}`;
export const dim = (s: string) => `${c.dim}${s}${c.reset}`;
export const bold = (s: string) => `${c.bold}${s}${c.reset}`;
export let stepN = 0;
export const step = (s: string) => console.log(`\n${p(`[${++stepN}]`)} ${bold(s)}`);
export const ok = (s: string) => console.log(`    ${g('✓')} ${s}`);
export const info = (s: string) => console.log(`    ${dim(s)}`);
export const warn = (s: string) => console.log(`    ${c.orange}⚠${c.reset}  ${s}`);

// When the user/agent opts in (--yes), lift the getLogs chunk cap so a large
// reconstruction proceeds despite a range-limited RPC (otherwise it stops early with
// guidance — see GetLogsScanTooLargeError + the skill's "Choosing an RPC" decision).
export function allowLargeScan(flags: Flags): void {
  if (flags.yes) process.env.ABX_GETLOGS_MAX_CHUNKS = String(1e9);
}

/**
 * Resolve the scan floor (fromBlock) for an add/index — the CLI-side shell around the SDK's
 * {@link sdkResolveScanFloor}: builds the client, forwards `--from-block`, and narrates its two
 * possible events (the SDK never prints). See the SDK function's doc comment for the "why" (never
 * a silent genesis default).
 */
export async function resolveScanFloor(address: Address, localFromBlock: string | undefined, flags: Flags): Promise<string> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  return sdkResolveScanFloor(publicClient, address, {
    explicit: flags['from-block'] as string | undefined,
    localFromBlock,
    onEvent: (e: ScanFloorEvent) => {
      if (e.kind === 'genesis-warning') warn('scanning from genesis (block 0) — slow on a range-capped RPC; pass the deploy block as --from-block to index instantly.');
      else info(`deploy block ${e.block} ${dim('(discovered on-chain via getCode — the scan floor)')}`);
    },
  });
}

// ── ensure the trust anchor exists ───────────────────────────────────────────
/**
 * The trust-anchor gate: a factory is THE address platforms allowlist by, so a missing
 * manifest entry must NEVER silently mint a new "canonical" — that fragments trust (and
 * a stale SDK would duplicate factories on real chains). Degrade to guidance; deploying
 * a private trust anchor is an explicit choice (`--bootstrap-factory`).
 */
export function refuseMissingFactory(kind: string, envVar: string, reason: string): never {
  throw new Error(
    `${reason}\n` +
      `  A canonical ${kind} may already exist for '${CHAIN}' — check with the ABX community / update @artblocks/abx-sdk ` +
      `(the shipped manifest: packages/sdk/src/deployments.ts), or set ${envVar}=0x… if you know the address.\n` +
      `  To deploy your OWN trust anchor instead (private chains, sandboxes — platforms won't recognize its clones), ` +
      `re-run with --bootstrap-factory.`,
  );
}

/** A `SendTx` that defers `makeWalletClient`/`makeHotSender` construction until the first actual
 *  send — trust-anchor bootstrap is rare (an existing, current anchor is the common case), so the
 *  happy path must never require a signing key. Memoized so a multi-tx bootstrap (the SeriesCode
 *  factory: 2 libraries + the linked factory itself) reuses ONE sender — and its nonce tracking —
 *  rather than a fresh one per send. */
export function lazyBootstrapSender(publicClient: PublicClient): SendTx {
  let cached: SendTx | undefined;
  return (tx) => {
    if (!cached) {
      const {wallet, account} = makeWalletClient({chainKey: CHAIN});
      cached = makeHotSender({wallet, account, publicClient});
    }
    return cached(tx);
  };
}

/** Get (or deploy) the chain's canonical 1/1 clone factory — narrates the SDK's `ensureFactory`
 *  (anchors.ts), which owns the resolve/verify/bootstrap logic; this keeps only the exact console
 *  output plus the exit-messaging refusal (`refuseMissingFactory`), which stays CLI-side since the
 *  SDK doesn't know a UX's flag names. `quiet` suppresses only the happy-path reuse line (the demo
 *  resolves the factory without making a teaching moment of it) — everything else always prints. */
export async function ensureFactory(override?: string, allowBootstrap = false, quiet = false): Promise<Address> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const send = lazyBootstrapSender(publicClient);
  try {
    return await sdkEnsureFactory(publicClient, send, {
      chainId: resolveChain(CHAIN).id,
      override,
      allowBootstrap,
      onEvent: (e: AnchorEvent) => {
        if (e.kind === 'resolved') {
          if (!quiet) info(`using canonical factory ${explorerBase()}/address/${e.address}`);
        } else if (e.kind === 'stale') {
          info(
            e.reason === 'no-code'
              ? 'configured factory has no code on this chain — deploying a fresh one'
              : 'configured factory is an older/incompatible version — deploying a fresh trust anchor',
          );
        } else if (e.kind === 'deploying') {
          info('deploying the canonical clone factory (ownerless trust anchor: 1 library → linked factory → implementation, CREATE2 throughout — a library already on-chain is reused)…');
        } else if (e.kind === 'deployed') {
          ok(`factory ${e.address}`);
          info(`implementation ${e.implementation}`);
          info(`libraries: AbxMetadataLib ${e.metadataLib}`);
          info(`tx ${explorerBase()}/tx/${e.txHash}`);
          warn(`${CHAIN} (chainId ${resolveChain(CHAIN).id}) isn't in the shipped manifest — to reuse this factory set ${bold(`ABX_FACTORY=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
        }
      },
    });
  } catch (err) {
    if (err instanceof AnchorUnavailableError) {
      const reason =
        err.detail === 'not-configured'
          ? `no canonical 1/1 factory is configured for '${CHAIN}'.`
          : err.detail === 'no-code'
            ? `the configured factory ${err.address} has no code on '${CHAIN}' — check ABX_CHAIN / the RPC endpoint.`
            : `the configured factory ${err.address} is an older/incompatible version on '${CHAIN}'.`;
      refuseMissingFactory('factory', 'ABX_FACTORY', reason);
    }
    throw err;
  }
}

// ── ensure the canonical Series trust anchor exists ──────────────────────────
/** Get (or deploy) the chain's `SeriesImageFactory` — the sibling of {@link ensureFactory}.
 *  Narrates the SDK's `ensureSeriesFactory` (anchors.ts), which owns the resolve/verify/bootstrap
 *  logic. */
export async function ensureSeriesFactory(override?: string, allowBootstrap = false): Promise<Address> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const send = lazyBootstrapSender(publicClient);
  try {
    return await sdkEnsureSeriesFactory(publicClient, send, {
      chainId: resolveChain(CHAIN).id,
      override,
      allowBootstrap,
      onEvent: (e: AnchorEvent) => {
        if (e.kind === 'resolved') info(`using canonical Series factory ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'stale') info('configured Series factory is missing or an older version — deploying a fresh trust anchor');
        else if (e.kind === 'deploying') info('deploying the canonical Series clone factory (ownerless trust anchor: 1 library → linked factory → implementation, CREATE2 throughout — a library already on-chain is reused)…');
        else if (e.kind === 'deployed') {
          ok(`Series factory ${e.address}`);
          info(`implementation ${e.implementation}`);
          info(`libraries: AbxMetadataLib ${e.metadataLib}`);
          info(`tx ${explorerBase()}/tx/${e.txHash}`);
          warn(`${CHAIN} (chainId ${resolveChain(CHAIN).id}) isn't in the shipped manifest — to reuse this factory set ${bold(`ABX_SERIES_FACTORY=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
        }
      },
    });
  } catch (err) {
    if (err instanceof AnchorUnavailableError) {
      const reason =
        err.detail === 'not-configured'
          ? `no canonical Series factory is configured for '${CHAIN}'.`
          : `the configured Series factory ${err.address} is missing or an older version on '${CHAIN}'.`;
      refuseMissingFactory('Series factory', 'ABX_SERIES_FACTORY', reason);
    }
    throw err;
  }
}

// ── ensure the canonical on-chain renderer exists ────────────────────────────
/** Get (or deploy) the chain's shared `AbxMetadataRenderer` — narrates the SDK's `ensureRenderer`
 *  (anchors.ts), which also self-heals to the CREATE2-deterministic address before deploying. No
 *  `allowBootstrap` gate here (unlike the three clone factories) — the renderer isn't a platform
 *  allowlist entry, so there's nothing to refuse; a stale/missing one always just gets redeployed. */
export async function ensureRenderer(override?: string): Promise<Address> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const send = lazyBootstrapSender(publicClient);
  return sdkEnsureRenderer(publicClient, send, {
    chainId: resolveChain(CHAIN).id,
    override,
    onEvent: (e: AnchorEvent) => {
      if (e.kind === 'resolved') info(`using canonical renderer ${explorerBase()}/address/${e.address}`);
      else if (e.kind === 'stale') info('configured renderer is missing or an older spec version — deploying a fresh one');
      else if (e.kind === 'canonical') info(`using canonical renderer at its deterministic address ${explorerBase()}/address/${e.address}`);
      else if (e.kind === 'deploying') info('deploying the canonical on-chain metadata renderer (CREATE2)…');
      else if (e.kind === 'deployed') {
        ok(`renderer ${e.address} (spec v${e.specVersion})`);
        info(`tx ${explorerBase()}/tx/${e.txHash}`);
        warn(`not in the shipped manifest for ${CHAIN} — to reuse this renderer set ${bold(`ABX_RENDERER=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
      }
    },
  });
}

/** The code-project trust anchor — narrates the SDK's `ensureSeriesCodeFactory` (anchors.ts),
 *  which owns the resolve/bootstrap logic (a sandbox / fresh chain links + deploys the two
 *  write-path libraries then the factory in-flight; see {@link deploySeriesCodeFactory}). */
export async function ensureSeriesCodeFactory(publicClient: PublicClient, override?: string, allowBootstrap = false): Promise<Address> {
  const send = lazyBootstrapSender(publicClient);
  try {
    return await sdkEnsureSeriesCodeFactory(publicClient, send, {
      chainId: resolveChain(CHAIN).id,
      override,
      allowBootstrap,
      onEvent: (e: AnchorEvent) => {
        if (e.kind === 'resolved') info(`using canonical SeriesCode factory ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'stale') info('configured SeriesCode factory has no code on this chain — deploying a fresh trust anchor');
        else if (e.kind === 'canonical') info(`using SeriesCode factory at its deterministic address ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'deploying') info('deploying the SeriesCode trust anchor (3 libraries → linked factory → implementation, CREATE2 throughout — libraries already on-chain are reused)…');
        else if (e.kind === 'deployed') {
          ok(`SeriesCode factory ${e.address} ${dim(`(impl ${e.implementation})`)}`);
          info(`libraries: AbxMetadataLib ${e.metadataLib} · AbxParamsLib ${e.paramsLib} · AbxCodeLib ${e.codeLib}`);
          warn(`${CHAIN} isn't in the shipped manifest — to reuse, set ${bold(`ABX_SERIES_CODE_FACTORY=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
        }
      },
    });
  } catch (err) {
    if (err instanceof AnchorUnavailableError) {
      const reason =
        err.detail === 'not-configured'
          ? `no canonical SeriesCode factory is configured for '${CHAIN}'.`
          : `the configured SeriesCode factory ${err.address} has no code on '${CHAIN}' — check ABX_CHAIN / the RPC endpoint.`;
      refuseMissingFactory('SeriesCode factory', 'ABX_SERIES_CODE_FACTORY', reason);
    }
    throw err;
  }
}

// ── ERC-1155 editions: the three edition trust anchors ────────────────────────
// The edition twins of `ensureFactory`/`ensureSeriesFactory`/`ensureSeriesCodeFactory` above —
// same narration shape, same `refuseMissingFactory` refusal on `AnchorUnavailableError`. Unlike the
// 721 1/1 factory, the two CREATE2-deterministic edition factories also report a `canonical` event
// (self-healed to the predicted address) — see anchors.ts's `AnchorEvent` doc for why.

/** Get (or deploy) the chain's canonical 1/1-edition clone factory — narrates the SDK's
 *  `ensureOneOfOneEditionFactory` (anchors.ts), the edition twin of {@link ensureFactory}. */
export async function ensureOneOfOneEditionFactory(override?: string, allowBootstrap = false): Promise<Address> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const send = lazyBootstrapSender(publicClient);
  try {
    return await sdkEnsureOneOfOneEditionFactory(publicClient, send, {
      chainId: resolveChain(CHAIN).id,
      override,
      allowBootstrap,
      onEvent: (e: AnchorEvent) => {
        if (e.kind === 'resolved') info(`using canonical 1/1-edition factory ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'canonical') info(`using canonical 1/1-edition factory at its deterministic address ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'stale') {
          info(
            e.reason === 'no-code'
              ? 'configured 1/1-edition factory has no code on this chain — deploying a fresh one'
              : 'configured 1/1-edition factory is an older/incompatible version — deploying a fresh trust anchor',
          );
        } else if (e.kind === 'deploying')
          info(
            'deploying the canonical 1/1-edition clone factory (ownerless trust anchor: 3 libraries → linked factory → implementation, CREATE2 throughout — libraries already on-chain are reused)…',
          );
        else if (e.kind === 'deployed') {
          ok(`1/1-edition factory ${e.address}`);
          info(`implementation ${e.implementation}`);
          info(`libraries: AbxMetadataLib ${e.metadataLib} · AbxParamsLib ${e.paramsLib} · AbxEditionLib ${e.editionLib}`);
          info(`tx ${explorerBase()}/tx/${e.txHash}`);
          warn(`${CHAIN} isn't in the shipped manifest — to reuse this factory set ${bold(`ABX_ONE_OF_ONE_EDITION_FACTORY=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
        }
      },
    });
  } catch (err) {
    if (err instanceof AnchorUnavailableError) {
      const reason =
        err.detail === 'not-configured'
          ? `no canonical 1/1-edition factory is configured for '${CHAIN}'.`
          : err.detail === 'no-code'
            ? `the configured 1/1-edition factory ${err.address} has no code on '${CHAIN}' — check ABX_CHAIN / the RPC endpoint.`
            : `the configured 1/1-edition factory ${err.address} is an older/incompatible version on '${CHAIN}'.`;
      refuseMissingFactory('1/1-edition factory', 'ABX_ONE_OF_ONE_EDITION_FACTORY', reason);
    }
    throw err;
  }
}

/** Get (or deploy) the chain's `EditionImageFactory` — narrates the SDK's `ensureEditionFactory`
 *  (anchors.ts), the edition twin of {@link ensureSeriesFactory}. */
export async function ensureEditionFactory(override?: string, allowBootstrap = false): Promise<Address> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const send = lazyBootstrapSender(publicClient);
  try {
    return await sdkEnsureEditionFactory(publicClient, send, {
      chainId: resolveChain(CHAIN).id,
      override,
      allowBootstrap,
      onEvent: (e: AnchorEvent) => {
        if (e.kind === 'resolved') info(`using canonical edition factory ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'canonical') info(`using canonical edition factory at its deterministic address ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'stale') {
          info(
            e.reason === 'no-code'
              ? 'configured edition factory has no code on this chain — deploying a fresh one'
              : 'configured edition factory is an older/incompatible version — deploying a fresh trust anchor',
          );
        } else if (e.kind === 'deploying')
          info(
            'deploying the canonical multi-work edition clone factory (ownerless trust anchor: 3 libraries → linked factory → implementation, CREATE2 throughout — libraries already on-chain are reused)…',
          );
        else if (e.kind === 'deployed') {
          ok(`edition factory ${e.address}`);
          info(`implementation ${e.implementation}`);
          info(`libraries: AbxMetadataLib ${e.metadataLib} · AbxParamsLib ${e.paramsLib} · AbxEditionLib ${e.editionLib}`);
          info(`tx ${explorerBase()}/tx/${e.txHash}`);
          warn(`${CHAIN} isn't in the shipped manifest — to reuse this factory set ${bold(`ABX_EDITION_FACTORY=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
        }
      },
    });
  } catch (err) {
    if (err instanceof AnchorUnavailableError) {
      const reason =
        err.detail === 'not-configured'
          ? `no canonical edition factory is configured for '${CHAIN}'.`
          : err.detail === 'no-code'
            ? `the configured edition factory ${err.address} has no code on '${CHAIN}' — check ABX_CHAIN / the RPC endpoint.`
            : `the configured edition factory ${err.address} is an older/incompatible version on '${CHAIN}'.`;
      refuseMissingFactory('edition factory', 'ABX_EDITION_FACTORY', reason);
    }
    throw err;
  }
}

/** The code-project EDITION trust anchor — narrates the SDK's `ensureEditionCodeFactory`
 *  (anchors.ts), the edition twin of {@link ensureSeriesCodeFactory} (three linked libraries
 *  instead of two — see `deployEditionCodeFactory`'s doc note). */
export async function ensureEditionCodeFactory(publicClient: PublicClient, override?: string, allowBootstrap = false): Promise<Address> {
  const send = lazyBootstrapSender(publicClient);
  try {
    return await sdkEnsureEditionCodeFactory(publicClient, send, {
      chainId: resolveChain(CHAIN).id,
      override,
      allowBootstrap,
      onEvent: (e: AnchorEvent) => {
        if (e.kind === 'resolved') info(`using canonical EditionCode factory ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'stale') info('configured EditionCode factory has no code on this chain — deploying a fresh trust anchor');
        else if (e.kind === 'canonical') info(`using EditionCode factory at its deterministic address ${explorerBase()}/address/${e.address}`);
        else if (e.kind === 'deploying') info('deploying the EditionCode trust anchor (4 libraries → linked factory → implementation, CREATE2 throughout — libraries already on-chain are reused)…');
        else if (e.kind === 'deployed') {
          ok(`EditionCode factory ${e.address} ${dim(`(impl ${e.implementation})`)}`);
          info(`libraries: AbxMetadataLib ${e.metadataLib} · AbxParamsLib ${e.paramsLib} · AbxCodeLib ${e.codeLib} · AbxEditionLib ${e.editionLib}`);
          warn(`${CHAIN} isn't in the shipped manifest — to reuse, set ${bold(`ABX_EDITION_CODE_FACTORY=${e.address}`)} (or add it to packages/sdk/src/deployments.ts).`);
        }
      },
    });
  } catch (err) {
    if (err instanceof AnchorUnavailableError) {
      const reason =
        err.detail === 'not-configured'
          ? `no canonical EditionCode factory is configured for '${CHAIN}'.`
          : `the configured EditionCode factory ${err.address} has no code on '${CHAIN}' — check ABX_CHAIN / the RPC endpoint.`;
      refuseMissingFactory('EditionCode factory', 'ABX_EDITION_CODE_FACTORY', reason);
    }
    throw err;
  }
}

/** The canonical seed source — narrates the SDK's `ensureSeedSource` (anchors.ts): a clean keyless
 *  singleton (like the renderer / chunk store / minter), so CREATE2 lands at THE canonical address
 *  on any chain. Resolves from the manifest, self-heals to the predicted address (deployed but not
 *  yet repointed), else auto-deploys via CREATE2. */
export async function ensureSeedSource(publicClient: PublicClient): Promise<Address> {
  const send = lazyBootstrapSender(publicClient);
  return sdkEnsureSeedSource(publicClient, send, {
    chainId: resolveChain(CHAIN).id,
    onEvent: (e: AnchorEvent) => {
      if (e.kind === 'canonical') info(`using the canonical seed source at its deterministic address ${e.address}`);
      else if (e.kind === 'deployed') ok(`AbxSeedSource ${e.address} ${dim('(deployed via CREATE2 — set ABX_SEED_SOURCE to reuse)')}`);
    },
  });
}

/**
 * Refuse a port that's already bound, with a formatted one-liner naming the port and the fix.
 *
 * Without this, `listen()` has no `'error'` handler and EADDRINUSE reaches Node's default handler:
 * the creator gets a raw stack trace through `node:net` and our own `dist/` paths, which reads as a
 * crash inside abx rather than "something else is on this port" — and it's the one unformatted error
 * surface in a CLI where every other error is formatted. `preview`'s default port colliding with a
 * studio left running in another terminal was reported as especially hard to diagnose.
 */
export async function assertPortFree(port: number, cmd: string): Promise<void> {
  if (!(await portInUse(port))) return;
  throw new Error(
    `port ${port} is already in use — most likely an \`abx ${cmd}\`/\`abx serve\`/\`abx preview\` still running in another terminal.\n` +
      `  Stop that one (Ctrl-C), or run this on a different port: \`abx ${cmd} --port ${port + 1}\`.`,
  );
}

/** Is a TCP port already bound on localhost? Used to preflight a serve BEFORE spending a tx. */
export async function portInUse(port: number): Promise<boolean> {
  const {createServer} = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port);
  });
}

/**
 * A throttled `onChunk` progress printer for {@link SelfHostIndexer.reindex}'s large-scan case — at
 * most one line every ~8s, so a multi-minute range-capped scan gives visible proof of life (block
 * count + %) without printing a line per chunk. Below the same 5000-block threshold that gates the
 * up-front "scanning blocks…" notice, it prints nothing: a small scan finishes before this would ever
 * fire. Large scans still need periodic progress so they do not appear hung.
 */
function throttledScanProgress(): (progress: {scanned: bigint; span: bigint}) => void {
  let lastPrintedAt = 0;
  return ({scanned, span}) => {
    if (span < 5000n) return;
    const now = Date.now();
    if (now - lastPrintedAt < 8000) return;
    lastPrintedAt = now;
    const pct = span > 0n ? Number((scanned * 100n) / span) : 100;
    info(dim(`  … still scanning: ${scanned}/${span} blocks (${pct}%)`));
  };
}

/**
 * Index a project we *just* deployed — and don't believe a zero.
 *
 * `eth_getLogs` is read-after-write inconsistent on load-balanced RPCs: `waitForTransactionReceipt`
 * resolves against a node that has the block, then the log query lands on one that doesn't yet, and
 * returns an empty set for a block we KNOW contains our deploy. The old code took that single read at
 * face value, printed `✓ reconstructed 0 events`, stored the empty projection, and served an empty
 * dashboard — a first-run that looks like the toolkit simply doesn't work. It reproduced 100% of the
 * time on `https://sepolia.base.org`, which is the DEFAULT endpoint when there's no `.env`, i.e. the
 * documented first run was the broken path. The same block returned all 9 logs seconds later.
 *
 * We have the one thing that makes this checkable: we just minted, so the spine cannot be empty.
 * So verify instead of trusting — re-scan at a constant delay until events appear, and if they
 * never do, say so as a FAILURE with the recovery command rather than dressing a zero up as a ✓.
 */
export async function reindexAfterDeploy(
  indexer: SelfHostIndexer,
  address: Address,
  opts: {attempts?: number; delayMs?: number; readUriDocuments?: boolean} = {},
): Promise<{state: ProjectState; elapsedMs: number}> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 1500;
  // Off by default (the SDK reconstruct default): composed contractURI/tokenURI documents are a
  // live read, never projected. `abx demo`'s read-back step is the one caller that passes `true`
  // — see `walkthroughReadBack`.
  const readUriDocuments = opts.readUriDocuments;
  const onChunk = throttledScanProgress();
  let last = await indexer.reindex(address, {readUriDocuments, onChunk});
  for (let i = 1; i < attempts && last.state.eventCount === 0; i++) {
    if (i === 1) {
      info(dim("no events yet — the RPC hasn't served the logs for that block; re-scanning…"));
    }
    await sleep(delayMs);
    // `full: true` — the stored projection has 0 events, so there is no valid checkpoint to
    // resume from; a full replay from the deploy block is the only correct re-scan.
    last = await indexer.reindex(address, {full: true, readUriDocuments, onChunk});
  }
  // Delay and repetition only fix the TRANSIENT shape of an empty scan. The permanent shape is an
  // endpoint whose log history is pruned — see `recoverEmptyScanPerEndpoint`.
  if (last.state.eventCount === 0) last = (await recoverEmptyScanPerEndpoint(indexer, address, readUriDocuments)) ?? last;
  if (last.state.eventCount === 0) {
    warn(
      `the RPC still reports no logs for this project after ${attempts} tries — the deploy DID succeed ` +
        `(it's on chain), but this node can't reconstruct it yet.`,
    );
    console.log(`    ${dim('if you JUST deployed, recover with')} ${bold(`abx index ${address} --full`)} ${dim('in a minute.')}`);
    console.log(`    ${dim(`if this project is NOT new, its logs are likely past your endpoint's retention — run`)} ${bold('abx doctor')} ${dim(`and put a full-archive endpoint first in ${rpcEnvVar(CHAIN)}.`)}`);
  }
  return last;
}

/**
 * Last resort for a scan that keeps coming back EMPTY: re-run it against each configured endpoint
 * ON ITS OWN, and keep the first result that has events.
 *
 * Why this exists at all — the read client is a viem `fallback` across every configured endpoint,
 * and `fallback` moves to the next endpoint on an *error*. An endpoint that has pruned its log
 * history does not error: it answers `eth_getLogs` with `[]` and HTTP 200, which is a success. So the
 * pool never rotates, every retry above asks the same endpoint the same question, and a project
 * whose logs are perfectly available on the SECOND configured endpoint reconstructs as empty. This
 * was measured on the two default Base Sepolia endpoints: one returns zero logs for a project's
 * entire history, the other returns them instantly.
 *
 * Cheap by construction: rather than pay a full replay per endpoint to find out, each endpoint is
 * first asked whether it still holds history AT THIS PROJECT'S deploy block — three calls, the same
 * check `abx doctor` grades RPCs with — and only an endpoint that passes gets a scan.
 */
async function recoverEmptyScanPerEndpoint(
  indexer: SelfHostIndexer,
  address: Address,
  readUriDocuments?: boolean,
): Promise<IndexResult | null> {
  const urls = resolveRpcUrls(CHAIN);
  if (urls.length < 2) return null; // nothing to rotate to — the caller's guidance covers it
  const floor = indexer.store.getRegistration(address)?.fromBlock;
  if (floor === undefined || floor === null) return null;
  info(
    `no events from the endpoint pool — asking each of the ${urls.length} endpoints on its own ` +
      `(a pruned log index answers "[]" without an error, so the pool never fails over)…`,
  );
  for (const rpcUrl of urls) {
    const label = redactRpcUrl(rpcUrl);
    let retained: boolean;
    let reason: string | undefined;
    try {
      ({retained, reason} = await probeHistoryAt(makePublicClient({chainKey: CHAIN, rpcUrl}), BigInt(floor)));
    } catch {
      continue; // unreachable right now — it tells us nothing about the others
    }
    if (!retained) {
      info(dim(`  ${label} — can't serve block ${floor}: ${reason ?? 'no logs at that depth'}`));
      continue;
    }
    try {
      const res = await indexer.reindex(address, {full: true, readUriDocuments, rpcUrl});
      if (res.state.eventCount > 0) {
        ok(`${label} served the logs — ${res.state.eventCount} events. Put it FIRST in ${rpcEnvVar(CHAIN)} so the next scan starts there.`);
        return res;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Effects (Playwright + Chromium) is an OPTIONAL dependency of the CLI, so the default
// `npm i -g @artblocks/abx-cli` stays small + browserless (the resolver serves read-only and never
// renders). Only `abx render` and `abx effects` need it — load it lazily here so a missing optional
// dep surfaces ONLY at those call sites, with a fix, instead of breaking startup for everyone.
export async function loadEffects(): Promise<typeof import('@artblocks/abx-effects')> {
  try {
    return await import('@artblocks/abx-effects');
  } catch {
    throw new Error(
      "effects support isn't installed (the optional @artblocks/abx-effects package + Playwright). " +
        'Install it with `npm i -g @artblocks/abx-effects`, or reinstall the CLI without --no-optional. ' +
        'Only `abx render` and `abx effects` need it; everything else runs browserless.',
    );
  }
}

/**
 * The publish topology's one hard prerequisite, checked BEFORE any capture.
 *
 * A resolver that doesn't share this machine's disk serves referenced output (the still, a video, a
 * model) by **redirect** — so it needs a URL, and it refuses the bytes (`site/content/docs/protocol/effects.mdx →
 * Bound vs referenced`). A backend that can't name a locator therefore has no publish lane at all,
 * and every render against one would be work spent to earn a 400.
 *
 * So this refuses up front and names the ways out, rather than warning and letting the render run.
 * It deliberately does NOT pick a backend for the operator: which store holds their content — and which
 * gateway serves it — is theirs to decide. The three that work are peers, not a ranking: `https://`
 * from S3/R2, an IPFS gateway, and Arweave are all fine, because derived output is re-creatable and
 * the only real requirement is that a third party can fetch it.
 */
export function requirePublishableBackend(flags: Flags, what: string): void {
  const backend = resolveBackend(storageOptions(storageOverrides(flags)));
  const {backend: name, source} = backendResolution(storageOverrides(flags));
  // The OK/NOT-OK decision is the shared render×storage validator (packages/storage/content-plan.ts)
  // — the same one deploy-code's --image-base guard and dry-run row consult, so this combination
  // can't drift into two disagreeing ideas of "publishable." The wording below stays CLI-specific
  // (it names the exact env vars + every way out) — only the verdict is shared. `backend.id` (not
  // `name`) — `resolveBackend` normalizes the `s3` alias to `cloud`, and the validator's backend set
  // is keyed on the normalized id.
  const result = validateRenderStorageCombo({backendId: backend.id, cloudHasPublicBase: backend.id === 'cloud' ? !!backend.publicBase : undefined, publishesToRemoteResolver: true});
  if (result.ok) return;
  // `cloud` is the one backend that HAS a locator method and can still return null: the URL is
  // `<publicBase>/<key>`, so without a public base it can name nothing. Catch that here too — it
  // would otherwise be the same failure one render later.
  if (name === 'cloud' && !backend.publicBase) {
    throw new Error(
      `${what} hands the resolver a URL for each render, but the 'cloud' backend has no public read base — ` +
        `set ${bold('ABX_S3_PUBLIC_BASE')} to the bucket's public URL (an R2/CloudFront/S3-website base), ` +
        `or use ${bold('--backend ipfs')} / ${bold('--backend arweave')}, or render co-located with the resolver.`,
    );
  }
  throw new Error(
    `${what} publishes each render to a resolver that doesn't share this machine's disk, but the '${name}' backend ` +
      `(${source === 'default' ? 'the default' : `from ${source}`}) can't produce a URL for what it stores — so the resolver would have nothing to serve.\n` +
      `  Point it at a backend that can (equal options — pick on cost/ops, not durability dogma):\n` +
      `    ${bold('--backend cloud')}    S3 / R2 / B2 with a public base (ABX_S3_* + ABX_S3_PUBLIC_BASE)\n` +
      `    ${bold('--backend ipfs')}     Pinata or your own Kubo + a public gateway (PINATA_JWT / ABX_IPFS_*)\n` +
      `    ${bold('--backend arweave')}  pay-once permanent (uploads under 100KiB are free, no setup)\n` +
      `  …or run co-located instead: ${bold('abx effects')} on the same host as ${bold('abx serve')}, sharing one backend and no remote token.`,
  );
}

// ── shared output ─────────────────────────────────────────────────────────--
export function printServing(url: string, address?: Address) {
  console.log(`\n  ${g('●')} ${bold('serving')}  ${url}`);
  console.log(`    ${dim('dashboard  ')}${url}`);
  console.log(`    ${dim('storage    ')}${activeBackendId()}`);
  if (address) {
    const cid = resolveChain(CHAIN).id;
    console.log(`    ${dim('tokenURI   ')}${url}/t/${cid}/${address}/0`);
    console.log(`    ${dim('image      ')}${url}/t/${cid}/${address}/0/image`);
    console.log(`    ${dim('state API  ')}${url}/api/project/${address}`);
  }
  // The dashboard is READ-ONLY: re-index/verify are admin actions that 404 unless the node has an
  // ABX_RESOLVER_ADMIN_TOKEN, so there is no button to press. This line used to say "hit Re-index
  // from chain", which sent every first-run user hunting for a control that isn't there.
  console.log(`\n  ${dim('The dashboard shows the event spine it replayed — that table IS the reconstruction.')}`);
  if (address) {
    console.log(`  ${dim('Rebuild it yourself (read-only, safe):')} ${bold(`abx index ${address} --full`)} ${dim('— replays from the deploy block and must land on identical state.')}`);
  }
  console.log(`  ${dim('Ctrl-C to stop.')}\n`);
}

/**
 * The CLI package's own root — the directory holding its `package.json`, found by walking up rather
 * than by counting `..`.
 *
 * **Counting is the bug this exists to prevent, and it shipped.** `resolveBundledSkill` and
 * `resolveRendererScaffold` each computed the root as `resolve(fileURLToPath(import.meta.url), '..',
 * '..')`. That is right for a module compiled to `dist/main.js` and wrong for one compiled to
 * `dist/commands/scaffold.js`, which is one level deeper — it lands on `dist/`, not the package root.
 * Both functions live in `src/commands/`, so in every published install they looked for
 * `<pkg>/dist/skill` and `<pkg>/dist/assets/renderer-scaffold`, neither of which exists. The result:
 * `abx skill install` — the CANONICAL way a user installs the agent skill, the first thing our own
 * quickstart tells them to run — failed on every fresh npm install with "bundled skill not found",
 * and `abx scaffold-renderer` failed the same way. Reported from the field on v0.1.0-alpha.21.
 *
 * Nothing caught it because dev runs from source (`pnpm abx`), where the fallback to the canonical
 * repo copy makes both functions work regardless of the arithmetic. The published layout is the only
 * place the number matters, and no test constructed one.
 *
 * So: no fixed depth anywhere. A file can move between `src/` and `src/commands/` without silently
 * breaking a path, and `packaging.test.ts` fails the build if fixed-depth root math comes back.
 */
export function findCliPackageRoot(): string | null {
  // Starts from THIS module, not the caller's — one definition, one starting point, and callers
  // cannot reintroduce the depth bug by calling from a different nesting level.
  return packageRootFrom(fileURLToPath(import.meta.url));
}

/**
 * The walk itself, as a pure function of a starting path — so it can be tested against a SIMULATED
 * published layout, which is the one layout a dev run never has and therefore the one the original
 * bug hid in. `findCliPackageRoot()` is this applied to the running module.
 *
 * @param from a file path inside the package (the walk starts at its directory)
 * @param name the `package.json` `name` that identifies the root
 */
export function packageRootFrom(from: string, name = '@artblocks/abx-cli'): string | null {
  let dir = resolvePath(from, '..');
  for (let i = 0; i < 8; i++) {
    const pkg = joinPath(dir, 'package.json');
    if (existsSync(pkg)) {
      // Name-checked: a build that emits its own `dist/package.json` (a common ESM/CJS trick) would
      // otherwise stop the walk one directory short — the same off-by-one in a new costume.
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as {name?: string};
        if (parsed.name === name) return dir;
      } catch {
        // unreadable/!JSON — keep walking rather than guess
      }
    }
    const parent = resolvePath(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Walk up from the CLI source to the workspace root (the dir with pnpm-workspace.yaml). Returns
 *  null when running from a published install (no workspace) — where --from-source doesn't apply. */
export function findRepoRoot(): string | null {
  let dir = resolvePath(fileURLToPath(import.meta.url), '..');
  for (let i = 0; i < 8; i++) {
    if (existsSync(joinPath(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolvePath(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function keepAlive() {
  process.on('SIGINT', () => {
    console.log(dim('\n  stopped.'));
    process.exit(0);
  });
  return new Promise<void>(() => {});
}

/**
 * Pick the canonical factory for a clone being added — the CLI-side shell around the SDK's
 * {@link sdkDetectCanonicalFactory} (which does the actual multicall probe; see its doc comment).
 * Shared by `add`'s local + remote paths (project.ts) and the deploy family's post-setup local
 * register (deploy.ts, via {@link registerAndIndexLocally}).
 */
export async function detectCanonicalFactory(
  address: Address,
  override?: string,
  stored?: string | null,
): Promise<Address | undefined> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  return sdkDetectCanonicalFactory(publicClient, address, {chainId: resolveChain(CHAIN).id, override, stored});
}

/**
 * Register + index a project LOCALLY (this node's own SQLite-backed projection) — the core of
 * `abx add`'s non-`--remote` path, factored out here because it's ALSO how `deploy` / `deploy-series`
 * / `deploy-code` register the project they just deployed (see cmdAdd in commands/project.ts, whose
 * local branch is a thin call to this). Kept self-sufficient (recomputes any `--attributes`/`--traits`
 * edit from `flags` itself) so it never depends on a caller's local variables.
 */
export async function registerAndIndexLocally(address: Address, flags: Flags): Promise<void> {
  const attrRaw = flags.attributes ? readFileSync(resolvePath(process.cwd(), String(flags.attributes)), 'utf8') : undefined;
  const perTokenEdit = attrRaw != null && looksPerTokenAttributes(attrRaw);
  const flagTraits: OpenSeaAttribute[] = [];
  if (attrRaw != null && !perTokenEdit) flagTraits.push(...normalizeAttributes(JSON.parse(attrRaw)));
  if (flags.traits) flagTraits.push(...parseTraitPairs(flags.traits));
  const editedTokenAttributes = perTokenEdit ? parseSeriesTraitsById(attrRaw) : undefined;

  allowLargeScan(flags);
  const indexer = localIndexer();
  const existingReg = indexer.store.getRegistration(address);
  const factory = await detectCanonicalFactory(address, flags.factory as string | undefined, existingReg?.factory);
  // Resolve the scan floor once — the deploy block, never a silent genesis default (see
  // resolveScanFloor). Reused for both register() writes so discovery runs at most once.
  const scanFloor = await resolveScanFloor(address, existingReg?.fromBlock, flags);
  // register() is a full-column upsert, so EVERY off-chain field must be edit-or-preserve here: a flag
  // edits it, its absence keeps what the deploy stored. Omitting one would silently null it on a plain
  // re-index (the clobber bug). Mirrors the remote path's fall-back-to-localReg for the same reason.
  const editDescription = flags.description ?? existingReg?.description ?? undefined;
  const editExternalUrl = (flags['external-url'] as string | undefined) ?? existingReg?.externalUrl ?? undefined;
  const editAttributes = flagTraits.length ? JSON.stringify(flagTraits) : existingReg?.attributes ?? undefined;
  const editTokenAttributes = editedTokenAttributes && Object.keys(editedTokenAttributes).length
    ? JSON.stringify(editedTokenAttributes)
    : existingReg?.tokenAttributes ?? undefined;
  indexer.register({
    address,
    chainKey: CHAIN,
    fromBlock: scanFloor,
    factory: factory ?? null,
    label: flags.label,
    description: editDescription,
    externalUrl: editExternalUrl,
    attributes: editAttributes,
    tokenAttributes: editTokenAttributes,
  });
  // Set expectations before a potentially multi-minute scan. `eth_getLogs` from a far-back floor
  // auto-chunks but emits no per-block output, so a large span reads as "hung" and invites a Ctrl-C
  // that aborts the index (the #1 add/index friction). Print the span up front when it's large;
  // stay silent on a fresh deploy (tiny recent window). Advisory only — one cheap head read.
  try {
    const prior = indexer.getProject(address);
    const start = prior?.toBlock ? BigInt(prior.toBlock) : BigInt(scanFloor);
    const head = await makePublicClient({chainKey: CHAIN}).getBlockNumber();
    const span = head - start;
    if (span > 5000n) {
      info(
        `scanning blocks ${start}${dim(' → ')}${head} ${dim(`(~${span} blocks)`)} — on a range-capped RPC (see ${g('abx doctor')}) ` +
          `this can take a few minutes; leave it running. A progress line prints periodically below, and ` +
          `${bold(`abx status ${address}`)} in another terminal confirms it's alive (not the same as fine-grained progress) if you want a second signal.`,
      );
    }
  } catch { /* advisory only — the real scan still runs */ }
  // Don't accept a zero here either: `deploy-code` finishes through this command, so this IS the
  // post-deploy index for a code project — and a real ABX clone always emits a spine (its extension
  // registrations at minimum), so 0 events means the RPC hasn't served the logs yet, not that the
  // project is empty. See reindexAfterDeploy.
  const {state, elapsedMs} = await reindexAfterDeploy(indexer, address);
  // Resolve durable locators for off-chain-by-hash content from this machine's index.
  const locators = await collectContentLocators(state, resolveBackend(storageOptions(storageOverrides(flags))));
  if (Object.keys(locators).length) {
    indexer.register({
      address,
      chainKey: CHAIN,
      fromBlock: scanFloor,
      factory: factory ?? null,
      label: flags.label,
      description: editDescription,
      externalUrl: editExternalUrl,
      attributes: editAttributes,
      tokenAttributes: editTokenAttributes,
      contentLocators: JSON.stringify(locators),
    });
  }
  // A ✓ on 0 events is the lie that produced an empty dashboard; reindexAfterDeploy has already
  // explained the failure and named the recovery command, so don't stamp it as success too.
  if (state.eventCount > 0) {
    ok(`registered + indexed ${state.name ?? address} LOCALLY (this machine): ${state.eventCount} events in ${elapsedMs}ms`);
  } else {
    warn(`registered ${state.name ?? address}, but with NO reconstructed state — it will serve empty until the index succeeds.`);
  }
  info(`serve it from here with ${bold('abx serve')} — or push it to a hosted resolver with ${bold('abx add ' + address + ' --remote')}`);
}
