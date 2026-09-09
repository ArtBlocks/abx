import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ABX_JS} from '@artblocks/abx-token-api';
import {
  buildPreviewDocument,
  previewDepTags,
  previewSeed,
  previewSourceFromFlags,
  previewConfigFromFlags,
} from '../src/preview.js';
import {parseDependencyRef} from '@artblocks/abx-sdk';

test('previewSeed is a real bytes32 — full width, so the sketch PRNG sees production entropy', () => {
  const s = previewSeed(0);
  assert.match(s, /^0x[0-9a-f]{64}$/);
});

test('previewSeed is deterministic per index but distinct across indexes', () => {
  // Stability matters: a re-render after an edit must be a like-for-like comparison, not new output.
  assert.equal(previewSeed(3), previewSeed(3));
  assert.notEqual(previewSeed(3), previewSeed(4));
  const many = new Set(Array.from({length: 32}, (_, i) => previewSeed(i)));
  assert.equal(many.size, 32);
});

test('the preview document inlines the REAL abx.js runtime, not a stub', () => {
  // The whole fidelity claim rests on this: one definition of the runtime surface, shared with
  // what the generator serves. A hand-rolled stub is exactly the drift this replaces.
  const doc = buildPreviewDocument('/*art*/', '{"seed":"0x1"}', []);
  assert.ok(doc.includes(ABX_JS));
  assert.ok(doc.includes('abx.traits = function'));
});

test('the preview document matches the generator document shape', () => {
  const doc = buildPreviewDocument('var x=1;', '{"chainId":84532,"seed":"0x1"}', []);
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes('<style>html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}</style>'));
  // tokenData is injected BEFORE abx.js, which reads it — order is load-bearing.
  assert.ok(doc.indexOf('window.abxTokenData=') < doc.indexOf('abx.tokenData = window.abxTokenData'));
  assert.ok(doc.trimEnd().endsWith('</body></html>'));
});

test('a script containing </script> is escaped so it cannot break out of the element', () => {
  const doc = buildPreviewDocument('var s = "</script>";', '{}', []);
  assert.ok(!doc.includes('"</script>"'));
  assert.ok(doc.includes('<\\/script'));
});

test('tokenData JSON escapes < so it cannot break out either', () => {
  const doc = buildPreviewDocument('var x=1;', '{"note":"a<b"}', []);
  assert.ok(doc.includes('a\\u003cb'));
});

test('dep tags come from the built-in CDN map for a name@version ref', () => {
  const {tags, notes} = previewDepTags([parseDependencyRef('p5@1.0.0')]);
  assert.equal(tags.length, 1);
  assert.match(tags[0], /^<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/p5@1\.0\.0/);
  assert.match(notes[0], /p5@1\.0\.0 →/);
});

test('an on-chain data-contract dep is reported, never silently dropped', () => {
  // It cannot be fetched without a chain, so the preview would render a sketch missing its
  // runtime — the creator must be told rather than left debugging their own code.
  const addr = '0x' + 'ab'.repeat(20);
  const {tags, notes} = previewDepTags([parseDependencyRef(addr)]);
  assert.equal(tags.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not fetchable offline/);
});

test('dep tags land in the document in declared order (index 0 is the runtime)', () => {
  const {tags} = previewDepTags([parseDependencyRef('p5@1.0.0'), parseDependencyRef('tonejs@14.0.0')]);
  const doc = buildPreviewDocument('var x=1;', '{}', tags);
  assert.ok(doc.indexOf('p5@1.0.0') < doc.indexOf('tone@14.0.0'));
});

test('--script and --code-dir are mutually exclusive', () => {
  assert.throws(
    () => previewSourceFromFlags({script: 'a.js', 'code-dir': 'build'}),
    /either --script <file> or --code-dir <dir>, not both/,
  );
});

test('preview needs a program', () => {
  assert.throws(() => previewSourceFromFlags({}), /needs the program/);
});

test('a valueless --script flag is not mistaken for a filename', () => {
  // `abx preview --script` (no value) parses as the string 'true' — treating that as a path
  // would fail later with a confusing ENOENT for a file literally named "true".
  assert.throws(() => previewSourceFromFlags({script: 'true'}), /needs the program/);
});

test('schemas and deps parse off the flags into the config', () => {
  const cfg = previewConfigFromFlags({
    script: 'art.js',
    schema: 'palette:HexColor:TokenOwner,mood:Select[Calm|Wild]:TokenOwner',
    dep: 'p5@1.0.0',
  });
  assert.equal(cfg.source.kind, 'script');
  assert.deepEqual(cfg.schemas.map((s) => s.key), ['palette', 'mood']);
  assert.equal(cfg.deps.length, 1);
});
