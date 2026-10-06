import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearRuntimeRpcEndpoint, resolveRpcUrls, runtimeRpcHeaders} from '@artblocks/abx-sdk';
import {configureFirstPartyCreatorRpc} from '../src/creator-rpc.js';

const RPC_ENV_KEYS = ['ABX_RPC_URLS', 'ABX_RPC_URLS_BASE_SEPOLIA'] as const;

function withoutRpcEnv<T>(fn: () => T): T {
  const saved = new Map(RPC_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RPC_ENV_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const key of RPC_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the first-party key installs a private creator RPC without putting the key in its URL', () => {
  withoutRpcEnv(() => {
    const url = configureFirstPartyCreatorRpc('base-sepolia', {ABX_SERVICES_API_KEY: 'abxk_secret'});
    try {
      assert.equal(url, 'https://services.abx.io/v1/rpc/84532');
      assert.equal(url?.includes('abxk_secret'), false);
      assert.equal(resolveRpcUrls('base-sepolia')[0], url);
      assert.deepEqual(runtimeRpcHeaders(url!), {authorization: 'Bearer abxk_secret'});
    } finally {
      clearRuntimeRpcEndpoint('base-sepolia');
    }
  });
});

test('creator-selected RPC configuration suppresses the automatic first-party endpoint', () => {
  const env = {
    ABX_SERVICES_API_KEY: 'abxk_secret',
    ABX_RPC_URLS_BASE_SEPOLIA: 'https://creator-choice.example',
  };
  assert.equal(configureFirstPartyCreatorRpc('base-sepolia', env), null);
});
