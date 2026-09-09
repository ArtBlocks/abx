// decodeReader/encodeReader — the `reader` field's (address reader, address pointer) codec.
// Positive: round-trips through encodeReader for arbitrary addresses. Negative: decodeReader
// must reject anything but the canonical abi.encode(address, address) shape —
// wrong word count (truncated / trailing-byte / double-encoded) and non-zero-padded address
// words — with an actionable message naming what was expected vs what was received.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, Hex} from 'viem';

import {decodeReader, encodeReader} from '../src/token.js';

const READER: Address = '0x1111111111111111111111111111111111111111';
const POINTER: Address = '0x2222222222222222222222222222222222222222';

// ── positive: round-trip through encodeReader ────────────────────────────────

test('decodeReader round-trips arbitrary addresses through encodeReader', () => {
  const value = encodeReader(READER, POINTER);
  const {reader, pointer} = decodeReader(value);
  assert.equal(reader.toLowerCase(), READER.toLowerCase());
  assert.equal(pointer.toLowerCase(), POINTER.toLowerCase());
});

test('decodeReader round-trips the zero address in either slot', () => {
  const ZERO: Address = '0x0000000000000000000000000000000000000000';
  const value = encodeReader(ZERO, POINTER);
  const {reader, pointer} = decodeReader(value);
  assert.equal(reader.toLowerCase(), ZERO);
  assert.equal(pointer.toLowerCase(), POINTER.toLowerCase());
});

test('decodeReader round-trips a max-value (0xff…ff) address', () => {
  const MAX: Address = '0xffffffffffffffffffffffffffffffffffffffff';
  const value = encodeReader(READER, MAX);
  const {reader, pointer} = decodeReader(value);
  assert.equal(reader.toLowerCase(), READER.toLowerCase());
  assert.equal(pointer.toLowerCase(), MAX);
});

// ── negative: shape (word count) ──────────────────────────────────────────────

test('decodeReader rejects a truncated value (one word, missing pointer)', () => {
  const value = encodeReader(READER, POINTER);
  const oneWord = value.slice(0, 2 + 64) as Hex; // '0x' + first 32-byte word only
  assert.throws(() => decodeReader(oneWord), /expected exactly two 32-byte ABI words/);
});

test('decodeReader rejects a truncated value (partial second word)', () => {
  const value = encodeReader(READER, POINTER);
  const partial = value.slice(0, value.length - 8) as Hex; // short by 4 bytes
  assert.throws(() => decodeReader(partial), /expected exactly two 32-byte ABI words/);
});

test('decodeReader rejects a value with trailing bytes appended', () => {
  const value = encodeReader(READER, POINTER);
  const withTrailer = (value + 'deadbeef') as Hex; // 4 extra bytes past the two words
  assert.throws(() => decodeReader(withTrailer), /expected exactly two 32-byte ABI words/);
});

test('decodeReader rejects a double-encoded value (abi.encode(bytes) wrapping a reader pair)', () => {
  const inner = encodeReader(READER, POINTER).slice(2); // 64 bytes, no '0x'
  // abi.encode(bytes): offset word (0x20) + length word (0x40) + the two inner words.
  const offset = '20'.padStart(64, '0');
  const length = '40'.padStart(64, '0');
  const doubleEncoded = `0x${offset}${length}${inner}` as Hex;
  assert.throws(() => decodeReader(doubleEncoded), /expected exactly two 32-byte ABI words/);
});

// ── negative: canonical zero padding ──────────────────────────────────────────

test('decodeReader rejects a reader word with non-zero padding', () => {
  const value = encodeReader(READER, POINTER);
  // Flip a byte inside the leading 12 zero bytes of the first (reader) word.
  const corrupted = ('0x' + '01' + value.slice(4)) as Hex;
  assert.throws(() => decodeReader(corrupted), /reader word is not canonically zero-padded/);
});

test('decodeReader rejects a pointer word with non-zero padding', () => {
  const value = encodeReader(READER, POINTER);
  const readerWord = value.slice(2, 2 + 64);
  const pointerWord = value.slice(2 + 64);
  // Flip a byte inside the leading 12 zero bytes of the second (pointer) word.
  const corruptedPointerWord = '01' + pointerWord.slice(2);
  const corrupted = `0x${readerWord}${corruptedPointerWord}` as Hex;
  assert.throws(() => decodeReader(corrupted), /pointer word is not canonically zero-padded/);
});
