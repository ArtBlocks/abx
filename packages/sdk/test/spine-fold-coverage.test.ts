// Every event the spine can decode either FOLDS into state or is excused, in writing, for not.
//
// Its sibling `spine-doc-coverage.test.ts` guards the *description*. This one guards the thing the
// descriptions were being mistaken for. Twice in four days an event shipped into the ABI, into
// `SPINE_EVENT_DOC`, and into no field of `ProjectState`:
//
//   · `DefaultMaxSupplySet` — added so the log could tell an open edition from a capped one, folded
//     nowhere; every `--copies N` edition read as uncapped while the head read said N.
//   · `BurnConfigured` + `MaxRoyaltyBpsUpdated` — and the upgrade memo then told consumers that
//     adding them to `SPINE_EVENT_DOC` made reconstruction "fold them rather than default them",
//     which the doc table has never done: it supplies `register`/`what` on the event record, full stop.
//
// Both were found by a downstream consumer building an indexer against us, which is the wrong place
// for a protocol to learn that its own reconstruction is incomplete. So: a new event is unfolded AND
// unexcused until someone decides which it is, and this test is what asks.
//
// It reads `reconstruct.ts` as source on purpose. The alternative — exporting a list of folded names
// — is a second thing to keep in sync, i.e. the very failure mode under guard. The `case` labels ARE
// the fold; nothing can claim one without implementing it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {spineEventAbi} from '../src/abi/index.js';
import {SPINE_EVENT_DOC, SPINE_EVENT_NO_FOLD} from '../src/spine.js';

const RECONSTRUCT = fileURLToPath(new URL('../src/reconstruct.ts', import.meta.url));

/** The event names `foldSpine`'s switch actually handles. */
function foldedEventNames(): Set<string> {
  const src = readFileSync(RECONSTRUCT, 'utf8');
  return new Set([...src.matchAll(/case '([A-Za-z0-9_]+)':/g)].map((m) => m[1]));
}

const abiEventNames = (): string[] => [...new Set(spineEventAbi.map((f) => (f as {name?: string}).name ?? ''))].sort();

test('every spine event either folds into state or is excused in SPINE_EVENT_NO_FOLD', () => {
  const folded = foldedEventNames();
  const names = abiEventNames();
  assert.ok(names.length > 40, `sanity: expected the whole spine, got ${names.length} events`);

  const unaccounted = names.filter((n) => !folded.has(n) && !SPINE_EVENT_NO_FOLD[n]);
  assert.deepEqual(
    unaccounted,
    [],
    `these spine events reach no field of ProjectState and give no reason why. Either add a case to ` +
      `foldSpine, or add an entry to SPINE_EVENT_NO_FOLD saying what reads the fact instead: ` +
      `${unaccounted.join(', ')}`,
  );
});

test('no event claims both — folded AND excused', () => {
  // A stale excuse for an event that has since grown a fold reads as "this is deliberately absent
  // from state" while state carries it, which is worse than no note at all.
  const folded = foldedEventNames();
  const both = Object.keys(SPINE_EVENT_NO_FOLD).filter((n) => folded.has(n));
  assert.deepEqual(both, [], `folded, but still excused from folding — drop the SPINE_EVENT_NO_FOLD entry: ${both.join(', ')}`);
});

test('no excuse names an event the spine cannot decode', () => {
  const names = new Set(abiEventNames());
  const orphans = Object.keys(SPINE_EVENT_NO_FOLD).filter((n) => !names.has(n));
  assert.deepEqual(orphans, [], `excused events that no ABX contract emits: ${orphans.join(', ')}`);
});

test('every excuse actually says something, and names a described event', () => {
  for (const [name, reason] of Object.entries(SPINE_EVENT_NO_FOLD)) {
    assert.ok(reason.trim().length > 20, `${name}: an excuse this short is not a reason (${JSON.stringify(reason)})`);
    // The two tables describe the same vocabulary; an event excused from folding but missing from
    // the doc table would narrate as a blank line in every readout.
    assert.ok(SPINE_EVENT_DOC[name], `${name}: excused from folding but absent from SPINE_EVENT_DOC`);
  }
});

test('the two collection-policy events fold — the regression this file exists for', () => {
  const folded = foldedEventNames();
  for (const name of ['BurnConfigured', 'MaxRoyaltyBpsUpdated', 'DefaultMaxSupplySet']) {
    assert.ok(folded.has(name), `${name} must have a case in foldSpine — being in SPINE_EVENT_DOC is not folding`);
  }
});
