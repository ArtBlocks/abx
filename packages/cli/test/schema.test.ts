import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSchemaSpec, parseSchemaSpecs, describeSchema} from '../src/schema.js';
import {PARAM_TYPES, AUTH_OPTIONS} from '@artblocks/abx-sdk';

const ZERO32 = `0x${'0'.repeat(64)}`;
const idx = (name: string, arr: readonly string[]) => arr.indexOf(name);

test('parseSchemaSpec: a simple type is unchanged (no bracket) — backwards compatible', () => {
  const s = parseSchemaSpec('palette:HexColor:TokenOwner');
  assert.equal(s.key, 'palette');
  assert.equal(s.paramType, idx('HexColor', PARAM_TYPES));
  assert.equal(s.auth, idx('TokenOwner', AUTH_OPTIONS));
  assert.equal(s.min, ZERO32);
  assert.equal(s.max, ZERO32);
  assert.deepEqual(s.selectOptions, []);
});

test('parseSchemaSpec: Select carries its options (the fix — was undeclarable)', () => {
  const s = parseSchemaSpec('season:Select[Spring|Summer|Autumn|Winter]:TokenOwner');
  assert.equal(s.paramType, idx('Select', PARAM_TYPES));
  assert.deepEqual(s.selectOptions, ['Spring', 'Summer', 'Autumn', 'Winter']);
  // options trim surrounding whitespace so `A | B` reads cleanly
  assert.deepEqual(parseSchemaSpec('x:Select[A | B | C]:TokenOwner').selectOptions, ['A', 'B', 'C']);
});

test('parseSchemaSpec: a Select with NO options is rejected (the contract would revert)', () => {
  assert.throws(() => parseSchemaSpec('season:Select:TokenOwner'), /a Select needs its options/);
});

test('parseSchemaSpec: duplicate / empty / delimiter-bearing options are rejected', () => {
  assert.throws(() => parseSchemaSpec('x:Select[A|A]:TokenOwner'), /duplicate Select option/);
  assert.throws(() => parseSchemaSpec('x:Select[A||B]:TokenOwner'), /non-empty/);
  assert.throws(() => parseSchemaSpec('x:Select[A|B,C]:TokenOwner'), /can't contain/); // a comma in a label
});

test('parseSchemaSpec: Uint256Range bounds encode to bytes32 min/max', () => {
  const s = parseSchemaSpec('density:Uint256Range[0..100]:TokenOwner');
  assert.equal(s.min, ZERO32);
  assert.equal(BigInt(s.max), 100n);
});

test('parseSchemaSpec: Int256Range accepts negatives (two’s-complement min)', () => {
  const s = parseSchemaSpec('temp:Int256Range[-50..50]:TokenOwner');
  assert.equal(BigInt.asIntN(256, BigInt(s.min)), -50n);
  assert.equal(BigInt.asIntN(256, BigInt(s.max)), 50n);
});

test('parseSchemaSpec: DecimalRange bounds use the 1e10 fixed-point scale', () => {
  const s = parseSchemaSpec('opacity:DecimalRange[0..1]:TokenOwner');
  assert.equal(BigInt(s.min), 0n);
  assert.equal(BigInt(s.max), 10_000_000_000n); // 1.0 × 1e10
});

test('parseSchemaSpec: Timestamp bounds accept ISO dates', () => {
  const s = parseSchemaSpec('window:Timestamp[2026-01-01..2026-12-31]:TokenOwner');
  assert.ok(BigInt(s.min) > 0n && BigInt(s.max) > BigInt(s.min));
});

test('parseSchemaSpec: a Range with no bracket is unbounded (min=max=0), preserving prior behavior', () => {
  const s = parseSchemaSpec('n:Uint256Range:TokenOwner');
  assert.equal(s.min, ZERO32);
  assert.equal(s.max, ZERO32);
});

test('parseSchemaSpec: bracket on a non-bounded type is rejected', () => {
  assert.throws(() => parseSchemaSpec('c:HexColor[x]:TokenOwner'), /takes no \[/);
});

test('parseSchemaSpec: min > max is caught client-side (clearer than the on-chain revert)', () => {
  assert.throws(() => parseSchemaSpec('n:Uint256Range[100..0]:TokenOwner'), /min must be ≤ max/);
  assert.throws(() => parseSchemaSpec('t:Int256Range[50..-50]:TokenOwner'), /min must be ≤ max/);
});

test('parseSchemaSpec: bad field shape / unknown type are rejected clearly', () => {
  assert.throws(() => parseSchemaSpec('justkey'), /expected key:Type:Auth/);
  assert.throws(() => parseSchemaSpec('k:Bogus:TokenOwner'), /Type ∈/);
});

// ── the Address leg + lock= ──────────────────────────────────────────────────────
// Both were reachable on-chain and unreachable from the CLI: an Address leg was refused outright
// ("set that schema post-deploy via the contract" — which was not a thing you could do), and
// lockAfter was hardcoded to 0 at the only call site, so the protocol's retire capability had no
// surface at all.

test('parseSchemaSpec: an Address leg names its holder inline', () => {
  const s = parseSchemaSpec('board:Bytes:Address(0x71Cf70753636779Ed124F529De762B9A2B6629c4)');
  assert.equal(AUTH_OPTIONS[s.auth], 'Address');
  assert.equal(s.authAddress, '0x71Cf70753636779Ed124F529De762B9A2B6629c4');
});

test('parseSchemaSpec: an Address leg without an address is refused, and says a CONTRACT may hold it', () => {
  assert.throws(() => parseSchemaSpec('k:HexColor:Address'), /needs one/);
  assert.throws(() => parseSchemaSpec('k:HexColor:Address'), /CONTRACT may hold this leg/);
});

test('parseSchemaSpec: a non-Address leg refuses an address', () => {
  assert.throws(() => parseSchemaSpec('k:HexColor:TokenOwner(0x71Cf70753636779Ed124F529De762B9A2B6629c4)'), /takes no address/);
});

test('parseSchemaSpec: lock= accepts an ISO date, unix seconds, and `now`', () => {
  assert.equal(parseSchemaSpec('k:HexColor:TokenOwner:lock=2026-12-31').lockAfter, Math.floor(Date.UTC(2026, 11, 31) / 1000));
  assert.equal(parseSchemaSpec('k:HexColor:TokenOwner:lock=1800000000').lockAfter, 1_800_000_000);
  // `now` must land in the PAST — the contract's test is `block.timestamp > lockAfter`, so a lock
  // set to exactly now would not bite until the next second. This is the retire idiom.
  assert.ok(parseSchemaSpec('k:HexColor:TokenOwner:lock=now').lockAfter < Math.floor(Date.now() / 1000) + 1);
});

test('parseSchemaSpec: no lock= means no lock', () => {
  assert.equal(parseSchemaSpec('k:HexColor:TokenOwner').lockAfter, 0);
});

test('parseSchemaSpec: a 4th field that is not lock= reports the shape error, not a mangled type', () => {
  // A ':' inside a Select label splits the spec — the old message ("malformed type Select[A|B") sent
  // people looking at the wrong thing.
  assert.throws(() => parseSchemaSpec('x:Select[A|B:C]:TokenOwner'), /expected key:Type:Auth/);
  assert.throws(() => parseSchemaSpec('x:HexColor:TokenOwner:whatever'), /lock=<when>/);
});

test('parseSchemaSpecs: comma-separates params; a Select option list never collides with the comma', () => {
  const list = parseSchemaSpecs('season:Select[Spring|Summer]:TokenOwner,palette:HexColor:TokenOwner');
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].selectOptions, ['Spring', 'Summer']);
  assert.equal(list[1].key, 'palette');
});

test('describeSchema: round-trips options + bounds for the readout', () => {
  assert.match(describeSchema(parseSchemaSpec('s:Select[A|B]:TokenOwner')), /Select\[A \| B\]/);
  assert.match(describeSchema(parseSchemaSpec('n:Uint256Range[0..100]:TokenOwner')), /Uint256Range\[0\.\.100\]/);
  assert.match(describeSchema(parseSchemaSpec('t:Int256Range[-5..5]:TokenOwner')), /\[-5\.\.5\]/);
  assert.match(describeSchema(parseSchemaSpec('d:DecimalRange[0..1]:TokenOwner')), /\[0\.\.1\]/);
});
