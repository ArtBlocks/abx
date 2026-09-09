import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactRpcUrl, redactRpcUrlsInText} from '../src/chains.js';

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
