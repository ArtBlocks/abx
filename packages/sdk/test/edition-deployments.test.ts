// ERC-1155 editions: CREATE2 predictions are stable + independent of call order, and the four new
// ChainDeployment fields resolve override → env → manifest exactly like every existing resolver
// (deployments.test.ts is the model). CANONICAL carries identical edition anchors on every shipped chain,
// so the manifest leg resolves to the recorded addresses and
// env/override must still WIN over it (the harder precedence case than an empty manifest).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOneOfOneEditionFactory,
  resolveEditionFactory,
  resolveEditionCodeFactory,
  resolveFixedPriceMinter1155,
  getDeployment,
} from '../src/deployments.js';
import {predictOneOfOneEditionFactory, predictEditionFactory, predictFixedPriceMinter1155} from '../src/create2.js';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const ARBITRUM_SEPOLIA = 421614;

// The canonical edition anchors (see deployments.ts CANONICAL + reference/deployments.mdx).
const ONE_OF_ONE_EDITION_FACTORY = '0x4e9dFcC70dCC02FA5bad113Bc2CF0A2218358B1E';
const EDITION_FACTORY = '0xCC29eD68f26693dc9Aa5f090B21F37985206cc19';
const EDITION_CODE_FACTORY = '0x86f9CFe597ab145452f4A66ac102291d54e8EB46';
const FIXED_PRICE_MINTER_1155 = '0x2af9f0c477c34a23cBeC646a3b6BC0cA4Df5d37f';

test('edition CREATE2 predictions are stable (pure functions of fixed bytecode + salt)', () => {
  assert.equal(predictOneOfOneEditionFactory(), predictOneOfOneEditionFactory());
  assert.equal(predictEditionFactory(), predictEditionFactory());
  assert.equal(predictFixedPriceMinter1155(), predictFixedPriceMinter1155());
  // Cross-chain-identical, like every other CREATE2 singleton here — no chain-specific immutables.
  assert.notEqual(predictOneOfOneEditionFactory(), predictEditionFactory());
  assert.notEqual(predictOneOfOneEditionFactory(), predictFixedPriceMinter1155());
});

test('manifest: the canonical edition anchors are recorded, identical on all shipped chains', () => {
  for (const chainId of [SEPOLIA, BASE_SEPOLIA, ARBITRUM_SEPOLIA]) {
    const deployment = getDeployment(chainId);
    assert.equal(deployment.oneOfOneEditionFactory, ONE_OF_ONE_EDITION_FACTORY);
    assert.equal(deployment.editionFactory, EDITION_FACTORY);
    assert.equal(deployment.editionCodeFactory, EDITION_CODE_FACTORY);
    assert.equal(deployment.fixedPriceMinter1155, FIXED_PRICE_MINTER_1155);
  }
});

test('CREATE2 predictions agree with the recorded manifest for the two predictable factories + the minter', () => {
  // The strongest cross-check available offline: the TS salt/bytecode twins must land exactly where
  // forge deployed. EditionCodeFactory has its own prediction assertion in link.test.ts because it
  // uses the 200-run compilation restriction.
  assert.equal(predictOneOfOneEditionFactory(), ONE_OF_ONE_EDITION_FACTORY);
  assert.equal(predictEditionFactory(), EDITION_FACTORY);
  assert.equal(predictFixedPriceMinter1155(), FIXED_PRICE_MINTER_1155);
});

test('resolveOneOfOneEditionFactory: override → ABX_ONE_OF_ONE_EDITION_FACTORY env → manifest', () => {
  const OVERRIDE = '0x1111111111111111111111111111111111111111';
  const ENV = '0x2222222222222222222222222222222222222222';
  const before = process.env.ABX_ONE_OF_ONE_EDITION_FACTORY;
  try {
    delete process.env.ABX_ONE_OF_ONE_EDITION_FACTORY;
    assert.equal(resolveOneOfOneEditionFactory(SEPOLIA), ONE_OF_ONE_EDITION_FACTORY); // manifest leg
    process.env.ABX_ONE_OF_ONE_EDITION_FACTORY = ENV;
    assert.equal(resolveOneOfOneEditionFactory(SEPOLIA), ENV); // env beats the manifest
    assert.equal(resolveOneOfOneEditionFactory(SEPOLIA, OVERRIDE), OVERRIDE); // override beats env
  } finally {
    if (before === undefined) delete process.env.ABX_ONE_OF_ONE_EDITION_FACTORY;
    else process.env.ABX_ONE_OF_ONE_EDITION_FACTORY = before;
  }
});

test('resolveEditionFactory / resolveEditionCodeFactory / resolveFixedPriceMinter1155: each reads its own named env var (beating the manifest)', () => {
  const cases: Array<[() => (chainId: number, override?: string) => string | undefined, string, string]> = [
    [() => resolveEditionFactory, 'ABX_EDITION_FACTORY', EDITION_FACTORY],
    [() => resolveEditionCodeFactory, 'ABX_EDITION_CODE_FACTORY', EDITION_CODE_FACTORY],
    [() => resolveFixedPriceMinter1155, 'ABX_FIXED_PRICE_MINTER_1155', FIXED_PRICE_MINTER_1155],
  ];
  const ENV = '0x5555555555555555555555555555555555555555';
  for (const [getResolve, envName, canonical] of cases) {
    const resolve = getResolve();
    const before = process.env[envName];
    try {
      delete process.env[envName];
      assert.equal(resolve(SEPOLIA), canonical, `${envName}: manifest leg resolves the canonical anchor`);
      process.env[envName] = ENV;
      assert.equal(resolve(SEPOLIA), ENV, `${envName} should be read by its resolver, beating the manifest`);
    } finally {
      if (before === undefined) delete process.env[envName];
      else process.env[envName] = before;
    }
  }
});
