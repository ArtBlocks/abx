import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeHistoryAt} from '../src/probe.ts';

// The bug this guards: a public endpoint that has PRUNED its log history answers
// `eth_getLogs` with `[]` and HTTP 200. The old archive probe asked for logs of
// `zeroAddress` at one old block and counted any non-throw as archive access — an
// assertion that cannot fail, since `zeroAddress` never emits logs even on a perfect
// archive node. So a pruning node was graded `best`, `abx doctor` printed
// "wide range + archive", and `abx add` reconstructed nothing.
//
// Measured live on two Base Sepolia endpoints, same tx 500k blocks back: one returned a
// receipt with 1 log, the other returned null. These fakes reproduce both shapes.

const BLOCK = 45_100_000n;
const TX = '0x8fa1f1ce58d970cb6f4fcebba504a9b94cd8b17d96de3cd83d29f89adce04286' as const;
const LOGGER = '0x4200000000000000000000000000000000000006' as const;

/** A node that serves the block, and whose receipt/log behaviour at depth is configurable. */
function fakeNode(opts: {txs?: readonly string[]; receipt?: 'ok' | 'pruned' | 'nologs' | 'ratelimited'; logsAtDepth?: number}) {
  return {
    async getBlock() {
      return {transactions: opts.txs ?? [TX]};
    },
    async getTransactionReceipt() {
      if (opts.receipt === 'pruned') throw new Error('Transaction receipt with hash "…" could not be found.');
      if (opts.receipt === 'ratelimited') throw new Error('HTTP request failed. Status: 429 Too Many Requests');
      return {logs: opts.receipt === 'nologs' ? [] : [{address: LOGGER}]};
    },
    async getLogs() {
      return Array.from({length: opts.logsAtDepth ?? 1}, () => ({address: LOGGER}));
    },
  };
}

test('a node that prunes receipts at depth is NOT archive — the failure the old probe could not see', async () => {
  const res = await probeHistoryAt(fakeNode({receipt: 'pruned'}) as never, BLOCK);
  assert.equal(res.retained, false);
  assert.match(res.reason ?? '', /history pruned/);
  assert.match(res.reason ?? '', /not the receipts/); // names the observation, so a caller can word its own fix
});

test('a node whose LOG INDEX is pruned (receipt has logs, getLogs returns empty) is NOT archive', async () => {
  const res = await probeHistoryAt(fakeNode({logsAtDepth: 0}) as never, BLOCK);
  assert.equal(res.retained, false);
  assert.match(res.reason ?? '', /log index pruned/);
});

test('a real archive node — receipt with a log, and getLogs returns it — IS archive', async () => {
  const res = await probeHistoryAt(fakeNode({}) as never, BLOCK);
  assert.deepEqual(res, {retained: true});
});

test('inconclusive probes fail SAFE: an empty block keeps the lenient verdict, not a fabricated failure', async () => {
  const emptyBlock = await probeHistoryAt(fakeNode({txs: []}) as never, BLOCK);
  assert.equal(emptyBlock.retained, true);
  // A block whose transactions logged nothing is equally inconclusive.
  const noLogs = await probeHistoryAt(fakeNode({receipt: 'nologs'}) as never, BLOCK);
  assert.equal(noLogs.retained, true);
});

test('an unreadable block at depth is reported as unusable, naming the depth', async () => {
  const broken = {
    async getBlock() {
      throw new Error('missing trie node');
    },
  };
  const res = await probeHistoryAt(broken as never, BLOCK);
  assert.equal(res.retained, false);
  assert.match(res.reason ?? '', /can't read a block/);
});

test('a rate limit is NOT evidence of pruning — a healthy endpoint must not be libelled by a 429', async () => {
  // The receipt call couldn't be made, so it says nothing about retention: fall through to the
  // lenient check rather than reporting "history pruned" about an endpoint that is fine.
  const res = await probeHistoryAt(fakeNode({receipt: 'ratelimited'}) as never, BLOCK);
  assert.equal(res.retained, true);
  assert.equal(res.reason, undefined);
});
