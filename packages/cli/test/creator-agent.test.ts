import assert from 'node:assert/strict';
import test from 'node:test';
import type {Address, PublicClient} from '@artblocks/abx-sdk';
import {CreatorAgentAuthorization, CreatorAuthorizationError} from '../src/creator-agent.js';
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
