import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {
  clearRuntimeRpcEndpoint,
  configureRuntimeRpcEndpoint,
  makePublicClient,
  resolveRpcUrls,
  runtimeRpcHeaders,
} from '../src/index.js';

const RPC_ENV_KEYS = ['ABX_RPC_URLS', 'ABX_RPC_URLS_BASE_SEPOLIA'] as const;

async function withoutRpcEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = new Map(RPC_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RPC_ENV_KEYS) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const key of RPC_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function rpcServer(response: {statusCode?: number; body?: unknown} = {}): Promise<{
  url: string;
  authorization: () => string | undefined;
  close: () => Promise<void>;
}> {
  let seenAuthorization: string | undefined;
  const server = createServer((req, res) => {
    seenAuthorization = req.headers.authorization;
    res.statusCode = response.statusCode ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response.body ?? {jsonrpc: '2.0', id: 1, result: '0x14a34'}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    authorization: () => seenAuthorization,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('a runtime RPC is preferred and authenticated while all public endpoints remain failovers', async () => {
  await withoutRpcEnv(async () => {
    const server = await rpcServer();
    configureRuntimeRpcEndpoint('base-sepolia', {
      url: server.url,
      headers: {authorization: 'Bearer creator-secret'},
    });
    try {
      const urls = resolveRpcUrls('base-sepolia');
      assert.equal(urls[0], server.url);
      assert.deepEqual(urls.slice(1), [
        'https://sepolia.base.org',
        'https://base-sepolia-rpc.publicnode.com',
      ]);
      assert.deepEqual(runtimeRpcHeaders(urls[1]), {}, 'the bearer header must not follow failover');
      assert.equal(await makePublicClient({chainKey: 'base-sepolia'}).getChainId(), 84532);
      assert.equal(server.authorization(), 'Bearer creator-secret');
    } finally {
      clearRuntimeRpcEndpoint('base-sepolia');
      await server.close();
    }
  });
});

test('creator RPC auth, quota, and upstream failures use a public fallback without leaking auth', async (t) => {
  for (const statusCode of [401, 429, 503]) {
    await t.test(String(statusCode), async () => {
      const privateRpc = await rpcServer({statusCode, body: {error: 'creator RPC unavailable'}});
      const publicRpc = await rpcServer();
      configureRuntimeRpcEndpoint('base-sepolia', {
        url: privateRpc.url,
        headers: {authorization: 'Bearer creator-secret'},
      });
      try {
        const client = makePublicClient({
          chainKey: 'base-sepolia',
          rpcUrls: [privateRpc.url, publicRpc.url],
        });
        assert.equal(await client.getChainId(), 84532);
        assert.equal(privateRpc.authorization(), 'Bearer creator-secret');
        assert.equal(publicRpc.authorization(), undefined);
      } finally {
        clearRuntimeRpcEndpoint('base-sepolia');
        await Promise.all([privateRpc.close(), publicRpc.close()]);
      }
    });
  }
});

test('an explicit RPC override wins outright over a runtime default', () => {
  configureRuntimeRpcEndpoint('sepolia', {
    url: 'https://services.example/v1/rpc/11155111',
    headers: {authorization: 'Bearer creator-secret'},
  });
  try {
    assert.deepEqual(resolveRpcUrls('sepolia', ['https://creator-choice.example']), [
      'https://creator-choice.example',
    ]);
    assert.deepEqual(runtimeRpcHeaders('https://creator-choice.example'), {});
  } finally {
    clearRuntimeRpcEndpoint('sepolia');
  }
});
