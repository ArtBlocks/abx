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
import {DEFAULT_CHAIN_KEY, resolveChain, resolveRpcUrls, rpcEnvVar} from './chains.js';
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

/** One receipt probe across independent readers. Exported so the stale-not-found behavior can be
 * regression-tested without binding sockets; callers normally use the polling wrapper below. */
export async function firstAvailableReceipt(
  readers: readonly Pick<PublicClient, 'getTransactionReceipt'>[],
  hash: Hex,
): Promise<{receipt?: TransactionReceipt; error?: unknown}> {
  try {
    // Resolve as soon as ANY independent endpoint has the receipt; one slow provider must not hold
    // a successful answer hostage. Promise.any rejects only after every endpoint has rejected.
    return {receipt: await Promise.any(readers.map((reader) => reader.getTransactionReceipt({hash})))};
  } catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error];
    return {error: reasons.find((reason) => reason !== undefined)};
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
  if (urls.length <= 1) return client.waitForTransactionReceipt({hash: args.hash, timeout: args.timeoutMs});
  const readers = urls.map((rpcUrl) =>
    createPublicClient({chain: client.chain, transport: http(rpcUrl, {retryCount: 0})}),
  );
  const deadline = Date.now() + (args.timeoutMs ?? 180_000);
  let lastError: unknown;
  for (;;) {
    const result = await firstAvailableReceipt(readers, args.hash);
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
  if (verifiedChains.has(chainKey)) return;
  const expected = resolveChain(chainKey).id;
  let actual: number;
  try {
    actual = await makePublicClient({chainKey}).getChainId();
  } catch (err) {
    if (opts.allowUnreachable) return; // offline dry-run: preview what we can, don't block
    throw new Error(
      `Could not reach an RPC for '${chainKey}' to verify the network: ${(err as Error).message}. ` +
        `Check ${rpcEnvVar(chainKey)} / ABX_RPC_URLS in your .env.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `RPC network mismatch: the configured endpoint reports chain ${actual}, but ABX_CHAIN='${chainKey}' ` +
        `expects ${expected}. Point ${rpcEnvVar(chainKey)} (or ABX_RPC_URLS) at a '${chainKey}' endpoint.`,
    );
  }
  verifiedChains.add(chainKey);
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
