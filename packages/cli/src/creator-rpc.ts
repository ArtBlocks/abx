import {
  AbxServiceClient,
  configureRuntimeRpcEndpoint,
  CREATOR_RPC_INTERFACE,
  resolveChain,
  resolveServiceInterfaceEndpoint,
  resolveServiceInterfaceUrl,
  rpcEnvVar,
} from '@artblocks/abx-sdk';

export const ABX_SERVICES_URL = 'https://services.abx.io';
export const ABX_SERVICES_API_KEY_VAR = 'ABX_SERVICES_API_KEY';
export const ABX_RPC_REMOTE_VAR = 'ABX_RPC_REMOTE';

export interface CreatorRpcRemote {
  url: string;
  token?: string;
}

/** An explicit provider selection wins; otherwise the first-party catalog is the zero-config
 * default only when its account key is present. The catalog is a provider choice, not an RPC URL. */
export function creatorRpcRemoteSpec(env: NodeJS.ProcessEnv = process.env): string | null {
  const selected = env[ABX_RPC_REMOTE_VAR]?.trim();
  if (selected) return selected;
  return env[ABX_SERVICES_API_KEY_VAR]?.trim() ? 'abx' : null;
}

/**
 * Discover and install one remote's authenticated creator RPC. The provider catalog is the trust
 * root: an unadvertised interface, chain, auth scheme, or route is never guessed. Public defaults
 * remain failovers, and the bearer header is scoped to the resolved URL so it cannot follow them.
 */
export async function configureCreatorRpcFromRemote(
  chainKey: string,
  remote: CreatorRpcRemote,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const token = remote.token?.trim();
  if (!token || env[rpcEnvVar(chainKey)]?.trim() || env.ABX_RPC_URLS?.trim()) return null;
  const chainId = resolveChain(chainKey).id;
  const descriptor = await new AbxServiceClient({baseUrl: remote.url, timeoutMs: 3_000}).descriptor();
  const endpoint = resolveServiceInterfaceEndpoint(remote.url, descriptor, CREATOR_RPC_INTERFACE);
  if (!endpoint || endpoint.auth !== 'bearer' || !endpoint.chains.includes(chainId)) return null;
  const route = resolveServiceInterfaceUrl(remote.url, descriptor, CREATOR_RPC_INTERFACE, {chainId});
  if (!route) return null;
  configureRuntimeRpcEndpoint(chainKey, {
    url: route.url,
    headers: {authorization: `Bearer ${token}`},
  });
  return route.url;
}
