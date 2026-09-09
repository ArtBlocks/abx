import {test} from 'node:test';
import assert from 'node:assert/strict';
import {declinesSkillInstall} from '../src/prompt.js';

// `abx doctor` offers to install/resync a missing or stale agent skill, defaulting to YES so the
// documented flow (`npm i -g` → `abx doctor`) sets the agent up in one pass. Because Enter accepts,
// the refusal set is the part that must not drift: getting it wrong writes files into someone's
// project when they meant to say no.

test('Enter (empty answer) accepts — the prompt is [Y/n]', () => {
  assert.equal(declinesSkillInstall(''), false);
  assert.equal(declinesSkillInstall('   '), false);
});

test('explicit refusals decline, in any case, with surrounding whitespace', () => {
  for (const a of ['n', 'N', 'no', 'NO', 'No', 'nope', ' n ', '\tno\n']) {
    assert.equal(declinesSkillInstall(a), true, `${JSON.stringify(a)} should decline`);
  }
});

test('affirmatives accept', () => {
  for (const a of ['y', 'Y', 'yes', 'YES', 'sure']) {
    assert.equal(declinesSkillInstall(a), false, `${JSON.stringify(a)} should accept`);
  }
});

test('a word merely starting with n is NOT a refusal', () => {
  // Guards against a sloppy /^n/i: "never mind" reads as a refusal to a human, but the point here is
  // that the predicate stays exact — anything unrecognized falls through to the default (accept),
  // and only the listed forms decline. Documented so the behavior is deliberate, not accidental.
  assert.equal(declinesSkillInstall('nah'), false);
  assert.equal(declinesSkillInstall('nevermind'), false);
});
