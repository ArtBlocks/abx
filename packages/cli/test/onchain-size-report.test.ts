import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {guardOnChainSize, __setRpcGasCapForTest} from '../src/ownerops.ts';

// These pin two properties: the guard never refuses, and what it claims about reach is
// the MEASURED cap rather than a hardcoded guess about somebody else's infrastructure.

/** Run the guard with a pinned cap and capture what it printed. */
async function report(bytes: number, gasCap: number | null, label = 'art.png'): Promise<string> {
  __setRpcGasCapForTest({gasCap, label: gasCap != null ? 'rpc.example' : null});
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    await guardOnChainSize(bytes, label);
  } finally {
    console.log = real;
  }
  // Strip ANSI so assertions match words, not colour codes.
  return lines.join('\n').replace(/\[[0-9;]*m/g, '');
}

afterEach(() => __setRpcGasCapForTest(undefined));

test('no size is refused — not at the old 100 KB wall, not anywhere', async () => {
  for (const kb of [101, 256, 512, 2048, 16384]) {
    await assert.doesNotReject(() => report(kb * 1024, 600_000_000), `${kb} KB must not throw`);
  }
});

test('the size that used to be refused reads on every endpoint, and is reported as such', async () => {
  // 101 KB estimates ~42M gas — inside the 50M floor. The old gate refused it outright.
  const out = await report(101 * 1024, 600_000_000);
  assert.match(out, /renders anywhere/);
  assert.doesNotMatch(out, /warning|REVERT/, '101 KB is not a warning case; it is under the floor');
});

test('a 77 KB payload renders everywhere, with both gas figures named', async () => {
  const out = await report(77 * 1024, 600_000_000);
  assert.match(out, /~16M gas to write/, 'the write is chunked — quote it');
  assert.match(out, /~31M gas to read/);
  assert.match(out, /renders anywhere/);
});

test('past the floor it names YOUR measured cap, not a guess', async () => {
  const out = await report(312 * 1024, 600_000_000);
  assert.match(out, /your RPC allows ~600M gas \(rpc\.example\)/, 'the measured number, attributed to the endpoint');
  assert.match(out, /serves ~729KB/, 'what that cap means in content terms');
  assert.match(out, /50M-capped provider the ceiling is ~117KB/, 'and what everyone else sees');
  assert.match(out, /revert/, 'the consequence, in the creator-facing terms');
  assert.match(out, /Writing is unaffected/, 'the write axis is never the thing at risk');
});

test('it never claims to know a marketplace\'s limit — only that it cannot', async () => {
  // The measurement is of OUR endpoint. Presenting it as though it settled whether the token
  // displays would be the same overreach the hardcoded threshold made, wearing a measurement.
  const out = await report(312 * 1024, 600_000_000);
  assert.match(out, /CANNOT know a marketplace's or an indexer's/);
  assert.match(out, /Measured just now/, 'point-in-time, not a standing property of someone else’s infra');
});

test('an uncapped node is reported as uncapped, never as our own probe ask', async () => {
  // The probe asks for 2,000,000,000. A node that hands all of it back did not clamp — reporting
  // "2000M cap" would be inventing a limit out of our own request.
  const out = await report(312 * 1024, Number.POSITIVE_INFINITY);
  assert.match(out, /no eth_call cap at all/);
  assert.doesNotMatch(out, /2000M|Infinity|NaN/);
});

test('every warning names the resolver route — on-chain bytes are preservation, serving is separate', async () => {
  // The reach problem is fixable after the fact: a resolver reads the on-chain content with its own
  // RPC and serves plain HTTP, so the marketplace never makes the big eth_call.
  for (const cap of [600_000_000, null]) {
    const out = await report(312 * 1024, cap);
    assert.match(out, /serves it over plain HTTP/, `cap ${cap} must offer the resolver route`);
    assert.match(out, /set-renderer <addr> --off/, 'and name the command that repoints tokenURI');
    assert.match(out, /preservation; serving is a separate, swappable choice/);
  }
});

test('an unmeasurable RPC says so — it never invents a cap and never blocks', async () => {
  const out = await report(312 * 1024, null);
  assert.match(out, /could not be measured/);
  assert.doesNotMatch(out, /your RPC allows/, 'must not claim a number it does not have');
  assert.match(out, /50M-capped provider the ceiling is ~117KB/, 'still gives the conservative reference');
});

test('past your own endpoint it says nothing you can point at will render it', async () => {
  const out = await report(800 * 1024, 600_000_000);
  assert.match(out, /past what your own RPC serves/);
  assert.match(out, /the bytes are permanent the moment they land/);
  assert.match(out, /serves it over plain HTTP/, 'even here there is a route — it is never a dead end');
});
