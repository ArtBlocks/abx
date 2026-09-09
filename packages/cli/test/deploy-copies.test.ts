// `--copies <N|open>` is the ONE surface that routes any of the three deploy commands to its
// ERC-1155 edition twin — no `--standard` flag, the creator never says "ERC-1155" (the parity
// plan's kernel). These lock the parse + the advisory note; the flag-combo refusals it feeds are
// covered live against real fixtures in deploy-copies-live.test.ts (they need a real chain read).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copiesOneNote, parseCopies, parseNonNegativeIntFlag} from '../src/commands/deploy.js';

test('parseCopies: "open" → 0n (uncapped)', () => {
  assert.equal(parseCopies('open'), 0n);
  assert.equal(parseCopies('OPEN'), 0n); // case-insensitive
  assert.equal(parseCopies(' open '), 0n); // tolerates incidental whitespace
});

test('parseCopies: a positive integer parses to that bigint', () => {
  assert.equal(parseCopies('1'), 1n);
  assert.equal(parseCopies('100'), 100n);
  assert.equal(parseCopies('9999999'), 9999999n);
});

test('parseCopies: absent (undefined) throws — callers must check flags.copies !== undefined first', () => {
  assert.throws(() => parseCopies(undefined), /needs a value/);
});

test('parseCopies: a bare --copies (parses to the literal "true") throws, naming both valid forms', () => {
  assert.throws(() => parseCopies('true'), (e: Error) => {
    assert.match(e.message, /positive integer/);
    assert.match(e.message, /"open"/);
    return true;
  });
});

test('parseCopies: 0 is refused — it collides with the on-chain "open" meaning, so say "open" instead', () => {
  assert.throws(() => parseCopies('0'), /ambiguous/);
});

test('parseCopies: non-integer / garbage input is refused with a clear message', () => {
  for (const bad of ['-1', '1.5', 'abc', '1e5', '', 'open ish']) {
    assert.throws(() => parseCopies(bad), /must be a positive integer/, `expected "${bad}" to be rejected`);
  }
});

test('parseCopies: tolerates incidental surrounding whitespace on a number', () => {
  assert.equal(parseCopies(' 100 '), 100n);
});

test('copiesOneNote: names the exact command and the reason (single-copy edition vs the plain 721 lane)', () => {
  const note = copiesOneNote('deploy');
  assert.match(note, /single-copy ERC-1155 edition/);
  assert.match(note, /abx deploy`/); // the no-`--copies` reproduction, backtick-quoted
});

test('parseNonNegativeIntFlag: accepts 0 and positive integers, rejects everything else', () => {
  assert.equal(parseNonNegativeIntFlag('0', 'mint-amount'), 0n);
  assert.equal(parseNonNegativeIntFlag('5', 'mint-amount'), 5n);
  for (const bad of ['true', '-1', '1.5', 'abc', '']) {
    assert.throws(() => parseNonNegativeIntFlag(bad, 'mint-amount'), /--mint-amount must be a non-negative integer/, `expected "${bad}" to be rejected`);
  }
});
