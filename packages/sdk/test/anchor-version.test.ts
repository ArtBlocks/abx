// `AbxVersion.CORE_VERSION` (Solidity) and `ABX_CORE_VERSION` (TypeScript) are one fact expressed
// twice, so this reads the contract source and diffs them — the same shape as
// `create2-salts.test.ts` for the salts and `packages/cli/test/onchain-uri.test.ts` for the
// renderer's SPEC_VERSION.
//
// This exists because the thing it guards already failed once in the other direction. The anchor
// freshness probes used to ask "does this implementation expose feature X" — a capability question
// every pre-remediation build also answers yes to — with a comment telling the next author to
// hand-bump the probed capability on every implementation change. Nobody did, so an operator
// holding an older factory must not have it reported as
// `resolved` and keep stamping clones on a vulnerable implementation. The probes now gate on
// `abxVersion()`; a version is only a safety control if the two halves cannot drift apart.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {ABX_CORE_VERSION} from '../src/anchors.js';

const VERSION_SOL = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/src/libraries/AbxVersion.sol',
);

test('ABX_CORE_VERSION equals AbxVersion.CORE_VERSION in the contract source', () => {
  const src = readFileSync(VERSION_SOL, 'utf8');
  const m = src.match(/uint16\s+internal\s+constant\s+CORE_VERSION\s*=\s*(\d+)\s*;/);
  assert.ok(
    m,
    'could not find `uint16 internal constant CORE_VERSION = <n>;` in AbxVersion.sol — if it was ' +
      'renamed or reformatted, update this regex rather than deleting the test, or the two halves ' +
      'silently stop being one fact.',
  );
  assert.equal(
    ABX_CORE_VERSION,
    BigInt(m![1]),
    `AbxVersion.CORE_VERSION is ${m![1]} but the SDK gates on ${ABX_CORE_VERSION}. Bumping the ` +
      'Solidity constant alone makes every existing anchor report as stale; bumping the TS constant ' +
      'alone makes a stale anchor report as current. Move both, in the same commit.',
  );
});
