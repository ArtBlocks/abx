/**
 * The storage half of a resolver migration: re-pinning node-custody images to a durable backend.
 *
 * The rest of the migration — reconciling a destination resolver's off-chain state against a
 * source resolver's served JSON (`buildMigrationPlan`/`verifyParity`) — is pure fetch-based
 * reconciliation with no storage dependency, so it lives in `@artblocks/abx-sdk`'s `migrate.ts`.
 * This module is the one piece that needs an actual byte-custody backend: turning a
 * {@link NodeCustodyImage} (bytes that live only on the soon-to-be-decommissioned source host)
 * into a portable, durable locator.
 */
import {hashContent, type StorageBackend} from './backend.js';
import type {NodeCustodyImage} from '@artblocks/abx-sdk';
import type {Hex} from 'viem';

/**
 * Re-pin node-custody images to a DURABLE backend so the destination never depends on the
 * (soon-to-be-decommissioned) source host. For each image: fetch the bytes from the source,
 * **verify** them against the on-chain hash (trustless — we trust the chain, not the old node),
 * then `put` them to the destination operator's own backend and read back a portable locator.
 *
 * If the configured backend isn't durable (no `locator` — fs/cloud serve only through their own
 * node, so re-pinning there just moves the single-host dependency), we re-pin NOTHING and report
 * every image as `needsDurableBackend`: the right move is to configure IPFS/Arweave and re-run,
 * never to bridge a URL that points back at the dying host.
 */
export interface RepinResult {
  /** hash → new durable locator, ready to bridge to the destination. */
  repinned: Record<string, string>;
  /** Re-pinned token ids (for reporting). */
  repinnedTokens: string[];
  /** Bytes fetched but their hash didn't match the on-chain commitment — NOT trusted, NOT pinned. */
  mismatched: NodeCustodyImage[];
  /** Couldn't fetch the bytes from the source (host down, 404). */
  unreachable: NodeCustodyImage[];
  /** Skipped because no durable backend is configured — these need IPFS/Arweave + a re-run. */
  needsDurableBackend: NodeCustodyImage[];
}

export async function repinNodeCustody(images: NodeCustodyImage[], backend: StorageBackend): Promise<RepinResult> {
  const result: RepinResult = {repinned: {}, repinnedTokens: [], mismatched: [], unreachable: [], needsDurableBackend: []};
  if (!images.length) return result;

  // A backend is "durable" for migration iff it can hand back a node-independent locator.
  if (!backend.locator) {
    result.needsDurableBackend = [...images];
    return result;
  }

  for (const img of images) {
    let bytes: Uint8Array;
    let contentType: string;
    try {
      const resp = await fetch(img.imageUrl);
      if (!resp.ok) {
        result.unreachable.push(img);
        continue;
      }
      bytes = new Uint8Array(await resp.arrayBuffer());
      contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
    } catch {
      result.unreachable.push(img);
      continue;
    }
    // Trustless: re-hash the fetched bytes and compare to the ON-CHAIN commitment.
    if (hashContent(bytes).toLowerCase() !== img.hash.toLowerCase()) {
      result.mismatched.push(img);
      continue;
    }
    await backend.put(img.hash as Hex, {bytes, contentType});
    const loc = await backend.locator(img.hash as Hex);
    if (loc) {
      result.repinned[img.hash.toLowerCase()] = loc;
      result.repinnedTokens.push(img.tokenId);
    } else {
      // Stored, but the backend still can't produce a portable locator — treat as not durable.
      result.needsDurableBackend.push(img);
    }
  }
  return result;
}
