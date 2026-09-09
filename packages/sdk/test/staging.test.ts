import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOnchainReadSize,
  exceedsOnchainSoftLimit,
  ONCHAIN_IMAGE_SOFT_LIMIT,
  ETH_CALL_GAS_FLOOR,
  ONCHAIN_READ_WARN_BYTES,
  readableBytesAtGas,
  planStagedContent,
  tokenUriGasEstimate,
  TOKEN_URI_GAS_PER_KB_HIGH,
  TOKEN_URI_GAS_PER_KB_LOW,
} from '../src/staging.ts';
import {METADATA_REPRESENTATION as R} from '../src/spine.ts';

const enc = (s: string) => new TextEncoder().encode(s);

// ── planStagedContent — pure chunk/tx-shape math ──────────────────────────────

test('planStagedContent: uncompressed content plans a single chunk, representation "reader"', () => {
  const content = enc('hello world');
  const p = planStagedContent(content, 'none');
  assert.equal(p.fastlz, false);
  assert.equal(p.chunks, 1);
  assert.equal(p.stagedBytes, content.length);
  assert.equal(p.representation, R.reader);
  assert.deepEqual([...p.content], [...content]);
});

test('planStagedContent: fastlz compresses per-chunk and keeps the on-chain "reader" representation', () => {
  const content = enc('the '.repeat(2000)); // highly repetitive → strong fastlz compression
  const p = planStagedContent(content, 'fastlz');
  assert.equal(p.fastlz, true);
  assert.equal(p.representation, R.reader); // fastlz still decodes ON-CHAIN, unlike gzip
  assert.ok(p.stagedBytes < content.length, `expected fastlz to shrink ${content.length}B, got ${p.stagedBytes}B`);
});

test('planStagedContent: "gzip" content is the caller\'s job — this only tags the representation "reader-gzip"', () => {
  // The SDK never gzips (a Node-only transform — see the module doc); the caller hands in
  // already-gzipped bytes. planStagedContent just tags it correctly and does NOT re-compress.
  const alreadyGzipped = enc('pretend this is gzip output');
  const p = planStagedContent(alreadyGzipped, 'gzip');
  assert.equal(p.fastlz, false);
  assert.equal(p.representation, R.readerGzip);
  assert.deepEqual([...p.content], [...alreadyGzipped]);
});

test('planStagedContent: large content splits into multiple chunks, tx plan mode "split"', () => {
  const content = new Uint8Array(60_000); // > one 22 KB default chunk, several times over
  const p = planStagedContent(content, 'none');
  assert.ok(p.chunks >= 3, `expected several chunks for 60 KB, got ${p.chunks}`);
  assert.equal(p.plan.mode, 'split');
});

test('planStagedContent: content within one chunk plans a single atomic writeContent', () => {
  const p = planStagedContent(enc('tiny'), 'none');
  assert.equal(p.chunks, 1);
  assert.equal(p.plan.mode, 'single');
  assert.equal(p.plan.txCount, 1);
});

// ── exceedsOnchainSoftLimit — the large-for-on-chain boundary ─────────────────

test('exceedsOnchainSoftLimit: at or under the limit is fine; one byte over trips it', () => {
  assert.equal(exceedsOnchainSoftLimit(0), false);
  assert.equal(exceedsOnchainSoftLimit(ONCHAIN_IMAGE_SOFT_LIMIT), false); // == is NOT over
  assert.equal(exceedsOnchainSoftLimit(ONCHAIN_IMAGE_SOFT_LIMIT + 1), true);
});

// ── classifyOnchainReadSize — who can READ it, measured rather than assumed ──────
// Separate axis from the write-cost predicate above: the write is chunked across transactions
// (~200 gas/byte, no block limit ever binds it), while `tokenURI` reassembles the whole document in
// one `eth_call`. So what a creator can afford to WRITE and what a node will serve to READ are
// different numbers — and the read one belongs to whoever's endpoint is asking.
//
// No fixed byte threshold is a refusal; the verdict describes endpoint reach.

test('nothing is refused at any size — the verdict describes reach, never permission', () => {
  for (const kb of [40, 100, 256, 1024, 8192]) {
    const v = classifyOnchainReadSize(kb * 1024, 600_000_000);
    assert.ok(v === 'ok' || v === 'endpoint-dependent' || v === 'beyond-local-rpc', `${kb} KB got ${v}`);
  }
  // A 101 KB payload stays within the conservative reference cap.
  assert.equal(classifyOnchainReadSize(101 * 1024, null), 'ok', '101 KB was refused; it fits under the 50M floor');
});

test('the boundary is the measured floor every endpoint serves, not a guessed byte count', () => {
  assert.equal(classifyOnchainReadSize(readableBytesAtGas(ETH_CALL_GAS_FLOOR) - 2048), 'ok');
  // Past the floor, reach depends on whose RPC is asking — and with no measurement we say exactly
  // that rather than inventing a verdict.
  assert.equal(classifyOnchainReadSize(200 * 1024, null), 'endpoint-dependent');
  assert.equal(classifyOnchainReadSize(200 * 1024, 600_000_000), 'endpoint-dependent', 'a 600M node reads 200 KB fine');
  assert.equal(classifyOnchainReadSize(800 * 1024, 600_000_000), 'beyond-local-rpc', 'past even a 600M node');
});

test('readableBytesAtGas inverts tokenUriGasEstimate, so the two can never drift apart', () => {
  for (const gas of [15_000_000, ETH_CALL_GAS_FLOOR, 250_000_000, 600_000_000]) {
    const bytes = readableBytesAtGas(gas);
    const backToGas = tokenUriGasEstimate(bytes);
    assert.ok(Math.abs(backToGas - gas) / gas < 0.01, `${gas} -> ${bytes} B -> ${backToGas}`);
  }
  // The measured caps, stated as content sizes. These are the numbers the CLI shows a creator.
  assert.ok(Math.abs(readableBytesAtGas(ETH_CALL_GAS_FLOOR) / 1024 - 117) < 3, 'a 50M endpoint reads ~117 KB');
  assert.ok(Math.abs(readableBytesAtGas(600_000_000) / 1024 - 729) < 10, 'sepolia.base.org reads ~729 KB');
});

test('the write gate and the read gate stay separate — the whole point of having both', () => {
  // A 30 KB file is already past the cost-sane WRITE limit yet reads on anything. If these ever
  // collapse into one threshold, one of the two truths the toolkit tells a creator has been lost.
  assert.equal(exceedsOnchainSoftLimit(30 * 1024), true);
  assert.equal(classifyOnchainReadSize(30 * 1024), 'ok');
  assert.ok(ONCHAIN_READ_WARN_BYTES < readableBytesAtGas(ETH_CALL_GAS_FLOOR), 'the note fires well before reach is at risk');
});

// The measurements these assert against are in staging.ts's own note: a `forge` sweep of
// `tokenURI` over `reader`-staged content, callee execution gas only. Each bound below is
// "within ~5% of the measured number at that size", so a re-fit that drifts fails here.
const MEASURED_TOKEN_URI_GAS: ReadonlyArray<readonly [kb: number, gas: number]> = [
  [10, 3_588_993],
  [40, 14_740_366],
  [100, 40_254_159],
  [187, 86_021_071],
  [256, 131_269_134],
];

test('tokenUriGasEstimate: within 5% of measured across the whole range — not a flat per-KB rate', () => {
  assert.equal(tokenUriGasEstimate(0), 0);
  for (const [kb, measured] of MEASURED_TOKEN_URI_GAS) {
    const est = tokenUriGasEstimate(kb * 1024);
    const off = Math.abs(est - measured) / measured;
    assert.ok(off < 0.05, `at ${kb} KB: estimate ${est} vs measured ${measured} (${(off * 100).toFixed(1)}% off)`);
  }
});

test('tokenUriGasEstimate: superlinear — the per-KB rate CLIMBS with size', () => {
  const perKb = (kb: number) => tokenUriGasEstimate(kb * 1024) / kb;
  assert.ok(perKb(10) < perKb(100), 'a 100 KB read must cost more per KB than a 10 KB one');
  assert.ok(perKb(100) < perKb(256), 'and 256 KB more per KB again — a flat rate would fail here');
  // The published range for the readable band, straight out of the measured table.
  assert.ok(perKb(10) >= TOKEN_URI_GAS_PER_KB_LOW * 0.95 && perKb(10) <= TOKEN_URI_GAS_PER_KB_LOW * 1.05);
  assert.ok(perKb(100) >= TOKEN_URI_GAS_PER_KB_HIGH * 0.95 && perKb(100) <= TOKEN_URI_GAS_PER_KB_HIGH * 1.05);
});

test('the published per-KB range still matches the fit at the sizes that decide projects', () => {
  // 100 KB reads at ~40M — comfortably inside the 50M floor, which is exactly why refusing it was
  // wrong. If a re-fit drifts, the numbers the CLI quotes a creator drift with it.
  const at100 = tokenUriGasEstimate(100 * 1024);
  assert.ok(at100 > 35_000_000 && at100 < 45_000_000, `expected ~40M at 100 KB, got ${at100}`);
  assert.ok(at100 < ETH_CALL_GAS_FLOOR, '100 KB must fit under the floor every endpoint serves');
});
