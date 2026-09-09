// `detectCanonicalFactory` must probe ALL SIX trust anchors — the three 721 ones and the three
// ERC-1155 edition ones.
//
// Regression: it was written when only the 721 anchors existed and the edition anchors were never
// added, so for any edition it matched nothing and fell back to `resolveFactory` (the 721 1/1
// anchor). That fallback answers `isAbxClone` = FALSE, so `abx verify` reported every
// genuinely-canonical edition as `canonical: NO — not a clone of the configured factory`. The
// docstring's promise ("canonicity just shows unverified, never wrong") was inverted: canonicality is
// the one signal a platform allowlist keys on, and the whole 1155 line failed it.
//
// A mocked multicall records which factories were probed, so this pins the candidate SET rather than
// just the happy-path answer — the set is the thing that silently went stale.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, PublicClient} from 'viem';
import {detectCanonicalFactory} from '../src/anchors.js';
import {
  resolveFactory,
  resolveSeriesFactory,
  resolveSeriesCodeFactory,
  resolveOneOfOneEditionFactory,
  resolveEditionFactory,
  resolveEditionCodeFactory,
} from '../src/deployments.js';

const BASE_SEPOLIA = 84532;
const CLONE = '0x25C50AB3e6CcF6e02D9676A9c3e19f8E43261d68' as Address;

/** Records the probed factories; `match` is the one whose `isAbxClone` returns true (none if unset). */
function mockClient(probed: Address[], match?: Address): PublicClient {
  const client = {
    multicall: async ({contracts}: {contracts: Array<{address: Address}>}) => {
      probed.push(...contracts.map((c) => c.address));
      return contracts.map((c) => ({status: 'success' as const, result: match ? c.address === match : false}));
    },
  };
  return client as unknown as PublicClient;
}

const lower = (a: string | undefined) => (a ?? '').toLowerCase();

test('detectCanonicalFactory probes all three EDITION anchors, not just the 721 ones', async () => {
  const probed: Address[] = [];
  await detectCanonicalFactory(mockClient(probed), CLONE, {chainId: BASE_SEPOLIA});
  const set = new Set(probed.map(lower));
  for (const [name, addr] of [
    ['OneOfOneEditionFactory', resolveOneOfOneEditionFactory(BASE_SEPOLIA)],
    ['EditionImageFactory', resolveEditionFactory(BASE_SEPOLIA)],
    ['EditionCodeFactory', resolveEditionCodeFactory(BASE_SEPOLIA)],
  ] as Array<[string, string | undefined]>) {
    assert.ok(addr, `${name} should be in the manifest for this chain`);
    assert.ok(set.has(lower(addr)), `${name} (${addr}) was never probed — an edition would fall back to the 721 anchor and read as NOT canonical`);
  }
});

test('detectCanonicalFactory still probes the three 721 anchors', async () => {
  const probed: Address[] = [];
  await detectCanonicalFactory(mockClient(probed), CLONE, {chainId: BASE_SEPOLIA});
  const set = new Set(probed.map(lower));
  for (const addr of [resolveFactory(BASE_SEPOLIA), resolveSeriesFactory(BASE_SEPOLIA), resolveSeriesCodeFactory(BASE_SEPOLIA)]) {
    assert.ok(addr && set.has(lower(addr)), `721 anchor ${addr} was never probed`);
  }
});

test('detectCanonicalFactory returns the EDITION anchor that claims the clone', async () => {
  const editionFactory = resolveOneOfOneEditionFactory(BASE_SEPOLIA) as Address;
  const hit = await detectCanonicalFactory(mockClient([], editionFactory), CLONE, {chainId: BASE_SEPOLIA});
  assert.equal(lower(hit), lower(editionFactory));
});

test('detectCanonicalFactory returns the 721 anchor that claims the clone', async () => {
  const seriesFactory = resolveSeriesFactory(BASE_SEPOLIA) as Address;
  const hit = await detectCanonicalFactory(mockClient([], seriesFactory), CLONE, {chainId: BASE_SEPOLIA});
  assert.equal(lower(hit), lower(seriesFactory));
});

test('an explicit override or a stored factory still short-circuits the probe entirely', async () => {
  const probed: Address[] = [];
  const override = '0x00000000000000000000000000000000000000ab' as Address;
  assert.equal(await detectCanonicalFactory(mockClient(probed), CLONE, {chainId: BASE_SEPOLIA, override}), override);
  const stored = '0x00000000000000000000000000000000000000cd';
  assert.equal(await detectCanonicalFactory(mockClient(probed), CLONE, {chainId: BASE_SEPOLIA, stored}), stored);
  assert.equal(probed.length, 0, 'neither path should have probed the chain');
});
