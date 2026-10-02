import assert from 'node:assert/strict';
import test from 'node:test';
import type {Address} from 'viem';
import {writeChunk, writeChunkBatch, writeContent, writeManifest} from '../src/chunks.ts';
import type {PreparedTx} from '../src/ops.ts';

const STORE = '0x0000000000000000000000000000000000000123' as Address;
const STOP = new Error('stop before receipt parsing');

test('every chunk-store operation marks receipt logs as inputs to a later transaction', async () => {
  const seen: PreparedTx[] = [];
  const send = async (tx: PreparedTx): Promise<never> => {
    seen.push(tx);
    throw STOP;
  };
  const chunk = {data: new Uint8Array([1, 2, 3]), compressed: false};
  const calls = [
    () => writeChunk(send, {store: STORE, data: chunk.data, chainId: 84532}),
    () => writeContent(send, {store: STORE, chunks: [chunk], chainId: 84532}),
    () => writeChunkBatch(send, {store: STORE, chunks: [chunk], chainId: 84532}),
    () => writeManifest(send, {store: STORE, chunks: [{pointer: STORE, compressed: false}], chainId: 84532}),
  ];

  for (const call of calls) await assert.rejects(call, (error) => error === STOP);
  assert.equal(seen.length, calls.length);
  assert.deepEqual(seen.map((tx) => tx.receiptPolicy), calls.map(() => 'dependent-logs'));
});
