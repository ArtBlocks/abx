import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {
  clearRuntimeRpcEndpoint,
  CREATOR_RPC_INTERFACE,
  resolveRpcUrls,
  runtimeRpcHeaders,
} from '@artblocks/abx-sdk';
import {configureCreatorRpcFromRemote, creatorRpcRemoteSpec} from '../src/creator-rpc.js';

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

async function catalogServer(): Promise<{
  url: string;
  descriptorAuthorization: () => string | undefined;
  close: () => Promise<void>;
}> {
  let baseUrl = '';
  let descriptorAuthorization: string | undefined;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/abx-service') {
      descriptorAuthorization = req.headers.authorization;
      res.end(
        JSON.stringify({
          interfaces: [CREATOR_RPC_INTERFACE],
          chains: [84532],
          endpoints: {
            [CREATOR_RPC_INTERFACE]: {
              baseUrl,
              chains: [84532],
              auth: 'bearer',
              pathTemplate: '/creator/{chainId}/rpc',
            },
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({error: 'not found'}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test catalog did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: baseUrl,
    descriptorAuthorization: () => descriptorAuthorization,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('an advertised remote installs its templated creator RPC without putting the key in its URL', async () => {
  await withoutRpcEnv(async () => {
    const catalog = await catalogServer();
    const url = await configureCreatorRpcFromRemote(
      'base-sepolia',
      {url: catalog.url, token: 'provider-secret'},
      {},
    );
    try {
      assert.equal(url, `${catalog.url}/creator/84532/rpc`);
      assert.equal(url?.includes('provider-secret'), false);
      assert.equal(resolveRpcUrls('base-sepolia')[0], url);
      assert.deepEqual(runtimeRpcHeaders(url!), {authorization: 'Bearer provider-secret'});
      assert.equal(catalog.descriptorAuthorization(), undefined, 'service discovery must remain public');
    } finally {
      clearRuntimeRpcEndpoint('base-sepolia');
      await catalog.close();
    }
  });
});

test('provider selection is generic while the first-party catalog remains the zero-config default', () => {
  assert.equal(creatorRpcRemoteSpec({ABX_SERVICES_API_KEY: 'abxk_secret'}), 'abx');
  assert.equal(
    creatorRpcRemoteSpec({ABX_SERVICES_API_KEY: 'abxk_secret', ABX_RPC_REMOTE: 'my-provider'}),
    'my-provider',
  );
  assert.equal(creatorRpcRemoteSpec({}), null);
});

test('creator-selected RPC configuration suppresses remote discovery', async () => {
  const env = {
    ABX_RPC_URLS_BASE_SEPOLIA: 'https://creator-choice.example',
  };
  assert.equal(
    await configureCreatorRpcFromRemote(
      'base-sepolia',
      {url: 'https://descriptor-must-not-be-fetched.example', token: 'provider-secret'},
      env,
    ),
    null,
  );
});
