// Owner-ops input validation. Regression guards for bugs the all-dimensions sweep found:
// `set-royalty --bps` accepted no bound-check (a non-numeric or >100% value would hit the chain or
// a cryptic ABI read), and the representation/reserved-key guards for the data plane.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRoyaltyBps} from '../src/ownerops.js';

test('parseRoyaltyBps accepts 0 up to the on-chain cap (1000 bps = 10%)', () => {
  assert.equal(parseRoyaltyBps('0'), 0);
  assert.equal(parseRoyaltyBps('500'), 500); // 5% — the default
  assert.equal(parseRoyaltyBps('750'), 750); // 7.5%
  assert.equal(parseRoyaltyBps('1000'), 1000); // 10% — the ceiling RoyaltyExtension enforces
});

test('parseRoyaltyBps rejects out-of-range and non-integer input with a clear message', () => {
  // The parse bound is the ABSOLUTE protocol maximum (10000 bps = 100%); a collection's own cap
  // (owner-set at deploy, reduce-only) may be lower and is enforced on chain. So values like 1500
  // (15%) and 4200 (42%) now parse cleanly — only out-of-range (>100%), negative, and non-integer
  // are rejected here. (empty/'true' are rejected upstream by requireFlag before this parses.)
  for (const bad of ['10001', '15000', '-1', '7.5', 'abc', 'true', '1e5']) {
    assert.throws(() => parseRoyaltyBps(bad), (e: Error) => {
      assert.match(e.message, /--bps must be a whole number 0.10000\b/);
      assert.match(e.message, /100 = 1%/); // teaches the bps↔% math in the error itself
      return true;
    }, `expected "${bad}" to be rejected`);
  }
  // and the rates a creator actually uses — including above the old 10% ceiling — now parse
  for (const ok of ['0', '250', '500', '750', '1000', '1500', '4200', '10000']) {
    assert.equal(typeof parseRoyaltyBps(ok), 'number');
  }
});

// set-param-hooks flag parsing: a hook role takes a 0x address or a clear literal. The read-modify-
// write + SeriesCode/dry-run guards are covered live + by the SDK encode test; this locks the parse.
import {parseHookAddress} from '../src/ownerops.js';
import {getAddress, zeroAddress} from 'viem';

test('parseHookAddress: clear literals all map to the zero address', () => {
  for (const clear of ['none', 'NONE', 'zero', '0', '0x0', zeroAddress]) {
    assert.equal(parseHookAddress('augment', clear), zeroAddress, `"${clear}" should clear`);
  }
});

test('parseHookAddress: a valid address is checksummed; junk and a bare flag throw', () => {
  const a = '0x0248a8d137bdad8ed91d5bf9eddcdc09d095b13c';
  assert.equal(parseHookAddress('configure', a), getAddress(a)); // normalized to EIP-55
  assert.throws(() => parseHookAddress('configure', '0xnope'), /must be a 0x address or "none"/);
  assert.throws(() => parseHookAddress('transfer', 'true'), /needs a value/); // bare `--transfer`
});

// Authorship + rights deploy flags → on-chain inline collection fields. Only the flags that are
// set are written, in declaration order, each as an `inline` field keyed by its reserved JSON key.
import {authorshipContractFields} from '../src/ownerops.js';
import {encodeTag, METADATA_REPRESENTATION as R, type Hex} from '@artblocks/abx-sdk';
import {toHex} from 'viem';

test('authorshipContractFields: builds inline collection fields only for the flags provided', () => {
  const fields = authorshipContractFields({creator: 'Casey Reas', license: 'CC BY-NC 4.0'});
  assert.deepEqual(fields, [
    {field: encodeTag('creator'), representation: encodeTag(R.inline), value: toHex('Casey Reas')},
    {field: encodeTag('license'), representation: encodeTag(R.inline), value: toHex('CC BY-NC 4.0')},
  ]);
  // the field key round-trips to the reserved JSON key the resolver/renderer project.
  assert.equal((fields[0].field as Hex).startsWith('0x'), true);
});

test('authorshipContractFields: no authorship flags → no fields (deploy writes nothing extra)', () => {
  assert.deepEqual(authorshipContractFields({name: 'X', description: 'hi'}), []);
});

test('authorshipContractFields: all four, in declaration order', () => {
  const keys = authorshipContractFields({
    'creator-links': 'https://reas.com',
    license: 'CC0-1.0',
    creator: 'CR',
    'display-notes': 'notes',
  }).map((f) => f.field);
  assert.deepEqual(keys, ['creator', 'display_notes', 'creator_links', 'license'].map((k) => encodeTag(k)));
});

// ── the generator repoint guard (membrane-enforce, not a warning) ─────────────
// The canonical AbxGenerator reads a token's param surface FROM CHAIN. A LEGACY implementation —
// deployed before enumeration shipped — has no such getters, so the generator would read NOTHING:
// every configured param silently vanishes from tokenData, the live view, and every render, behind
// a tokenURI that still looks healthy. `set-field` refuses that combination outright.
import {assertGeneratorRepointable} from '../src/ownerops.js';
import {METADATA_REPRESENTATION as REP, resolveGenerator, type Address} from '@artblocks/abx-sdk';

const LEGACY = '0x7CcC774271daa029cF0284BE913611Bc66eA5155' as Address;
const OTHER_RENDERER = '0x00000000000000000000000000000000deadbeef' as Address;
const encoded = (a: Address) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const yes = async () => true;
const no = async () => false;

test('repoint guard: a legacy token pointed at the canonical generator is REFUSED', async () => {
  const generator = resolveGenerator(84532) ?? resolveGenerator(11155111);
  assert.ok(generator, 'the manifest must know a canonical generator to guard');
  await assert.rejects(
    assertGeneratorRepointable(LEGACY, 'animation_url', {representation: REP.renderer, value: encoded(generator!)}, no),
    (e: Error) => {
      assert.match(e.message, /refusing/i);
      assert.match(e.message, /LEGACY/);
      assert.match(e.message, /silently disappear/); // names the failure, not just the rule
      assert.match(e.message, /redeploy/); // …and the way out
      return true;
    },
  );
});

test('repoint guard: a token that DOES enumerate passes', async () => {
  const generator = resolveGenerator(84532) ?? resolveGenerator(11155111);
  await assertGeneratorRepointable(LEGACY, 'animation_url', {representation: REP.renderer, value: encoded(generator!)}, yes);
});

test('repoint guard: only the CANONICAL generator is guarded — a creator\'s own field renderer is not', async () => {
  // no probe should even run for a third-party renderer; `no` would refuse if it did.
  await assertGeneratorRepointable(LEGACY, 'image', {representation: REP.renderer, value: encoded(OTHER_RENDERER)}, no);
});

test('repoint guard: non-renderer representations are untouched (inline text, keccak commitments)', async () => {
  await assertGeneratorRepointable(LEGACY, 'description', {representation: REP.inline, value: '0xdeadbeef'}, no);
  await assertGeneratorRepointable(LEGACY, 'image', {value: `0x${'11'.repeat(32)}`}, no);
});

// ── the `renderer` field-value encoding (the alpha.29 field-notes headline bug) ────────────────
// `set-field --representation renderer --value <20-byte address>` wrote the address VERBATIM. The
// metadata renderer does `abi.decode(v, (address))`, which reverts on anything shorter than a word,
// so tokenURI reverted for the whole collection — while `contractField("image")` still read back
// the right representation and a right-looking address. Confirmed on chain: the reporter's
// 0xA480…33bf holds `renderer` + a 20-byte value, and its tokenURI reverts.
import {encodeStructuredFieldValue} from '../src/ownerops.js';

const RENDERER = '0x34287A37004c4372166a7b7150501544b95e960b';
const RENDERER_WORD = `0x${'0'.repeat(24)}34287a37004c4372166a7b7150501544b95e960b`;

test('renderer: a bare 20-byte address is abi-encoded to a 32-byte word, not written raw', () => {
  assert.equal(encodeStructuredFieldValue(REP.renderer, RENDERER), RENDERER_WORD);
  // checksummed, lowercase, and whitespace-padded input all land on the same bytes
  assert.equal(encodeStructuredFieldValue(REP.renderer, RENDERER.toLowerCase()), RENDERER_WORD);
  assert.equal(encodeStructuredFieldValue(REP.renderer, `  ${RENDERER}  `), RENDERER_WORD);
});

test('renderer: an already-canonical abi.encode(address) passes through unchanged', () => {
  assert.equal(encodeStructuredFieldValue(REP.renderer, RENDERER_WORD), RENDERER_WORD);
  assert.equal(encodeStructuredFieldValue(REP.renderer, RENDERER_WORD.toUpperCase().replace('0X', '0x')), RENDERER_WORD);
});

test('renderer: a length the renderer cannot decode is REFUSED, and the error says what to pass', () => {
  for (const bad of ['0xdeadbeef', `0x${'11'.repeat(21)}`, '0x', 'not-hex']) {
    assert.throws(() => encodeStructuredFieldValue(REP.renderer, bad), (e: Error) => {
      assert.match(e.message, /expects the field renderer's 0x address/);
      assert.match(e.message, /reverts tokenURI for the WHOLE collection/);
      return true;
    }, `expected "${bad}" to be refused`);
  }
});

test('renderer: a 32-byte word with dirty high bytes (e.g. a keccak commitment) is REFUSED', () => {
  // This decodes "successfully" to a garbage address, so nothing downstream would catch it.
  assert.throws(() => encodeStructuredFieldValue(REP.renderer, `0x${'11'.repeat(32)}`), (e: Error) => {
    assert.match(e.message, /first 12 bytes are zero/);
    return true;
  });
});

test('reader: only abi.encode(address, address) is accepted, and the error points at --file', () => {
  const ok = `0x${'0'.repeat(24)}${'aa'.repeat(20)}${'0'.repeat(24)}${'bb'.repeat(20)}`;
  for (const rep of [REP.reader, REP.readerGzip]) {
    assert.equal(encodeStructuredFieldValue(rep, ok), ok);
    assert.throws(() => encodeStructuredFieldValue(rep, `0x${'aa'.repeat(20)}`), (e: Error) => {
      assert.match(e.message, /abi\.encode\(address reader, address pointer\)/);
      assert.match(e.message, /--file/);
      return true;
    });
  }
});

test('every other representation carries raw bytes and is passed through untouched', () => {
  for (const rep of [REP.inline, REP.keccak256, REP.url, REP.ipfs, REP.arweave, REP.urlTemplate, REP.inlineGzip]) {
    assert.equal(encodeStructuredFieldValue(rep, '0xdeadbeef'), '0xdeadbeef');
  }
  // …including a value that would be refused under `renderer`
  assert.equal(encodeStructuredFieldValue(REP.inline, '0x00'), '0x00');
});

// ── dry-run simulation: the revert decoder ────────────────────────────────────
// `--dry-run` now eth_calls the prepared transaction and says whether it would succeed. Decoding the
// revert is best-effort BY THE NODE — several public endpoints return `execution reverted` with no
// data — so the two branches are pinned separately: decode when data is there, and say plainly that
// the node sent none when it isn't (never "we couldn't read it").
import {revertReason} from '../src/riskgate.js';
import {encodeErrorResult} from 'viem';
import {seriesCodeAbi} from '@artblocks/abx-sdk';

test('revertReason: an ABX custom error decodes to its own name', () => {
  const data = encodeErrorResult({abi: seriesCodeAbi, errorName: 'RoyaltyTooHigh'});
  assert.match(revertReason({data}), /^RoyaltyTooHigh\(\)$/);
  // viem nests the payload one level down on a CallExecutionError
  assert.match(revertReason({cause: {data}}), /^RoyaltyTooHigh\(\)$/);
});

test('revertReason: a node that sends NO revert data says so, rather than blaming the decode', () => {
  const r = revertReason({shortMessage: 'Execution reverted for an unknown reason.'});
  assert.match(r, /this RPC returns no revert data/);
  assert.doesNotMatch(r, /unknown reason/i); // viem's phrasing must not survive — it reads as our failure
  assert.match(r, /lock, a cap, or the wrong signer/); // and it names what it usually is
});

test('revertReason: an unrelated error keeps its own message', () => {
  assert.equal(revertReason({shortMessage: 'HTTP request failed.'}), 'HTTP request failed.');
  assert.equal(revertReason(new Error('boom')), 'boom');
});
