// Proof that swapping the watcher's two hand-rolled backoff formulas for the hoisted
// `@artblocks/abx-sdk` helpers (`exponentialBackoffDelay`, `linearBackoffDelay`) is a NO-OP on the
// numbers produced — the whole point of "adopt the shared helper" is that nothing downstream of it
// changes. Each table below computes the OLD formula (copied verbatim from the pre-swap
// `watcher.ts`) and the NEW formula (the sdk helper, called with the exact mapping `watcher.ts` now
// uses) and asserts they agree at every attempts/failures value that matters — including past the
// cap, where a mapping mistake is easiest to hide.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exponentialBackoffDelay, linearBackoffDelay} from '@artblocks/abx-sdk';

// ── dueForRetry's exponential backoff (watcher.ts) ───────────────────────────────────────────
// OLD: Math.min(baseMs * 2 ** Math.min(attempts, 8), 15 * 60_000)
// NEW: exponentialBackoffDelay(Math.min(attempts, 8) + 1, baseMs, 15 * 60_000)
//   — the sdk helper is 1-indexed (delay(attempt) = min(baseMs * 2^(attempt-1), cap)), so
//     attempt = min(attempts, 8) + 1 reproduces the exponent min(attempts, 8) exactly, cap included.

function oldExponential(attempts: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** Math.min(attempts, 8), capMs);
}

function newExponential(attempts: number, baseMs: number, capMs: number): number {
  return exponentialBackoffDelay(Math.min(attempts, 8) + 1, baseMs, capMs);
}

test('watcher retry backoff: old formula === sdk helper (via the +1 mapping) for attempts 0..12', () => {
  const baseMs = 12_000; // ABX_WATCH_INTERVAL_MS default
  const capMs = 15 * 60_000;
  const table: Array<{attempts: number; old: number; sdk: number}> = [];
  for (let attempts = 0; attempts <= 12; attempts++) {
    const old = oldExponential(attempts, baseMs, capMs);
    const sdk = newExponential(attempts, baseMs, capMs);
    table.push({attempts, old, sdk});
    assert.equal(sdk, old, `attempts=${attempts}: sdk helper (${sdk}) !== old formula (${old})`);
  }
  // The cap must actually bind somewhere in this range (proves the test isn't vacuously passing
  // below the cap only) — attempts>=8 all pin to the same capped value.
  assert.equal(table[8].old, capMs, 'attempts=8 must already be capped at 15 minutes');
  assert.equal(table[12].old, table[8].old, 'attempts beyond 8 must not keep growing — the exponent stays pinned at 8');
});

test('watcher retry backoff: holds for a range of baseMs values too (not just the production default)', () => {
  const capMs = 15 * 60_000;
  for (const baseMs of [1, 100, 1_000, 12_000, 60_000]) {
    for (let attempts = 0; attempts <= 12; attempts++) {
      assert.equal(newExponential(attempts, baseMs, capMs), oldExponential(attempts, baseMs, capMs), `baseMs=${baseMs} attempts=${attempts}`);
    }
  }
});

// ── the tick loop's linear backoff (watcher.ts) ──────────────────────────────────────────────
// OLD: intervalMs * Math.max(1, failures)
// NEW: linearBackoffDelay(Math.max(1, failures), intervalMs)   (= attempt * baseMs, same shape)

function oldLinear(failures: number, intervalMs: number): number {
  return intervalMs * Math.max(1, failures);
}

function newLinear(failures: number, intervalMs: number): number {
  return linearBackoffDelay(Math.max(1, failures), intervalMs);
}

test('watcher tick-failure backoff: old formula === sdk helper for failures 0..12', () => {
  const intervalMs = 12_000;
  for (let failures = 0; failures <= 12; failures++) {
    assert.equal(newLinear(failures, intervalMs), oldLinear(failures, intervalMs), `failures=${failures}`);
  }
  // failures=0 and failures=1 must collapse to the same delay (Math.max(1, ·) floors it) — the
  // detail that would break if someone "simplified" the mapping to a bare linearBackoffDelay(failures, …).
  assert.equal(newLinear(0, intervalMs), newLinear(1, intervalMs));
});
