import {Chacha20Poly1305} from '@hpke/chacha20poly1305';
import {CipherSuite, DhkemP256HkdfSha256, HkdfSha256} from '@hpke/core';
import {generateAuthorizationSignature} from '@privy-io/node';

const OAUTH = 'https://auth.privy.io/api/oauth/v2';
const WALLET_API = 'https://api.privy.io/v1/wallets';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

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

/** Ephemeral Privy device session. Tokens and the decrypted signing key never leave this instance. */
export class CreatorAgentAuthorization {
  readonly #appId: string;
  readonly #fetch: typeof fetch;
  #device?: {code: string; expiresAt: number; interval: number};
  #accessToken?: string;
  #authorizationKey?: string;
  #keyExpiresAt = 0;
  #wallets: AuthorizedCreatorWallet[] = [];

  constructor(options: {appId: string; fetchImpl?: typeof fetch}) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.appId)) throw new CreatorAuthorizationError('invalid_app_id');
    this.#appId = options.appId;
    this.#fetch = options.fetchImpl ?? fetch;
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

  async start(): Promise<CreatorDeviceAuthorization> {
    if (this.#device) throw new CreatorAuthorizationError('already_started');
    const {response, data} = await this.#request('device_authorization', {});
    if (!response.ok) throw new CreatorAuthorizationError('device_authorization_failed');
    const expiresAt = Date.now() + seconds(data.expires_in);
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
      const remaining = device.expiresAt - Date.now();
      if (remaining <= 0) throw new CreatorAuthorizationError('expired');
      await new Promise((resolve) => setTimeout(resolve, Math.min(device.interval, remaining)));
      const {response, data} = await this.#request('token', {grant_type: DEVICE_GRANT, device_code: device.code});
      if (response.ok) {
        this.#accessToken = string(data.access_token);
        await this.#authenticate();
        this.#device = undefined;
        return this.#wallets.map((wallet) => ({...wallet}));
      }
      const code = typeof data.error === 'string' ? data.error : '';
      if (response.status === 400 && (code === 'authorization_pending' || code === 'slow_down')) {
        if (code === 'slow_down') device.interval += 5_000;
        continue;
      }
      throw new CreatorAuthorizationError(code === 'access_denied' ? 'access_denied' : 'provider_error');
    }
  }

  async #authenticate(): Promise<void> {
    if (!this.#accessToken) throw new CreatorAuthorizationError('login_required');
    try {
      const suite = new CipherSuite({kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305()});
      const pair = await suite.kem.generateKeyPair();
      const publicKey = await globalThis.crypto.subtle.exportKey('spki', pair.publicKey);
      const {response, data} = await this.#request(
        'wallets/authenticate',
        {encryption_type: 'HPKE', recipient_public_key: Buffer.from(publicKey).toString('base64')},
        this.#accessToken,
      );
      if (!response.ok) throw new CreatorAuthorizationError('wallet_authentication_failed');
      const encrypted = object(data.encrypted_authorization_key);
      const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : Date.parse(string(data.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5_000) throw new CreatorAuthorizationError('expired_signing_key');
      if (!Array.isArray(data.wallets)) throw new CreatorAuthorizationError('invalid_response');
      const wallets = data.wallets.map((value) => {
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
      this.#accessToken = undefined;
    } catch (error) {
      if (error instanceof CreatorAuthorizationError) throw error;
      throw new CreatorAuthorizationError('key_exchange_failed');
    }
  }

  sign(input: {walletId: string; body: Record<string, unknown>; idempotencyKey: string; requestExpiry: string}) {
    if (!this.#authorizationKey || this.#keyExpiresAt <= Date.now()) throw new CreatorAuthorizationError('authorization_expired');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.walletId) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.idempotencyKey)) {
      throw new CreatorAuthorizationError('invalid_request');
    }
    if (input.body.method !== 'eth_sendTransaction') throw new CreatorAuthorizationError('unsupported_method');
    if (!this.#wallets.some((wallet) => wallet.id === input.walletId && wallet.chainType === 'ethereum')) {
      throw new CreatorAuthorizationError('wallet_not_authorized');
    }
    const expiry = Number(input.requestExpiry);
    if (!Number.isSafeInteger(expiry) || expiry <= Date.now() || expiry > Date.now() + 60_000 || expiry > this.#keyExpiresAt) {
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
    this.#accessToken = undefined;
    this.#authorizationKey = undefined;
    this.#wallets = [];
  }
}
