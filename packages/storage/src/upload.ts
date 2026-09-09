/**
 * `abx storage upload` core — upload ONE file and return a public locator that PRESERVES the
 * filename, so the declared mimeType survives when the locator is later attached (`abx attach`).
 * The on-chain metadata field has no MIME slot: the URL extension IS the type declaration, so a
 * bare content-addressed locator (`ar://<txid>`, `<gw>/ipfs/<cid>`) — which has no extension —
 * would make the attached artifact `application/octet-stream`. Extracted from main.ts so the
 * capability-based branch (the exact bug this guards) is unit-testable with fake backends.
 */
import type {StorageBackend, StoredContent} from './backend.js';
import {hashContent} from './backend.js';

export interface UploadResult {
  /** A fetchable public URL for the file. */
  locator: string;
  /** True when `locator` carries the filename (extension → correct declared type on attach). */
  filenamePreserved: boolean;
  /** Set when we had to fall back to a bare (extension-less) locator — the caller warns. */
  fallbackReason?: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * Store `content` under `name` and return the best available public locator. Preference order:
 *  1. path-addressed host (cloud/S3/R2): the object key IS the filename → `<publicBase>/<name>`.
 *  2. content-addressed host with directory support (ipfs/arweave): wrap the single file in a
 *     one-entry directory → `<base>/<name>` (filename preserved).
 *  3. bare content-addressed locator (e.g. kubo IPFS with no dir-add): `<gw>/ipfs/<cid>` — no
 *     extension; `filenamePreserved: false` so the caller can warn about the octet-stream type.
 * Throws for a backend that can't produce any public URL (e.g. `fs`).
 */
export async function uploadAndLocate(backend: StorageBackend, name: string, content: StoredContent): Promise<UploadResult> {
  if (backend.publicBase && backend.putObject) {
    await backend.putObject(name, content);
    return {locator: `${trimSlash(backend.publicBase)}/${name}`, filenamePreserved: true};
  }
  if (backend.putDirectory && backend.locator) {
    try {
      const {base} = await backend.putDirectory([{name, bytes: content.bytes, contentType: content.contentType}]);
      return {locator: `${trimSlash(base)}/${name}`, filenamePreserved: true};
    } catch (e) {
      const hash = hashContent(content.bytes);
      await backend.put(hash, content);
      const loc = await backend.locator(hash);
      if (!loc) throw e;
      return {locator: loc, filenamePreserved: false, fallbackReason: (e as Error).message};
    }
  }
  if (backend.locator) {
    const hash = hashContent(content.bytes);
    await backend.put(hash, content);
    const loc = await backend.locator(hash);
    if (!loc) throw new Error(`backend '${backend.id}' stored the file but returned no durable locator`);
    return {locator: loc, filenamePreserved: false};
  }
  throw new Error(`backend '${backend.id}' can't produce a public URL for an attached file — use ipfs, arweave, or cloud (with a public base).`);
}
