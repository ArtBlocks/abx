// Smoke coverage for the read-only per-contract dashboard (dashboard.ts). The 721 case pins
// down "byte-identical to before editions" — the Owner fact, unchanged — while the edition
// cases exercise the Supply/Holders swap the ERC-1155 editions phase adds.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ProjectState} from '@artblocks/abx-sdk';
import {renderDashboard} from '../src/dashboard.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;
const HOLDER_A = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const HOLDER_B = '0x2222222222222222222222222222222222222222' as `0x${string}`;

function baseState(over: Partial<ProjectState> = {}): ProjectState {
  return {
    address: ADDR,
    chainId: 11155111,
    abxVersion: 1,
    deployBlock: '100',
    deployTx: '0xdeadbeef' as `0x${string}`,
    factory: null,
    implementation: null,
    isCanonical: true,
    name: 'Dashboard Fixture',
    symbol: 'DASH',
    owner: HOLDER_A,
    contractURI: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: null,
    collectionFields: [],
    lockedCollectionFields: [],
    extensions: [],
    tokens: [],
    events: [],
    fromBlock: '100',
    toBlock: '110',
    eventCount: 0,
    reconstructedAt: '2026-08-05T00:00:00.000Z',
    ...over,
  } as ProjectState;
}

test('a 721 project renders the Owner fact — byte-identical to before editions (no Supply/Holders)', () => {
  const state = baseState({
    contractType: '1of1',
    tokens: [{tokenId: '0', lifecycle: 'live', owner: HOLDER_B, tokenURI: null, fields: [], lockedFields: []}],
  });
  const html = renderDashboard(state, 'http://node', 11155111);
  assert.match(html, /<span class="fl">Owner<\/span>/);
  assert.doesNotMatch(html, /<span class="fl">Supply<\/span>/);
  assert.doesNotMatch(html, /<span class="fl">Holders<\/span>/);
});

test('an edition project shows Supply "X / Y" and a live Holders count instead of Owner', () => {
  const state = baseState({
    contractType: 'edition',
    maxInvocations: '10',
    tokens: [
      {
        tokenId: '0',
        lifecycle: 'live',
        owner: null, // editions never carry a single owner
        tokenURI: null,
        fields: [],
        lockedFields: [],
        supply: '12',
        maxSupply: '100',
        holders: {[HOLDER_A]: '9', [HOLDER_B]: '3'},
      },
    ],
  });
  const html = renderDashboard(state, 'http://node', 11155111);
  assert.match(html, /<span class="fl">Supply<\/span><span class="fv">12 \/ 100<\/span>/);
  assert.match(html, /<span class="fl">Holders<\/span><span class="fv">2<\/span>/);
  assert.doesNotMatch(html, /<span class="fl">Owner<\/span>/);
});

test('an open (uncapped) edition token reads "(open)" instead of a cap', () => {
  const state = baseState({
    contractType: '1of1-edition', // no maxInvocations at all — id space fixed to {0}
    tokens: [{tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '4', holders: {[HOLDER_A]: '4'}}],
  });
  const html = renderDashboard(state, 'http://node', 11155111);
  assert.match(html, /<span class="fl">Supply<\/span><span class="fv">4 \(open\)<\/span>/);
});

// The two cases a truthiness check on `maxSupply` got wrong once the fold started carrying the
// collection default: a `'0'` cap is a non-empty string, so it is TRUTHY.

test('an id deliberately closed to 0 says so — never "12 / 0"', () => {
  const state = baseState({
    contractType: 'edition',
    defaultMaxSupply: '10',
    tokens: [
      {
        tokenId: '0',
        lifecycle: 'live',
        owner: null,
        tokenURI: null,
        fields: [],
        lockedFields: [],
        supply: '12',
        maxSupply: '0',
        maxSupplyOverridden: true, // `setMaxSupply(0, 0)` — closed forever
        holders: {[HOLDER_A]: '12'},
      },
    ],
  });
  const html = renderDashboard(state, 'http://node', 11155111);
  assert.match(html, /<span class="fl">Supply<\/span><span class="fv">12 \(closed — no more can be minted\)<\/span>/);
  assert.doesNotMatch(html, /12 \/ 0/);
});

test('an open collection’s id carries a 0 cap and still reads "(open)"', () => {
  // `--copies open` ⇒ editionSize 0 ⇒ every id folds maxSupply '0' with no override.
  const state = baseState({
    contractType: 'edition',
    defaultMaxSupply: '0',
    tokens: [
      {tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '7', maxSupply: '0', holders: {[HOLDER_A]: '7'}},
    ],
  });
  const html = renderDashboard(state, 'http://node', 11155111);
  assert.match(html, /<span class="fl">Supply<\/span><span class="fv">7 \(open\)<\/span>/);
  assert.doesNotMatch(html, /7 \/ 0/);
});

test('an edition-code project with a not-yet-minted token 0 reads Supply "0 (open)" and zero holders', () => {
  const state = baseState({
    contractType: 'edition-code',
    maxInvocations: '25',
    tokens: [{tokenId: '0', lifecycle: 'unminted', owner: null, tokenURI: null, fields: [], lockedFields: []}],
  });
  const html = renderDashboard(state, 'http://node', 11155111);
  assert.match(html, /<span class="fl">Supply<\/span><span class="fv">0 \(open\)<\/span>/);
  assert.match(html, /<span class="fl">Holders<\/span><span class="fv">0<\/span>/);
});
