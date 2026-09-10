// `verifyProvenance` — canonicity PLUS which generation of the anchors stamped the clone, and
// `verifyCanonical`'s explicit trust set.
//
// Both exist because a third-party host kept a fork of a rule we agree on. `verifyCanonical` had no
// way to take an operator's pinned allowlist (appending ours to theirs would make a GATE quietly more
// permissive than the operator asked for) and no way to report how many anchors answered (so a
// coverage gap and a real "no" looked identical from outside). And `false` conflated "deployed by an
// ABX factory since replaced" with "deployed outside the toolkit entirely" — its own docstring said
// so — which are very different things to show a collector.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, PublicClient} from 'viem';

import {verifyCanonical, verifyProvenance, canonicalFactories} from '../src/anchors.js';
import {ANCHOR_GENERATIONS, currentAnchorGeneration, resolveFactory} from '../src/deployments.js';

const SEPOLIA = 11155111;
const CLONE = '0x25C50AB3e6CcF6e02D9676A9c3e19f8E43261d68' as Address;
const FOREIGN = '0x00000000000000000000000000000000000F0001' as Address;

/** A chain where `match` claims the clone. `mode` decides how the others answer: `'success'` (a real
 *  "no") or `'failure'` (an RPC/anchor that never answered — evidence of nothing). */
function mockClient(probed: Address[][], match?: Address, mode: 'success' | 'failure' = 'success'): PublicClient {
  return {
    multicall: async ({contracts}: {contracts: Array<{address: Address}>}) => {
      probed.push(contracts.map((c) => c.address));
      return contracts.map((c) =>
        match && c.address.toLowerCase() === match.toLowerCase()
          ? {status: 'success' as const, result: true}
          : mode === 'failure'
            ? {status: 'failure' as const, error: new Error('no answer')}
            : {status: 'success' as const, result: false},
      );
    },
  } as unknown as PublicClient;
}

test('canonicalFactories is the one enumeration: six anchors, deduped', () => {
  const set = canonicalFactories(SEPOLIA);
  assert.equal(set.length, 6, `expected six trust anchors, got ${set.length} — a token family may be missing`);
  assert.equal(new Set(set.map((a) => a.toLowerCase())).size, 6);
});

test('a current-generation clone answers `current` with the core version — "canonically ABX v2"', async () => {
  const anchor = currentAnchorGeneration().factories.seriesFactory;
  const res = await verifyProvenance(mockClient([], anchor), CLONE, SEPOLIA);
  assert.equal(res.canonical, true);
  assert.equal(res.generation, 'current');
  assert.equal(res.generationId, currentAnchorGeneration().id);
  assert.equal(res.generationLifecycle, 'current');
  assert.equal(res.support?.reads, true);
  assert.equal(res.support?.serving, true);
  assert.equal(res.coreVersion, currentAnchorGeneration().coreVersion);
  assert.equal(res.factory, anchor);
  assert.equal(res.anchorsAnswered, 6);
});

test('a foreign contract is a settled `false` — anchors answered, none claimed it', async () => {
  const res = await verifyProvenance(mockClient([]), FOREIGN, SEPOLIA);
  assert.equal(res.canonical, false);
  assert.equal(res.generation, null);
  assert.equal(res.generationId, null);
  assert.equal(res.generationLifecycle, null);
  assert.equal(res.support, null);
  assert.equal(res.coreVersion, null);
  assert.ok(res.anchorsAnswered > 0, 'a settled `false` requires that something actually answered');
});

test('no anchor answered ⇒ `null` and anchorsAnswered 0 — a coverage gap, never a verdict', async () => {
  const res = await verifyProvenance(mockClient([], undefined, 'failure'), CLONE, SEPOLIA);
  assert.equal(res.canonical, null);
  assert.equal(res.anchorsAnswered, 0);
  // The same discipline in the gate itself.
  assert.equal(await verifyCanonical(mockClient([], undefined, 'failure'), CLONE, SEPOLIA), null);
});

test('an explicit trust set REPLACES the manifest — a pinned gate never widens', async () => {
  const pinned = [FOREIGN];
  const probed: Address[][] = [];
  // The clone IS canonical by the manifest; the operator did not pin its anchor, so the answer is no.
  const anchor = currentAnchorGeneration().factories.factory;
  const client = mockClient(probed, anchor);
  assert.equal(await verifyCanonical(client, CLONE, SEPOLIA, {factories: pinned}), false);
  assert.deepEqual(probed, [pinned], 'the manifest anchors must not be probed alongside a pinned set');

  const res = await verifyProvenance(client, CLONE, SEPOLIA, {factories: pinned});
  assert.equal(res.canonical, false);
  // Nor may an explicit set fall through to retired generations — that would widen it too.
  assert.deepEqual(probed[1], pinned);
});

test('a custom trusted factory does not manufacture ABX generation provenance', async () => {
  const res = await verifyProvenance(mockClient([], FOREIGN), CLONE, SEPOLIA, {factories: [FOREIGN]});
  assert.equal(res.canonical, true);
  assert.equal(res.factory, FOREIGN);
  assert.equal(res.generation, null);
  assert.equal(res.generationId, null);
  assert.equal(res.generationLifecycle, null);
  assert.equal(res.support, null);
  assert.equal(res.coreVersion, null);
});

test('the gate never consults prior generations — provenance is not trust', async () => {
  // Prior anchors answer for `verifyProvenance` only. This asserts the *wiring*, not the data: with
  // no prior generation yet, `verifyCanonical` still probes exactly the six live anchors and nothing
  // else, and it keeps holding as generations accumulate.
  const probed: Address[][] = [];
  await verifyCanonical(mockClient(probed), CLONE, SEPOLIA);
  assert.deepEqual(probed, [canonicalFactories(SEPOLIA)]);
  const priorAddrs = new Set(
    ANCHOR_GENERATIONS.filter((g) => g.lifecycle !== 'current')
      .flatMap((g) => Object.values(g.factories))
      .map((a) => a.toLowerCase()),
  );
  for (const probedAddr of probed.flat()) {
    assert.ok(!priorAddrs.has(probedAddr.toLowerCase()), `the gate probed a prior anchor: ${probedAddr}`);
  }
});

test('a chain with no anchors configured is `null`, not `false`', async () => {
  const UNKNOWN_CHAIN = 424242;
  assert.equal(resolveFactory(UNKNOWN_CHAIN), undefined);
  const res = await verifyProvenance(mockClient([]), CLONE, UNKNOWN_CHAIN);
  assert.equal(res.canonical, null);
  assert.equal(res.anchorsAnswered, 0);
});
