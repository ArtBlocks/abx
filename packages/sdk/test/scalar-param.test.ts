// PostParam scalar encoding (encodeScalarParam). Regression guards for the fresh-angle sweep: every
// type must give a CLEAN, teaching error on bad input (never leak a raw "Cannot convert X to a
// BigInt"), and Timestamp must accept a human/ISO date, not only Unix seconds.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeScalarParam} from '@artblocks/abx-sdk';

const OPTS = ['Sparse', 'Flowing', 'Dense'];

test('valid values encode across all types', () => {
  assert.equal(encodeScalarParam('Bool', 'true', []).display, 'true');
  assert.equal(encodeScalarParam('HexColor', '#ff7f50', []).display, '#ff7f50');
  assert.equal(encodeScalarParam('Select', 'Dense', OPTS).display, 'Dense');
  assert.equal(encodeScalarParam('Select', '2', OPTS).display, 'Dense'); // by index
  assert.equal(encodeScalarParam('Uint256Range', '42', []).display, '42');
  assert.equal(encodeScalarParam('DecimalRange', '1.5', []).display, '1.5');
});

test('Timestamp accepts Unix seconds AND a human/ISO date', () => {
  assert.equal(encodeScalarParam('Timestamp', '1730000000', []).display, '1730000000');
  // an ISO date parses to a deterministic Unix-seconds value (UTC midnight)
  assert.equal(encodeScalarParam('Timestamp', '2026-07-16', []).display, String(Date.parse('2026-07-16') / 1000));
});

test('bad input gives a clean, type-specific error — never a raw BigInt conversion leak', () => {
  const bad: Array<[string, string, string[], RegExp]> = [
    ['Bool', 'yes', [], /Bool wants true\|false/],
    ['HexColor', 'coral', [], /HexColor wants #rrggbb/],
    ['Select', 'Nope', OPTS, /Select wants one of \[Sparse, Flowing, Dense\]/],
    ['Select', '9', OPTS, /Select wants one of/], // out-of-range index
    ['Uint256Range', 'abc', [], /Uint256Range wants a non-negative integer/],
    ['Uint256Range', '-5', [], /non-negative integer/],
    ['Int256Range', 'x', [], /Int256Range wants an integer/],
    ['DecimalRange', 'abc', [], /DecimalRange wants a decimal/],
    ['Timestamp', 'notadate', [], /Timestamp wants Unix seconds .* or an ISO date/],
  ];
  for (const [t, v, o, re] of bad) {
    assert.throws(() => encodeScalarParam(t as never, v, o), (e: Error) => {
      assert.doesNotMatch(e.message, /Cannot convert .* to a BigInt/, `${t} "${v}" leaked a raw BigInt error`);
      assert.match(e.message, re);
      return true;
    }, `expected ${t} "${v}" to be rejected cleanly`);
  }
});
