import {decodeOnChainJson} from './served.js';

export const MARKETPLACE_COLLECTION_FIELDS = ['name', 'description', 'image', 'external_link', 'banner_image', 'featured_image'] as const;

export function validateCollectionMetadata(document: unknown) {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return {profile: 'marketplace' as const, valid: false, missing, invalid: ['document']};
  }
  for (const field of MARKETPLACE_COLLECTION_FIELDS) {
    const value = (document as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === '') {missing.push(field); continue;}
    if (typeof value !== 'string' || !value.trim()) {invalid.push(field); continue;}
    if (field === 'name' || field === 'description') continue;
    let valid = false;
    try {
      const url = new URL(value);
      valid = value.trim() === value && (field === 'external_link'
        ? ['http:', 'https:'].includes(url.protocol)
        : ['http:', 'https:', 'ipfs:', 'ar:'].includes(url.protocol) || /^data:image\//i.test(value));
    } catch { /* malformed URI */ }
    if (!valid) invalid.push(field);
  }
  return {profile: 'marketplace' as const, valid: !missing.length && !invalid.length, missing, invalid};
}

/** One bounded metadata read, never a token enumeration or reindex. */
export async function loadCollectionMetadata(uri: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const limit = 1024 * 1024;
  if (uri.length > limit * 2) throw new Error('collection metadata exceeds the 1 MiB read budget');
  const inline = decodeOnChainJson(uri);
  let body = inline;
  if (body === null) {
    if (!/^https?:\/\//i.test(uri)) throw new Error('collection metadata needs an explicit HTTP(S) gateway');
    const response = await fetchImpl(uri, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(10_000)});
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error('collection metadata is not reachable as HTTP(S) or inline JSON');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw new Error('collection metadata exceeds the 1 MiB read budget');
        chunks.push(chunk.value);
      }
    } finally {await reader.cancel().catch(() => {});}
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(body) > limit) throw new Error('collection metadata exceeds the 1 MiB read budget');
  const document: unknown = JSON.parse(body);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('collection metadata must be a JSON object');
  return document as Record<string, unknown>;
}
