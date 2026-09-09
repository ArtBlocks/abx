// `abx verify --json` used to have exactly one machine-readable verdict, `ok` — content-integrity
// only (does what's served hash to the on-chain commitment). That's the right scope for `ok`
// decided to keep it that way, matching the exit-code rule in `cmdVerifyBody`), but it left
// automation with no way to ask "is this project fully SERVABLE right now": a missing render and an
// un-refetched ipfs/arweave/url locator both left `ok: true` with nothing else to read.
//
// `computeAvailability` and `pointerOnlyImageCheck` are the two pure pieces that back the new
// `availability` field — extracted so its three states are named explicitly
// (a hash mismatch, a pointer that cannot be recomputed locally, and missing served output) are
// unit-testable without an indexer, a storage backend, or a live chain.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {MetadataField} from '@artblocks/abx-sdk';
import {computeAvailability, pointerOnlyImageCheck} from '../src/commands/project.js';

const field = (representation: string): MetadataField => ({field: 'image', representation, value: '0x00' as MetadataField['value']});

// ── pointerOnlyImageCheck: the "real commitment we didn't re-fetch" detector ────────────────────

test('pointerOnlyImageCheck: ipfs/arweave/url/url-template image fields are pointer-only', () => {
  assert.equal(pointerOnlyImageCheck([field('ipfs')]), 'ipfs');
  assert.equal(pointerOnlyImageCheck([field('arweave')]), 'arweave');
  assert.equal(pointerOnlyImageCheck([field('url')]), 'url');
  assert.equal(pointerOnlyImageCheck([field('url-template')]), 'url-template');
});

test('pointerOnlyImageCheck: a keccak256/sha256 image is NOT pointer-only — verifyProject already checks those', () => {
  assert.equal(pointerOnlyImageCheck([field('keccak256')]), null);
  assert.equal(pointerOnlyImageCheck([field('sha256')]), null);
});

test('pointerOnlyImageCheck: inline/renderer/reader representations are not locator commitments', () => {
  assert.equal(pointerOnlyImageCheck([field('inline')]), null);
  assert.equal(pointerOnlyImageCheck([field('renderer')]), null);
  assert.equal(pointerOnlyImageCheck([field('reader')]), null);
});

test('pointerOnlyImageCheck: no image field at all is "no commitment", not "unrecomputable"', () => {
  assert.equal(pointerOnlyImageCheck([]), null);
  assert.equal(pointerOnlyImageCheck([{field: 'description', representation: 'inline', value: '0x00' as MetadataField['value']}]), null);
});

// ── computeAvailability: the verdict, from facts a caller already gathered ──────────────────────

test('computeAvailability: a code project with every minted render present is "available"', () => {
  const v = computeAvailability({isCode: true, minted: 3, present: 3, anyCheck: false, unrecomputablePointers: 0});
  assert.equal(v.status, 'available');
  assert.match(v.note, /3\/3/);
});

test('computeAvailability: a code project with zero renders present is "unavailable" — missing served output', () => {
  const v = computeAvailability({isCode: true, minted: 4, present: 0, anyCheck: false, unrecomputablePointers: 0});
  assert.equal(v.status, 'unavailable');
  assert.match(v.note, /0\/4/);
});

test('computeAvailability: a code project with SOME renders present is "partial"', () => {
  const v = computeAvailability({isCode: true, minted: 4, present: 2, anyCheck: false, unrecomputablePointers: 0});
  assert.equal(v.status, 'partial');
  assert.match(v.note, /2\/4/);
});

test('computeAvailability: a code project with nothing minted yet is "unknown" — not "unavailable"', () => {
  // Nothing has failed to render; nothing has been minted to render YET. Reporting "unavailable"
  // here would read as a broken deploy on a project that simply hasn't sold token #0.
  const v = computeAvailability({isCode: true, minted: 0, present: 0, anyCheck: false, unrecomputablePointers: 0});
  assert.equal(v.status, 'unknown');
});

test('computeAvailability: a non-code project whose bytes were actually fetched+compared is "available" regardless of match', () => {
  // `anyCheck` means a hash check RAN — whether it matched is `ok`'s question, not availability's.
  // The content IS being served from wherever it lives; a wrong-content verdict is an integrity
  // finding, never an availability one.
  const v = computeAvailability({isCode: false, minted: 0, present: 0, anyCheck: true, unrecomputablePointers: 0});
  assert.equal(v.status, 'available');
});

test('computeAvailability: an un-refetched locator commitment (ipfs/arweave/url) is "unknown" — a real gap, not a failure', () => {
  const v = computeAvailability({isCode: false, minted: 0, present: 0, anyCheck: false, unrecomputablePointers: 2});
  assert.equal(v.status, 'unknown');
  assert.match(v.note, /2 locator commitment/);
});

test('computeAvailability: no commitments at all — nothing to serve, so "available" (there is no gap)', () => {
  const v = computeAvailability({isCode: false, minted: 0, present: 0, anyCheck: false, unrecomputablePointers: 0});
  assert.equal(v.status, 'available');
  assert.match(v.note, /no content commitments/);
});
