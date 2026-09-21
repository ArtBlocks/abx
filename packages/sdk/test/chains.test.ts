import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CHAIN_KEYS,
  chainById,
  DEFAULT_CHAIN_KEY,
  KNOWN_CHAIN_KEYS,
  redactRpcUrl,
  redactRpcUrlsInText,
  resolveChain,
  resolveRpcUrls,
} from '../src/chains.js';
import {CHAIN_SUPPORT, chainSupportByKey, isChainSelectable} from '../src/chain-support.js';

test('chain registry separates recognized networks from selectable networks', () => {
  assert.equal(DEFAULT_CHAIN_KEY, 'base-sepolia');
  assert.deepEqual(ALL_CHAIN_KEYS, [
    'base-sepolia',
    'sepolia',
    'robinhood-testnet',
    'arbitrum-sepolia',
    'base',
    'robinhood',
    'arbitrum',
    'ethereum',
  ]);
  assert.deepEqual(KNOWN_CHAIN_KEYS, [
    'base-sepolia',
    'sepolia',
    'robinhood-testnet',
    'arbitrum-sepolia',
    'base',
    'robinhood',
  ]);
  assert.equal(CHAIN_SUPPORT.filter(isChainSelectable).length, 6);
  assert.equal(chainSupportByKey('arbitrum-sepolia')?.contractStatus, 'deployed');
  assert.equal(chainSupportByKey('arbitrum-sepolia')?.supportLevel, 'experimental');
  assert.equal(chainSupportByKey('arbitrum')?.contractStatus, 'not-deployed');
  assert.equal(chainSupportByKey('arbitrum')?.supportLevel, 'disabled');
  assert.equal(chainSupportByKey('robinhood-testnet')?.contractStatus, 'deployed');
  assert.equal(chainSupportByKey('robinhood-testnet')?.supportLevel, 'experimental');
  assert.equal(chainSupportByKey('base')?.contractStatus, 'deployed');
  assert.equal(chainSupportByKey('base')?.supportLevel, 'beta');
  assert.equal(chainSupportByKey('robinhood')?.contractStatus, 'deployed');
  assert.equal(chainSupportByKey('robinhood')?.supportLevel, 'beta');
  assert.equal(chainSupportByKey('ethereum')?.supportLevel, 'disabled');
});

test('registry ids agree with viem chain metadata, including disabled production networks', () => {
  for (const support of CHAIN_SUPPORT) {
    assert.equal(resolveChain(support.key).id, support.chainId);
    assert.equal(chainById(support.chainId)?.id, support.chainId);
  }
});

test('Robinhood Chain Testnet has a keyless default RPC ready for qualification', () => {
  assert.deepEqual(resolveRpcUrls('robinhood-testnet'), ['https://rpc.testnet.chain.robinhood.com']);
});

test('Base has a keyless default RPC for beta access', () => {
  assert.deepEqual(resolveRpcUrls('base'), ['https://mainnet.base.org']);
});

test('Robinhood Chain has a keyless default RPC for beta access', () => {
  assert.deepEqual(resolveRpcUrls('robinhood'), ['https://rpc.mainnet.chain.robinhood.com']);
});

test('Arbitrum Sepolia has a keyless default RPC for qualification', () => {
  assert.deepEqual(resolveRpcUrls('arbitrum-sepolia'), ['https://sepolia-rollup.arbitrum.io/rpc']);
});

test('Arbitrum One has a keyless default RPC ready for production beta', () => {
  assert.deepEqual(resolveRpcUrls('arbitrum'), ['https://arb1.arbitrum.io/rpc']);
});

test('redactRpcUrlsInText removes credential-bearing configured endpoints from upstream errors', () => {
  const rpc = 'https://rpc.example/v2/super-secret-api-key?tenant=private';
  const input = `HTTP request failed at ${rpc}\nURL: ${rpc}`;
  const output = redactRpcUrlsInText(input, [rpc]);
  assert.equal(output.includes(rpc), false);
  assert.equal(output.includes('super-secret-api-key'), false);
  assert.equal(output, `HTTP request failed at ${redactRpcUrl(rpc)}\nURL: ${redactRpcUrl(rpc)}`);
});

test('redactRpcUrlsInText handles overlapping endpoints longest-first', () => {
  const base = 'https://rpc.example/v2';
  const keyed = `${base}/secret-key`;
  const output = redactRpcUrlsInText(`failed ${keyed}`, [base, keyed]);
  assert.equal(output.includes('secret-key'), false);
});
