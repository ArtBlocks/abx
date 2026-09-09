import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData} from 'viem';
import {
  prepareSetTokenField,
  prepareLockTokenField,
  prepareDeployRenderer,
  prepareDeployFixedPriceMinter,
  batchOps,
  prepareMulticall,
  prepareCodeSetup,
} from '../src/ops.ts';
import {planContentTxs, planChunks, DEFAULT_CHUNK_SIZE, DEFAULT_TX_GAS_BUDGET} from '../src/chunks.ts';

const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const CHAIN = 11155111;

const MULTICALL_ABI = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{name: 'data', type: 'bytes[]'}],
    outputs: [{name: 'results', type: 'bytes[]'}],
  },
] as const;

function fieldOp(field: string, value: `0x${string}`, contract = TOKEN) {
  return prepareSetTokenField({contract, tokenId: 0, field, representation: 'inline', value, chainId: CHAIN});
}

test('batchOps merges a same-target run into one multicall', () => {
  const ops = [fieldOp('name', '0xaa'), fieldOp('description', '0xbb'), fieldOp('image', '0xcc')];
  const out = batchOps(ops);
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'multicall');
  assert.equal(out[0].to, TOKEN);
  // the multicall wraps exactly the three original calldatas
  const {args} = decodeFunctionData({abi: MULTICALL_ABI, data: out[0].data});
  assert.equal((args[0] as readonly unknown[]).length, 3);
});

test('batchOps keeps a lone op as-is and never folds a creation tx', () => {
  assert.equal(batchOps([fieldOp('name', '0xaa')])[0].op, 'set-field');
  const out = batchOps([prepareDeployRenderer({chainId: CHAIN}), fieldOp('name', '0xaa')]);
  assert.equal(out.length, 2);
  assert.equal(out[0].op, 'deploy-renderer'); // creation, never merged
  assert.equal(out[1].op, 'set-field');
});

test('batchOps never folds two CREATE2-proxy deploys together, even though they share a `to`', () => {
  // The renderer and the minter both deploy via the SAME keyless CREATE2 proxy address, so they
  // share `to` and carry no value — by the plain "same target, value-free" rule they'd look
  // mergeable. But the proxy has no `multicall`; folding them would produce a tx that reverts on
  // the address it's actually sent to. This is the hazard fixed alongside making these `prepare*`
  // functions route through CREATE2 for real (they used to be `to: null` and never hit this path).
  const out = batchOps([prepareDeployRenderer({chainId: CHAIN}), prepareDeployFixedPriceMinter({chainId: CHAIN})]);
  assert.equal(out.length, 2, 'each CREATE2-proxy deploy stays its own transaction');
  assert.equal(out[0].op, 'deploy-renderer');
  assert.equal(out[1].op, 'deploy-fixed-price-minter');
});

test('batchOps splits runs when the target changes (order preserved)', () => {
  const out = batchOps([
    fieldOp('a', '0xaa', TOKEN),
    fieldOp('b', '0xbb', TOKEN),
    fieldOp('c', '0xcc', OTHER),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].op, 'multicall');
  assert.equal(out[0].to, TOKEN);
  assert.equal(out[1].op, 'set-field');
  assert.equal(out[1].to, OTHER);
});

test('prepareMulticall rejects mixed targets and value-bearing ops', () => {
  assert.throws(() => prepareMulticall({ops: [fieldOp('a', '0xaa', TOKEN), fieldOp('b', '0xbb', OTHER)]}), /same contract/);
  const valued = {...fieldOp('a', '0xaa'), value: '0x1' as const};
  assert.throws(() => prepareMulticall({ops: [valued]}), /value-free/);
});

test('lock + set in one batch round-trips through the multicall', () => {
  const ops = [fieldOp('image', '0xcc'), prepareLockTokenField({contract: TOKEN, tokenId: 0, field: 'image', chainId: CHAIN})];
  const out = batchOps(ops);
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'multicall');
});

test('planContentTxs: small content is a single atomic tx', () => {
  const chunks = planChunks(new Uint8Array(1_000));
  const plan = planContentTxs(chunks);
  assert.equal(plan.mode, 'single');
  assert.equal(plan.txCount, 1);
});

test('planChunks: chunk count keys off DEFAULT_CHUNK_SIZE — a few-KB file is ONE chunk', () => {
  // Regression: an agent guessed "~2 chunks" for a 2.4 KB SVG. The 22 KB chunk size means
  // anything up to DEFAULT_CHUNK_SIZE is exactly one chunk (one staging tx).
  assert.equal(planChunks(new Uint8Array(2_421)).length, 1, '2.4 KB → 1 chunk');
  assert.equal(planChunks(new Uint8Array(DEFAULT_CHUNK_SIZE)).length, 1, 'exactly the chunk size → 1 chunk');
  assert.equal(planChunks(new Uint8Array(DEFAULT_CHUNK_SIZE + 1)).length, 2, 'one byte over → 2 chunks');
  assert.equal(planChunks(new Uint8Array(DEFAULT_CHUNK_SIZE * 3 - 1)).length, 3, 'just under 3× → 3 chunks');
});

test('planContentTxs: oversized content splits into gas-bounded batches + manifest', () => {
  // ~200 kB of incompressible-ish data → many chunks, exceeding one tx's budget.
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  const chunks = planChunks(big);
  const plan = planContentTxs(chunks, {gasBudget: DEFAULT_TX_GAS_BUDGET});
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.ok(plan.batches.length >= 2, 'should need multiple batches');
    assert.equal(plan.txCount, plan.batches.length + 1); // + manifest tx
    // every batch fits the budget
    const gas = (cs: typeof chunks) => cs.reduce((g, c) => g + 40_000 + c.data.length * 240, 0);
    for (const b of plan.batches) assert.ok(gas(b) <= DEFAULT_TX_GAS_BUDGET);
  }
});

// ── code-setup gas floor ─────────────────────────────────────────────────────────
// A `deploy-code` setup multicall stores the program as on-chain content, so its cost is dominated
// by CREATE code deposit (~200 gas/byte) — invisible to an `eth_estimateGas` taken while the target
// clone's code has not propagated to the answering node, which returns the CALLDATA cost alone. That
// is how every attempt in a reporter's session sent 201,616 gas for a call needing 941,331 and
// reverted `DeploymentFailed()`. The floor exists so an under-estimate cannot underfund the CREATE.

test('prepareCodeSetup: gasFloor is the bare, provable code deposit', () => {
  const tx = prepareCodeSetup({
    contract: '0x7CcC774271daa029cF0284BE913611Bc66eA5155',
    calls: ['0x1234'],
    chainId: 84532,
    chunkCount: 1,
    chunkBytes: [3563], // the reported minimal failing case
    schemaKeys: [],
  });
  // Exactly 200 gas/byte and NOT A GRAM MORE. This is a detector for an impossible estimate, so it
  // must be un-arguable: padding it would (a) risk rejecting a legitimate estimate and (b) tempt a
  // caller into sending it as the gas limit, which would under-fund any setup carrying schema,
  // dependency or mint legs — the very bug this whole mechanism exists to prevent.
  assert.equal(BigInt(tx.gasFloor!), 712_600n);
  // Below the 941,331 the chain really needs for this payload — deliberately. The floor proves an
  // estimate is broken; it never claims to be sufficient.
  assert.ok(BigInt(tx.gasFloor!) < 941_331n);
});

test('prepareCodeSetup: the floor scales with the payload, it is not a constant', () => {
  const one = prepareCodeSetup({
    contract: '0x7CcC774271daa029cF0284BE913611Bc66eA5155',
    calls: ['0x1234'], chainId: 84532, chunkCount: 1, chunkBytes: [3563], schemaKeys: [],
  });
  const two = prepareCodeSetup({
    contract: '0x7CcC774271daa029cF0284BE913611Bc66eA5155',
    calls: ['0x1234'], chainId: 84532, chunkCount: 2, chunkBytes: [3563, 3563], schemaKeys: [],
  });
  assert.equal(BigInt(two.gasFloor!), BigInt(one.gasFloor!) * 2n);
});

test('prepareCodeSetup: a chunk-free setup carries no floor (ordinary calldata work)', () => {
  const tx = prepareCodeSetup({
    contract: '0x7CcC774271daa029cF0284BE913611Bc66eA5155',
    calls: ['0x1234'], chainId: 84532, chunkCount: 0, chunkBytes: [], schemaKeys: ['palette'],
  });
  assert.equal(tx.gasFloor, undefined);
});
