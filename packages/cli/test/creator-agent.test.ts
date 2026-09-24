import assert from 'node:assert/strict';
import test from 'node:test';
import type {Address, PublicClient} from '@artblocks/abx-sdk';
import {CreatorAgentAuthorization, CreatorAuthorizationError} from '../src/creator-agent.js';
import {assertSponsorConfigured, creatorApiUrl, sponsoredPreviewAddress} from '../src/creator-signer.js';
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
