import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAttributes, parseTraitPairs, stitchAttributes} from '../src/traits.ts';

test('parseTraitPairs reads key=value pairs, inferring numbers', () => {
  const attrs = parseTraitPairs('Background=Blue; Edition=3');
  assert.deepEqual(attrs, [
    {trait_type: 'Background', value: 'Blue'},
    {trait_type: 'Edition', value: 3},
  ]);
});

test('parseTraitPairs trims, allows newlines, and rejects pairs with no =', () => {
  assert.deepEqual(parseTraitPairs('  Style = Hand-drawn \n Series=Donuts '), [
    {trait_type: 'Style', value: 'Hand-drawn'},
    {trait_type: 'Series', value: 'Donuts'},
  ]);
  assert.throws(() => parseTraitPairs('NotAPair'), /key=value/);
});

test('normalizeAttributes accepts the canonical array and drops empty trait_types', () => {
  const out = normalizeAttributes([
    {trait_type: 'Palette', value: 'Warm', display_type: 'string'},
    {trait_type: '', value: 'ignored'},
    {value: 'no name'},
  ]);
  assert.deepEqual(out, [{trait_type: 'Palette', value: 'Warm', display_type: 'string'}]);
});

test('normalizeAttributes accepts a {name: value} convenience map', () => {
  assert.deepEqual(normalizeAttributes({Background: 'Blue', Edition: 3}), [
    {trait_type: 'Background', value: 'Blue'},
    {trait_type: 'Edition', value: 3},
  ]);
});

test('normalizeAttributes coerces booleans to strings and treats null as empty', () => {
  assert.deepEqual(normalizeAttributes({Animated: true}), [{trait_type: 'Animated', value: 'true'}]);
  assert.deepEqual(normalizeAttributes(null), []);
});

test('stitchAttributes: on-chain wins per trait_type (case-insensitive), the rest union', () => {
  const onChain = [{trait_type: 'Background', value: 'Blue'}];
  const offChain = [
    {trait_type: 'background', value: 'Red'}, // same trait, different case → on-chain wins, off-chain dropped
    {trait_type: 'Edition', value: 1}, // unique → kept
  ];
  assert.deepEqual(stitchAttributes(onChain, offChain), [
    {trait_type: 'Background', value: 'Blue'},
    {trait_type: 'Edition', value: 1},
  ]);
});

test('stitchAttributes tolerates null/undefined on either side', () => {
  assert.deepEqual(stitchAttributes(null, [{trait_type: 'A', value: 1}]), [{trait_type: 'A', value: 1}]);
  assert.deepEqual(stitchAttributes([{trait_type: 'A', value: 1}], undefined), [{trait_type: 'A', value: 1}]);
  assert.deepEqual(stitchAttributes(null, null), []);
});
