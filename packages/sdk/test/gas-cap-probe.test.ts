import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeEthCallGasCap} from '../src/probe.ts';

// The cap is measured. An endpoint that rejects state overrides must produce
// "unknown", never a wrong number and never a thrown error, because the whole point is that this
// can no longer stop anyone from deploying.

/** Run `fn` with `fetch` stubbed to `impl`, restoring the real one afterwards. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});

test('reports the gas the node actually provisioned, not what we asked for', async () => {
  let sent: any;
  const cap = await withFetch(async (_u, init) => {
    sent = JSON.parse(String((init as RequestInit).body));
    return json({jsonrpc: '2.0', id: 1, result: '0x' + (600_000_000).toString(16)});
  }, () => probeEthCallGasCap('https://example.invalid'));

  assert.equal(cap, 600_000_000);
  assert.equal(sent.method, 'eth_call');
  const [callObj, block, overrides] = sent.params;
  assert.equal(block, 'latest');
  // The whole probe is the state override: it injects GAS;MSTORE;RETURN and reads the answer back.
  // Without an override there is nothing to call, and a node would just return empty.
  const addr = callObj.to as string;
  assert.equal(overrides[addr].code, '0x5a60005260206000f3');
  assert.ok(Number(BigInt(callObj.gas)) > 600_000_000, 'must ask for more than any node grants, so the answer is the cap');
});

test('an endpoint that ignores state overrides is UNKNOWN, never a wrong number', async () => {
  // A node that drops the override returns empty data for a call to an account with no code.
  for (const result of ['0x', '0x0', undefined]) {
    const cap = await withFetch(async () => json({jsonrpc: '2.0', id: 1, result}), () => probeEthCallGasCap('https://example.invalid'));
    assert.equal(cap, null, `result ${String(result)} must read as unknown`);
  }
});

test('errors, non-200s and unreachable hosts degrade to null instead of throwing', async () => {
  const cases: Array<[string, typeof fetch]> = [
    ['jsonrpc error', async () => json({jsonrpc: '2.0', id: 1, error: {code: -32000, message: 'nope'}})],
    ['http 429', async () => new Response('rate limited', {status: 429})],
    ['network failure', async () => { throw new Error('ECONNREFUSED'); }],
    ['garbage body', async () => new Response('<html>proxy</html>', {status: 200})],
  ];
  for (const [label, impl] of cases) {
    const cap = await withFetch(impl, () => probeEthCallGasCap('https://example.invalid'));
    assert.equal(cap, null, `${label} must degrade to unknown, not throw`);
  }
});

test('a suspiciously tiny answer is rejected — that is an override that did not take', async () => {
  const cap = await withFetch(async () => json({jsonrpc: '2.0', id: 1, result: '0x' + (21_000).toString(16)}),
    () => probeEthCallGasCap('https://example.invalid'));
  assert.equal(cap, null, 'no real node caps eth_call at 21k; treating it as one would understate reach');
});
