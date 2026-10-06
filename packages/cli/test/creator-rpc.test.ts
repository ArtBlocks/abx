import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearRuntimeRpcEndpoint, resolveRpcUrls, runtimeRpcHeaders} from '@artblocks/abx-sdk';
import {configureFirstPartyCreatorRpc} from '../src/creator-rpc.js';

test('the first-party key installs a private creator RPC without putting the key in its URL', () => {
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

test('creator-selected RPC configuration suppresses the automatic first-party endpoint', () => {
  const env = {
    ABX_SERVICES_API_KEY: 'abxk_secret',
    ABX_RPC_URLS_BASE_SEPOLIA: 'https://creator-choice.example',
  };
  assert.equal(configureFirstPartyCreatorRpc('base-sepolia', env), null);
});
