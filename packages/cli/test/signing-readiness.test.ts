import assert from 'node:assert/strict';
import {test} from 'node:test';
import {privateKeyToAccount} from 'viem/accounts';
import {signingReadiness} from '../src/riskgate.js';

test('a successful simulation alone does not imply an available signer or authorization', () => {
  const simulation = {status: 'would-succeed' as const};
  assert.equal(signingReadiness('send', {simulation}).status, 'blocked');
  assert.equal(signingReadiness('send', {key: 'bad', simulation}).status, 'blocked');
  assert.equal(signingReadiness('sponsor', {simulation}).status, 'blocked');
  assert.equal(signingReadiness('sign', {simulation}).status, 'unknown');
  assert.equal(signingReadiness('unsigned', {simulation}).status, 'unknown');
});

test('ready requires the matching hot signer and already-proven execution/funding', () => {
  const key = `0x${'01'.repeat(32)}` as const;
  const expectedSigner = privateKeyToAccount(key).address;
  assert.equal(signingReadiness('send', {key, expectedSigner}).status, 'unknown');
  assert.equal(signingReadiness('send', {key, expectedSigner, simulation: {status: 'would-succeed'}}).ready, true);
  assert.equal(signingReadiness('send', {key, expectedSigner: `0x${'02'.repeat(20)}`, simulation: {status: 'would-succeed'}}).status, 'blocked');
  assert.equal(signingReadiness('send', {key, simulation: {status: 'would-revert', reason: 'insufficient funds'}}).status, 'blocked');
});

test('creator self-payment and gas sponsorship remain distinct without checking grants or spending', () => {
  const result = signingReadiness('sponsor', {apiKey: 'present', value: 1n});
  assert.equal(result.status, 'unknown');
  assert.equal(result.valueCompatibleWithSponsorship, false);
  assert.match(result.unchecked.join(' '), /self-payment/);
  assert.equal(signingReadiness('sponsor', {apiKey: 'present', value: 0n}).valueCompatibleWithSponsorship, true);
});
