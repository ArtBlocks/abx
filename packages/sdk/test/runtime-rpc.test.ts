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

async function rpcServer(): Promise<{url: string; authorization: () => string | undefined; close: () => Promise<void>}> {
  let seenAuthorization: string | undefined;
  const server = createServer((req, res) => {
    seenAuthorization = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({jsonrpc: '2.0', id: 1, result: '0x14a34'}));
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
