// The code-project folds: params (set/clear, provenance), schemas (emitted in full,
// selectOptions kept as JSON), hooks, delegation (explicit zero vs absent-default),
// seed source, script lock, and the ordered dependency list — plus the JS twin of the
// canonical scalar decode (parity with TokenDataLib's Solidity tests).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {foldSpine} from '../src/reconstruct.js';
import {
  decodeDecimalParam,
  decodeScalarParam,
  encodeScalarParam,
  encodeTag,
} from '../src/spine.js';
import type {SpineEvent} from '../src/types.js';

let seq = 0;
function ev(name: string, args: Record<string, string>): SpineEvent {
  seq += 1;
  return {
    name,
    register: 2,
    what: '',
    blockNumber: String(seq),
    logIndex: seq,
    txHash: `0x${seq.toString(16).padStart(64, '0')}`,
    args,
  };
}

const SOURCE = '0x00000000000000000000000000000000000Aaaa1';
const OWNER = '0x00000000000000000000000000000000000Aaaa2';
const ZERO = '0x0000000000000000000000000000000000000000';

test('token params fold last-writer-wins with explicit clear and provenance', () => {
  const fold = foldSpine([
    ev('TokenParamConfigured', {
      tokenId: '0',
      key: encodeTag('seed'),
      value: '0x' + 'ab'.repeat(32),
      valueIsHash: 'false',
      updatedBy: SOURCE,
    }),
    ev('TokenParamConfigured', {
      tokenId: '0',
      key: encodeTag('palette'),
      value: '0x' + '0'.repeat(58) + '0e1a40',
      valueIsHash: 'false',
      updatedBy: OWNER,
    }),
    ev('TokenParamCleared', {tokenId: '0', key: encodeTag('palette'), updatedBy: OWNER}),
  ]);

  const params = fold.tokenParams.get('0')!;
  assert.equal(params.size, 1); // cleared is gone — unset, not zero
  const seed = params.get('seed')!;
  assert.equal(seed.valueIsHash, false);
  assert.equal(seed.updatedBy, SOURCE); // provenance = the seed source, not the owner
});

test('schema folds in full, selectOptions survive as a real array', () => {
  const fold = foldSpine([
    ev('ParamSchemaConfigured', {
      key: encodeTag('mood'),
      paramType: '1', // Select
      auth: '1', // TokenOwner
      authAddress: ZERO,
      lockAfter: '0',
      min: '0x' + '0'.repeat(64),
      max: '0x' + '0'.repeat(64),
      selectOptions: JSON.stringify(['calm', 'storm, at sea']), // comma inside an option
    }),
  ]);
  const schema = fold.paramSchemas.get('mood')!;
  assert.equal(schema.paramType, 'Select');
  assert.equal(schema.auth, 'TokenOwner');
  assert.equal(schema.authAddress, null);
  assert.deepEqual(schema.selectOptions, ['calm', 'storm, at sea']);
});

test('hooks, seed source, and explicit delegation opt-out fold', () => {
  const fold = foldSpine([
    ev('HooksConfigured', {configureHook: SOURCE, augmentHook: ZERO, transferHook: ZERO}),
    ev('SeedSourceSet', {seedSource: SOURCE}),
    ev('DelegateRegistrySet', {registry: ZERO}), // explicit opt-out at init
  ]);
  assert.equal(fold.paramHooks?.configureHook, SOURCE);
  assert.equal(fold.paramHooks?.augmentHook, null);
  assert.equal(fold.seedSource, SOURCE);
  assert.equal(fold.delegateRegistry, null); // explicitly disabled — NOT the canonical default
});

// The hook set's one-way lock. It folds independently of `HooksConfigured` on purpose: a project may
// freeze hooks it never set (that is the strongest thing it can say — "no transfer veto can ever be
// armed here"), and the freeze must survive whatever order the two events arrive in.
test('ParamHooksFrozen folds — with hooks set, and with none ever set', () => {
  const withHooks = foldSpine([
    ev('HooksConfigured', {configureHook: ZERO, augmentHook: ZERO, transferHook: SOURCE}),
    ev('ParamHooksFrozen', {}),
  ]);
  assert.equal(withHooks.paramHooksFrozen, true);
  assert.equal(withHooks.paramHooks?.transferHook, SOURCE); // the armed veto stays armed

  const frozenEmpty = foldSpine([ev('ParamHooksFrozen', {})]);
  assert.equal(frozenEmpty.paramHooksFrozen, true);
  assert.equal(frozenEmpty.paramHooks, null); // never set, and now never settable

  // …and a project that never froze reads false, not undefined — the CLI prints a live-power warning
  // off this, so it has to be a definite boolean.
  assert.equal(foldSpine([]).paramHooksFrozen, false);
});

test('absent DelegateRegistrySet stays undefined (assembly resolves the canonical default)', () => {
  const fold = foldSpine([]);
  assert.equal(fold.delegateRegistry, undefined);
});

test('dependencies fold as an ordered, dense list', () => {
  const fold = foldSpine([
    ev('DependencyUpdated', {index: '0', resolution: '0', ref: encodeTag('p5js@1.9.0')}),
    ev('DependencyUpdated', {index: '1', resolution: '1', ref: '0x' + 'cafe'.repeat(10).slice(0, 40) + '0'.repeat(24)}),
    ev('DependencyUpdated', {index: '0', resolution: '0', ref: encodeTag('p5js@2.0.0')}), // replace in place
    ev('DependencyRemoved', {index: '1'}),
    ev('DependencyRegistrySet', {registry: SOURCE}),
    ev('DependenciesLocked', {}),
    ev('ScriptLocked', {}),
  ]);
  assert.equal(fold.dependencies.length, 1);
  assert.equal(fold.dependencies[0].resolution, 'registry');
  assert.equal(fold.dependencies[0].refDecoded, 'p5js@2.0.0');
  assert.equal(fold.dependencyRegistry, SOURCE);
  assert.equal(fold.dependenciesLocked, true);
  assert.equal(fold.scriptLocked, true);
});

test('canonical scalar decode matches TokenDataLib (the Solidity twin)', () => {
  // DecimalRange: ÷ 1e10, trailing zeros trimmed, no point when whole
  assert.equal(decodeDecimalParam(10_000_000_000n), '1');
  assert.equal(decodeDecimalParam(15_000_000_000n), '1.5');
  assert.equal(decodeDecimalParam(10_123_400_000_000n), '1012.34');
  assert.equal(decodeDecimalParam(1n), '0.0000000001');
  assert.equal(decodeDecimalParam(0n), '0');

  assert.equal(decodeScalarParam('HexColor', 0x0e1a40n), '#0e1a40');
  // Out-of-domain HexColor is masked to 24 bits, byte-for-byte with the on-chain
  // `TokenDataLib.decodeScalar` (`& 0xffffff`). The raw owner setter can store such a value before a
  // HexColor schema is attached; without the mask the two serving planes would split `inputsHash`.
  // The Solidity twin of this assertion is in `test_DecodeScalars` in
  // contracts/test/FieldRenderer.t.sol — the two together pin the on-chain↔SDK parity.
  assert.equal(decodeScalarParam('HexColor', 0x1ffffffn), '#ffffff');
  assert.equal(decodeScalarParam('HexColor', 0xabcdef123456n), '#123456');
  assert.equal(decodeScalarParam('Bool', 1n), 'true');
  assert.equal(decodeScalarParam('Bool', 0n), 'false');
  assert.equal(decodeScalarParam('Int256Range', BigInt.asUintN(256, -42n)), '-42');
  assert.equal(decodeScalarParam('Timestamp', 1_750_000_000n), '1750000000');
});

test('encodeScalarParam is the exact reverse of the canonical decode', () => {
  const roundtrip = (t: Parameters<typeof encodeScalarParam>[0], input: string, opts: string[] = []) => {
    const {value, display} = encodeScalarParam(t, input, opts);
    return {display, back: t === 'Select' ? opts[Number(BigInt(value))] : decodeScalarParam(t, value)};
  };
  assert.deepEqual(roundtrip('HexColor', '#22DDaa'), {display: '#22ddaa', back: '#22ddaa'});
  assert.deepEqual(roundtrip('DecimalRange', '1012.34'), {display: '1012.34', back: '1012.34'});
  assert.deepEqual(roundtrip('Int256Range', '-42'), {display: '-42', back: '-42'});
  assert.deepEqual(roundtrip('Bool', 'true'), {display: 'true', back: 'true'});
  assert.deepEqual(roundtrip('Select', 'storm', ['calm', 'storm']), {display: 'storm', back: 'storm'});
  assert.deepEqual(roundtrip('Select', '0', ['calm', 'storm']), {display: 'calm', back: 'calm'});
  assert.throws(() => encodeScalarParam('HexColor', 'red'));
  assert.throws(() => encodeScalarParam('Select', 'hurricane', ['calm', 'storm']));
  assert.throws(() => encodeScalarParam('DecimalRange', '1.00000000001')); // >10 places
});
