import {createHash} from 'node:crypto';
import {AsyncEntry} from '@napi-rs/keyring';

export interface StoredCreatorAuthorization {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface CreatorAuthorizationStore {
  load(): Promise<StoredCreatorAuthorization | null>;
  save(tokens: StoredCreatorAuthorization): Promise<void>;
  clear(): Promise<void>;
}

interface KeyringEntry {
  getPassword(signal?: AbortSignal): Promise<string | undefined>;
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

const SERVICE = 'io.abx.cli.creator-wallet';
const timeout = () => AbortSignal.timeout(15_000);

function secret(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new Error('invalid_creator_authorization');
  return value;
}

function decode(raw: string): StoredCreatorAuthorization {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid_creator_authorization');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_creator_authorization');
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) <= 0) {
    throw new Error('invalid_creator_authorization');
  }
  return {
    accessToken: secret(row.accessToken),
    refreshToken: secret(row.refreshToken),
    expiresAt: Number(row.expiresAt),
  };
}

/** Native per-user credential storage: Keychain on macOS, Credential Manager on Windows, and
 * Secret Service/keyutils on Linux. The refresh credential is never written to project files. */
export class CreatorKeyringStore implements CreatorAuthorizationStore {
  readonly #entry: KeyringEntry;

  constructor(appId: string, walletAddress: string, entry?: KeyringEntry) {
    const identity = createHash('sha256').update(`${appId}:${walletAddress.toLowerCase()}`).digest('hex');
    this.#entry = entry ?? new AsyncEntry(SERVICE, identity);
  }

  async load(): Promise<StoredCreatorAuthorization | null> {
    const raw = await this.#entry.getPassword(timeout());
    if (raw === undefined) return null;
    try {
      return decode(raw);
    } catch {
      await this.#entry.deleteCredential(timeout());
      return null;
    }
  }

  async save(tokens: StoredCreatorAuthorization): Promise<void> {
    await this.#entry.setPassword(JSON.stringify({version: 1, ...tokens}), timeout());
  }

  async clear(): Promise<void> {
    await this.#entry.deleteCredential(timeout());
  }
}
