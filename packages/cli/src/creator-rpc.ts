import {configureRuntimeRpcEndpoint, resolveChain, rpcEnvVar} from '@artblocks/abx-sdk';

export const ABX_SERVICES_URL = 'https://services.abx.io';
export const ABX_SERVICES_API_KEY_VAR = 'ABX_SERVICES_API_KEY';

/**
 * Prefer the first-party creator RPC only when its account key is present and the creator has not
 * made an explicit RPC choice. Public defaults remain failovers, and the bearer header is scoped
 * to this exact URL so it cannot reach them.
 */
export function configureFirstPartyCreatorRpc(
  chainKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env[ABX_SERVICES_API_KEY_VAR]?.trim();
  if (!token || env[rpcEnvVar(chainKey)]?.trim() || env.ABX_RPC_URLS?.trim()) return null;
  const url = `${ABX_SERVICES_URL}/v1/rpc/${resolveChain(chainKey).id}`;
  configureRuntimeRpcEndpoint(chainKey, {
    url,
    headers: {authorization: `Bearer ${token}`},
  });
  return url;
}
