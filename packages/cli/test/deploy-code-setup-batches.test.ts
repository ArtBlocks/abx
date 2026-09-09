/**
 * `deploy-code`'s gas-bounded setup-transaction splitting (w7 sweep): a `deploy-code` setup used to
 * ride ONE atomic multicall no matter how large the on-chain script was. A 60KB script (3 chunks)
 * produced a setup transaction wanting 17,307,586 gas against the ~16,777,216 (2^24)
 * `eth_estimateGas` ceiling (not the block gas limit) and failed with a useless "gas limit too high",
 * leaving a verifiably half-configured contract on chain.
 *
 * These are pure unit tests of `planCodeSetupBatches`/`codeSetupTxsFromBatches` — no chain, no CLI
 * subprocess — covering the four things the fix promises: a small setup stays exactly one
 * transaction (no behavior change for the common case); a large one splits into gas-bounded batches,
 * ordered chunks → config → mints, mints strictly last; and a single leg that alone exceeds the
 * `eth_estimateGas` ceiling refuses BEFORE building anything, with real numbers.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toHex, type Hex} from 'viem';
import {DEFAULT_TX_GAS_BUDGET, MEASURED_ESTIMATE_GAS_ALLOWANCE, estimateChunkGasForBytes} from '@artblocks/abx-sdk';
import {
  chunkSetupLeg,
  schemaSetupLeg,
  depsSetupLeg,
  uriSetupLeg,
  mintSetupLeg,
  planCodeSetupBatches,
  codeSetupTxsFromBatches,
  type SetupLeg,
} from '../src/commands/deploy.js';

const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const CHAIN_ID = 11155111;

/** A throwaway calldata blob of `n` zero bytes — content never matters for these tests, only length
 *  (which drives the chunk's gas estimate) and identity (so batch membership is checkable). */
function hexOfBytes(n: number, fill = 0): Hex {
  return toHex(new Uint8Array(n).fill(fill));
}

test('planCodeSetupBatches: an empty setup is zero batches', () => {
  assert.deepEqual(planCodeSetupBatches({chunks: [], config: [], mints: []}), []);
});

test('planCodeSetupBatches: a small setup (a few chunks + a schema + a mint) stays ONE combined transaction — no behavior change for the common case', () => {
  const chunks = [chunkSetupLeg(0, hexOfBytes(2_000), '0xaa')];
  const config = [schemaSetupLeg('palette', '0xbb')];
  const mints = [mintSetupLeg('0xcc')];
  const batches = planCodeSetupBatches({chunks, config, mints});
  assert.equal(batches.length, 1, 'everything still fits one transaction');
  assert.deepEqual(
    batches[0].map((l) => l.kind),
    ['chunk', 'schema', 'mint'],
    'the single batch preserves chunks-then-config-then-mints order even though nothing forced a split',
  );
});

test('planCodeSetupBatches: a large script (60KB / 3 chunks) splits into MULTIPLE gas-bounded transactions', () => {
  // Mirrors the reported failure: a 60KB script chunked at ~22KB (DEFAULT_SCRIPT_CHUNK_SIZE) is 3
  // chunks. Each one alone already exceeds half the tx budget, so no two can share a transaction.
  const chunkBytes = [22_000, 22_000, 16_000];
  const chunks = chunkBytes.map((n, i) => chunkSetupLeg(i, hexOfBytes(n), toHex(new Uint8Array([i]))));
  const totalChunkGas = chunkBytes.reduce((g, n) => g + estimateChunkGasForBytes(n), 0);
  assert.ok(totalChunkGas > DEFAULT_TX_GAS_BUDGET, 'sanity: the reported case truly cannot fit one tx');
  assert.ok(totalChunkGas < MEASURED_ESTIMATE_GAS_ALLOWANCE * 3, 'sanity: still well within what MULTIPLE txs can carry');

  const batches = planCodeSetupBatches({chunks, config: [], mints: []});
  assert.ok(batches.length > 1, `expected >1 setup transaction, got ${batches.length}`);
  // Every batch fits the budget — the whole point of the split.
  for (const batch of batches) {
    const gas = batch.reduce((g, l) => g + l.gas, 0);
    assert.ok(gas <= DEFAULT_TX_GAS_BUDGET, `batch gas ${gas} must stay under the ${DEFAULT_TX_GAS_BUDGET} budget`);
  }
  // No chunk is dropped or duplicated, and order is preserved.
  const seen = batches.flatMap((b) => b.map((l) => l.chunkBytes?.[0]));
  assert.deepEqual(seen, chunkBytes);
});

test('planCodeSetupBatches: chunks, config, and mints never share a batch once a split is needed — mints strictly last', () => {
  // Oversized chunks force a split; a cheap schema/dep/uri config leg and a mint leg ride along.
  const chunks = [0, 1, 2].map((i) => chunkSetupLeg(i, hexOfBytes(22_000), toHex(new Uint8Array([i]))));
  const config = [schemaSetupLeg('palette', '0xaa'), depsSetupLeg(['0xbb', '0xcc']), uriSetupLeg(['0xdd', '0xee'])];
  const mints = [mintSetupLeg('0xf1'), mintSetupLeg('0xf2'), mintSetupLeg('0xf3')];
  const batches = planCodeSetupBatches({chunks, config, mints});
  assert.ok(batches.length > 1, 'the oversized chunks force a split');

  const kindsPerBatch = batches.map((b) => new Set(b.map((l) => l.kind)));
  for (const kinds of kindsPerBatch) {
    // A batch is homogeneous in GROUP terms: chunk-only, config-only (schema/deps/uri may mix with
    // each other), or mint-only — never chunk+mint, config+mint, or chunk+config.
    const hasMint = kinds.has('mint');
    const hasChunk = kinds.has('chunk');
    const hasConfig = kinds.has('schema') || kinds.has('deps') || kinds.has('uri');
    assert.ok(Number(hasMint) + Number(hasChunk) + Number(hasConfig) <= 1, `batch mixes groups: ${[...kinds].join(',')}`);
  }
  // The LAST batch(es) are exactly the mint batch(es); nothing mint-shaped appears before a non-mint
  // leg later in the sequence.
  const firstMintBatchIndex = kindsPerBatch.findIndex((k) => k.has('mint'));
  assert.ok(firstMintBatchIndex !== -1, 'mints must appear somewhere');
  for (let i = firstMintBatchIndex; i < kindsPerBatch.length; i++) {
    assert.ok(kindsPerBatch[i].has('mint') && kindsPerBatch[i].size === 1, `batch ${i} after the first mint batch must be mint-only`);
  }
});

test('planCodeSetupBatches: refuses BEFORE building anything when a single leg alone exceeds the eth_estimateGas ceiling', () => {
  // No realistic `deploy-code` leg can hit this today (a script chunk is capped well under it by
  // EIP-170; schema/dependency/uri/mint legs are flat, small estimates) — this is the defensive net
  // for an indivisible leg that batching cannot fix, so it must never reach a raw "gas limit too high".
  const oversizedBytes = 100_000; // 40_000 + 100_000*240 ≈ 24,040,000 > MEASURED_ESTIMATE_GAS_ALLOWANCE
  const hugeLeg: SetupLeg = chunkSetupLeg(0, hexOfBytes(oversizedBytes), '0xaa');
  assert.ok(hugeLeg.gas > MEASURED_ESTIMATE_GAS_ALLOWANCE, 'sanity: this leg really is too big alone');
  assert.throws(
    () => planCodeSetupBatches({chunks: [hugeLeg], config: [], mints: []}),
    (err: Error) => {
      assert.ok(err.message.includes(hugeLeg.gas.toLocaleString()), `message should name the leg's real gas: ${err.message}`);
      assert.ok(
        err.message.includes(MEASURED_ESTIMATE_GAS_ALLOWANCE.toLocaleString()),
        `message should name the real ceiling: ${err.message}`,
      );
      assert.doesNotMatch(err.message, /^gas limit too high$/i);
      return true;
    },
  );
});

test('codeSetupTxsFromBatches: rebuilds each batch\'s own chunk/schema/dependency/on-chain-URI labeling', () => {
  const chunks = [chunkSetupLeg(0, hexOfBytes(3_563), '0xaa')];
  const config = [schemaSetupLeg('palette', '0xbb'), uriSetupLeg(['0xcc', '0xdd'])];
  const mints = [mintSetupLeg('0xee')];
  const batches = planCodeSetupBatches({chunks, config, mints}); // small ⇒ one combined batch
  assert.equal(batches.length, 1);
  const txs = codeSetupTxsFromBatches(batches, {contract: CONTRACT, chainId: CHAIN_ID, deps: ['p5@1.0.0']});
  assert.equal(txs.length, 1);
  assert.match(txs[0].summary, /store your program/i);
  assert.match(txs[0].summary, /palette/i);
  assert.match(txs[0].summary, /on-chain metadata resolution/i);
  // No dependency leg rode this batch, so the summary must not claim one.
  assert.doesNotMatch(txs[0].summary, /dependenc/i);
});
