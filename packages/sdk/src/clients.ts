import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {DEFAULT_CHAIN_KEY, redactRpcUrl, resolveChain, resolveRpcUrls, rpcEnvVar} from './chains.js';
import {readEnv} from './util.js';
import {MissingSigningKeyError} from './errors.js';

export interface ClientOptions {
  chainKey?: string;
  /** A single RPC endpoint — wins outright over everything else (env included). */
  rpcUrl?: string;
  /** Several RPC endpoints, in preference order (a viem `fallback` transport failing over
   *  across them). Loses to `rpcUrl` when both are set; otherwise takes precedence over env
   *  resolution — see {@link resolveRpcUrls}'s override → env → manifest precedence. */
  rpcUrls?: string[];
}

/**
 * A transport over one or more endpoints. With several, a viem `fallback` fails
 * over on error — so a request one endpoint rejects (e.g. a too-wide `eth_getLogs`)
 * is retried on the next, which is how the toolkit "finds the endpoint fit for the
 * job" at request time. `retryCount: 0` makes that failover immediate.
 */
function clientRpcList(opts: ClientOptions): string[] {
  return opts.rpcUrl ? [opts.rpcUrl] : resolveRpcUrls(opts.chainKey, opts.rpcUrls);
}

function makeTransport(urls: readonly string[]): Transport {
  if (urls.length <= 1) return http(urls[0]);
  // Keep operator preference deterministic. Receipt reads separately query every endpoint because
  // "not found" from a stale node is a successful JSON-RPC response, not a fallback-triggering error.
  return fallback(urls.map((u) => http(u, {retryCount: 0})));
}

const rpcLists = new WeakMap<object, readonly string[]>();

type ReceiptReader = Pick<PublicClient, 'getTransactionReceipt'> & Partial<Pick<PublicClient, 'getChainId'>>;

class ReceiptValidationError extends Error {}

function receiptMissing(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'TransactionReceiptNotFoundError' || /receipt.{0,40}(not found|could not be found)/i.test(message);
}

/** Validate the untrusted JSON-RPC object before it can drive a dependent transaction. Viem formats
 * normal receipts, but the queried hash and each log's receipt identity are cross-field invariants
 * a provider response must not be allowed to contradict. */
export function assertReceiptIdentity(receipt: TransactionReceipt, hash: Hex): void {
  const expected = hash.toLowerCase();
  if (receipt.transactionHash?.toLowerCase() !== expected) {
    throw new ReceiptValidationError(
      `RPC returned receipt ${receipt.transactionHash ?? '(missing hash)'} for requested transaction ${hash}.`,
    );
  }
  if (receipt.status !== 'success' && receipt.status !== 'reverted') {
    throw new ReceiptValidationError(`RPC returned an invalid receipt status for transaction ${hash}.`);
  }
  for (const log of receipt.logs ?? []) {
    if (log.transactionHash?.toLowerCase() !== expected) {
      throw new ReceiptValidationError(
        `RPC returned a log from ${log.transactionHash ?? '(missing transaction hash)'} in receipt ${hash}.`,
      );
    }
    if (log.blockHash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) {
      throw new ReceiptValidationError(`RPC returned a log from a different block in receipt ${hash}.`);
    }
    if (log.blockNumber !== receipt.blockNumber) {
      throw new ReceiptValidationError(`RPC returned a log from a different block number in receipt ${hash}.`);
    }
  }
}

async function checkedReceipt(
  reader: ReceiptReader,
  hash: Hex,
  expectedChainId?: number,
): Promise<TransactionReceipt> {
  const receipt = await reader.getTransactionReceipt({hash});
  assertReceiptIdentity(receipt, hash);
  if (expectedChainId !== undefined) {
    if (!reader.getChainId) throw new ReceiptValidationError('Receipt reader cannot verify its chain id.');
    const actual = await reader.getChainId();
    if (actual !== expectedChainId) {
      throw new ReceiptValidationError(`Receipt RPC reports chain ${actual}, expected ${expectedChainId}.`);
    }
  }
  return receipt;
}

/** One receipt probe across independent readers. Exported so the stale-not-found behavior can be
 * regression-tested without binding sockets; callers normally use the polling wrapper below. */
export async function firstAvailableReceipt(
  readers: readonly ReceiptReader[],
  hash: Hex,
  options: {expectedChainId?: number; allowStalePrimaryFallback?: boolean} = {},
): Promise<{receipt?: TransactionReceipt; error?: unknown}> {
  if (readers.length === 0) return {error: new Error('No receipt RPC is configured.')};
  try {
    // The first endpoint remains the trust preference used by every other fallback read. A healthy
    // primary saying "not found" is ordinary propagation lag; a secondary must not overrule it with
    // receipt logs that a later transaction may consume. Poll until the primary catches up.
    return {receipt: await checkedReceipt(readers[0], hash, options.expectedChainId)};
  } catch (primaryError) {
    if (primaryError instanceof ReceiptValidationError || readers.length === 1) return {error: primaryError};
    if (receiptMissing(primaryError) && !options.allowStalePrimaryFallback) return {error: primaryError};
    try {
      // The primary could not answer (transport, rate limit, or method policy), so fail over exactly
      // as the ordered viem transport already does. After a grace period, a repeatedly not-found
      // primary is also treated as stale. Every candidate verifies chain + receipt shape.
      return {
        receipt: await Promise.any(
          readers.slice(1).map((reader) => checkedReceipt(reader, hash, options.expectedChainId)),
        ),
      };
    } catch (fallbackError) {
      const reasons = fallbackError instanceof AggregateError ? fallbackError.errors : [fallbackError];
      return {error: reasons.find((reason) => reason !== undefined) ?? primaryError};
    }
  }
}

/** A read-only client — all the indexer and token API ever need. */
export function makePublicClient(opts: ClientOptions = {}): PublicClient {
  const urls = clientRpcList(opts);
  const client = createPublicClient({chain: resolveChain(opts.chainKey), transport: makeTransport(urls)});
  rpcLists.set(client, urls);
  return client;
}

/** Wait for a mined receipt across every endpoint behind an ABX client. A stale node commonly
 * answers "not found" as a successful JSON-RPC response, which a normal fallback transport cannot
 * distinguish from an authoritative absence and therefore will not fail over. Querying each
 * independent endpoint fixes that exact read-after-write boundary. */
export async function waitForTransactionReceiptResilient(
  client: PublicClient,
  args: {hash: Hex; timeoutMs?: number; pollingIntervalMs?: number},
): Promise<TransactionReceipt> {
  const urls = rpcLists.get(client) ?? [];
  if (urls.length <= 1) {
    const receipt = await client.waitForTransactionReceipt({hash: args.hash, timeout: args.timeoutMs});
    assertReceiptIdentity(receipt, args.hash);
    if (client.chain) {
      const actualChainId = await client.getChainId();
      if (actualChainId !== client.chain.id) {
        throw new ReceiptValidationError(
          `Receipt RPC reports chain ${actualChainId}, expected ${client.chain.id}.`,
        );
      }
    }
    return receipt;
  }
  const readers = urls.map((rpcUrl) =>
    createPublicClient({chain: client.chain, transport: http(rpcUrl, {retryCount: 0})}),
  );
  const deadline = Date.now() + (args.timeoutMs ?? 180_000);
  const startedAt = Date.now();
  let lastError: unknown;
  for (;;) {
    const result = await firstAvailableReceipt(readers, args.hash, {
      expectedChainId: client.chain?.id,
      // Give the preferred provider a short propagation window. Beyond that, repeated not-found
      // responses while another configured provider has the receipt are evidence of staleness.
      allowStalePrimaryFallback: Date.now() - startedAt >= 6_000,
    });
    if (result.receipt) return result.receipt;
    lastError = result.error;
    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(`Receipt ${args.hash} was not available before timeout.`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollingIntervalMs ?? 1_000));
  }
}

const verifiedChains = new Set<string>();

/**
 * Verify the configured RPC actually IS the chain we think it is, before any write.
 * The env var names a network ("sepolia") but the URL behind it could point anywhere;
 * this calls `eth_chainId` and hard-fails on a mismatch so an irreversible tx can't go
 * to the wrong chain. Memoized per chainKey — one round-trip per process, so callers can
 * invoke it liberally at write preflights. Reads never call it (they stay zero-overhead).
 *
 * `allowUnreachable` (used by `--dry-run` preflights): a *wrong-network* RPC still hard-fails
 * with the clear mismatch message — a dry run makes RPC reads (predict address, resolve the
 * factory/renderer) that otherwise fail deep inside viem as an opaque "returned no data" — but
 * an *unreachable* RPC is tolerated (returns silently), so a genuinely offline `--dry-run` can
 * still preview what it can. Only a reachable-but-wrong endpoint is a preview-blocking error.
 */
export async function assertChainId(
  chainKey: string = DEFAULT_CHAIN_KEY,
  opts: {allowUnreachable?: boolean} = {},
): Promise<void> {
  const urls = resolveRpcUrls(chainKey);
  const verificationKey = `${chainKey}\0${urls.join('\0')}`;
  if (verifiedChains.has(verificationKey)) return;
  const expected = resolveChain(chainKey).id;
  const checks = await Promise.allSettled(
    urls.map((url) =>
      createPublicClient({chain: resolveChain(chainKey), transport: http(url, {retryCount: 0})}).getChainId(),
    ),
  );
  const reachable = checks.flatMap((result, index) =>
    result.status === 'fulfilled' ? [{actual: result.value, url: urls[index]}] : [],
  );
  const wrong = reachable.find(({actual}) => actual !== expected);
  if (wrong) {
    throw new Error(
      `RPC network mismatch: the configured endpoint (${redactRpcUrl(wrong.url)}) reports chain ${wrong.actual}, but ABX_CHAIN='${chainKey}' ` +
        `expects ${expected}. Point ${rpcEnvVar(chainKey)} (or ABX_RPC_URLS) at a '${chainKey}' endpoint.`,
    );
  }
  if (reachable.length === 0) {
    if (opts.allowUnreachable) return; // offline dry-run: preview what we can, don't block
    throw new Error(
      `Could not reach an RPC for '${chainKey}' to verify the network. Check ${rpcEnvVar(chainKey)} / ABX_RPC_URLS in your .env.`,
    );
  }
  verifiedChains.add(verificationKey);
}

export interface WalletClientOptions extends ClientOptions {
  /** An explicit key — bypasses `ABX_DEPLOYER_PK` (and any `.env`) entirely. For a caller that
   *  already resolved a key itself (a browser-wallet bridge is the OTHER signing lane — this is
   *  for a host embedding the SDK with its own key management, not that lane). */
  privateKey?: Hex;
}

/**
 * A signing client, backed by a private key. The SDK never takes custody of keys beyond
 * reading them from the operator's own env (or an explicit override) — there is no key
 * storage, no prompt, no remote signer here.
 *
 * Key resolution: `opts.privateKey` → `ABX_DEPLOYER_PK`. That is the ONLY env name read —
 * `SEPOLIA_FUNDED_PK` / `SEPOLIA_WALLET_PK` (earlier alphas) are no longer consulted.
 */
export function makeWalletClient(opts: WalletClientOptions = {}): {
  wallet: WalletClient;
  account: Account;
} {
  const pk = opts.privateKey ?? readEnv('ABX_DEPLOYER_PK');
  if (!pk) throw new MissingSigningKeyError();
  const account = privateKeyToAccount(normalizePk(pk));
  const chain = resolveChain(opts.chainKey);
  const wallet = createWalletClient({account, chain, transport: makeTransport(clientRpcList(opts))});
  return {wallet, account};
}

function normalizePk(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

/**
 * The signing key (0x-normalized), same resolution as {@link makeWalletClient}
 * (`override` → `ABX_DEPLOYER_PK`), or `undefined` if none is set. For reusing the hot key as
 * a *storage* signing identity (an Ethereum Turbo identity) without constructing a wallet
 * client. Never throws.
 */
export function envSigningKey(override?: Hex): `0x${string}` | undefined {
  const pk = override ?? readEnv('ABX_DEPLOYER_PK');
  return pk ? normalizePk(pk) : undefined;
}
