import {createHash, createHmac} from 'node:crypto';
import type {Hex} from 'viem';
import type {DirEntry, StorageBackend, StoredContent} from './backend.js';

/**
 * S3-compatible **cloud** object storage — one adapter for AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO, and anything else that speaks the S3 API. It signs plain
 * `fetch` requests with AWS Signature V4 using only `node:crypto`, so it adds
 * **zero dependencies** (no AWS SDK, no native module) — the toolkit's minimal-deps
 * ethos, kept. Content is stored path-style and addressed by its commitment hash.
 */
export interface CloudStorageConfig {
  /** S3 endpoint origin, e.g. `https://<acct>.r2.cloudflarestorage.com` or `https://s3.us-east-1.amazonaws.com`. */
  endpoint: string;
  bucket: string;
  /** `auto` for R2; the bucket's region for AWS (e.g. `us-east-1`). */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix for stored objects. Default `abx/content/`. */
  prefix?: string;
  /** SigV4 service name. Default `s3`. */
  service?: string;
  /**
   * Public READ base for objects — distinct from the signed-API `endpoint`. The bucket's
   * public URL or a CDN in front of it (e.g. `https://<bucket>.s3.<region>.amazonaws.com`,
   * `https://s3.<region>.amazonaws.com/<bucket>`, or `https://cdn.you.xyz`), such that
   * `<publicBase>/<key>` fetches the object. Required to bake direct object URLs on-chain
   * (the `url`/`url-template` image patterns) or to serve images off this node's `/image` route.
   * Unset → node-served only (the resolver serves via `get()`); no direct URLs.
   */
  publicBase?: string;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** The AWS SigV4 signing key: an HMAC chain over date → region → service. */
export function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** RFC-3986 encode one path segment (encodeURIComponent leaves `!'()*` alone). */
function rfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodePath(path: string): string {
  return path.split('/').map(rfc3986).join('/');
}

export interface SigV4Input {
  method: string;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
  dateStamp: string; // YYYYMMDD
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Compute an AWS Signature V4 authorization for a request. Pure and deterministic
 * (date is an input), so it verifies against AWS's published test vectors.
 */
export function sigv4Signature(p: SigV4Input): {authorization: string; signature: string; signedHeaders: string} {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [p.method, p.canonicalUri, p.canonicalQuery, canonicalHeaders, signedHeaders, p.payloadHash].join('\n');
  const scope = `${p.dateStamp}/${p.region}/${p.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', p.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', deriveSigningKey(p.secretAccessKey, p.dateStamp, p.region, p.service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    signedHeaders,
  };
}

export class CloudStorageBackend implements StorageBackend {
  readonly id = 'cloud';
  /** The public READ base (`<publicBase>/<key>`), when configured — see {@link StorageBackend.publicBase}. */
  readonly publicBase?: string;
  private readonly origin: string;
  private readonly prefix: string;
  private readonly service: string;

  constructor(private readonly cfg: CloudStorageConfig) {
    this.origin = cfg.endpoint.replace(/\/+$/, '');
    this.prefix = cfg.prefix ?? 'abx/content/';
    this.service = cfg.service ?? 's3';
    this.publicBase = cfg.publicBase ? cfg.publicBase.replace(/\/+$/, '') : undefined;
  }

  private key(hash: Hex): string {
    return `${this.prefix}${hash.toLowerCase().replace(/^0x/, '')}`;
  }

  private send(method: string, hash: Hex, body?: Uint8Array, contentType?: string): Promise<Response> {
    return this.sendKey(method, this.key(hash), body, contentType);
  }

  /** Signed S3 request against an arbitrary object key (the key-based core of {@link send}). */
  private async sendKey(method: string, key: string, body?: Uint8Array, contentType?: string): Promise<Response> {
    const path = `/${this.cfg.bucket}/${key}`;
    const url = `${this.origin}${path}`;
    const host = new URL(url).host;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;

    const signHeaders: Record<string, string> = {host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate};
    if (contentType) signHeaders['content-type'] = contentType;

    const {authorization} = sigv4Signature({
      method,
      canonicalUri: encodePath(path),
      canonicalQuery: '',
      headers: signHeaders,
      payloadHash,
      amzDate,
      dateStamp,
      region: this.cfg.region,
      service: this.service,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
    });

    // `host` is managed by fetch; the rest must match what we signed.
    const headers: Record<string, string> = {authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate};
    if (contentType) headers['content-type'] = contentType;
    return fetch(url, {method, headers, body});
  }

  async put(hash: Hex, content: StoredContent): Promise<void> {
    const res = await this.send('PUT', hash, content.bytes, content.contentType);
    if (!res.ok) throw new Error(`Cloud storage PUT failed (${res.status}): ${await res.text()}`);
  }

  async get(hash: Hex): Promise<StoredContent | null> {
    const res = await this.send('GET', hash);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Cloud storage GET failed (${res.status}): ${await res.text()}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream'};
  }

  async has(hash: Hex): Promise<boolean> {
    const res = await this.send('HEAD', hash);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Cloud storage HEAD failed (${res.status})`);
    return true;
  }

  /**
   * The public READ URL for the object (`<publicBase>/<key>`), or null if no public base is
   * configured (then the resolver serves the bytes through its own `/image` route). Note: S3 is
   * NOT content-addressed, so this URL has no on-chain integrity anchor of its own — the on-chain
   * keccak256 remains the anchor (verify any served bytes against it).
   */
  async locator(hash: Hex): Promise<string | null> {
    return this.publicBase ? `${this.publicBase}/${this.key(hash)}` : null;
  }

  /**
   * Write bytes at an EXACT key (not content-addressed), overwriting in place — the
   * deterministic-thumbnail primitive. `key` is the object path relative to the bucket root
   * (and to {@link publicBase}), e.g. `orbit-weave/0.png`, so `<publicBase>/<key>` is the stable
   * URL an on-chain `url-template` names. No `prefix` is prepended: the key IS the public path,
   * fully determined by what was baked on-chain.
   */
  async putObject(key: string, content: StoredContent): Promise<void> {
    const res = await this.sendKey('PUT', key.replace(/^\/+/, ''), content.bytes, content.contentType);
    if (!res.ok) throw new Error(`Cloud storage PUT (${key}) failed (${res.status}): ${await res.text()}`);
  }

  /** Read bytes previously written by {@link putObject} at `key`, or null (404). */
  async getObject(key: string): Promise<StoredContent | null> {
    const res = await this.sendKey('GET', key.replace(/^\/+/, ''));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Cloud storage GET (${key}) failed (${res.status}): ${await res.text()}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream'};
  }

  /**
   * Upload a directory of files under a content-derived prefix and return its public base
   * (`<publicBase>/<dirPrefix>`), so `<base>/0.png` resolves — the S3 form of the O(1) directory
   * pattern (one on-chain `url-template`). The prefix is a hash of the (name, bytes) set, so the
   * same inputs re-upload to the same location (idempotent) and distinct collections never collide.
   */
  async putDirectory(entries: DirEntry[]): Promise<{base: string}> {
    if (!this.cfg.publicBase) {
      throw new Error(
        'cloud directory upload needs a public read base — set ABX_S3_PUBLIC_BASE (or --public-base) to your ' +
          'bucket public URL / CDN, e.g. https://<bucket>.s3.<region>.amazonaws.com or https://cdn.you.xyz. ' +
          "It's baked on-chain, so prefer a domain/CDN you control (moving it is then DNS, not a tx).",
      );
    }
    const dirHash = sha256Hex(entries.map((e) => `${e.name}:${sha256Hex(e.bytes)}`).join('|')).slice(0, 32);
    const dirPrefix = `${this.prefix}dir/${dirHash}`;
    for (const e of entries) {
      const res = await this.sendKey('PUT', `${dirPrefix}/${e.name}`, e.bytes, e.contentType);
      if (!res.ok) throw new Error(`Cloud storage directory PUT failed for ${e.name} (${res.status}): ${await res.text()}`);
    }
    return {base: `${this.cfg.publicBase.replace(/\/+$/, '')}/${dirPrefix}`};
  }

  async health(): Promise<{ok: boolean; detail?: string}> {
    // A signed read of a key that won't exist: 404 → endpoint reachable + credentials
    // accepted; a 401/403 → bad credentials; a network error → wrong endpoint.
    const probe = ('0x' + '00'.repeat(32)) as Hex;
    try {
      await this.get(probe);
      return {ok: true, detail: `${this.origin}/${this.cfg.bucket} (region ${this.cfg.region})`};
    } catch (e) {
      return {ok: false, detail: (e as Error).message};
    }
  }
}

/** Build a cloud-storage config from the environment (works for AWS S3, R2, B2, MinIO). */
export function cloudConfigFromEnv(): CloudStorageConfig {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Cloud storage backend needs ${k} (set ABX_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY).`);
    return v;
  };
  return {
    endpoint: need('ABX_S3_ENDPOINT'),
    bucket: need('ABX_S3_BUCKET'),
    region: process.env.ABX_S3_REGION ?? 'auto',
    accessKeyId: need('ABX_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('ABX_S3_SECRET_ACCESS_KEY'),
    prefix: process.env.ABX_S3_PREFIX ?? 'abx/content/',
    service: 's3',
    publicBase: process.env.ABX_S3_PUBLIC_BASE,
  };
}
