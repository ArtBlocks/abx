// Every event the spine ABI can decode must be described in `SPINE_EVENT_DOC`.
//
// The doc table is not decoration: `decodedToSpineEvents` reads `register` and `what` off it for
// each folded event, and falls back to `{register: 2, what: ''}` for anything missing. So a
// drifted table is silent twice over — a blank description in every readout that narrates the
// spine, and an event mislabelled Register 2 (native ABX vocabulary) when it belongs to Register 1
// (a standard the world already speaks) or to a factory.
//
// The coverage guard prevents an event from being documented without being folded. A table that
// relies on memory is not a reliable table; this test is the update mechanism.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {spineEventAbi} from '../src/abi/index.js';
import {SPINE_EVENT_DOC} from '../src/spine.js';

test('every spine ABI event has a SPINE_EVENT_DOC entry', () => {
  const names = [...new Set(spineEventAbi.map((f) => (f as {name?: string}).name ?? ''))].sort();
  assert.ok(names.length > 40, `sanity: expected the whole spine, got ${names.length} events`);
  const missing = names.filter((n) => !SPINE_EVENT_DOC[n]);
  assert.deepEqual(
    missing,
    [],
    `undescribed spine events (add them to SPINE_EVENT_DOC with the right register): ${missing.join(', ')}`,
  );
});

test('no SPINE_EVENT_DOC entry describes an event the spine cannot decode', () => {
  // The other direction: a stale entry for a renamed/removed event is dead weight that reads like
  // a live signal. Keyed by NAME (not signature), so same-named 721/1155 variants collapse to one.
  const names = new Set(spineEventAbi.map((f) => (f as {name?: string}).name ?? ''));
  const orphans = Object.keys(SPINE_EVENT_DOC).filter((n) => !names.has(n));
  assert.deepEqual(orphans, [], `documented events that no ABX contract emits: ${orphans.join(', ')}`);
});

test('every entry says something — a non-empty `what` and a real register', () => {
  for (const [name, doc] of Object.entries(SPINE_EVENT_DOC)) {
    assert.ok(doc.what.trim().length > 0, `${name}: empty description`);
    assert.ok(doc.register === 1 || doc.register === 2, `${name}: register must be 1 or 2`);
  }
});
