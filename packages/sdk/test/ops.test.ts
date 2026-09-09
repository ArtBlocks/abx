// The royalty ceiling is now PER-COLLECTION: owner-set at deploy (0–10000 bps, up to 100%) and
// reduce-only after (`RoyaltyExtension.maxRoyaltyBps`). So `MAX_ROYALTY_BPS` is the ABSOLUTE protocol
// maximum (10000), and a collection's own — possibly lower — cap is the binding one, enforced on
// chain. `prepareSetRoyalty` refuses locally against whichever cap the caller supplies (`maxBps` =
// the live `maxRoyaltyBps()`, else the absolute max) so an over-cap change fails instant/local/free
// rather than as a signed, gas-paid revert.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address} from 'viem';
import {MAX_ROYALTY_BPS, prepareSetRoyalty, prepareReduceMaxRoyaltyBps} from '../src/ops.js';

const TOKEN = '0x00000000000000000000000000000000000000a1' as Address;
const RECEIVER = '0x00000000000000000000000000000000000000b2' as Address;
const CHAIN = 84532;

test('MAX_ROYALTY_BPS is the absolute protocol maximum (100%)', () => {
  assert.equal(MAX_ROYALTY_BPS, 10000);
});

test('prepareSetRoyalty refuses above the absolute max, and above a supplied per-collection cap', () => {
  // Above the absolute max: always refused, no cap needed.
  for (const bps of [MAX_ROYALTY_BPS + 1, 20000]) {
    assert.throws(
      () => prepareSetRoyalty({contract: TOKEN, receiver: RECEIVER, bps, chainId: CHAIN}),
      /out of range|cap/,
      `${bps} bps exceeds 100% and must fail locally`,
    );
  }
  // Within the absolute max but above THIS collection's cap: refused when the cap is supplied.
  for (const bps of [1001, 1500, 5000]) {
    assert.throws(
      () => prepareSetRoyalty({contract: TOKEN, receiver: RECEIVER, bps, chainId: CHAIN, maxBps: 1000}),
      /out of range|cap/,
      `${bps} bps is above the collection's 10% cap and must fail locally`,
    );
  }
  // At or below the supplied cap: builds fine (a legitimate 42% collection).
  assert.doesNotThrow(() =>
    prepareSetRoyalty({contract: TOKEN, receiver: RECEIVER, bps: 4200, chainId: CHAIN, maxBps: 4200}),
  );
});

test('prepareSetRoyalty accepts zero, the common rates, and the cap itself', () => {
  for (const bps of [0, 250, 500, 750, MAX_ROYALTY_BPS]) {
    const tx = prepareSetRoyalty({contract: TOKEN, receiver: RECEIVER, bps, chainId: CHAIN});
    assert.equal(tx.to, TOKEN, `${bps} bps must build`);
  }
});

test('prepareSetRoyalty still refuses a negative rate', () => {
  assert.throws(() => prepareSetRoyalty({contract: TOKEN, receiver: RECEIVER, bps: -1, chainId: CHAIN}), /out of range/);
});

// `prepareReduceMaxRoyaltyBps` is the owner's reduce-only cap lever (RoyaltyExtension.reduceMaxRoyaltyBps).
// The builder itself is domain-only (0–100%); the reduce-only + not-below-royalty invariants are the
// CLI's preflight (it reads the live cap + rate) and the chain's, not this pure function's.
test('prepareReduceMaxRoyaltyBps builds a reduceMaxRoyaltyBps tx within the absolute domain', () => {
  for (const bps of [0, 1000, 4200, MAX_ROYALTY_BPS]) {
    const tx = prepareReduceMaxRoyaltyBps({contract: TOKEN, newMaxBps: bps, chainId: CHAIN});
    assert.equal(tx.to, TOKEN, `${bps} must build`);
    assert.equal(tx.op, 'set-royalty-cap');
  }
});

test('prepareReduceMaxRoyaltyBps refuses a value outside 0–10000', () => {
  for (const bps of [-1, MAX_ROYALTY_BPS + 1, 20000]) {
    assert.throws(() => prepareReduceMaxRoyaltyBps({contract: TOKEN, newMaxBps: bps, chainId: CHAIN}), /out of range/);
  }
});
