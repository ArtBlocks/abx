import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ABX_JS} from '@artblocks/abx-token-api';
import {
  buildPreviewDocument,
  previewDepTags,
  previewSeed,
  previewSourceFromFlags,
  previewConfigFromFlags,
  compareCheckRuns,
  CHECK_EXIT,
  PREVIEW_FLAGS,
  previewCheckInteger,
} from '../src/preview.js';
import {parseDependencyRef} from '@artblocks/abx-sdk';
import {connect} from 'node:net';
import {startPreviewServer} from '../src/preview.js';

test('malformed Host and request targets return errors while the preview remains available', async () => {
  const server = await startPreviewServer({source: {kind: 'script', path: '/unused.js'}, deps: [], schemas: []}, 0);
  try {
    for (const [target, host] of [['/', ''], ['/', 'bad host'], ['//', 'localhost']]) {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(server.port, '127.0.0.1', () =>
          socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
        );
        let data = ''; socket.on('data', (chunk) => {data += chunk;});
        socket.on('end', () => resolve(data)); socket.on('error', reject);
      });
      assert.match(reply, /^HTTP\/1.1 400/);
    }
    assert.equal((await fetch(`${server.url}/api/seed`)).status, 200);
  } finally {await server.close();}
});

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

test('directory preview contains filesystem reads and requires a local Host', async () => {
  const {mkdtemp, mkdir, writeFile, symlink, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {startPreviewServer} = await import('../src/preview.js');
  const root = await mkdtemp(join(tmpdir(), 'abx-preview-boundary-'));
  await mkdir(join(root, 'build')); await writeFile(join(root, 'build/index.html'), 'art');
  await writeFile(join(root, 'build/.env'), 'DUMMY_SECRET'); await writeFile(join(root, 'outside'), 'DUMMY_OUTSIDE');
  await symlink(join(root, 'outside'), join(root, 'build/link'));
  await symlink(join(root, 'build/.env'), join(root, 'build/note'));
  const preview = await startPreviewServer({source: {kind: 'dir', path: join(root, 'build')}, schemas: [], deps: []}, 0);
  try {
    const base = `http://127.0.0.1:${preview.port}`;
    assert.equal((await fetch(`${base}/__abx_code/index.html`)).status, 200);
    assert.equal((await fetch(`${base}/__abx_code/.env`)).status, 404);
    assert.equal((await fetch(`${base}/__abx_code/link`)).status, 403);
    assert.equal((await fetch(`${base}/__abx_code/note`)).status, 404);
    await rm(join(root, 'build/index.html'));
    await symlink(join(root, 'build/.env'), join(root, 'build/index.html'));
    assert.equal((await fetch(`${base}/view`)).status, 404);
    await rm(join(root, 'build/index.html'));
    await symlink(join(root, 'outside'), join(root, 'build/index.html'));
    assert.equal((await fetch(`${base}/view`)).status, 403);
    const {request} = await import('node:http');
    const status = await new Promise<number | undefined>((resolve) => {const req = request(base, {headers: {host: 'untrusted.test'}}, (res) => {res.resume(); resolve(res.statusCode);}); req.end();});
    assert.equal(status, 403);
  } finally {await preview.close(); await rm(root, {recursive: true, force: true});}
});

test('compareCheckRuns: identical runs pass, drift in pixels or traits fails and hazards are merged', () => {
  const run = (h: string, t: Record<string, unknown> | null, hz: string[] = [], timedOut = false) => ({pixelHash: h, traits: t, hazards: hz, timedOut, done: true});
  const clean = compareCheckRuns([{seed: 's0', runs: [run('x', {a: 1}), run('x', {a: 1}), run('x', {a: 1})]}]);
  assert.equal(clean.verdict, 'pass');
  assert.equal(clean.ok, true);
  assert.equal(clean.runs, 3);
  assert.deepEqual(clean.seeds[0].hazards, []);

  // drift only on the THIRD run: two runs would have called this deterministic
  const late = compareCheckRuns([{seed: 's0', runs: [run('x', null, ['Date.now']), run('x', null), run('y', null, ['Math.random'])]}]);
  assert.equal(late.verdict, 'drift');
  assert.equal(late.seeds[0].pixelMatch, false);
  assert.equal(late.seeds[0].traitsMatch, true);
  assert.equal(late.seeds[0].distinctPixels, 2);
  assert.deepEqual(late.seeds[0].hazards, ['Date.now', 'Math.random']);

  const tr = compareCheckRuns([{seed: 's0', runs: [run('x', {a: 1}), run('x', {a: 2}), run('x', {a: 1})]}]);
  assert.equal(tr.verdict, 'drift');
  assert.equal(tr.seeds[0].traitsMatch, false);
});

test('compareCheckRuns: a timeout with matching output is a harness verdict, never a pass', () => {
  const run = (timedOut: boolean) => ({pixelHash: 'x', traits: null, hazards: [], timedOut, done: true});
  const r = compareCheckRuns([{seed: 's0', runs: [run(false), run(true), run(false)]}]);
  assert.equal(r.verdict, 'harness');
  assert.equal(r.ok, false);
  assert.equal(CHECK_EXIT[r.verdict], 2);
  assert.deepEqual([CHECK_EXIT.pass, CHECK_EXIT.drift], [0, 1]);
});

test('compareCheckRuns: drift that starts after frame 1 is caught only when later frames are compared', () => {
  const run = (later?: string[]) => ({pixelHash: 'a', ...(later ? {laterHashes: later} : {}), traits: null, hazards: [], done: true});
  const single = compareCheckRuns([{seed: 's0', runs: [run(), run(), run()]}]);
  assert.equal(single.verdict, 'pass');
  assert.equal(single.frames, 1);
  assert.deepEqual(single.seeds[0].driftFrames, []);

  const steady = compareCheckRuns([{seed: 's0', runs: [run(['b']), run(['b'])]}]);
  assert.equal(steady.verdict, 'pass');
  assert.equal(steady.frames, 2);

  const late = compareCheckRuns([{seed: 's0', runs: [run(['b', 'c']), run(['b', 'x']), run(['b', 'c'])]}]);
  assert.equal(late.verdict, 'drift');
  assert.equal(late.frames, 3);
  assert.deepEqual(late.seeds[0].driftFrames, [3]);
  assert.equal(late.seeds[0].pixelMatch, false);
  assert.equal(late.seeds[0].distinctPixels, 2);
});

test('--check is an accepted preview flag', () => {
  assert.ok(PREVIEW_FLAGS.has('check'));
  assert.ok(PREVIEW_FLAGS.has('runs'));
  assert.ok(PREVIEW_FLAGS.has('frames'));
});


test('check comparison normalizes object traits and compares later traits and completion', () => {
  const run = (traits: Record<string, unknown>) => ({pixelHash: 'x', traits, hazards: [], done: true});
  assert.equal(compareCheckRuns([{seed: 's', runs: [run({a: 1, b: {c: 2, d: 3}}), run({b: {d: 3, c: 2}, a: 1})]}]).verdict, 'pass');
  const late = compareCheckRuns([{seed: 's', runs: [
    {...run({a: 1}), laterHashes: ['same'], laterTraits: [{a: 2}]},
    {...run({a: 1}), laterHashes: ['same'], laterTraits: [{a: 3}]},
  ]}]);
  assert.equal(late.verdict, 'drift');
  assert.equal(late.seeds[0].pixelMatch, true);
  assert.equal(late.seeds[0].traitsMatch, false);
  assert.deepEqual(late.seeds[0].driftFrames, [2]);
  assert.equal(compareCheckRuns([{seed: 's', runs: [run({a: 1}), {...run({a: 1}), done: false}]}]).verdict, 'harness');
  assert.equal(compareCheckRuns([{seed: 's', runs: [run({a: 1}), {...run({a: 2}), errors: ['page_error']}]}]).verdict, 'harness');
  assert.equal(compareCheckRuns([]).verdict, 'harness');
  assert.equal(compareCheckRuns([{seed: 's', runs: [run({a: 1})]}]).verdict, 'harness');
});

test('check options reject unbounded, fractional and invalid counts instead of silently coercing', () => {
  for (const value of ['Infinity', 'NaN', '-1', '0', '1.5', '11', 'true']) {
    assert.throws(() => previewCheckInteger('runs', value, 3, 2, 10), /--runs must be an integer/);
  }
  assert.equal(previewCheckInteger('runs', undefined, 3, 2, 10), 3);
  assert.equal(previewCheckInteger('runs', '2', 3, 2, 10), 2);
});
