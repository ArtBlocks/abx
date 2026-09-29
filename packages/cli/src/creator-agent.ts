import {Chacha20Poly1305} from '@hpke/chacha20poly1305';
import {CipherSuite, DhkemP256HkdfSha256, HkdfSha256} from '@hpke/core';
import {generateAuthorizationSignature} from '@privy-io/node';
import type {CreatorAuthorizationStore, StoredCreatorAuthorization} from './creator-keyring.js';

const OAUTH = 'https://auth.privy.io/api/oauth/v2';
const WALLET_API = 'https://api.privy.io/v1/wallets';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const PROVIDER_ERRORS = new Set([
  'access_denied',
  'authorization_pending',
  'device_auth_not_enabled',
  'expired_token',
  'invalid_grant',
  'slow_down',
]);

export class CreatorAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(`Creator wallet authorization: ${code}`);
    this.name = 'CreatorAuthorizationError';
  }
}

export interface CreatorDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

export interface AuthorizedCreatorWallet {
  id: string;
  address: string;
  chainType: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CreatorAuthorizationError('invalid_response');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new CreatorAuthorizationError('invalid_response');
  return value;
}

function verificationUrl(value: unknown): string {
  const raw = string(value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CreatorAuthorizationError('invalid_verification_url');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) {
    throw new CreatorAuthorizationError('invalid_verification_url');
  }
  return parsed.toString();
}

function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 86_400) {
    throw new CreatorAuthorizationError('invalid_response');
  }
  return value * 1_000;
}

function base64(value: unknown): Uint8Array {
  const encoded = string(value);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new CreatorAuthorizationError('invalid_response');
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

/** Privy device grant client. Refresh credentials may be retained in a native OS credential store;
 * decrypted request-signing keys remain memory-only and die with this instance. */
export class CreatorAgentAuthorization {
  readonly #appId: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #store?: CreatorAuthorizationStore;
  readonly #onPersistenceError?: () => void;
  #device?: {code: string; expiresAt: number; interval: number};
  #tokens?: StoredCreatorAuthorization;
  #authorizationKey?: string;
  #keyExpiresAt = 0;
  #wallets: AuthorizedCreatorWallet[] = [];
  #persist = false;
  #refreshing?: Promise<void>;
  #authenticating?: Promise<void>;

  constructor(options: {
    appId: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    store?: CreatorAuthorizationStore;
    onPersistenceError?: () => void;
  }) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.appId)) throw new CreatorAuthorizationError('invalid_app_id');
    this.#appId = options.appId;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#store = options.store;
    this.#onPersistenceError = options.onPersistenceError;
  }

  async #request(path: string, body: object, token?: string): Promise<{response: Response; data: Record<string, unknown>}> {
    try {
      const response = await this.#fetch(`${OAUTH}/${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'content-type': 'application/json',
          'privy-app-id': this.#appId,
          ...(token ? {authorization: `Bearer ${token}`, 'privy-grant-type': 'device_code'} : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (text.length > 65_536) throw new CreatorAuthorizationError('invalid_response');
      return {response, data: object(JSON.parse(text))};
    } catch (error) {
      if (error instanceof CreatorAuthorizationError) throw error;
      throw new CreatorAuthorizationError('request_failed');
    }
  }

  #providerError(response: Response, data: Record<string, unknown>): CreatorAuthorizationError {
    if (data.error === 'Device authorization is not enabled for this app') {
      return new CreatorAuthorizationError('device_auth_not_enabled');
    }
    const code = typeof data.error === 'string' && PROVIDER_ERRORS.has(data.error) ? data.error : 'provider_error';
    return new CreatorAuthorizationError(code);
  }

  #parseTokens(data: Record<string, unknown>, startedAt: number): StoredCreatorAuthorization {
    if (data.token_type !== 'Bearer') throw new CreatorAuthorizationError('invalid_response');
    return {
      accessToken: string(data.access_token),
      refreshToken: string(data.refresh_token),
      expiresAt: startedAt + seconds(data.expires_in),
    };
  }

  async start(): Promise<CreatorDeviceAuthorization> {
    if (this.#device) throw new CreatorAuthorizationError('already_started');
    const {response, data} = await this.#request('device_authorization', {});
    if (!response.ok) throw this.#providerError(response, data);
    const expiresAt = this.#now() + seconds(data.expires_in);
    this.#device = {
      code: string(data.device_code),
      expiresAt,
      interval: data.interval === undefined ? 5_000 : seconds(data.interval),
    };
    return {
      userCode: string(data.user_code),
      verificationUri: verificationUrl(data.verification_uri),
      ...(data.verification_uri_complete ? {verificationUriComplete: verificationUrl(data.verification_uri_complete)} : {}),
    };
  }

  async wait(): Promise<AuthorizedCreatorWallet[]> {
    const device = this.#device;
    if (!device) throw new CreatorAuthorizationError('not_started');
    for (;;) {
      const remaining = device.expiresAt - this.#now();
      if (remaining <= 0) throw new CreatorAuthorizationError('expired_token');
      await new Promise((resolve) => setTimeout(resolve, Math.min(device.interval, remaining)));
      const startedAt = this.#now();
      const {response, data} = await this.#request('token', {grant_type: DEVICE_GRANT, device_code: device.code});
      if (response.ok) {
        this.#tokens = this.#parseTokens(data, startedAt);
        await this.#authenticate();
        this.#device = undefined;
        return this.#wallets.map((wallet) => ({...wallet}));
      }
      const error = this.#providerError(response, data);
      if (response.status === 400 && (error.code === 'authorization_pending' || error.code === 'slow_down')) {
        if (error.code === 'slow_down') device.interval += 5_000;
        continue;
      }
      throw error;
    }
  }

  /** Resume a prior Privy grant. Returns null when no usable credential remains. */
  async restore(): Promise<AuthorizedCreatorWallet[] | null> {
    if (!this.#store) return null;
    const stored = await this.#store.load();
    if (!stored) return null;
    this.#tokens = stored;
    this.#persist = true;
    try {
      await this.#authenticate();
      return this.#wallets.map((wallet) => ({...wallet}));
    } catch (error) {
      if (
        error instanceof CreatorAuthorizationError &&
        ['access_denied', 'expired_token', 'invalid_grant', 'login_required'].includes(error.code)
      ) {
        await this.#clearStored();
        return null;
      }
      throw error;
    }
  }

  /** Persist a newly approved grant after the caller verifies that Privy returned the expected wallet. */
  async remember(): Promise<void> {
    if (!this.#store || !this.#tokens) return;
    await this.#store.save(this.#tokens);
    this.#persist = true;
  }

  async #saveRotatedTokens(): Promise<void> {
    if (!this.#persist || !this.#store || !this.#tokens) return;
    try {
      await this.#store.save(this.#tokens);
    } catch {
      this.#persist = false;
      this.#onPersistenceError?.();
    }
  }

  async #clearStored(): Promise<void> {
    this.#tokens = undefined;
    this.#authorizationKey = undefined;
    this.#keyExpiresAt = 0;
    this.#wallets = [];
    this.#persist = false;
    if (!this.#store) return;
    try {
      await this.#store.clear();
    } catch {
      this.#onPersistenceError?.();
    }
  }

  async #refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    if (!this.#tokens) throw new CreatorAuthorizationError('login_required');
    const previous = this.#tokens;
    const refreshToken = this.#tokens.refreshToken;
    this.#refreshing = (async () => {
      this.#tokens = undefined;
      this.#authorizationKey = undefined;
      this.#keyExpiresAt = 0;
      this.#wallets = [];
      const startedAt = this.#now();
      try {
        const {response, data} = await this.#request('token', {grant_type: 'refresh_token', refresh_token: refreshToken});
        if (!response.ok) throw this.#providerError(response, data);
        this.#tokens = this.#parseTokens(data, startedAt);
        await this.#saveRotatedTokens();
      } catch (error) {
        if (
          error instanceof CreatorAuthorizationError &&
          ['access_denied', 'expired_token', 'invalid_grant'].includes(error.code)
        ) {
          await this.#clearStored();
        } else {
          // Preserve the last durable grant after a transient failure. If Privy accepted an
          // ambiguous refresh, the next attempt will return a definitive invalid-grant response.
          this.#tokens = previous;
        }
        throw error;
      }
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #accessToken(): Promise<string> {
    if (this.#refreshing) await this.#refreshing;
    if (!this.#tokens) throw new CreatorAuthorizationError('login_required');
    if (this.#tokens.expiresAt <= this.#now() + 30_000) await this.#refresh();
    if (!this.#tokens || this.#tokens.expiresAt <= this.#now()) throw new CreatorAuthorizationError('login_required');
    return this.#tokens.accessToken;
  }

  async #authenticate(): Promise<void> {
    if (this.#authenticating) return this.#authenticating;
    if (this.#authorizationKey && this.#keyExpiresAt > this.#now() + 5_000) return;
    this.#authenticating = this.#exchangeKey().finally(() => {
      this.#authenticating = undefined;
    });
    return this.#authenticating;
  }

  async #exchangeKey(): Promise<void> {
    try {
      const suite = new CipherSuite({kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305()});
      const pair = await suite.kem.generateKeyPair();
      const publicKey = await globalThis.crypto.subtle.exportKey('spki', pair.publicKey);
      const body = {encryption_type: 'HPKE', recipient_public_key: Buffer.from(publicKey).toString('base64')};
      let result = await this.#request('wallets/authenticate', body, await this.#accessToken());
      if (result.response.status === 401) {
        await this.#refresh();
        result = await this.#request('wallets/authenticate', body, await this.#accessToken());
      }
      if (!result.response.ok) throw this.#providerError(result.response, result.data);
      const encrypted = object(result.data.encrypted_authorization_key);
      const expiresAt =
        typeof result.data.expires_at === 'number' ? result.data.expires_at : Date.parse(string(result.data.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= this.#now() + 5_000) {
        throw new CreatorAuthorizationError('expired_signing_key');
      }
      if (!Array.isArray(result.data.wallets)) throw new CreatorAuthorizationError('invalid_response');
      const wallets = result.data.wallets.map((value) => {
        const wallet = object(value);
        return {id: string(wallet.id), address: string(wallet.address), chainType: string(wallet.chain_type)};
      });
      const recipient = await suite.createRecipientContext({recipientKey: pair.privateKey, enc: base64(encrypted.encapsulated_key)});
      const bytes = new Uint8Array(await recipient.open(base64(encrypted.ciphertext)));
      try {
        this.#authorizationKey = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        this.#keyExpiresAt = expiresAt;
        this.#wallets = wallets;
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      this.#authorizationKey = undefined;
      this.#keyExpiresAt = 0;
      this.#wallets = [];
      if (error instanceof CreatorAuthorizationError) throw error;
      throw new CreatorAuthorizationError('key_exchange_failed');
    }
  }

  async sign(input: {walletId: string; body: Record<string, unknown>; idempotencyKey: string; requestExpiry: string}) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.walletId) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.idempotencyKey)) {
      throw new CreatorAuthorizationError('invalid_request');
    }
    if (input.body.method !== 'eth_sendTransaction') throw new CreatorAuthorizationError('unsupported_method');
    await this.#authenticate();
    if (!this.#authorizationKey || this.#keyExpiresAt <= this.#now()) {
      throw new CreatorAuthorizationError('authorization_expired');
    }
    if (!this.#wallets.some((wallet) => wallet.id === input.walletId && wallet.chainType === 'ethereum')) {
      throw new CreatorAuthorizationError('wallet_not_authorized');
    }
    const expiry = Number(input.requestExpiry);
    if (!Number.isSafeInteger(expiry) || expiry <= this.#now() || expiry > this.#now() + 60_000 || expiry > this.#keyExpiresAt) {
      throw new CreatorAuthorizationError('invalid_request_expiry');
    }
    const url = `${WALLET_API}/${encodeURIComponent(input.walletId)}/rpc`;
    const headers = {
      'privy-app-id': this.#appId,
      'privy-idempotency-key': input.idempotencyKey,
      'privy-request-expiry': input.requestExpiry,
    };
    const signature = generateAuthorizationSignature({
      authorizationPrivateKey: this.#authorizationKey,
      input: {version: 1, method: 'POST', url, body: input.body, headers},
    });
    return {url, headers: {...headers, 'privy-authorization-signature': signature}};
  }

  dispose(): void {
    this.#device = undefined;
    this.#tokens = undefined;
    this.#authorizationKey = undefined;
    this.#keyExpiresAt = 0;
    this.#wallets = [];
  }
}
