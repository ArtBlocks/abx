import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exponentialBackoffDelay, linearBackoffDelay} from '../src/util.ts';

test('linearBackoffDelay: attempt * baseMs, 1-indexed', () => {
  assert.equal(linearBackoffDelay(1, 1000), 1000);
  assert.equal(linearBackoffDelay(2, 1000), 2000);
  assert.equal(linearBackoffDelay(5, 300), 1500);
});

test('exponentialBackoffDelay: baseMs * 2^(attempt-1), 1-indexed', () => {
  assert.equal(exponentialBackoffDelay(1, 1000, 60_000), 1000); // 1000 * 2^0
  assert.equal(exponentialBackoffDelay(2, 1000, 60_000), 2000); // 1000 * 2^1
  assert.equal(exponentialBackoffDelay(3, 1000, 60_000), 4000); // 1000 * 2^2
  assert.equal(exponentialBackoffDelay(4, 1000, 60_000), 8000); // 1000 * 2^3
});

test('exponentialBackoffDelay: caps at capMs once the doubling would exceed it', () => {
  // 1000 * 2^9 = 512_000, over a 60_000 cap — every attempt past the crossover reads as the cap.
  assert.equal(exponentialBackoffDelay(10, 1000, 60_000), 60_000);
  assert.equal(exponentialBackoffDelay(20, 1000, 60_000), 60_000);
  // the crossover attempt itself: 1000 * 2^5 = 32_000 (under cap), 2^6 = 64_000 (over) → capped
  assert.equal(exponentialBackoffDelay(6, 1000, 60_000), 32_000);
  assert.equal(exponentialBackoffDelay(7, 1000, 60_000), 60_000);
});

test('exponentialBackoffDelay: a cap below baseMs caps attempt 1 too', () => {
  assert.equal(exponentialBackoffDelay(1, 5000, 1000), 1000);
});
