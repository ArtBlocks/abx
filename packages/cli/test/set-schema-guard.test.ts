import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Hex} from 'viem';
import {strandingRisks} from '../src/ownerops.js';
import {parseSchemaSpec} from '../src/schema.js';
import type {OnChainParamSchema} from '@artblocks/abx-sdk';

// `setParamSchema` is a full-row upsert AND the contract never re-validates values already stored
// under a key. So a schema edit can leave live tokens holding values their own schema forbids —
// silently, with nothing on-chain to notice. This guard is the only thing between an owner and that,
// which is why it is refuse-by-default rather than a warning.

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const base = (over: Partial<OnChainParamSchema> = {}): OnChainParamSchema => ({
  exists: true,
  paramType: 2, // Uint256Range
  auth: 1,
  authAddress: '0x0000000000000000000000000000000000000000',
  lockAfter: 0,
  min: ZERO32,
  max: `0x${(100n).toString(16).padStart(64, '0')}` as Hex,
  selectOptions: [],
  ...over,
});

test('guard: an identical schema is not a risk', () => {
  assert.deepEqual(strandingRisks(base(), parseSchemaSpec('d:Uint256Range[0..100]:TokenOwner')), []);
});

test('guard: widening a bound is safe, narrowing is not', () => {
  assert.deepEqual(strandingRisks(base(), parseSchemaSpec('d:Uint256Range[0..200]:TokenOwner')), []);
  const narrowed = strandingRisks(base(), parseSchemaSpec('d:Uint256Range[0..50]:TokenOwner'));
  assert.equal(narrowed.length, 1);
  assert.match(narrowed[0], /max lowered \(100 → 50\)/);
});

test('guard: raising the minimum strands values below it', () => {
  const risks = strandingRisks(base(), parseSchemaSpec('d:Uint256Range[10..100]:TokenOwner'));
  assert.match(risks[0], /min raised \(0 → 10\)/);
});

test('guard: dropping a Select option strands tokens already set to it', () => {
  const before = base({paramType: 1, min: ZERO32, max: ZERO32, selectOptions: ['Seed', 'Newsprint', 'Neon']});
  const risks = strandingRisks(before, parseSchemaSpec('t:Select[Seed|Neon]:TokenOwner'));
  assert.equal(risks.length, 1);
  assert.match(risks[0], /Newsprint/);
  // Adding an option is safe — nothing stored becomes invalid.
  assert.deepEqual(strandingRisks(before, parseSchemaSpec('t:Select[Seed|Newsprint|Neon|Dusk]:TokenOwner')), []);
});

test('guard: changing the type is always a risk (a stored value keeps its old encoding)', () => {
  const risks = strandingRisks(base(), parseSchemaSpec('d:HexColor:TokenOwner'));
  assert.match(risks[0], /type Uint256Range → HexColor/);
});

// A schema write used to need a `params.keys` companion write in the same transaction to keep the
// on-chain generator's key list in step. Params enumerate on-chain now — the contract maintains the
// key set inside its own write paths — so `set-schema` is a single op again and there is nothing
// left to keep in step. (The set-schema tx shape itself is covered by the SDK's prepare* tests.)
