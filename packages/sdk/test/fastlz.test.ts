import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flzCompress, flzDecompress} from '../src/fastlz.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function roundTrip(label: string, input: Uint8Array) {
  const compressed = flzCompress(input);
  const restored = flzDecompress(compressed);
  assert.deepEqual([...restored], [...input], `round-trip mismatch: ${label}`);
  return compressed;
}

test('round-trips empty / tiny inputs', () => {
  roundTrip('empty', new Uint8Array(0));
  roundTrip('one byte', enc('x'));
  roundTrip('two bytes (below min match)', enc('ab'));
});

test('round-trips and compresses repetitive content', () => {
  const c = roundTrip('repeat', enc('the '.repeat(64)));
  assert.ok(c.length < 32, `expected strong compression, got ${c.length} bytes`);
});

test('round-trips RLE (long single-byte run, overlap copy)', () => {
  const c = roundTrip('rle', enc('a'.repeat(5000)));
  // ~19 max-length (264) matches × 3 bytes each — strong compression, exact bytes round-trip.
  assert.ok(c.length < 100, `RLE should compress hard, got ${c.length}`);
});

test('round-trips a ~30 kB blob (the multi-chunk motivating case)', () => {
  roundTrip('30kb', enc('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(900)));
});

test('round-trips incompressible-ish bytes without corruption', () => {
  const a = new Uint8Array(3000);
  let x = 0x12345;
  for (let i = 0; i < a.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    a[i] = (x >>> 16) & 0xff; // higher bits = less LCG structure
  }
  roundTrip('pseudo-random', a);
});
