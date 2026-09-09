import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, Hex} from 'viem';
import {
  DEFAULT_SCRIPT_CHUNK_SIZE,
  joinScriptChunks,
  planScriptReplace,
  prepareRemoveLastScriptChunk,
  prepareSetScriptChunk,
  splitScriptChunks,
  verifyScriptReplace,
  type ScriptChunkReader,
} from '../src/script-chunks.js';

test('splitScriptChunks: a small script is one chunk, join is identity', () => {
  const src = 'const mass = 1;\nfunction draw(){ background(0); }\n';
  const chunks = splitScriptChunks(src);
  assert.equal(chunks.length, 1);
  assert.equal(joinScriptChunks(chunks), src);
});

test('splitScriptChunks: empty source stores nothing', () => {
  assert.deepEqual(splitScriptChunks(''), []);
  assert.equal(joinScriptChunks([]), '');
});

test('splitScriptChunks: splits at a newline so join reconstitutes the source', () => {
  const a = 'x'.repeat(90);
  const b = 'const mass = 1;\nfunction draw(){}\n';
  const src = `${a}\n${b}`;
  const chunks = splitScriptChunks(src, 100);
  assert.equal(chunks.length, 2);
  assert.equal(joinScriptChunks(chunks), src);
  // The join character is NOT stored in either chunk — the generator inserts it.
  assert.equal(new TextDecoder().decode(chunks[0]), a);
});

test('splitScriptChunks: packs many short lines into one chunk until the window fills', () => {
  const line = 'const a = 1;\n';
  const src = line.repeat(4000); // well over 22 kB, newlines every 13 bytes
  const chunks = splitScriptChunks(src);
  assert.ok(chunks.length >= 2);
  assert.equal(joinScriptChunks(chunks), src);
  for (const c of chunks) assert.ok(c.length <= DEFAULT_SCRIPT_CHUNK_SIZE);
});

test('splitScriptChunks: a 22 kB+ span with no newline is refused (the `mass` split)', () => {
  // The live failure: a fixed 22_000-byte slice cut `mass` into `ma` + `ss`, and the generator's
  // `\n` join made that a SyntaxError. Refusing is the honest outcome — there is no split that
  // matches the on-chain join.
  const src = `${'x'.repeat(DEFAULT_SCRIPT_CHUNK_SIZE)}mass`;
  assert.throws(() => splitScriptChunks(src), /no newline/);
});

test('splitScriptChunks: CRLF files still reassemble (split is on LF)', () => {
  const src = `${'a'.repeat(80)}\r\n${'b'.repeat(80)}\r\n`;
  const chunks = splitScriptChunks(src, 90);
  assert.equal(joinScriptChunks(chunks), src);
});

// ── prepareSetScriptChunk / prepareRemoveLastScriptChunk ──────────────────────
// `OnChainScript.sol`'s writers originally had no `prepare*` wrapper — deploy-code hand-encoded
// `encodeFunctionData` inline. These mirror `prepareSetDependency`/`prepareRemoveLastDependency`'s
// shape (ops.ts) exactly: same `PreparedTx` fields, same per-byte gasFloor reasoning as the
// code-setup multicall.

const CONTRACT = '0x0000000000000000000000000000000000c0de' as Address;

test('prepareSetScriptChunk: encodes index + chunk, and floors gas at 200/byte', () => {
  const tx = prepareSetScriptChunk({contract: CONTRACT, index: 2, chunk: '0xaabbcc' as Hex, chainId: 84532});
  assert.equal(tx.to, CONTRACT);
  assert.equal(tx.value, '0x0');
  assert.equal(tx.chainId, 84532);
  assert.equal(tx.fields.index, '2');
  assert.equal(tx.fields.bytes, '3');
  assert.equal(tx.gasFloor, `0x${(3 * 200).toString(16)}`);
  assert.match(tx.summary, /chunk \[2\]/);
});

test('prepareSetScriptChunk: an empty chunk carries no gasFloor (nothing deposited)', () => {
  const tx = prepareSetScriptChunk({contract: CONTRACT, index: 0, chunk: '0x' as Hex, chainId: 84532});
  assert.equal(tx.fields.bytes, '0');
  assert.equal(tx.gasFloor, undefined);
});

test('prepareRemoveLastScriptChunk: value-free, same-contract call with no index (pops the tail)', () => {
  const tx = prepareRemoveLastScriptChunk({contract: CONTRACT, chainId: 84532});
  assert.equal(tx.to, CONTRACT);
  assert.equal(tx.value, '0x0');
  assert.match(tx.summary, /last script chunk/i);
});

// ── planScriptReplace ──────────────────────────────────────────────────────────
// The diff `replace-script` sends only what changed against — mirrors `resume.ts`'s script-chunk
// leg: content, not count, decides "present", so a hand-repaired or already-correct index is never
// re-sent (200 gas/byte makes that the most expensive way to be "safe").

function reader(chunks: (Hex | null)[]): ScriptChunkReader {
  return {
    scriptChunkCount: async () => chunks.length,
    scriptChunk: async (i) => (i < chunks.length ? chunks[i] : null),
  };
}

test('planScriptReplace: byte-identical replacement is a NOOP — nothing to write, nothing to remove', async () => {
  const plan = await planScriptReplace(reader(['0xaaaa' as Hex, '0xbbbb' as Hex]), ['0xaaaa' as Hex, '0xbbbb' as Hex]);
  assert.deepEqual(plan.toWrite, []);
  assert.equal(plan.toRemove, 0);
  assert.equal(plan.noop, true);
  assert.equal(plan.currentCount, 2);
  assert.equal(plan.targetCount, 2);
});

test('planScriptReplace: only the CHANGED index is queued, same count', async () => {
  const plan = await planScriptReplace(
    reader(['0xaaaa' as Hex, '0xbbbb' as Hex, '0xcccc' as Hex]),
    ['0xaaaa' as Hex, '0xNEWBBBB' as unknown as Hex, '0xcccc' as Hex],
  );
  assert.deepEqual(plan.toWrite, [{index: 1, hex: '0xNEWBBBB'}]);
  assert.equal(plan.toRemove, 0);
  assert.equal(plan.noop, false);
});

test('planScriptReplace: comparison is case-insensitive (hex casing must not force a re-send)', async () => {
  const plan = await planScriptReplace(reader(['0xAABBCC' as Hex]), ['0xaabbcc' as Hex]);
  assert.deepEqual(plan.toWrite, []);
  assert.equal(plan.noop, true);
});

test('planScriptReplace: growing writes only the NEW trailing indices, removes nothing', async () => {
  const plan = await planScriptReplace(
    reader(['0xaaaa' as Hex]),
    ['0xaaaa' as Hex, '0xbbbb' as Hex, '0xcccc' as Hex],
  );
  assert.deepEqual(plan.toWrite, [
    {index: 1, hex: '0xbbbb'},
    {index: 2, hex: '0xcccc'},
  ]);
  assert.equal(plan.toRemove, 0);
  assert.equal(plan.currentCount, 1);
  assert.equal(plan.targetCount, 3);
});

// Truncation matters because `removeLastScriptChunk` pops ONE chunk at a time,
// so shrinking by N is N queued calls — `toRemove` is that count, not a single "resize" op.
test('planScriptReplace: shrinking queues toRemove = the count difference, and only re-sends changed retained indices', async () => {
  const plan = await planScriptReplace(
    reader(['0xaaaa' as Hex, '0xbbbb' as Hex, '0xcccc' as Hex, '0xdddd' as Hex, '0xeeee' as Hex]),
    ['0xaaaa' as Hex, '0xNEW' as unknown as Hex], // index 0 unchanged, index 1 changed, 2/3/4 gone
  );
  assert.deepEqual(plan.toWrite, [{index: 1, hex: '0xNEW'}]);
  assert.equal(plan.toRemove, 3);
  assert.equal(plan.currentCount, 5);
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.noop, false);
});

test('planScriptReplace: shrinking to a byte-identical prefix still queues the removes (not a noop)', async () => {
  // Fewer chunks is a real on-chain change even when every RETAINED index already matches — a noop
  // here would silently leave the stale tail in place.
  const plan = await planScriptReplace(reader(['0xaaaa' as Hex, '0xbbbb' as Hex]), ['0xaaaa' as Hex]);
  assert.deepEqual(plan.toWrite, []);
  assert.equal(plan.toRemove, 1);
  assert.equal(plan.noop, false);
});

test('planScriptReplace: clearing the script entirely (0 target chunks) removes every chunk', async () => {
  const plan = await planScriptReplace(reader(['0xaaaa' as Hex, '0xbbbb' as Hex]), []);
  assert.deepEqual(plan.toWrite, []);
  assert.equal(plan.toRemove, 2);
  assert.equal(plan.targetCount, 0);
});

// ── verifyScriptReplace ────────────────────────────────────────────────────────
// The safety property `replace-script` exists for: a transaction not reverting is proof the EVM
// accepted each call, never proof the FINAL program is what was intended. These pin the failure
// mode directly — a half-applied or otherwise wrong on-chain result must report `ok: false` with
// the actual reassembled bytes, never a false "verified".

test('verifyScriptReplace: reassembly matches exactly → ok', async () => {
  const src = 'const a = 1;\nfunction draw(){}';
  const chunks = splitScriptChunks(src, 20); // force a multi-chunk split
  const r = reader(chunks.map((c) => `0x${Buffer.from(c).toString('hex')}` as Hex));
  const result = await verifyScriptReplace(r, src);
  assert.equal(result.ok, true);
  assert.equal(result.reassembled, src);
  assert.equal(result.chunkCount, chunks.length);
});

test('verifyScriptReplace: a HALF-APPLIED replacement (one stale chunk) is caught, not reported clean', async () => {
  // Simulates the dangerous partial-write state: chunk 0 has new content while chunk 1 is still the
  // OLD content (e.g. a hand-repaired multicall that only partially landed before this atomic
  // design existed, or a concurrent write). The reassembled program is neither the old nor the new
  // script — and this must say so.
  const oldChunk1 = `0x${Buffer.from('OLD TAIL').toString('hex')}` as Hex;
  const newChunk0 = `0x${Buffer.from('const a = 1;').toString('hex')}` as Hex;
  const r = reader([newChunk0, oldChunk1]);
  const result = await verifyScriptReplace(r, 'const a = 1;\nNEW TAIL');
  assert.equal(result.ok, false);
  assert.match(result.reassembled, /OLD TAIL/);
});

test('verifyScriptReplace: scriptChunkCount/scriptChunk disagreeing (a null mid-read) fails verification, never silently gaps', async () => {
  const r: ScriptChunkReader = {
    scriptChunkCount: async () => 2,
    scriptChunk: async (i) => (i === 0 ? (`0x${Buffer.from('a').toString('hex')}` as Hex) : null),
  };
  const result = await verifyScriptReplace(r, 'a\nb');
  assert.equal(result.ok, false);
});
