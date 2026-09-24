import type {Address, Hex} from 'viem';

export type CreatorOperationState = 'prepared' | 'submitting' | 'pending' | 'confirmed' | 'failed' | 'unknown';

export interface CreatorWallet {
  address: Address;
  provider: 'privy';
  /** Public Privy application identifier used for the creator's device authorization. */
  providerAppId: string;
}

export interface CreatorAccount {
  accountId: string;
  emailVerified: boolean;
  wallet: CreatorWallet | null;
  capabilities: {wallet: boolean; sponsorship: boolean; sponsoredChains: number[]};
}

export interface CreatorOperation {
  operationId: string;
  chainId: number;
  walletId: string;
  state: CreatorOperationState;
  providerTransactionId: string | null;
  transactionHash: Hex | null;
  userOperationHash: Hex | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface CreatorSigningRequest {
  walletId: string;
  idempotencyKey: string;
  requestExpiry: string;
  body: Record<string, unknown>;
}

export interface CreatorPreparedOperation {
  operation: CreatorOperation;
  signingRequest: CreatorSigningRequest;
}

export interface CreatorApiClientOptions {
  /** Explicit provider endpoint, normally resolved from `abx-creator-wallet/v1` in its remote descriptor. */
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CreatorApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`ABX Creators: ${code} (HTTP ${status})`);
    this.name = 'CreatorApiError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ABX Creators returned an invalid response');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('ABX Creators returned an invalid response');
  return value;
}

function address(value: unknown): Address {
  const parsed = string(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(parsed)) throw new Error('ABX Creators returned an invalid wallet address');
  return parsed as Address;
}

function provider(value: unknown): 'privy' {
  if (value !== 'privy') throw new Error('ABX Creators returned an unsupported wallet provider');
  return value;
}

function operation(value: unknown): CreatorOperation {
  const row = object(value);
  const state = string(row.state) as CreatorOperationState;
  if (!['prepared', 'submitting', 'pending', 'confirmed', 'failed', 'unknown'].includes(state)) {
    throw new Error('ABX Creators returned an invalid operation state');
  }
  const nullable = (entry: unknown): string | null => (entry === null ? null : string(entry));
  if (!Number.isSafeInteger(row.chainId) || Number(row.chainId) <= 0) {
    throw new Error('ABX Creators returned an invalid chain');
  }
  return {
    operationId: string(row.operationId),
    chainId: Number(row.chainId),
    walletId: string(row.walletId),
    state,
    providerTransactionId: nullable(row.providerTransactionId),
    transactionHash: nullable(row.transactionHash) as Hex | null,
    userOperationHash: nullable(row.userOperationHash) as Hex | null,
    errorCode: nullable(row.errorCode),
    updatedAt: string(row.updatedAt),
  };
}

/** Account/wallet API client. It never receives a wallet key or authorization token. */
export class CreatorApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CreatorApiClientOptions) {
    let baseUrl = options.baseUrl;
    if (baseUrl.length > 2_048) throw new Error('ABX Creators service URL is too long');
    while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    if (!this.#token) throw new Error('ABX Creators needs an ABX Services API key');
  }

  async account(): Promise<CreatorAccount> {
    const data = object(await this.#request('GET', '/v1/account'));
    const capabilities = object(data.capabilities);
    const wallet = data.wallet === null ? null : object(data.wallet);
    const chains = capabilities.sponsoredChains;
    if (!Array.isArray(chains) || chains.some((chainId) => !Number.isSafeInteger(chainId))) {
      throw new Error('ABX Creators returned invalid sponsored chains');
    }
    return {
      accountId: string(data.accountId),
      emailVerified: data.emailVerified === true,
      wallet: wallet
        ? {
            address: address(wallet.address),
            provider: provider(wallet.provider),
            providerAppId: string(wallet.providerAppId),
          }
        : null,
      capabilities: {
        wallet: capabilities.wallet === true,
        sponsorship: capabilities.sponsorship === true,
        sponsoredChains: chains as number[],
      },
    };
  }

  async provisionWallet(): Promise<CreatorWallet & {created: boolean}> {
    const data = object(await this.#request('POST', '/v1/wallet'));
    return {
      address: address(data.address),
      provider: provider(data.provider),
      providerAppId: string(data.providerAppId),
      created: data.created === true,
    };
  }

  async prepare(input: {
    operationId: string;
    chainId: number;
    /** Null for direct EVM contract creation. */
    to: Address | null;
    value: Hex;
    data: Hex;
    gasLimit: number;
  }): Promise<CreatorPreparedOperation> {
    const result = object(await this.#request('POST', '/v1/operations', input));
    const signing = object(result.signingRequest);
    return {
      operation: operation(result.operation),
      signingRequest: {
        walletId: string(signing.walletId),
        idempotencyKey: string(signing.idempotencyKey),
        requestExpiry: string(signing.requestExpiry),
        body: object(signing.body),
      },
    };
  }

  async submit(
    operationId: string,
    input: {requestExpiry: string; data: Hex; signed: {url: string; headers: Record<string, string>}},
  ): Promise<CreatorOperation> {
    try {
      // The service allows up to 30 seconds for Privy. Keep the caller alive beyond that boundary so
      // it receives the durable operation instead of abandoning a write that may still land.
      const result = object(
        await this.#request(
          'POST',
          `/v1/operations/${encodeURIComponent(operationId)}/submit`,
          input,
          Math.max(this.#timeoutMs, 45_000),
        ),
      );
      return operation(result.operation);
    } catch (submitError) {
      if (
        submitError instanceof CreatorApiError &&
        (submitError.status < 500 || submitError.code === 'sponsorship_disabled')
      )
        throw submitError;
      // The write may already have reached the provider. Never replay it: reconcile the durable
      // operation created during prepare through the read-only status endpoint instead.
      try {
        return await this.getOperation(operationId);
      } catch {
        throw new Error(
          `Sponsored operation ${operationId} has an unknown submission outcome. Check its status before doing anything else; do not retry it.`,
        );
      }
    }
  }

  async getOperation(operationId: string): Promise<CreatorOperation> {
    const result = object(await this.#request('GET', `/v1/operations/${encodeURIComponent(operationId)}`));
    return operation(result.operation);
  }

  async #request(method: string, path: string, body?: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : {'content-type': 'application/json'}),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
    } catch {
      throw new Error('ABX Creators is unavailable; no transaction was retried');
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const parsed = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
      throw new CreatorApiError(typeof parsed.error === 'string' ? parsed.error : 'request_failed', response.status);
    }
    return data;
  }
}
