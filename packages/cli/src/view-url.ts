import {AbxServiceClient, AbxServiceError, discoveredLiveViewUrl, resolveServiceInterfaceEndpoint, TOKEN_API_INTERFACE, type ServiceDescriptor} from '@artblocks/abx-sdk';
import {resolveBaseUrl} from '@artblocks/abx-token-api';
import {resolveRemote} from './remote.js';
import type {Flags} from './flags.js';

export interface ViewerSurface {baseUrl: string; content?: ServiceDescriptor['content']}

function servingBase(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('viewer base must be an HTTP(S) serving URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

/** One public descriptor lookup per operation, never per token. No credentials are transmitted. */
export async function viewerSurface(flags: Flags): Promise<ViewerSurface> {
  if (flags['base-url'] !== undefined) {
    if (flags.remote !== undefined) throw new Error('choose --base-url or --remote, not both');
    return {baseUrl: servingBase(flags['base-url'])};
  }
  const remote = resolveRemote(flags.remote);
  if (!remote) return {baseUrl: servingBase(resolveBaseUrl())};
  const catalog = servingBase(remote.url);
  let descriptor: ServiceDescriptor;
  try {descriptor = await new AbxServiceClient({baseUrl: catalog, timeoutMs: 3000, retryDelayMs: 100}).descriptor();}
  catch (error) {
    if (error instanceof AbxServiceError && error.status === 404) return {baseUrl: catalog};
    throw error;
  }
  const endpoint = resolveServiceInterfaceEndpoint(catalog, descriptor, TOKEN_API_INTERFACE);
  if (!endpoint) throw new Error('selected service does not advertise a token API');
  return {baseUrl: servingBase(endpoint.baseUrl), content: descriptor.content};
}

export function tokenViewerUrl(surface: ViewerSurface, chainId: number, contract: string, tokenId: string, code: boolean): string {
  if (!/^0x[0-9a-f]{40}$/i.test(contract)) throw new Error('viewer needs a contract address');
  if (!/^\d+$/.test(tokenId) || BigInt(tokenId) >= (1n << 256n)) throw new Error('viewer token ID must be a uint256');
  const key = {chainId, address: contract.toLowerCase(), tokenId: BigInt(tokenId).toString()};
  const base = servingBase(surface.baseUrl);
  return code ? discoveredLiveViewUrl(base, surface.content, key)
    : `${base}/t/${chainId}/${key.address}/${key.tokenId}/data/image`;
}
