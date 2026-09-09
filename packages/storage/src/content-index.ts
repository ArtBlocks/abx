import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Hex} from 'viem';
import {resolveDataDir} from '@artblocks/abx-sdk/node';

/**
 * The off-chain `keccak → pointer` index used by backends whose native content id
 * isn't the commitment hash (IPFS CID, Arweave txid). It's the necessary bridge
 * until a pointer commitment is recorded on-chain — small JSON next to the
 * projection, and removable the day the pointer lives on-chain.
 */
export interface IndexEntry {
  /** The backend's native id for the content — an IPFS CID or an Arweave txid. */
  pointer: string;
  contentType: string;
}

export class ContentIndex {
  readonly path: string;
  private data: Record<string, IndexEntry>;

  constructor(dataDir?: string) {
    // Centralized in the SDK — see resolveDataDir's doc comment.
    const base = dataDir ?? resolveDataDir().dir;
    mkdirSync(base, {recursive: true});
    this.path = resolve(base, 'content-index.json');
    this.data = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, IndexEntry>) : {};
  }

  private key(hash: Hex): string {
    return hash.toLowerCase();
  }

  get(hash: Hex): IndexEntry | null {
    return this.data[this.key(hash)] ?? null;
  }

  has(hash: Hex): boolean {
    return this.key(hash) in this.data;
  }

  set(hash: Hex, entry: IndexEntry): void {
    this.data[this.key(hash)] = entry;
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}
