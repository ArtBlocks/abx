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
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

const SERVICE = 'io.abx.cli.creator-wallet';
const timeout = () => AbortSignal.timeout(15_000);

export class CreatorCredentialStoreAccessError extends Error {
  constructor() {
    super(
      'Could not read the saved ABX creator-wallet authorization from the OS credential store. ' +
      'ABX stopped before signing or starting another agent grant. ' +
      'If you denied the Keychain prompt, retry only when you intend to allow this Node installation access.',
    );
    this.name = 'CreatorCredentialStoreAccessError';
  }
}

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
  #entry?: KeyringEntry;
  readonly #identity: string;

  constructor(appId: string, walletAddress: string, entry?: KeyringEntry) {
    this.#identity = createHash('sha256').update(`${appId}:${walletAddress.toLowerCase()}`).digest('hex');
    this.#entry = entry;
  }

  #credential(): KeyringEntry {
    return this.#entry ??= new AsyncEntry(SERVICE, this.#identity);
  }

  async load(): Promise<StoredCreatorAuthorization | null> {
    let raw: string | null | undefined;
    try {
      raw = await this.#credential().getPassword(timeout());
    } catch {
      throw new CreatorCredentialStoreAccessError();
    }
    if (raw === undefined || raw === null) return null;
    try {
      return decode(raw);
    } catch {
      await this.#credential().deleteCredential(timeout());
      return null;
    }
  }

  async save(tokens: StoredCreatorAuthorization): Promise<void> {
    await this.#credential().setPassword(JSON.stringify({version: 1, ...tokens}), timeout());
  }

  async clear(): Promise<void> {
    await this.#credential().deleteCredential(timeout());
  }
}
