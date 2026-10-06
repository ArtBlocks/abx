import {arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, robinhood, robinhoodTestnet, sepolia} from 'viem/chains';
import type {Chain} from 'viem';
import {CHAIN_SUPPORT, CHAIN_SUPPORT_REGISTRY, isChainSelectable} from './chain-support.js';
import {readEnv} from './util.js';

/**
 * Chain targets. The SDK is neutral about *which* chain — it takes a target as
 * input — but the toolkit's demo runs on a testnet, so that's the default here.
 * The protocol is per-EVM-chain (one project = one contract, per chain).
 */
export const CHAINS: Record<string, Chain> = {
  'base-sepolia': baseSepolia,
  sepolia,
  'robinhood-testnet': robinhoodTestnet,
  'arbitrum-sepolia': arbitrumSepolia,
  base,
  robinhood,
  ethereum: mainnet,
  arbitrum,
};

for (const support of CHAIN_SUPPORT) {
  const chain = CHAINS[support.key];
  if (!chain || chain.id !== support.chainId) {
    throw new Error(`Chain metadata mismatch for ${support.key}: registry=${support.chainId}, viem=${chain?.id ?? 'missing'}`);
  }
}

/** Every recognized chain, including production and deliberately disabled entries. */
export const ALL_CHAIN_KEYS = CHAIN_SUPPORT.map((chain) => chain.key);

/** Chains this release permits callers to select with `ABX_CHAIN`. */
export const SUPPORTED_CHAIN_KEYS = CHAIN_SUPPORT.filter(isChainSelectable).map((chain) => chain.key);

/** Backward-compatible name for the CLI-selectable chain list. */
export const KNOWN_CHAIN_KEYS = SUPPORTED_CHAIN_KEYS;

export const DEFAULT_CHAIN_KEY = CHAIN_SUPPORT_REGISTRY.defaultChain;

// Public, keyless endpoints per chain — overridable. Each supported chain has independent
// providers where the network offers them: a public RPC is a convenience, not an availability
// guarantee, and rate limits / lag / method policy differ between providers. A self-hoster can
// replace the list outright through ABX_RPC_URLS_<CHAIN>; nothing depends on either provider.
const DEFAULT_RPC_URLS: Record<string, readonly string[]> = {
  'base-sepolia': ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com'],
  'robinhood-testnet': [
    'https://rpc.testnet.chain.robinhood.com',
    'https://robinhood-sepolia-rpc.publicnode.com',
  ],
  'arbitrum-sepolia': [
    'https://sepolia-rollup.arbitrum.io/rpc',
    'https://arbitrum-sepolia-rpc.publicnode.com',
  ],
  robinhood: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
};

export interface RuntimeRpcEndpoint {
  url: string;
  /** Headers sent only to this exact endpoint. Credentials never follow a fallback URL. */
  headers?: Readonly<Record<string, string>>;
}

/** Process-local provider injection for an embedding CLI. The SDK remains provider-neutral;
 * explicit options and ABX_RPC_URLS* always take precedence over this runtime default. */
const RUNTIME_RPC_ENDPOINTS = new Map<string, RuntimeRpcEndpoint>();

export function configureRuntimeRpcEndpoint(chainKey: string, endpoint: RuntimeRpcEndpoint): void {
  resolveChain(chainKey);
  const parsed = new URL(endpoint.url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('runtime RPC endpoint must use http or https');
  }
  RUNTIME_RPC_ENDPOINTS.set(chainKey, {
    url: endpoint.url.replace(/\/+$/, ''),
    headers: {...endpoint.headers},
  });
}

/** Primarily for isolated tests and embedders replacing their process-local configuration. */
export function clearRuntimeRpcEndpoint(chainKey: string): void {
  RUNTIME_RPC_ENDPOINTS.delete(chainKey);
}

/** Headers registered for exactly this URL. Public and creator-selected fallbacks receive none. */
export function runtimeRpcHeaders(url: string): Record<string, string> {
  for (const endpoint of RUNTIME_RPC_ENDPOINTS.values()) {
    if (endpoint.url === url) return {...endpoint.headers};
  }
  return {};
}

export function resolveChain(key: string = DEFAULT_CHAIN_KEY): Chain {
  const chain = CHAINS[key];
  if (!chain) throw new Error(`Unknown chain "${key}". Known: ${Object.keys(CHAINS).join(', ')}`);
  return chain;
}

/** A supported chain by its EIP-155 id, or undefined. Callers that only carry a chainId (the
 *  token-api's routes are `/t/<chainId>/…`) need this to reach the chain's metadata. */
export function chainById(chainId: number): Chain | undefined {
  return Object.values(CHAINS).find((c) => c.id === chainId);
}

/**
 * Block-explorer base URL for a chain id, taken from viem's own chain metadata rather than a
 * hand-maintained table — so adding a chain to {@link CHAINS} brings its explorer along and no
 * separate list can fall out of sync. Falls back to Etherscan's Sepolia only for an unknown id.
 *
 * There was a hardcoded `https://sepolia.etherscan.io` in the token-api dashboard, so every link on
 * it — contract, tx, address — pointed at Ethereum Sepolia regardless of the chain being served.
 * Since the default chain is Base Sepolia, that meant the dashboard for a normal `abx demo` sent you
 * to an explorer where the contract does not exist.
 */
export function explorerUrl(chainId: number): string {
  return chainById(chainId)?.blockExplorers?.default?.url ?? 'https://sepolia.etherscan.io';
}

/** Env-name suffix for a user-facing key: uppercased, any run of non-alphanumerics collapsed to
 *  one `_` (`base-sepolia` → `BASE_SEPOLIA`, `my.provider` → `MY_PROVIDER`). Shared by every
 *  `ABX_<FAMILY>_<NAME>_*` convention (`ABX_RPC_URLS_<CHAIN>`, `ABX_REMOTE_<NAME>_URL/_TOKEN`) so
 *  the conventions can't drift. Lossy — the normalized form is the canonical name. */
export function envSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** The env var holding RPC endpoints for a chain: per-chain `ABX_RPC_URLS_<CHAIN>` (e.g.
 *  `ABX_RPC_URLS_SEPOLIA`) when set, else the bare `ABX_RPC_URLS` (the active `ABX_CHAIN`). */
export function rpcEnvVar(chainKey: string): string {
  return `ABX_RPC_URLS_${envSuffix(chainKey)}`;
}

/**
 * The ordered, de-duplicated RPC endpoints for `chainKey`. Precedence is **override → env →
 * runtime provider → manifest default**, while explicit caller configuration always wins:
 *   - `override` (a `ClientOptions.rpcUrls`, or a single `rpcUrl` the caller already joined) —
 *     explicit config wins outright, no env involved.
 *   - env: a per-chain `ABX_RPC_URLS_<CHAIN>` wins when set; otherwise the bare `ABX_RPC_URLS`
 *     (understood as "for the active `ABX_CHAIN`"). Both are comma/whitespace-separated lists in
 *     preference order — the client fails over across them and `abx doctor` probes + ranks each
 *     (e.g. widest `eth_getLogs` range). The bare and per-chain vars are never mixed, so a list for
 *     one network can't leak into another; a chainId guard (see `assertChainId`) then verifies the
 *     endpoints actually ARE `chainKey`.
 *   - runtime provider: an embedding CLI may inject a credentialed default for this process. It is
 *     used only when neither explicit nor env configuration exists; its headers are URL-scoped.
 *   - manifest: the built-in keyless defaults for `chainKey`, normally independent providers. They
 *     remain after a runtime provider as credential-free failover.
 */
export function resolveRpcUrls(chainKey: string = DEFAULT_CHAIN_KEY, override?: string | string[]): string[] {
  const overrideList = override === undefined ? undefined : Array.isArray(override) ? override.join(',') : override;
  const configured = overrideList ?? readEnv(rpcEnvVar(chainKey)) ?? readEnv('ABX_RPC_URLS');
  const runtime = RUNTIME_RPC_ENDPOINTS.get(chainKey);
  const list = configured?.trim()
    ? configured
    : [runtime?.url, ...(DEFAULT_RPC_URLS[chainKey] ?? [])]
        .filter((url): url is string => Boolean(url))
        .join(',');
  const seen = new Set<string>();
  const urls = list
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => u && !seen.has(u) && seen.add(u));
  if (urls.length === 0 && DEFAULT_RPC_URLS[chainKey]) urls.push(...DEFAULT_RPC_URLS[chainKey]);
  return urls;
}

/** The primary RPC endpoint (the first of {@link resolveRpcUrls}). */
export function resolveRpcUrl(chainKey: string = DEFAULT_CHAIN_KEY, override?: string | string[]): string {
  return resolveRpcUrls(chainKey, override)[0] ?? '';
}

/** A display-safe form of an RPC URL — host + a redacted key tail (URLs can embed keys). */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const tail = last.length > 6 ? `…${last.slice(-4)}` : last;
    return tail ? `${u.host}/…/${tail}` : u.host;
  } catch {
    return url.length > 24 ? `${url.slice(0, 20)}…` : url;
  }
}

/** Replace configured RPC URLs embedded in an error or diagnostic string with display-safe labels.
 * Provider and transport libraries commonly echo their request URL on failure; because RPC keys
 * often live in the path or query, printing a raw upstream message can disclose a credential. */
export function redactRpcUrlsInText(text: string, urls: readonly string[]): string {
  let safe = text;
  for (const url of [...urls].sort((a, b) => b.length - a.length)) {
    if (!url) continue;
    safe = safe.split(url).join(redactRpcUrl(url));
  }
  return safe;
}
