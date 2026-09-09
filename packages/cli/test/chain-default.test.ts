import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT_CHAIN_KEY} from '@artblocks/abx-sdk';

// Regression: the base-sepolia default migration left a stale `process.env.ABX_CHAIN ?? 'sepolia'`
// in ownerops.ts (every owner-op ran on the WRONG chain when ABX_CHAIN was unset) and in the
// resolver's server.ts (SERVER_CHAIN_KEY desynced from SERVER_CHAIN_ID). Silent + env-dependent, so
// a behavioral test can't catch it — this lints the source for the exact stale pattern. Every module
// that defaults a chain key MUST use the single source of truth, DEFAULT_CHAIN_KEY.

test('DEFAULT_CHAIN_KEY is the shipped default (base-sepolia)', () => {
  assert.equal(DEFAULT_CHAIN_KEY, 'base-sepolia');
});

test('no module hardcodes a stale `ABX_CHAIN ?? \'sepolia\'` chain-key default', () => {
  // Test runner cwd is the repo root (see the `test` script). Read the two modules that regressed.
  for (const rel of ['packages/cli/src/ownerops.ts', 'packages/token-api/src/server.ts']) {
    const src = readFileSync(rel, 'utf8');
    assert.doesNotMatch(
      src,
      /ABX_CHAIN\s*\?\?\s*['"]sepolia['"]/,
      `${rel} hardcodes a stale 'sepolia' chain default — use DEFAULT_CHAIN_KEY (a wrong-chain default is silent + serious)`,
    );
  }
});

// main.ts and ownerops.ts once carried separate `const CHAIN = process.env.ABX_CHAIN
// ?? DEFAULT_CHAIN_KEY` — two copies whose only job was to agree with each other (one flagged
// "MUST match main.ts/config.ts" in its own comment — the smell of a fact that should live in one
// place). config.ts is now the sole source; both import it. Pin that the copies stay dead.
test('CHAIN is derived in exactly one place (config.ts) — main.ts/ownerops.ts import it, never re-derive', () => {
  const derivation = /const\s+CHAIN\s*=\s*process\.env\.ABX_CHAIN/;
  const configSrc = readFileSync('packages/cli/src/config.ts', 'utf8');
  assert.match(configSrc, derivation, 'config.ts should still own the CHAIN derivation');
  for (const rel of ['packages/cli/src/main.ts', 'packages/cli/src/ownerops.ts']) {
    const src = readFileSync(rel, 'utf8');
    assert.doesNotMatch(src, derivation, `${rel} must import CHAIN from config.ts, not re-derive it`);
    assert.match(src, /import\s*\{[^}]*\bCHAIN\b[^}]*\}\s*from\s*['"]\.\/config\.js['"]/, `${rel} must import CHAIN from ./config.js`);
  }
});
