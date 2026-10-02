import assert from 'node:assert/strict';
import test from 'node:test';
import type {Hex, PublicClient, TransactionReceipt} from 'viem';
import {firstAvailableReceipt} from '../src/clients.ts';

const HASH = `0x${'12'.repeat(32)}` as Hex;

test('receipt probing checks another RPC when a stale endpoint reports not found', async () => {
  const calls: string[] = [];
  const stale = {
    getTransactionReceipt: async () => {
      calls.push('stale');
      throw new Error('Transaction receipt could not be found');
    },
  } as unknown as Pick<PublicClient, 'getTransactionReceipt'>;
  const expected = {transactionHash: HASH, status: 'success'} as TransactionReceipt;
  const current = {
    getTransactionReceipt: async () => {
      calls.push('current');
      return expected;
    },
  } as unknown as Pick<PublicClient, 'getTransactionReceipt'>;

  const result = await firstAvailableReceipt([stale, current], HASH);
  assert.equal(result.receipt, expected);
  assert.deepEqual(calls.sort(), ['current', 'stale']);
});

test('receipt probing preserves an error when every endpoint is unavailable', async () => {
  const unavailable = (message: string) =>
    ({getTransactionReceipt: async () => { throw new Error(message); }}) as unknown as Pick<PublicClient, 'getTransactionReceipt'>;
  const result = await firstAvailableReceipt([unavailable('rate limited'), unavailable('stale')], HASH);
  assert.equal(result.receipt, undefined);
  assert.ok(result.error instanceof Error);
});
