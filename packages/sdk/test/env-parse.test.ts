// parseEnvContent — the pure half of the .env loader. The duplicate-key case is the one that
// matters: last-wins (matching conventional dotenv tooling) is fine, silence is not (a stale
// duplicate ABX_RPC_URLS_<CHAIN> line left the CLI talking to a different network while every check
// read green).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEnvContent} from '../src/env.js';

test('parses entries, skipping blanks/comments and stripping matched quotes', () => {
  const {entries, duplicates} = parseEnvContent(
    ['# a comment', '', 'A=1', 'B="quoted"', "C='single'", 'D=has=equals', 'NOEQUALS'].join('\n'),
  );
  assert.deepEqual(entries, [
    ['A', '1'],
    ['B', 'quoted'],
    ['C', 'single'],
    ['D', 'has=equals'],
  ]);
  assert.deepEqual(duplicates, []);
});

test('a duplicated key keeps the LAST value, in its original position, and is reported', () => {
  const {entries, duplicates} = parseEnvContent(
    ['ABX_RPC_URLS_SEPOLIA=https://real-sepolia.example', 'OTHER=x', 'ABX_RPC_URLS_SEPOLIA=http://localhost:8545'].join('\n'),
  );
  // last-wins, matching conventional dotenv tooling — but the key keeps its FIRST position in the
  // ordered entries, only the value is updated.
  assert.deepEqual(entries, [
    ['ABX_RPC_URLS_SEPOLIA', 'http://localhost:8545'],
    ['OTHER', 'x'],
  ]);
  // ...and the shadowed (earlier) line is surfaced, not swallowed
  assert.deepEqual(duplicates, ['ABX_RPC_URLS_SEPOLIA']);
});

test('a key duplicated three times keeps the LAST value and is reported once', () => {
  const {entries, duplicates} = parseEnvContent(['K=1', 'K=2', 'K=3'].join('\n'));
  assert.deepEqual(entries, [['K', '3']]);
  assert.deepEqual(duplicates, ['K']);
});
