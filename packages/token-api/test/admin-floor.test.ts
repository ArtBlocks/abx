import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planRegistrationFloor} from '../src/control-plane.js';

// The admin control plane's scan-floor decision (remote `abx add`). The bug this guards: a first
// registration with no floor used to default to '0' → a from-genesis scan that never finished on a
// range-capped RPC. Now: explicit floor wins, else the stored one, else null (caller derives or
// refuses — never genesis). And re-sending the SAME floor stays incremental, so the CLI can always
// forward the deploy block (even on a nudge) without triggering a re-scan each time.

test('explicit body floor wins; as a first add (no stored floor) it forces a full replay', () => {
  assert.deepEqual(planRegistrationFloor('11238537', undefined), {fromBlock: '11238537', full: true});
});

test('re-POST with the SAME stored floor stays INCREMENTAL — a nudge is not a re-scan', () => {
  assert.deepEqual(planRegistrationFloor('11238537', '11238537'), {fromBlock: '11238537', full: false});
});

test('a CHANGED floor forces a full replay', () => {
  assert.deepEqual(planRegistrationFloor('200', '100'), {fromBlock: '200', full: true});
});

test('no body floor falls back to the stored floor, incremental (the plain nudge)', () => {
  assert.deepEqual(planRegistrationFloor(undefined, '100'), {fromBlock: '100', full: false});
});

test('neither supplied nor stored → null (caller must derive the deploy block or refuse; NEVER genesis)', () => {
  assert.equal(planRegistrationFloor(undefined, undefined), null);
});

test('forceFull (body.full) overrides even a matching stored floor', () => {
  assert.deepEqual(planRegistrationFloor('100', '100', true), {fromBlock: '100', full: true});
});
