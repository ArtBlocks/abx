import type {Hex} from 'viem';
import type {DirEntry, StorageBackend, StoredContent} from './backend.js';
import {ContentIndex} from './content-index.js';

/**
 * IPFS byte custody, two modes:
 *  - **`kubo`** — add + pin to an IPFS node you run (the Kubo HTTP API), retrieve
 *    via your gateway. Self-hosted, dep-free.
 *  - **`pinata`** — pin through a managed service (Pinata), retrieve via a gateway.
 *    Same shape for other pinning services.
 *
 * IPFS addresses by **CID**, but the toolkit keys content by its keccak256
 * commitment. Until a CID commitment is recorded on-chain, this backend keeps an
 * off-chain `keccak → {cid, contentType}` index next to the projection — localized
 * here, and removable the day the CID lives on-chain (the commitment extension
 * already allows multiple kinds).
 */
export interface IpfsConfig {
  mode: 'kubo' | 'pinata';
  /** Gateway base for retrieval, e.g. `http://127.0.0.1:8080` or `https://gateway.pinata.cloud`. */
  gateway: string;
  /** Kubo API base, e.g. `http://127.0.0.1:5001`. */
  apiUrl?: string;
  /** Pinata API base. Default `https://api.pinata.cloud`. */
  pinataEndpoint?: string;
  /** Pinata JWT — secret, from env, never persisted to config. */
  pinataJwt?: string;
}

const trim = (u: string): string => u.replace(/\/+$/, '');

export class IpfsBackend implements StorageBackend {
  readonly id = 'ipfs';
  private readonly index: ContentIndex;

  constructor(private readonly cfg: IpfsConfig, dataDir?: string) {
    this.index = new ContentIndex(dataDir);
  }

  async put(hash: Hex, content: StoredContent): Promise<void> {
    const cid = this.cfg.mode === 'pinata' ? await this.addPinata(content) : await this.addKubo(content);
    this.index.set(hash, {pointer: cid, contentType: content.contentType});
  }

  async get(hash: Hex): Promise<StoredContent | null> {
    const entry = this.index.get(hash);
    if (!entry) return null;
    const res = await fetch(`${trim(this.cfg.gateway)}/ipfs/${entry.pointer}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`IPFS gateway GET failed (${res.status})`);
    // Gateways don't reliably echo the original content type — use what we stored.
    return {bytes: new Uint8Array(await res.arrayBuffer()), contentType: entry.contentType};
  }

  async has(hash: Hex): Promise<boolean> {
    return this.index.has(hash);
  }

  /**
   * The **gateway HTTPS URL** for the pinned bytes (`<gateway>/ipfs/<cid>`) — the production-safe
   * form an NFT `image` needs, since browsers, wallets, and most marketplaces can't render a raw
   * `ipfs://<cid>`. The CID is content-addressed so the bytes are resolvable through *any* gateway
   * (and verifiable against the on-chain keccak256); we serve a concrete, reachable one. A pinning
   * service + a public gateway is therefore part of operating IPFS custody — a local gateway
   * (`127.0.0.1`/`localhost`) produces a URL only this machine can resolve. Null until pinned.
   */
  async locator(hash: Hex): Promise<string | null> {
    const entry = this.index.get(hash);
    return entry ? `${trim(this.cfg.gateway)}/ipfs/${entry.pointer}` : null;
  }

  /**
   * Pin a directory of files as ONE IPFS object and return its gateway base
   * (`<gateway>/ipfs/<dirCID>`), so `<base>/0.png` resolves. The CID is content-addressed →
   * gateway-agnostic integrity for the whole set. `kubo` recurses through a local node (below);
   * `pinata` pins through the managed service.
   */
  async putDirectory(entries: DirEntry[]): Promise<{base: string}> {
    if (this.cfg.mode !== 'pinata') {
      const cid = await this.addKuboDirectory(entries);
      return {base: `${trim(this.cfg.gateway)}/ipfs/${cid}`};
    }
    if (!this.cfg.pinataJwt) throw new Error('IPFS pinata mode needs PINATA_JWT');
    const fd = new FormData();
    // Each file is appended under a common wrapping folder; Pinata returns that folder's CID,
    // so the entries are addressable as `<gateway>/ipfs/<cid>/<name>`.
    for (const e of entries) {
      fd.append('file', new Blob([e.bytes], {type: e.contentType}), `abx/${e.name}`);
    }
    fd.append('pinataOptions', JSON.stringify({cidVersion: 1}));
    const res = await fetch(`${trim(this.cfg.pinataEndpoint ?? 'https://api.pinata.cloud')}/pinning/pinFileToIPFS`, {
      method: 'POST',
      headers: {authorization: `Bearer ${this.cfg.pinataJwt}`},
      body: fd,
    });
    if (!res.ok) throw new Error(`Pinata directory pin failed (${res.status}): ${await res.text()}`);
    const cid = ((await res.json()) as {IpfsHash?: string}).IpfsHash;
    if (!cid) throw new Error('Pinata directory pin returned no CID');
    return {base: `${trim(this.cfg.gateway)}/ipfs/${cid}`};
  }

  async health(): Promise<{ok: boolean; detail?: string}> {
    try {
      if (this.cfg.mode === 'pinata') {
        if (!this.cfg.pinataJwt) return {ok: false, detail: 'PINATA_JWT not set'};
        const res = await fetch(`${trim(this.cfg.pinataEndpoint ?? 'https://api.pinata.cloud')}/data/testAuthentication`, {
          headers: {authorization: `Bearer ${this.cfg.pinataJwt}`},
        });
        return {ok: res.ok, detail: res.ok ? `pinata auth ok · gateway ${this.cfg.gateway}` : `pinata auth failed (${res.status})`};
      }
      if (!this.cfg.apiUrl) return {ok: false, detail: 'kubo apiUrl not set'};
      const res = await fetch(`${trim(this.cfg.apiUrl)}/api/v0/version`, {method: 'POST'});
      return {ok: res.ok, detail: res.ok ? `kubo ${this.cfg.apiUrl} · gateway ${this.cfg.gateway}` : `kubo unreachable (${res.status})`};
    } catch (e) {
      return {ok: false, detail: (e as Error).message};
    }
  }

  private form(content: StoredContent): FormData {
    const fd = new FormData();
    fd.set('file', new Blob([content.bytes], {type: content.contentType}), 'content');
    return fd;
  }

  private async addKubo(content: StoredContent): Promise<string> {
    if (!this.cfg.apiUrl) throw new Error('IPFS kubo mode needs an apiUrl (e.g. http://127.0.0.1:5001)');
    const res = await fetch(`${trim(this.cfg.apiUrl)}/api/v0/add?pin=true&cid-version=1`, {method: 'POST', body: this.form(content)});
    if (!res.ok) throw new Error(`IPFS add failed (${res.status}): ${await res.text()}`);
    const last = (await res.text()).trim().split('\n').pop() ?? '';
    const cid = (JSON.parse(last) as {Hash?: string}).Hash;
    if (!cid) throw new Error('IPFS add returned no CID');
    return cid;
  }

  /**
   * Recursive directory add through a local Kubo node's `/api/v0/add`. Each entry is appended as
   * its own multipart part with a filename under a common `abx/` prefix — Kubo infers the
   * directory tree from the slash-separated filenames (the same trick the Pinata path above uses),
   * so `abx/index.html` lands at `index.html` under the returned root, not nested under a temp
   * wrapper name. `recursive=true` tells Kubo to accept and pin that multi-file tree rather than
   * erroring on more than one `file` part.
   *
   * Kubo streams one NDJSON object per added path, ending with the wrapping `abx` directory once
   * everything beneath it has landed — so that final line is the "the whole tree is in and
   * pinned" signal. A dropped connection, a killed node, or a mid-stream error object never
   * produces it, so anything short of a clean, fully-parsed stream ending in that line throws
   * rather than returning a CID for a partial upload.
   */
  private async addKuboDirectory(entries: DirEntry[]): Promise<string> {
    if (!this.cfg.apiUrl) throw new Error('IPFS kubo mode needs an apiUrl (e.g. http://127.0.0.1:5001)');
    const wrapName = 'abx';
    const fd = new FormData();
    for (const e of entries) {
      fd.append('file', new Blob([e.bytes], {type: e.contentType}), `${wrapName}/${e.name}`);
    }
    const res = await fetch(`${trim(this.cfg.apiUrl)}/api/v0/add?recursive=true&pin=true&cid-version=1`, {
      method: 'POST',
      body: fd,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`IPFS directory add failed (${res.status}): ${text}`);

    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) throw new Error('IPFS directory add returned no output');

    let root: string | undefined;
    for (const line of lines) {
      let obj: {Name?: string; Hash?: string; Type?: string; Message?: string};
      try {
        obj = JSON.parse(line);
      } catch {
        // A cut-off connection lands mid-object — surface that as a truncation, not a JSON bug.
        throw new Error(`IPFS directory add returned malformed output (truncated stream?): ${line}`);
      }
      // Kubo reports a failed file (e.g. it ran out of disk mid-add) as a JSON object on the same
      // stream instead of a non-2xx status, so a per-line check is the only way to catch it.
      if (obj.Type === 'error') throw new Error(`IPFS directory add failed mid-stream: ${obj.Message ?? line}`);
      if (obj.Name === wrapName && obj.Hash) root = obj.Hash;
    }
    if (!root) throw new Error('IPFS directory add stream ended without the wrapping directory CID (partial upload?)');
    return root;
  }

  private async addPinata(content: StoredContent): Promise<string> {
    if (!this.cfg.pinataJwt) throw new Error('IPFS pinata mode needs PINATA_JWT');
    const res = await fetch(`${trim(this.cfg.pinataEndpoint ?? 'https://api.pinata.cloud')}/pinning/pinFileToIPFS`, {
      method: 'POST',
      headers: {authorization: `Bearer ${this.cfg.pinataJwt}`},
      body: this.form(content),
    });
    if (!res.ok) throw new Error(`Pinata pin failed (${res.status}): ${await res.text()}`);
    const cid = (await res.json() as {IpfsHash?: string}).IpfsHash;
    if (!cid) throw new Error('Pinata pin returned no CID');
    return cid;
  }
}

/** Build an IPFS config from the environment (non-secret values; PINATA_JWT is the secret). */
export function ipfsConfigFromEnv(): IpfsConfig {
  const mode = (process.env.ABX_IPFS_MODE ?? (process.env.PINATA_JWT ? 'pinata' : 'kubo')) as 'kubo' | 'pinata';
  return {
    mode,
    gateway: process.env.ABX_IPFS_GATEWAY ?? (mode === 'pinata' ? 'https://gateway.pinata.cloud' : 'http://127.0.0.1:8080'),
    apiUrl: process.env.ABX_IPFS_API_URL ?? 'http://127.0.0.1:5001',
    pinataEndpoint: process.env.ABX_PINATA_ENDPOINT ?? 'https://api.pinata.cloud',
    pinataJwt: process.env.PINATA_JWT,
  };
}
