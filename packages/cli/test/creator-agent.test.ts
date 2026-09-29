import assert from 'node:assert/strict';
import test from 'node:test';
import type {Address, PublicClient} from '@artblocks/abx-sdk';
import {Chacha20Poly1305} from '@hpke/chacha20poly1305';
import {CipherSuite, DhkemP256HkdfSha256, HkdfSha256} from '@hpke/core';
import {generateP256KeyPair} from '@privy-io/node';
import {CreatorAgentAuthorization, CreatorAuthorizationError} from '../src/creator-agent.js';
import {CreatorKeyringStore, type CreatorAuthorizationStore, type StoredCreatorAuthorization} from '../src/creator-keyring.js';
import {
  assertSponsorConfigured,
  assertSponsoredPreparedTx,
  creatorApiUrl,
  sponsoredGasLimit,
  sponsoredPreviewAddress,
  sponsoredWalletAddress,
} from '../src/creator-signer.js';
import {warnUnfunded} from '../src/commands/deploy.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});

const creatorWallet = {
  id: 'wallet_123',
  address: '0x1111111111111111111111111111111111111111',
  chain_type: 'ethereum',
};

async function encryptedSigner(key: string, publicKey: unknown, expiresAt: number) {
  const suite = new CipherSuite({kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305()});
  const recipientPublicKey = await globalThis.crypto.subtle.importKey(
    'spki',
    Buffer.from(String(publicKey), 'base64'),
    {name: 'ECDH', namedCurve: 'P-256'},
    true,
    [],
  );
  const sender = await suite.createSenderContext({recipientPublicKey});
  const ciphertext = await sender.seal(new TextEncoder().encode(key));
  return json({
    encrypted_authorization_key: {
      encryption_type: 'HPKE',
      encapsulated_key: Buffer.from(sender.enc).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    },
    expires_at: expiresAt,
    wallets: [creatorWallet],
  });
}

class MemoryAuthorizationStore implements CreatorAuthorizationStore {
  value: StoredCreatorAuthorization | null = null;
  saves = 0;
  clears = 0;
  async load() {
    return this.value ? {...this.value} : null;
  }
  async save(tokens: StoredCreatorAuthorization) {
    this.value = {...tokens};
    this.saves += 1;
  }
  async clear() {
    this.value = null;
    this.clears += 1;
  }
}

test('creator agent starts a device grant without sending credentials', async () => {
  let request: RequestInit | undefined;
  const auth = new CreatorAgentAuthorization({
    appId: 'app_test',
    fetchImpl: (async (url, init) => {
      assert.equal(url, 'https://auth.privy.io/api/oauth/v2/device_authorization');
      request = init;
      return json({
        device_code: 'device_123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.privy.io/activate',
        verification_uri_complete: 'https://auth.privy.io/activate?code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      });
    }) as typeof fetch,
  });
  const device = await auth.start();
  assert.equal(device.userCode, 'ABCD-EFGH');
  assert.equal(device.verificationUriComplete, 'https://auth.privy.io/activate?code=ABCD-EFGH');
  assert.equal((request?.headers as Record<string, string>).authorization, undefined);
  assert.equal((request?.headers as Record<string, string>)['privy-app-id'], 'app_test');
  auth.dispose();
});

test('creator agent refuses an unsafe verification URL', async () => {
  const auth = new CreatorAgentAuthorization({
    appId: 'app_test',
    fetchImpl: (async () =>
      json({
        device_code: 'device_123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://attacker.example/activate',
        expires_in: 600,
      })) as typeof fetch,
  });
  await assert.rejects(() => auth.start(), (error: unknown) => {
    assert.ok(error instanceof CreatorAuthorizationError);
    assert.equal(error.code, 'invalid_verification_url');
    return true;
  });
});

test('creator agent validates the public app id before any request', () => {
  assert.throws(() => new CreatorAgentAuthorization({appId: 'bad app id'}), /invalid_app_id/);
});

test('creator grants persist after approval, rotate through Privy, and resume without another device code', async () => {
  let now = 1_000_000;
  const store = new MemoryAuthorizationStore();
  const pair = await generateP256KeyPair();
  const firstHandlers = [
    () =>
      json({
        device_code: 'device_123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://services.abx.io/authorize',
        expires_in: 600,
        interval: 0.001,
      }),
    () =>
      json({
        access_token: 'access_first',
        refresh_token: 'refresh_first',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    (body: Record<string, unknown>) => encryptedSigner(pair.privateKey, body.recipient_public_key, now + 120_000),
  ];
  const first = new CreatorAgentAuthorization({
    appId: 'app_test',
    now: () => now,
    store,
    fetchImpl: (async (_url, init) => {
      const handler = firstHandlers.shift();
      assert.ok(handler, 'unexpected first-session request');
      return handler(JSON.parse(String(init?.body)));
    }) as typeof fetch,
  });
  await first.start();
  assert.deepEqual(await first.wait(), [
    {id: creatorWallet.id, address: creatorWallet.address, chainType: creatorWallet.chain_type},
  ]);
  assert.equal(store.value, null, 'wallet identity must be checked before a credential is retained');
  await first.remember();
  assert.equal(store.value?.refreshToken, 'refresh_first');
  first.dispose();

  now += 900_000;
  const requests: Record<string, unknown>[] = [];
  const resumed = new CreatorAgentAuthorization({
    appId: 'app_test',
    now: () => now,
    store,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.grant_type === 'refresh_token') {
        assert.equal(body.refresh_token, 'refresh_first');
        return json({
          access_token: 'access_rotated',
          refresh_token: 'refresh_rotated',
          token_type: 'Bearer',
          expires_in: 900,
        });
      }
      return encryptedSigner(pair.privateKey, body.recipient_public_key, now + 120_000);
    }) as typeof fetch,
  });
  assert.deepEqual(await resumed.restore(), [
    {id: creatorWallet.id, address: creatorWallet.address, chainType: creatorWallet.chain_type},
  ]);
  assert.equal(store.value?.refreshToken, 'refresh_rotated');
  assert.equal(requests.some((request) => 'device_code' in request), false);
  resumed.dispose();
});

test('a transient refresh failure keeps the durable grant for a later attempt', async () => {
  const store = new MemoryAuthorizationStore();
  store.value = {accessToken: 'expired_access', refreshToken: 'refresh_retry', expiresAt: 1};
  const auth = new CreatorAgentAuthorization({
    appId: 'app_test',
    now: () => 1_000_000,
    store,
    fetchImpl: (async () => {
      throw new Error('temporary network failure');
    }) as typeof fetch,
  });
  await assert.rejects(() => auth.restore(), /request_failed/);
  assert.equal(store.value?.refreshToken, 'refresh_retry');
  assert.equal(store.clears, 0);
});

test('native credential records round-trip without exposing a plaintext fallback', async () => {
  let value: string | undefined;
  const entry = {
    async getPassword() {
      return value;
    },
    async setPassword(next: string) {
      value = next;
    },
    async deleteCredential() {
      const present = value !== undefined;
      value = undefined;
      return present;
    },
  };
  const store = new CreatorKeyringStore('app_test', creatorWallet.address, entry);
  const tokens = {accessToken: 'access', refreshToken: 'refresh', expiresAt: 123_456};
  await store.save(tokens);
  assert.deepEqual(await store.load(), tokens);
  await store.clear();
  assert.equal(await store.load(), null);
});

test('sponsor preflight permits Base networks behind the live account gate and requires the API key', () => {
  const before = process.env.ABX_SERVICES_API_KEY;
  try {
    delete process.env.ABX_SERVICES_API_KEY;
    assert.throws(() => assertSponsorConfigured('sepolia'), /Base and Base Sepolia only/);
    assert.throws(() => assertSponsorConfigured('base'), /ABX_SERVICES_API_KEY/);
    assert.throws(() => assertSponsorConfigured('base-sepolia'), /ABX_SERVICES_API_KEY/);
    process.env.ABX_SERVICES_API_KEY = 'abx_test_key';
    assert.doesNotThrow(() => assertSponsorConfigured('base'));
    assert.doesNotThrow(() => assertSponsorConfigured('base-sepolia'));
  } finally {
    if (before === undefined) delete process.env.ABX_SERVICES_API_KEY;
    else process.env.ABX_SERVICES_API_KEY = before;
  }
});

test('sponsored deploys skip the native-balance and faucet preflight', async () => {
  let balanceReads = 0;
  const publicClient = {
    getBalance: async () => {
      balanceReads += 1;
      return 1n;
    },
  } as unknown as PublicClient;
  const wallet = '0x0000000000000000000000000000000000000001' as Address;

  await warnUnfunded(publicClient, wallet, 'sponsor');
  assert.equal(balanceReads, 0, 'the service-funded lane must not inspect or require wallet gas');

  await warnUnfunded(publicClient, wallet, 'send');
  assert.equal(balanceReads, 1, 'self-funded lanes still retain the native-balance preflight');
});

test('sponsored transactions preserve large network gas estimates without an ABX policy cap', () => {
  assert.equal(sponsoredGasLimit(4_933_890n), 4_933_890);
  assert.equal(sponsoredGasLimit(30_000_000n), 30_000_000);
  assert.throws(() => sponsoredGasLimit(BigInt(Number.MAX_SAFE_INTEGER) + 1n), /cannot be represented safely/);
});

test('sponsored transaction boundary requires a target and still pins chain and zero value', () => {
  const creation = {
    op: 'deploy-contract', to: null, data: '0x60006000f3', value: '0x0', chainId: 84532,
    summary: 'Deploy exact initcode', fields: {},
  } as const;
  assert.throws(() => assertSponsoredPreparedTx(creation, 84532), /requires a call target/);
  assert.doesNotThrow(() => assertSponsoredPreparedTx({...creation, to: '0x4e59b44847b379578588920cA78FbF26c0B4956C'}, 84532));
  assert.throws(() => assertSponsoredPreparedTx({...creation, chainId: 8453}, 84532), /expected 84532/);
  assert.throws(() => assertSponsoredPreparedTx({...creation, value: '0x1'}, 84532), /never covers/);
});

test('the explicit creator API override is a bounded development escape hatch', async () => {
  assert.equal(
    await creatorApiUrl(84532, {ABX_CREATORS_API_URL: 'https://api.example///'}),
    'https://api.example',
  );
  await assert.rejects(
    () => creatorApiUrl(84532, {ABX_CREATORS_API_URL: 'http://api.example'}),
    /must be HTTPS/,
  );
  await assert.rejects(
    () => creatorApiUrl(84532, {ABX_CREATORS_API_URL: 'https://api.example?token=secret'}),
    /must be HTTPS/,
  );
});

test('sponsored preview resolves the existing account wallet with a read-only request', async () => {
  const address = '0xadCaecC6539F91646293ea058A9f398dCC2271A6' as Address;
  const requests: Array<{url: string; method: string}> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({url: String(input), method: init?.method ?? 'GET'});
    return json({
      accountId: 'acct_test',
      emailVerified: true,
      wallet: {address, provider: 'privy', providerAppId: 'app_test'},
      capabilities: {wallet: true, sponsorship: true, sponsoredChains: [8453, 84532]},
    });
  };

  assert.equal(
    await sponsoredPreviewAddress('base', {
      env: {ABX_SERVICES_API_KEY: 'abx_test_key', ABX_CREATORS_API_URL: 'https://api.example'},
      fetchImpl,
    }),
    address,
  );
  assert.deepEqual(requests, [{url: 'https://api.example/v1/account', method: 'GET'}]);
});

test('sponsored preview refuses to provision missing account state', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requests.push(String(input));
    return json({
      accountId: 'acct_test',
      emailVerified: true,
      wallet: null,
      capabilities: {wallet: false, sponsorship: true, sponsoredChains: [8453]},
    });
  };

  await assert.rejects(
    () =>
      sponsoredPreviewAddress('base', {
        env: {ABX_SERVICES_API_KEY: 'abx_test_key', ABX_CREATORS_API_URL: 'https://api.example'},
        fetchImpl,
      }),
    /has not provisioned one yet/,
  );
  assert.deepEqual(requests, ['https://api.example/v1/account']);
});

test('a real sponsored plan provisions the stable wallet once, then resolves it', async () => {
  const address = '0xadCaecC6539F91646293ea058A9f398dCC2271A6' as Address;
  const requests: Array<{url: string; method: string}> = [];
  let provisioned = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    requests.push({url: String(input), method});
    if (String(input).endsWith('/v1/wallet')) {
      provisioned = true;
      return json({address, provider: 'privy', providerAppId: 'app_test', created: true}, 201);
    }
    return json({
      accountId: 'acct_test',
      emailVerified: true,
      wallet: provisioned ? {address, provider: 'privy', providerAppId: 'app_test'} : null,
      capabilities: {wallet: provisioned, sponsorship: true, sponsoredChains: [84532]},
    });
  };
  assert.equal(
    await sponsoredWalletAddress('base-sepolia', {
      env: {ABX_SERVICES_API_KEY: 'abx_test_key', ABX_CREATORS_API_URL: 'https://api.example'},
      fetchImpl,
      provision: true,
    }),
    address,
  );
  assert.deepEqual(requests, [
    {url: 'https://api.example/v1/account', method: 'GET'},
    {url: 'https://api.example/v1/wallet', method: 'POST'},
    {url: 'https://api.example/v1/account', method: 'GET'},
  ]);
});

test('sponsored preview enforces live per-chain entitlement', async () => {
  const fetchImpl: typeof fetch = async () =>
    json({
      accountId: 'acct_test',
      emailVerified: true,
      wallet: {
        address: '0xadCaecC6539F91646293ea058A9f398dCC2271A6',
        provider: 'privy',
        providerAppId: 'app_test',
      },
      capabilities: {wallet: true, sponsorship: true, sponsoredChains: [84532]},
    });

  await assert.rejects(
    () =>
      sponsoredPreviewAddress('base', {
        env: {ABX_SERVICES_API_KEY: 'abx_test_key', ABX_CREATORS_API_URL: 'https://api.example'},
        fetchImpl,
      }),
    /not enabled for Base/,
  );
});
