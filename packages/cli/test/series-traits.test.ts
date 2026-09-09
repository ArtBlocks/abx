import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSeriesTraits, looksPerTokenAttributes, parseSeriesTraitsById} from '../src/series-traits.js';

const SLOTS = ['astro.png', 'cat0.png', 'cat1.png']; // token ids 0,1,2

test('parseSeriesTraits: object keyed by filename → per-token attributes', () => {
  const m = parseSeriesTraits(
    JSON.stringify({
      'astro.png': [{trait_type: 'Subject', value: 'Astronaut'}],
      'cat0.png': {Subject: 'Cat', Mood: 'Calm'}, // {name:value} map form is normalized
    }),
    SLOTS,
  );
  assert.equal(m.size, 2);
  assert.deepEqual(m.get(0), [{trait_type: 'Subject', value: 'Astronaut'}]);
  assert.deepEqual(m.get(1), [{trait_type: 'Subject', value: 'Cat'}, {trait_type: 'Mood', value: 'Calm'}]);
  assert.equal(m.has(2), false); // cat1.png had no entry
});

test('parseSeriesTraits: object keyed by BASENAME (no extension) and by token-id string', () => {
  const byBase = parseSeriesTraits(JSON.stringify({astro: [{trait_type: 'A', value: '1'}]}), SLOTS);
  assert.deepEqual(byBase.get(0), [{trait_type: 'A', value: '1'}]);
  const byId = parseSeriesTraits(JSON.stringify({'2': [{trait_type: 'B', value: '2'}]}), SLOTS);
  assert.deepEqual(byId.get(2), [{trait_type: 'B', value: '2'}]);
});

test('parseSeriesTraits: array indexed by token id (only within range)', () => {
  const m = parseSeriesTraits(
    JSON.stringify([[{trait_type: 'N', value: '0'}], [{trait_type: 'N', value: '1'}]]),
    SLOTS,
  );
  assert.equal(m.size, 2);
  assert.deepEqual(m.get(0), [{trait_type: 'N', value: '0'}]);
  assert.equal(m.has(2), false);
  // an over-length array ignores entries past the token count
  assert.equal(parseSeriesTraits(JSON.stringify([[], [], [], [{trait_type: 'X', value: 'Y'}]]), SLOTS).size, 0);
});

test('parseSeriesTraits: no manifest → empty; no matching keys → empty', () => {
  assert.equal(parseSeriesTraits(undefined, SLOTS).size, 0);
  assert.equal(parseSeriesTraits(JSON.stringify({'nope.png': [{trait_type: 'X', value: 'Y'}]}), SLOTS).size, 0);
});

test('parseSeriesTraits: invalid JSON and a non-array/object payload throw clear errors', () => {
  assert.throws(() => parseSeriesTraits('{not json', SLOTS), /not valid JSON/);
  assert.throws(() => parseSeriesTraits('42', SLOTS), /expects a JSON array .* or an object/);
});

// `abx add --attributes` lane detection: per-token EDIT vs a flat 1/1 payload. Ambiguity must
// default to flat so a 1/1's `--attributes` is never mis-routed into the per-token column.
test('looksPerTokenAttributes: flat 1/1 payloads are NOT per-token', () => {
  assert.equal(looksPerTokenAttributes(JSON.stringify([{trait_type: 'Background', value: 'Blue'}])), false); // OpenSea array
  assert.equal(looksPerTokenAttributes(JSON.stringify({Background: 'Blue', Edition: 3})), false); // {name:value} map (scalar values)
  assert.equal(looksPerTokenAttributes('[]'), false); // empty → flat (nothing to route per-token)
  assert.equal(looksPerTokenAttributes('{not json'), false);
});

test('looksPerTokenAttributes: per-token payloads ARE per-token', () => {
  assert.equal(looksPerTokenAttributes(JSON.stringify([[{trait_type: 'N', value: '0'}], [{trait_type: 'N', value: '1'}]])), true); // array of arrays
  assert.equal(looksPerTokenAttributes(JSON.stringify({'0': [{trait_type: 'S', value: 'Cat'}], '2': {Mood: 'Calm'}})), true); // object of arrays/maps
});

test('parseSeriesTraitsById: array indexes by token id; object numeric keys are token ids; filenames drop', () => {
  const byArr = parseSeriesTraitsById(JSON.stringify([[{trait_type: 'N', value: '0'}], [{trait_type: 'N', value: '1'}]]));
  assert.deepEqual(byArr, {'0': [{trait_type: 'N', value: '0'}], '1': [{trait_type: 'N', value: '1'}]});
  const byObj = parseSeriesTraitsById(JSON.stringify({'0': {Subject: 'Cat'}, '5': [{trait_type: 'X', value: 'Y'}], 'astro.png': [{trait_type: 'Z', value: 'W'}]}));
  assert.deepEqual(byObj, {'0': [{trait_type: 'Subject', value: 'Cat'}], '5': [{trait_type: 'X', value: 'Y'}]}); // filename key dropped (no --dir at add-time)
});
