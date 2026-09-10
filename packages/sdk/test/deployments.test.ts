import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ANCHOR_GENERATIONS,
  currentAnchorGeneration,
  findAnchorGenerationByCoreVersion,
  findAnchorGenerationByFactory,
  findAnchorGenerationForProject,
  findAnchorGenerationById,
  DEPLOYMENTS,
  getDeployment,
  isCurrentGenerator,
  resolveGenerator,
  resolveRenderer,
  supportsGenerationOperation,
  summarizeAnchorGeneration,
} from '../src/deployments.js';
import {predictChunkStore, predictRenderer, predictFixedPriceMinter, predictSeedSource} from '../src/create2.js';
import {isAddress} from 'viem';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const GENERATOR = '0xb7104ADfa6fb5615E46e2a681A2Ff043B08fADB5';
const RENDERER = '0x85C1aE1F076d808fF7c1729F21B85038Fa16105E';

// Every recorded address must be a VALID EIP-55 checksum, not merely 40 hex characters.
//
// This is not pedantry: viem refuses a mis-checksummed address at `readContract`/`writeContract`, so
// one wrong nibble of casing in the manifest turns into `Address "0x…" is invalid` at the point of
// use — and the manifest is the one place nobody re-derives it. Both AbxGenerator entries shipped
// that way once (the address was right, the casing was mangled in transcription), which broke every
// on-chain-URI read on both testnets while the per-entry equality tests below stayed green, because
// they compared against the same mangled string. A property over the whole manifest is what catches
// the next one.
test('manifest: every address is a valid EIP-55 checksum', () => {
  for (const [chain, record] of Object.entries(DEPLOYMENTS)) {
    for (const [name, value] of Object.entries(record)) {
      if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) continue;
      assert.ok(isAddress(value), `chain ${chain}: ${name} = ${value} is not a valid checksummed address`);
    }
  }
});

// The manifest is the zero-state trust root: the canonical generator + the CURRENT renderer
// rev (spec v9 — CREATE2, route-only field provenance, no abx_params, no duplicated image artifact) must
// resolve with no env and no flags.
test('manifest: sepolia ships the canonical generator + the current renderer rev', () => {
  assert.equal(DEPLOYMENTS[SEPOLIA].generator, GENERATOR);
  assert.equal(DEPLOYMENTS[SEPOLIA].renderer, RENDERER);
  assert.equal(resolveGenerator(SEPOLIA), GENERATOR);
  assert.equal(resolveRenderer(SEPOLIA), RENDERER);
  // an unshipped chain resolves to nothing (the CLI degrades to guidance, never a silent deploy)
  assert.equal(resolveGenerator(8453), undefined);
  assert.deepEqual(getDeployment(8453), {});
});

// The CREATE2 invariant: the deterministic address the CLI's lazy deployers land at (and self-heal
// to) MUST equal the manifest address — otherwise `ensureRenderer`/`ensureChunkStore` would deploy a
// duplicate at a different address. Guards against salt-string or bytecode drift vs. AbxSalts.sol.
test('lazy-deploy CREATE2 predictions equal the manifest addresses (both chains)', () => {
  assert.equal(predictRenderer(), DEPLOYMENTS[SEPOLIA].renderer);
  assert.equal(predictChunkStore(), DEPLOYMENTS[SEPOLIA].chunkStore);
  assert.equal(predictFixedPriceMinter(), DEPLOYMENTS[SEPOLIA].fixedPriceMinter);
  assert.equal(predictSeedSource(), DEPLOYMENTS[SEPOLIA].seedSource);
  // canonical infra is cross-chain-identical, so the same prediction serves every chain
  assert.equal(DEPLOYMENTS[BASE_SEPOLIA].renderer, DEPLOYMENTS[SEPOLIA].renderer);
  assert.equal(DEPLOYMENTS[BASE_SEPOLIA].chunkStore, DEPLOYMENTS[SEPOLIA].chunkStore);
});

// Precedence is override → env → manifest — identical to every other resolver (resolveRenderer
// is the model). The env lane is how an operator declares a private/unshipped deployment.
test('resolveGenerator: explicit override → ABX_GENERATOR env → manifest', () => {
  const OVERRIDE = '0x1111111111111111111111111111111111111111';
  const ENV = '0x2222222222222222222222222222222222222222';
  const before = process.env.ABX_GENERATOR;
  try {
    delete process.env.ABX_GENERATOR;
    assert.equal(resolveGenerator(SEPOLIA), GENERATOR); // manifest
    process.env.ABX_GENERATOR = ENV;
    assert.equal(resolveGenerator(SEPOLIA), ENV); // env beats manifest
    assert.equal(resolveGenerator(8453), ENV); // env also covers an unshipped chain
    assert.equal(resolveGenerator(SEPOLIA, OVERRIDE), OVERRIDE); // override beats env
  } finally {
    if (before === undefined) delete process.env.ABX_GENERATOR;
    else process.env.ABX_GENERATOR = before;
  }
});

// ── isCurrentGenerator: the per-collection singleton check ─────────────────────────────────────
//
// The factory-generation ladder above ({@link ANCHOR_GENERATIONS}) already answers "which
// generation of the trust anchors deployed this collection". The other half is the SINGLETON a
// collection's `animation_url` field can pin — the generator — which this manifest deliberately
// keeps NO history for (see the file docstring). So the check is binary: does the collection's
// stored pointer match today's canonical generator, or not. A `false` here is not a defect; it just
// isn't distinguishable from "a prior generation" vs "a fully custom renderer" without a registry
// this file intentionally does not keep.
test('isCurrentGenerator: true for the manifest address, false for anything else, on a shipped chain', () => {
  assert.equal(isCurrentGenerator(SEPOLIA, GENERATOR), true);
  assert.equal(isCurrentGenerator(SEPOLIA, '0x1111111111111111111111111111111111111111'), false);
  // a DIFFERENT chain's canonical generator is not THIS chain's canonical generator either
  assert.equal(isCurrentGenerator(SEPOLIA, DEPLOYMENTS[BASE_SEPOLIA].generator!), false);
});

test('isCurrentGenerator: address comparison is case-insensitive (viem/EIP-55 casing must not matter)', () => {
  assert.equal(isCurrentGenerator(SEPOLIA, GENERATOR.toLowerCase() as typeof GENERATOR), true);
  assert.equal(isCurrentGenerator(SEPOLIA, GENERATOR.toUpperCase().replace('0X', '0x') as typeof GENERATOR), true);
});

test('isCurrentGenerator: null (not false) when the chain has no canonical generator recorded at all', () => {
  // An unshipped chain is a DIFFERENT fact from "doesn't match" — collapsing the two would report a
  // collection on a chain this manifest has never heard of as if it were pinned to something wrong.
  assert.equal(isCurrentGenerator(8453, GENERATOR), null);
});

// ── anchor generations: the identity that makes "canonically ABX v2" sayable ──────────────────
//
// The manifest records which generation of the trust anchors deployed a clone, keyed by the CORE
// VERSION those anchors stamp — so a collection can prove what it is by reading its own
// `abxVersion()`, which keeps working after its factory is retired. That identity only holds if one
// core version means one generation, and the way to make a convention hold is not to write it down:
// it is these three assertions, which fail the suite if a redeploy batch forgets to bump.
//
test('generations: core versions are unique and increasing — one core version, one generation', () => {
  const versions = ANCHOR_GENERATIONS.map((g) => g.coreVersion);
  assert.deepEqual(
    versions,
    [...new Set(versions)],
    `two generations claim the same core version: ${versions.join(', ')}.\n` +
      `A redeploy batch that changes runtime MUST bump AbxVersion.CORE_VERSION — ` +
      `see the redeploy checklist in contracts/README.md.`,
  );
  const ascending = [...versions].sort((a, b) => b - a);
  assert.deepEqual(versions, ascending, 'ANCHOR_GENERATIONS must be newest-first (descending coreVersion)');
});

test('generations: `prior` is unreachable until a generation is superseded, and that is a state, not a gap', () => {
  // Today ANCHOR_GENERATIONS holds exactly one entry, so `verifyProvenance` can only answer
  // 'current' or nothing — the prior-generation lane is built and untravelled. That is deliberate
  // (pre-launch testnet generations are disposable and not backfilled), but it is worth asserting so
  // nobody reads the feature's presence as evidence it has ever answered, and so the day a batch
  // retires an anchor set this test is what says the lane went live.
  const prior = ANCHOR_GENERATIONS.filter((g) => g.lifecycle !== 'current');
  if (prior.length === 0) {
    assert.equal(ANCHOR_GENERATIONS.length, 1, 'no prior generations, so there should be exactly one entry');
    return;
  }
  // Once a generation HAS been superseded: every prior entry must carry a full six-anchor set, or a
  // provenance lookup would silently skip whichever family is missing — the same hole that once made
  // every canonical edition read `canonical: NO`.
  for (const gen of prior) {
    assert.ok(gen.retired, `prior generation ${gen.id} must record when it was retired`);
    assert.equal(gen.support.newDeployments, false, `prior generation ${gen.id} cannot accept new deployments`);
    assert.equal(
      Object.keys(gen.factories).length,
      6,
      `prior generation v${gen.coreVersion} lists ${Object.keys(gen.factories).length} anchors, not 6`,
    );
  }
});

test('generations: exactly one is current, and it is first', () => {
  const current = ANCHOR_GENERATIONS.filter((g) => g.lifecycle === 'current');
  assert.equal(current.length, 1, 'exactly one generation may be current');
  assert.equal(ANCHOR_GENERATIONS[0], current[0]);
  assert.equal(currentAnchorGeneration(), current[0]);
  assert.equal(current[0].retired, undefined);
  assert.equal(supportsGenerationOperation(current[0], 'newDeployments'), true);
});

test('generations: stable identity and factory lookups resolve the current generation', () => {
  const current = currentAnchorGeneration();
  assert.equal(current.id, 'abx-core-v2');
  assert.equal(findAnchorGenerationById(current.id), current);
  assert.equal(findAnchorGenerationByCoreVersion(current.coreVersion), current);
  assert.equal(findAnchorGenerationByFactory(current.factories.editionCodeFactory), current);
  assert.equal(
    findAnchorGenerationForProject({
      abxVersion: current.coreVersion,
      factory: current.factories.editionCodeFactory,
      isCanonical: true,
    }),
    current,
  );
  assert.deepEqual(summarizeAnchorGeneration(current), {
    id: current.id,
    coreVersion: current.coreVersion,
    lifecycle: current.lifecycle,
    support: current.support,
  });
});

test('generations: project lookup requires factory proof and a matching on-chain core version', () => {
  const current = currentAnchorGeneration();
  const project = {
    abxVersion: current.coreVersion,
    factory: current.factories.factory,
    isCanonical: true,
  };
  assert.equal(findAnchorGenerationForProject({...project, isCanonical: false}), undefined);
  assert.equal(findAnchorGenerationForProject({...project, abxVersion: current.coreVersion + 1}), undefined);
  assert.equal(findAnchorGenerationForProject({...project, factory: null}), undefined);
});

test('generations: the current one matches AbxVersion.CORE_VERSION in the contracts', () => {
  // Read the constant from source rather than mirroring it here — mirroring is the drift this guards.
  const sol = readFileSync(new URL('../../../contracts/src/libraries/AbxVersion.sol', import.meta.url), 'utf8');
  const m = /CORE_VERSION\s*=\s*(\d+)/.exec(sol);
  assert.ok(m, 'could not find CORE_VERSION in contracts/src/libraries/AbxVersion.sol');
  assert.equal(
    currentAnchorGeneration().coreVersion,
    Number(m![1]),
    'the recorded current generation and the contracts disagree about the core version. Bumping the ' +
      'constant means recording a new generation (and retiring the old one); recording one means bumping.',
  );
});

test('generations: the current generation IS the live trust set — no drift between the two', () => {
  const live = DEPLOYMENTS[SEPOLIA];
  assert.deepEqual(currentAnchorGeneration().factories, {
    factory: live.factory,
    seriesFactory: live.seriesFactory,
    seriesCodeFactory: live.seriesCodeFactory,
    oneOfOneEditionFactory: live.oneOfOneEditionFactory,
    editionFactory: live.editionFactory,
    editionCodeFactory: live.editionCodeFactory,
  });
});

test('generations: a prior generation never leaks into the live record (provenance is not trust)', () => {
  // Prior generations are provenance only. The type forbids libraries/singletons here at all; this
  // check keeps their retired factory addresses out of the live trust set.
  const liveAddrs = new Set(
    Object.values(DEPLOYMENTS)
      .flatMap((d) => Object.values(d))
      .filter((v): v is string => typeof v === 'string')
      .map((a) => a.toLowerCase()),
  );
  for (const gen of ANCHOR_GENERATIONS.filter((g) => g.lifecycle !== 'current')) {
    for (const [name, addr] of Object.entries(gen.factories)) {
      assert.ok(
        !liveAddrs.has(addr.toLowerCase()),
        `prior generation v${gen.coreVersion}'s ${name} (${addr}) is still in the live manifest`,
      );
    }
  }
});
