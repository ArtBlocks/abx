import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {Hex} from 'viem';
import {resolveDataDir} from '@artblocks/abx-sdk/node';
import type {StorageBackend, StoredContent} from './backend.js';

/**
 * The reference backend: content-addressed files on the local disk — "store the
 * bytes on your droplet and serve them." Zero dependencies, the natural floor for
 * a self-hoster. Bytes live at `<dataDir>/content/<hash>`, with the MIME type in a
 * sidecar so `get` can replay it. Deleting the directory loses the content (it is
 * the source of truth) — exactly why custody is switchable but never lapsable.
 */
export class LocalFsBackend implements StorageBackend {
  readonly id = 'fs';
  readonly dir: string;

  constructor(dataDir?: string) {
    // Centralized in the SDK — see resolveDataDir's doc comment.
    const base = dataDir ?? resolveDataDir().dir;
    this.dir = resolve(base, 'content');
    mkdirSync(this.dir, {recursive: true});
  }

  private path(hash: Hex): string {
    return join(this.dir, hash.toLowerCase().replace(/^0x/, ''));
  }

  async put(hash: Hex, content: StoredContent): Promise<void> {
    writeFileSync(this.path(hash), content.bytes);
    writeFileSync(this.path(hash) + '.type', content.contentType, 'utf8');
  }

  async get(hash: Hex): Promise<StoredContent | null> {
    const p = this.path(hash);
    if (!existsSync(p)) return null;
    const bytes = new Uint8Array(readFileSync(p));
    const typePath = p + '.type';
    const contentType = existsSync(typePath) ? readFileSync(typePath, 'utf8') : 'application/octet-stream';
    return {bytes, contentType};
  }

  async has(hash: Hex): Promise<boolean> {
    return existsSync(this.path(hash));
  }

  async health(): Promise<{ok: boolean; detail?: string}> {
    try {
      const probe = join(this.dir, '.probe');
      writeFileSync(probe, 'ok');
      readFileSync(probe);
      rmSync(probe);
      return {ok: true, detail: `writable: ${this.dir}`};
    } catch (e) {
      return {ok: false, detail: (e as Error).message};
    }
  }
}
