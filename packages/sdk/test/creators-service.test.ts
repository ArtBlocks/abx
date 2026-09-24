import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CreatorApiClient, CreatorApiError} from '../src/creators-service.js';

const address = '0x1111111111111111111111111111111111111111' as const;

test('account and provision calls carry only the services API key and parse the public wallet config', async () => {
  const requests: Array<{url: string; init?: RequestInit}> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({url: String(url), init});
    if (String(url).endsWith('/v1/account')) {
      return Response.json({
        accountId: 'account-1',
        emailVerified: true,
        wallet: {address, provider: 'privy', providerAppId: 'app-1'},
        capabilities: {wallet: true, sponsorship: false, sponsoredChains: []},
      });
    }
    return Response.json({address, provider: 'privy', providerAppId: 'app-1', created: true}, {status: 201});
  };
  const client = new CreatorApiClient({baseUrl: 'https://api.example', token: 'api-key', fetchImpl});
  assert.equal((await client.account()).wallet?.address, address);
  assert.equal((await client.provisionWallet()).created, true);
  for (const request of requests) {
    assert.equal((request.init?.headers as Record<string, string>).authorization, 'Bearer api-key');
    assert.equal(String(request.init?.headers).includes('app-secret'), false);
  }
})

test('prepare, submit, and status preserve the exact signed operation contract', async () => {
  const bodies: unknown[] = [];
  const op = {
    operationId: 'operation_001',
    chainId: 84532,
    walletId: 'wallet-1',
    state: 'prepared',
    providerTransactionId: null,
    transactionHash: null,
    userOperationHash: null,
    errorCode: null,
    updatedAt: '2026-09-18T00:00:00.000Z',
  };
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (String(url).endsWith('/v1/operations')) {
      return Response.json({
        operation: op,
        signingRequest: {
          walletId: 'wallet-1',
          idempotencyKey: 'abx_account_operation_001',
          requestExpiry: '1789776000000',
          body: {method: 'eth_sendTransaction', caip2: 'eip155:84532'},
        },
      });
    }
    return Response.json({operation: {...op, state: 'pending'}});
  };
  const client = new CreatorApiClient({baseUrl: 'https://api.example', token: 'api-key', fetchImpl});
  const prepared = await client.prepare({
    operationId: 'operation_001',
    chainId: 84532,
    to: address,
    value: '0x0',
    data: '0x1234',
    gasLimit: 500000,
  });
  assert.equal(prepared.signingRequest.body.caip2, 'eip155:84532');
  await client.submit('operation_001', {
    requestExpiry: prepared.signingRequest.requestExpiry,
    data: '0x1234',
    signed: {url: 'https://api.privy.io/v1/wallets/wallet-1/rpc', headers: {'privy-authorization-signature': 'x'}},
  });
  await client.getOperation('operation_001');
  assert.deepEqual(bodies[0], {
    operationId: 'operation_001',
    chainId: 84532,
    to: address,
    value: '0x0',
    data: '0x1234',
    gasLimit: 500000,
  });
  assert.equal((bodies[1] as {data: string}).data, '0x1234');
})

test('errors expose only stable service codes and writes are never retried', async () => {
  let calls = 0;
  const client = new CreatorApiClient({
    baseUrl: 'https://api.example',
    token: 'api-key',
    fetchImpl: async () => {
      calls++;
      return Response.json({error: 'sponsorship_disabled', secret: 'never reflect this'}, {status: 503});
    },
  });
  await assert.rejects(
    client.prepare({operationId: 'operation_001', chainId: 84532, to: address, value: '0x0', data: '0x', gasLimit: 100000}),
    (error) => error instanceof CreatorApiError && error.code === 'sponsorship_disabled' && !error.message.includes('never reflect'),
  );
  assert.equal(calls, 1);
})

test('an ambiguous submit switches to read-only reconciliation without replaying the write', async () => {
  let submits = 0;
  let reads = 0;
  const op = {
    operationId: 'operation_001',
    chainId: 84532,
    walletId: 'wallet-1',
    state: 'confirmed',
    providerTransactionId: 'transaction-1',
    transactionHash: `0x${'12'.repeat(32)}`,
    userOperationHash: `0x${'34'.repeat(32)}`,
    errorCode: null,
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
  const client = new CreatorApiClient({
    baseUrl: 'https://api.example',
    token: 'api-key',
    fetchImpl: async (_url, init) => {
      if (init?.method === 'POST') {
        submits++;
        return Response.json({error: 'provider_response_unknown'}, {status: 503});
      }
      reads++;
      return Response.json({operation: op});
    },
  });

  assert.equal(
    (
      await client.submit('operation_001', {
        requestExpiry: '1789776000000',
        data: '0x1234',
        signed: {url: 'https://api.privy.io/v1/wallets/wallet-1/rpc', headers: {}},
      })
    ).state,
    'confirmed',
  );
  assert.equal(submits, 1);
  assert.equal(reads, 1);
})

test('a definitive submit rejection is not reconciled or retried', async () => {
  for (const [code, status] of [
    ['provider_rejected_400_invalid_data', 400],
    ['sponsorship_disabled', 503],
  ] as const) {
    let calls = 0;
    const client = new CreatorApiClient({
      baseUrl: 'https://api.example',
      token: 'api-key',
      fetchImpl: async () => {
        calls++;
        return Response.json({error: code}, {status});
      },
    });
    await assert.rejects(
      client.submit('operation_001', {
        requestExpiry: '1789776000000',
        data: '0x1234',
        signed: {url: 'https://api.privy.io/v1/wallets/wallet-1/rpc', headers: {}},
      }),
      (error) => error instanceof CreatorApiError && error.code === code,
    );
    assert.equal(calls, 1);
  }
})

test('service URL normalization is bounded and strips trailing slashes', async () => {
  let seen = '';
  const client = new CreatorApiClient({
    baseUrl: 'https://api.example///',
    token: 'api-key',
    fetchImpl: (async (url) => {
      seen = String(url);
      return Response.json({
        accountId: 'account-1',
        emailVerified: true,
        wallet: null,
        capabilities: {wallet: false, sponsorship: false, sponsoredChains: []},
      });
    }) as typeof fetch,
  });
  await client.account();
  assert.equal(seen, 'https://api.example/v1/account');
  assert.throws(
    () => new CreatorApiClient({baseUrl: `https://api.example/${'/'.repeat(2_048)}`, token: 'api-key'}),
    /URL is too long/,
  );
})
