import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDryRun, parseBlockTagFlag, parseFlags, parseSaltFlag, REPEATABLE_FLAGS} from '../src/flags.js';
import {editionSchemaAdvisory, parseSchemaSpecs} from '../src/schema.js';

test('parseFlags: a normal repeated flag is last-wins', () => {
  assert.equal(parseFlags(['--name', 'A', '--name', 'B']).name, 'B');
});

test('parseFlags: --dep and --schema ACCUMULATE (repeated ≡ comma-separated), argv order preserved', () => {
  // Regression: a second --schema used to silently drop the first (last-wins), so a two-param drop
  // lost a param. --schema now accumulates like --dep.
  assert.ok(REPEATABLE_FLAGS.has('schema') && REPEATABLE_FLAGS.has('dep'));
  assert.equal(parseFlags(['--dep', 'p5@1.0.0', '--dep', 'foo@1']).dep, 'p5@1.0.0,foo@1');
  assert.equal(
    parseFlags(['--schema', 'density:Uint256Range[0..100]:TokenOwner', '--schema', 'season:Select[A|B]:TokenOwner']).schema,
    'density:Uint256Range[0..100]:TokenOwner,season:Select[A|B]:TokenOwner',
  );
  // repeated ≡ the equivalent comma-joined single flag
  assert.equal(
    parseFlags(['--schema', 'a:HexColor:Creator', '--schema', 'b:Bool:Creator']).schema,
    parseFlags(['--schema', 'a:HexColor:Creator,b:Bool:Creator']).schema,
  );
});

test('parseFlags: --k=v, bare --k → true, and non-flag args are ignored', () => {
  assert.equal(parseFlags(['--onchain-uri'])['onchain-uri'], 'true');
  assert.equal(parseFlags(['--max=16']).max, '16');
  assert.equal(parseFlags(['deploy', '--name', 'X']).name, 'X');
});

// isDryRun: the one place `--dry-run` truthiness is decided — every write command (owner-op or
// deploy) reads it through here instead of a hand-rolled `!!flags['dry-run']`.
test('isDryRun: true for a bare or valued --dry-run, false when absent', () => {
  assert.equal(isDryRun(parseFlags(['--dry-run'])), true);
  assert.equal(isDryRun(parseFlags(['--dry-run', 'true'])), true);
  assert.equal(isDryRun(parseFlags(['--name', 'X'])), false);
  assert.equal(isDryRun({}), false);
});

// A salt's leading 20 bytes are an access guard the FACTORY enforces: the caller's own address means
// only that signer may deploy with it; all-zero means anyone may. Omitting --salt gives you the
// former. Only `abx predict` ever explained this, while the deploy commands took an explicit --salt
// verbatim and said nothing — so a creator pinning a vanity salt with a zero prefix and announcing
// the predicted address was handing it to whoever deployed there first, and the front-runner ends up
// as `owner()` because ownership is set by `initialize`, not by the prediction. The security
// review reproduced that.
//
// The warning lives in the parser because that is the one place every command passes through; the
// five deploy call sites that derive an address from a salt would each have needed it otherwise.
test('parseSaltFlag: an all-zero guard prefix warns that anyone may deploy', () => {
  const lines: string[] = [];
  const orig = console.log;
  // `warn` goes through console.log (stdout, not stderr) — capture the real path rather than a mock.
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const open = parseSaltFlag(`0x${'0'.repeat(40)}${'1'.repeat(24)}`);
    assert.ok(open, 'still returns the salt — this warns, it does not refuse');
    assert.match(lines.join(''), /ANYONE may deploy/, 'the zero-prefix case is called out');

    lines.length = 0;
    parseSaltFlag(`0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C${'1'.repeat(24)}`);
    assert.equal(lines.join(''), '', 'a signer-pinned guard prefix is silent');
  } finally {
    console.log = orig;
  }
});

test('parseSaltFlag: still validates shape', () => {
  assert.throws(() => parseSaltFlag('0xdeadbeef'), /32-byte hex/);
  assert.equal(parseSaltFlag(undefined), undefined);
  assert.equal(parseSaltFlag('true'), undefined, 'a bare --salt is not a value');
});

// A holder-writable param on an ERC-1155 edition is SHARED by
// every holder of that id, and a data-typed one has no on-chain size budget — so one holder can make
// the shared metadata unreadable for all co-holders. Both are deliberate protocol choices (byte
// accounting on chain would cost every project to police a configuration almost nobody should use),
// which makes the advisory the actual mitigation rather than a footnote about one.
test('editionSchemaAdvisory: silent unless a holder can write, loud about data types', () => {
  const spec = (s: string) => parseSchemaSpecs(s);

  assert.equal(editionSchemaAdvisory(spec('palette:Select[a|b]:Creator')), null, 'creator-only says nothing');
  assert.equal(editionSchemaAdvisory([]), null);

  const shared = editionSchemaAdvisory(spec('mood:Uint256Range:TokenOwner'));
  assert.match(shared!, /shares one value/, 'names the actual hazard: shared, not per-copy');
  assert.doesNotMatch(shared!, /size cap/, 'a scalar has no size hazard to warn about');

  const data = editionSchemaAdvisory(spec('title:String:TokenOwner'));
  assert.match(data!, /size cap/, 'a data type adds the availability hazard');
  assert.match(data!, /title/);

  // every auth leg that includes a holder counts, not just the bare one
  const ADDR = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C';
  assert.ok(editionSchemaAdvisory(spec('k:Uint256Range:CreatorOrTokenOwner')));
  for (const auth of ['TokenOwnerOrAddress', 'CreatorOrTokenOwnerOrAddress']) {
    // the *OrAddress legs name a specific writer, so the spec carries one
    assert.ok(editionSchemaAdvisory(spec(`k:Uint256Range:${auth}(${ADDR})`)), `${auth} is holder-writable`);
  }

  // A holder-writable `seed` schema on an edition is the sharp case — the
  // normally-immutable generative seed becomes re-rollable by ANY holder of the id, changing the
  // artwork for every co-holder. The advisory calls it out by name; a non-seed key does not.
  const seed = editionSchemaAdvisory(spec('seed:Uint256Range:TokenOwner'));
  assert.match(seed!, /seed is holder-writable/, 'names seed specifically');
  assert.match(seed!, /re-roll/, 'explains the generative consequence');
  assert.doesNotMatch(shared!, /re-roll/, 'a non-seed key gets no seed note');
});


test('parseBlockTagFlag: only the two reorg-safe tags, and a number is REFUSED not coerced', () => {
  assert.equal(parseBlockTagFlag('safe'), 'safe');
  assert.equal(parseBlockTagFlag('finalized'), 'finalized');

  // absent, and the bare `--to-block` with no value, both mean "unset" — not a tag.
  assert.equal(parseBlockTagFlag(undefined), undefined);
  assert.equal(parseBlockTagFlag('true'), undefined);

  // A raw height is the important refusal: `abx index` chooses its own incremental window, so a
  // hand-pinned block would freeze the watermark somewhere the next run can't reason about. Refusing
  // beats silently ignoring it — an ignored --to-block reads as "it scanned to there".
  for (const bad of ['12345', 'latest', 'pending', 'earliest', '0x1f', 'SAFE']) {
    assert.throws(() => parseBlockTagFlag(bad), /takes 'safe' or 'finalized'/, `${bad} must be refused`);
  }
  // the error names what to do instead, per the house rule on actionable errors
  assert.throws(() => parseBlockTagFlag('99'), /omit the flag for the default/);
});
