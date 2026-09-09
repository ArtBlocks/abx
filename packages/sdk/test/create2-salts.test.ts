// The salt twins: `ABX_SALT` (create2.ts) must stay byte-identical to `AbxSalts.sol`, because the
// deterministic address is `keccak256(0xff ++ proxy ++ keccak256(salt) ++ keccak256(initcode))` — a
// single character of drift between the TS and Solidity halves silently sends the SDK to a
// different address than the forge script, and nothing else in the repo would notice until two
// chains disagreed. So this reads the CONTRACT SOURCE and diffs the two salt tables, the way
// `packages/cli/test/onchain-uri.test.ts` pins the renderer's SPEC_VERSION against its .sol.
//
// This file exists because of the write-path libraries in particular. They were held to be
// nonce-dependent (they are not — they are CREATE2'd through the keyless proxy at the salts below),
// and that false belief cost two ERC-1155 token types their libraries and an EIP-170 floor its
// headroom. The salts are now stated in both halves; this test is what keeps them one fact.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {keccak256, toBytes} from 'viem';
import {ABX_SALT, saltHash} from '../src/create2.js';

const SALTS_SOL = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/script/AbxSalts.sol');

/** Every `bytes32 internal constant NAME = keccak256("string");` in AbxSalts.sol, as NAME → string. */
function solSalts(): Map<string, string> {
  const src = readFileSync(SALTS_SOL, 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/bytes32\s+internal\s+constant\s+(\w+)\s*=\s*\n?\s*keccak256\("([^"]+)"\)/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** SCREAMING_SNAKE (Solidity) → lowerCamel (TS), so the two tables can be diffed by name. */
const camel = (screaming: string): string =>
  screaming.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

test('AbxSalts.sol parses (guards this test against a rename/reformat silently passing)', () => {
  const sol = solSalts();
  assert.ok(sol.size >= 15, `expected every AbxSalts constant, parsed ${sol.size}`);
  for (const name of ['PARAMS_LIB', 'CODE_LIB', 'EDITION_LIB', 'SERIES_CODE_FACTORY', 'EDITION_CODE_FACTORY']) {
    assert.ok(sol.has(name), `AbxSalts.${name} must be declared`);
  }
});

test('every ABX_SALT string is the one AbxSalts.sol hashes, under the twin name', () => {
  const sol = solSalts();
  const byCamel = new Map([...sol].map(([name, s]) => [camel(name), s]));
  for (const [key, value] of Object.entries(ABX_SALT)) {
    const solValue = byCamel.get(key);
    assert.ok(solValue !== undefined, `ABX_SALT.${key} has no AbxSalts.sol twin (expected a ${key} constant)`);
    assert.equal(value, solValue, `ABX_SALT.${key} drifted from AbxSalts.sol`);
  }
});

test('every AbxSalts.sol constant has an ABX_SALT twin (the generator is the one exception)', () => {
  // The generator is salted in Solidity but never predicted here: its constructor bakes chain-specific
  // immutables, so its address legitimately differs per chain. Present in ABX_SALT for parity.
  const missing = [...solSalts().keys()].map(camel).filter((k) => !(k in ABX_SALT));
  assert.deepEqual(missing, [], `AbxSalts.sol constants with no ABX_SALT entry: ${missing.join(', ')}`);
});

test('the three write-path library salts hash to the values the deploy scripts use', () => {
  // Spot-check the arithmetic itself, not just the strings: these are the exact bytes32 values
  // `DeployLibraries.s.sol` feeds the keyless proxy, so a viem/keccak regression would show here.
  assert.equal(ABX_SALT.paramsLib, 'abx.lib.params.v1');
  assert.equal(ABX_SALT.codeLib, 'abx.lib.code.v1');
  assert.equal(ABX_SALT.editionLib, 'abx.lib.edition.v1');
  assert.equal(saltHash(ABX_SALT.paramsLib), '0xbf0c74210ab6a4720d238a4ce2636e2c2ce21a378a8f7688db175e0fd05697d5');
  assert.equal(saltHash(ABX_SALT.codeLib), '0x04c93005461fa51fa65cb9fbcf3d4ef591b3f9d1e7f01c6ddac70116149002bd');
  assert.equal(saltHash(ABX_SALT.editionLib), '0x84bb4cc42185d7007eb139933b5ef32e59c09e94267ed5e0a4a6b3ad71c14d4a');
  // …and that `saltHash` is plain keccak256 of the utf-8 string, like Solidity's keccak256("literal").
  assert.equal(saltHash(ABX_SALT.paramsLib), keccak256(toBytes('abx.lib.params.v1')));
});

// Every anchor and singleton the SDK deploys must go through the keyless proxy, never a bare
// contract creation. `to: null` deploys to a nonce-dependent address, which for a trust anchor is
// not a cosmetic difference: the anchor is the one address platforms allowlist and the manifest
// records, so a nonce-dependent one can never match either, and a second bootstrap on the same
// chain silently produces a second, differently-addressed anchor.
//
// This is a source-level ban rather than a call-through, because that is exactly how the last two
// escaped: `prepareDeployFactory` and `prepareDeploySeriesFactory` sat three lines from
// `prepareDeployRenderer`'s comment explaining why `to: null` was wrong for a singleton, and kept
// `to: null` anyway. Nothing failed. Clone deploys legitimately target a factory, so the rule is
// not "everything is CREATE2" — it is "nothing is a bare creation".
test('no deploy op is a bare contract creation (`to: null`)', () => {
  const OPS_TS = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ops.ts');
  const src = readFileSync(OPS_TS, 'utf8');
  const offenders = src
    .split('\n')
    .map((line, i) => ({line: line.trim(), n: i + 1}))
    // The string appears in prose explaining the ban; only a real property assignment counts.
    .filter(({line}) => /^to:\s*null\s*,?$/.test(line));
  assert.deepEqual(
    offenders,
    [],
    `ops.ts has ${offenders.length} bare-creation deploy(s) at line(s) ${offenders
      .map((o) => o.n)
      .join(', ')} — route it through CREATE2_PROXY with create2Calldata() and a canonical ABX_SALT, ` +
      'and add a predict*() helper so the address is computable before the deploy.',
  );
});
