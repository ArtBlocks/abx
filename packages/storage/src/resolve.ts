import {LocalFsBackend} from './fs.js';
import {CloudStorageBackend, cloudConfigFromEnv, type CloudStorageConfig} from './cloud.js';
import {IpfsBackend, ipfsConfigFromEnv, type IpfsConfig} from './ipfs.js';
import {ArweaveBackend, arweaveConfigFromEnv, type ArweaveConfig} from './arweave.js';
import type {StorageBackend} from './backend.js';

export interface ResolveStorageOptions {
  /** Backend id; defaults to `ABX_STORAGE_BACKEND`, then `fs`. */
  backend?: string;
  /** Data directory for the `fs` backend and the `ipfs` content index. */
  dataDir?: string;
  /** Full cloud config (the CLI merges non-secret config + env secrets). Falls back to env. */
  cloud?: CloudStorageConfig;
  /** Full IPFS config (the CLI merges non-secret config + env secrets). Falls back to env. */
  ipfs?: IpfsConfig;
  /** Full Arweave config (the CLI merges non-secret config + env secrets). Falls back to env. */
  arweave?: ArweaveConfig;
}

function assertCloud(cfg: CloudStorageConfig): void {
  const missing = (['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `Cloud storage is missing ${missing.join(', ')}. Pass non-secret values as flags ` +
        `(\`--backend cloud --endpoint <url> --bucket <b> --region <r>\`) or set env vars ` +
        `(ABX_S3_ENDPOINT / ABX_S3_BUCKET / ABX_S3_REGION); credentials in .env (ABX_S3_ACCESS_KEY_ID / ABX_S3_SECRET_ACCESS_KEY).`,
    );
  }
}

/**
 * Pick a storage backend. Built backends: **`fs`** (local disk, zero-dep floor) ·
 * **`cloud`** / `s3` (S3-compatible: AWS S3, R2, B2, MinIO) · **`ipfs`** (self-hosted
 * Kubo node or managed Pinata). Each implements the same {@link StorageBackend}
 * interface, so the indexer and token API never change. Non-secret config is passed
 * in via `opts` (the CLI resolves it from flags → env → default); secrets come from env.
 * With no `opts`, every backend falls back to building entirely from env.
 *
 * `arweave` is pay-once permanent storage — retrieval dep-free via a gateway,
 * upload through an injectable bundler.
 */
export function resolveBackend(opts: ResolveStorageOptions = {}): StorageBackend {
  const id = opts.backend ?? process.env.ABX_STORAGE_BACKEND ?? 'fs';
  switch (id) {
    case 'fs':
      return new LocalFsBackend(opts.dataDir);
    case 'cloud':
    case 's3': {
      const cfg = opts.cloud ?? cloudConfigFromEnv();
      assertCloud(cfg);
      return new CloudStorageBackend(cfg);
    }
    case 'ipfs':
      return new IpfsBackend(opts.ipfs ?? ipfsConfigFromEnv(), opts.dataDir);
    case 'arweave':
      return new ArweaveBackend(opts.arweave ?? arweaveConfigFromEnv(), opts.dataDir);
    default:
      throw new Error(`Unknown storage backend '${id}'. Built: fs | cloud (alias s3) | ipfs | arweave.`);
  }
}
