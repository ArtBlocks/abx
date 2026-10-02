import assert from 'node:assert/strict';
import test from 'node:test';
import type {Hex, PublicClient, TransactionReceipt} from 'viem';
import {firstAvailableReceipt} from '../src/clients.ts';

const HASH = `0x${'12'.repeat(32)}` as Hex;
const OTHER_HASH = `0x${'34'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'56'.repeat(32)}` as Hex;
const CHAIN_ID = 84532;

const expected = {
  transactionHash: HASH,
  status: 'success',
  blockHash: BLOCK_HASH,
  blockNumber: 123n,
  logs: [],
} as unknown as TransactionReceipt;

type ReceiptReader = Pick<PublicClient, 'getTransactionReceipt'> & Partial<Pick<PublicClient, 'getChainId'>>;

function reader(
  getTransactionReceipt: ReceiptReader['getTransactionReceipt'],
  chainId = CHAIN_ID,
): ReceiptReader {
  return {getTransactionReceipt, getChainId: async () => chainId} as ReceiptReader;
}

test('receipt probing gives a not-found primary a propagation grace period', async () => {
  const calls: string[] = [];
  const stale = reader(async () => {
    calls.push('primary');
    throw new Error('Transaction receipt could not be found');
  });
  const current = reader(async () => {
    calls.push('backup');
    return expected;
  });

  const result = await firstAvailableReceipt([stale, current], HASH, {expectedChainId: CHAIN_ID});
  assert.equal(result.receipt, undefined);
  assert.deepEqual(calls, ['primary']);
});

test('receipt probing accepts a validated backup after the stale-primary grace period', async () => {
  const calls: string[] = [];
  const stale = reader(async () => {
    calls.push('primary');
    throw new Error('Transaction receipt could not be found');
  });
  const current = reader(async () => {
    calls.push('backup');
    return expected;
  });

  const result = await firstAvailableReceipt([stale, current], HASH, {
    expectedChainId: CHAIN_ID,
    allowStalePrimaryFallback: true,
  });
  assert.equal(result.receipt, expected);
  assert.deepEqual(calls, ['primary', 'backup']);
});

test('receipt probing immediately fails over when the primary is unavailable', async () => {
  const unavailable = reader(async () => {
    throw new Error('rate limited');
  });
  const result = await firstAvailableReceipt([unavailable, reader(async () => expected)], HASH, {
    expectedChainId: CHAIN_ID,
  });
  assert.equal(result.receipt, expected);
});

test('dependent-log receipts never let an uncorroborated backup replace the preferred RPC', async () => {
  let backupCalled = false;
  const result = await firstAvailableReceipt(
    [
      reader(async () => {
        throw new Error('rate limited');
      }),
      reader(async () => {
        backupCalled = true;
        return expected;
      }),
    ],
    HASH,
    {expectedChainId: CHAIN_ID, requirePreferred: true},
  );
  assert.equal(result.receipt, undefined);
  assert.equal(backupCalled, false);
  assert.match(String(result.error), /rate limited/);
});

test('receipt probing rejects a receipt for the wrong hash without consulting a backup', async () => {
  let backupCalled = false;
  const mismatched = {...expected, transactionHash: OTHER_HASH} as TransactionReceipt;
  const result = await firstAvailableReceipt(
    [
      reader(async () => mismatched),
      reader(async () => {
        backupCalled = true;
        return expected;
      }),
    ],
    HASH,
    {expectedChainId: CHAIN_ID},
  );
  assert.equal(result.receipt, undefined);
  assert.match(String(result.error), /for requested transaction/);
  assert.equal(backupCalled, false);
});

test('receipt probing rejects a backup from the wrong chain', async () => {
  const result = await firstAvailableReceipt(
    [
      reader(async () => {
        throw new Error('rate limited');
      }),
      reader(async () => expected, 1),
    ],
    HASH,
    {expectedChainId: CHAIN_ID},
  );
  assert.equal(result.receipt, undefined);
  assert.match(String(result.error), /reports chain 1, expected 84532/);
});

test('receipt probing rejects logs whose receipt identity is inconsistent', async () => {
  const inconsistent = {
    ...expected,
    logs: [{transactionHash: OTHER_HASH, blockHash: BLOCK_HASH, blockNumber: 123n}],
  } as unknown as TransactionReceipt;
  const result = await firstAvailableReceipt(
    [
      reader(async () => {
        throw new Error('rate limited');
      }),
      reader(async () => inconsistent),
    ],
    HASH,
    {expectedChainId: CHAIN_ID},
  );
  assert.equal(result.receipt, undefined);
  assert.match(String(result.error), /returned a log from/);
});

test('receipt probing preserves an error when every endpoint is unavailable', async () => {
  const unavailable = (message: string) =>
    reader(async () => {
      throw new Error(message);
    });
  const result = await firstAvailableReceipt([unavailable('rate limited'), unavailable('stale')], HASH);
  assert.equal(result.receipt, undefined);
  assert.ok(result.error instanceof Error);
});
