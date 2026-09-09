import {keccak256, type Hex} from 'viem';

/**
 * Byte custody for ABX content.
 *
 * The protocol's central asymmetry: **state replays from chain, but source
 * bytes do not.** A token's content commitment is an on-chain `keccak256` of the
 * bytes that *are* the work; this service holds those bytes and serves them.
 *
 * Content is **addressed by its commitment hash** — `put(hash, …)` stores under
 * the same `keccak256` the contract committed, and `get(hash)` returns it. So the
 * pointer lives on-chain (the commitment), storage stays off-chain, and the bytes
 * are both locatable (by hash) and verifiable (re-hash, compare) with no trust in
 * any server. Custody is *switchable, never lapsable*: move backends freely
 * (re-put, verify, drop the old), but never let the bytes go.
 */
export interface StoredContent {
  bytes: Uint8Array;
  /** MIME type, e.g. `image/png` — served back verbatim. */
  contentType: string;
}

/** One file in a directory upload — `name` is the path under the directory (e.g. `0.png`). */
export interface DirEntry {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface StorageBackend {
  /** Short backend id, e.g. `fs` · `s3` · `ipfs` · `arweave`. */
  readonly id: string;
  /** Store bytes under their commitment hash. Idempotent (content-addressed). */
  put(hash: Hex, content: StoredContent): Promise<void>;
  /** Fetch bytes previously stored under this hash, or null if this backend lacks them. */
  get(hash: Hex): Promise<StoredContent | null>;
  /** Whether this backend currently holds content for the hash. */
  has(hash: Hex): Promise<boolean>;
  /** Optional liveness + credentials check for `abx doctor`. */
  health?(): Promise<{ok: boolean; detail?: string}>;
  /**
   * Optional content-addressed locator for the hash — a gateway-agnostic URI a client can
   * resolve WITHOUT this server (e.g. `ipfs://<cid>`, `ar://<txid>`). Backends that only
   * serve bytes through this node (fs, cloud) omit it, and the resolver falls back to its
   * own `/…/image` URL. Lets the served metadata point the heavy asset straight at a
   * durable, peer-to-peer locator while the node serves only thin JSON.
   */
  locator?(hash: Hex): Promise<string | null>;
  /**
   * Optional: upload a whole directory of files in ONE shot and return the **gateway base URL**
   * for it (no trailing slash) — an IPFS directory CID (`<gateway>/ipfs/<cid>`) or an Arweave
   * path manifest (`<gateway>/<manifestTxid>`). A file named `0.png` is then reachable at
   * `<base>/0.png`. This is what powers the O(1) directory pattern: N files → one on-chain
   * `url-template` (`<base>/{id}.<ext>`), no per-token on-chain data. Content-addressed roots
   * (CID / manifest txid) give integrity without a per-file keccak anchor. Backends that serve
   * only through this node (fs, cloud) omit it.
   */
  putDirectory?(entries: DirEntry[]): Promise<{base: string}>;

  /**
   * The public READ base for this backend (no trailing slash) such that `<publicBase>/<key>`
   * fetches an object written by {@link putObject}, or undefined if objects are only reachable
   * through this node. Present only on **mutable, path-addressed** hosts (S3/R2/CDN) — the ones
   * that can serve a STABLE per-token URL an on-chain `url-template` names. Content-addressed
   * backends (ipfs/arweave) omit it: their locator changes with the bytes, so they can't back a
   * deterministic `/{id}` path without rewriting chain state on every update.
   */
  readonly publicBase?: string;

  /**
   * Optional: write bytes at a CALLER-CHOSEN key (NOT content-addressed), overwriting in place.
   * This is the deterministic-thumbnail primitive: the effect runner writes token N's still to the
   * exact key an on-chain `image` `url-template` points at (`<publicBase>/<key>`), overwriting on
   * re-render — so the on-chain pointer is stable while the pixels update, with no chain write and
   * no metadata resolver. Only mutable path-addressed backends (cloud) implement it.
   */
  putObject?(key: string, content: StoredContent): Promise<void>;

  /** Optional: read bytes previously written by {@link putObject} at `key`, or null if absent. */
  getObject?(key: string): Promise<StoredContent | null>;
}

/** keccak256 of arbitrary content bytes — the value committed on-chain (the image `keccak256` field). */
export function hashContent(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

// `contentTypeFromPath` lives in `@artblocks/abx-sdk` (src/mime.ts) and is re-exported from
// `./index.ts` unchanged, so this package's public API stays
// identical.
export {contentTypeFromPath} from '@artblocks/abx-sdk';
