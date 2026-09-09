// `probeChunkStore` is the fail-closed sibling to `ensureChunkStore`: a
// request-scoped or read-only service needs to answer "is there a usable chunk store" at startup
// WITHOUT ever sending a transaction, and needs the three negative outcomes (nothing configured, an
// address with no code, an address whose code isn't a current chunk store) to be distinguishable —
// a caller branches on the verdict rather than parsing a thrown error's message.
//
// Mirrors the `probeSeedSource`/`probeTransferValidator` mocked-client style (see
// creator-token.test.ts): a stub `PublicClient` answers `getCode` and `call` directly, no real RPC.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, PublicClient} from 'viem';
import {probeChunkStore} from '../src/chunks.js';
import {resolveChunkStore} from '../src/deployments.js';

const BASE_SEPOLIA = 84532;
const UNSHIPPED_CHAIN = 8453; // no manifest entry — matches deployments.test.ts's convention
const MANIFEST_STORE = resolveChunkStore(BASE_SEPOLIA) as Address;
const OVERRIDE = '0x1111111111111111111111111111111111111111' as Address;

/** A PublicClient stub: `getCode` answers `code` (or throws when `codeThrows` is set), `call`
 *  succeeds or throws `callThrows` — the same shape `writeContent([],[])` is probed with. */
function mockClient(opts: {code?: string; codeThrows?: string; callThrows?: string; onGetCode?: (a: Address) => void}): PublicClient {
  return {
    getCode: async ({address}: {address: Address}) => {
      opts.onGetCode?.(address);
      if (opts.codeThrows) throw new Error(opts.codeThrows);
      return opts.code;
    },
    call: async () => {
      if (opts.callThrows) throw new Error(opts.callThrows);
      return {data: '0x'};
    },
  } as unknown as PublicClient;
}

// Isolate every test from a real ABX_CHUNK_STORE in the ambient env (mirrors deployments.test.ts's
// resolveGenerator test) — precedence tests set it deliberately and must restore it after.
function withoutEnvOverride<T>(fn: () => T | Promise<T>): Promise<T> {
  const before = process.env.ABX_CHUNK_STORE;
  delete process.env.ABX_CHUNK_STORE;
  return Promise.resolve(fn()).finally(() => {
    if (before === undefined) delete process.env.ABX_CHUNK_STORE;
    else process.env.ABX_CHUNK_STORE = before;
  });
}

// ── negative: nothing configured ───────────────────────────────────────────────────────────────

test('probeChunkStore: unconfigured — no override, no env, no manifest entry for this chain', async () =>
  withoutEnvOverride(async () => {
    const client = mockClient({});
    const probe = await probeChunkStore(client, {chainId: UNSHIPPED_CHAIN});
    assert.equal(probe.verdict, 'unconfigured');
    assert.equal(probe.address, undefined);
  }));

// ── negative: an address is configured but nothing is deployed there ──────────────────────────

test('probeChunkStore: no-code — configured address, chain says nothing is deployed there', async () =>
  withoutEnvOverride(async () => {
    const client = mockClient({code: '0x'});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA});
    assert.equal(probe.verdict, 'no-code');
    assert.equal(probe.address, MANIFEST_STORE);
  }));

test('probeChunkStore: no-code — `getCode` answering undefined counts the same as "0x"', async () =>
  withoutEnvOverride(async () => {
    const client = mockClient({code: undefined});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA});
    assert.equal(probe.verdict, 'no-code');
  }));

// ── negative: code exists but isn't a compatible chunk store ───────────────────────────────────

test('probeChunkStore: incompatible — has code, but reverts the writeContent([],[]) probe', async () =>
  withoutEnvOverride(async () => {
    const client = mockClient({code: '0x6080', callThrows: 'execution reverted (unknown selector)'});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA});
    assert.equal(probe.verdict, 'incompatible');
    assert.equal(probe.address, MANIFEST_STORE);
  }));

// ── positive ────────────────────────────────────────────────────────────────────────────────────

test('probeChunkStore: ok — has code and answers the writeContent([],[]) probe', async () =>
  withoutEnvOverride(async () => {
    const client = mockClient({code: '0x6080'});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA});
    assert.equal(probe.verdict, 'ok');
    assert.equal(probe.address, MANIFEST_STORE);
  }));

// ── override preserves chain defaults ──────────────────────────────────────────────────────────

test('probeChunkStore: an explicit override is probed instead of the chain default', async () =>
  withoutEnvOverride(async () => {
    const seen: Address[] = [];
    const client = mockClient({code: '0x6080', onGetCode: (a) => seen.push(a)});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA, override: OVERRIDE});
    assert.equal(probe.verdict, 'ok');
    assert.equal(probe.address, OVERRIDE);
    assert.deepEqual(seen, [OVERRIDE]); // the manifest default was never even queried
  }));

test('probeChunkStore: with no override, the chain manifest default is still used', async () =>
  withoutEnvOverride(async () => {
    const seen: Address[] = [];
    const client = mockClient({code: '0x6080', onGetCode: (a) => seen.push(a)});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA});
    assert.equal(probe.address, MANIFEST_STORE);
    assert.deepEqual(seen, [MANIFEST_STORE]);
  }));

// ── unreachable: a transport failure is not a verdict on the address ──────────────────────────

test('probeChunkStore: unreachable — getCode itself fails (RPC down), not a refusal on the merits', async () =>
  withoutEnvOverride(async () => {
    const client = mockClient({codeThrows: 'fetch failed: ECONNREFUSED'});
    const probe = await probeChunkStore(client, {chainId: BASE_SEPOLIA});
    assert.equal(probe.verdict, 'unreachable');
    assert.equal(probe.address, MANIFEST_STORE);
    assert.ok(probe.error?.includes('ECONNREFUSED'));
  }));

// ── never sends a transaction ───────────────────────────────────────────────────────────────────

test('probeChunkStore: never calls sendTransaction/writeContract — read-only by construction', async () =>
  withoutEnvOverride(async () => {
    // The stub client exposes only `getCode`/`call` — no `sendTransaction`/`writeContract` at all,
    // so any attempt to send would throw "X is not a function" and fail the test loudly, for every
    // verdict path (unconfigured has no client calls, so it is excluded here).
    for (const opts of [{code: '0x'}, {code: '0x6080', callThrows: 'nope'}, {code: '0x6080'}]) {
      const probe = await probeChunkStore(mockClient(opts), {chainId: BASE_SEPOLIA});
      assert.ok(['no-code', 'incompatible', 'ok'].includes(probe.verdict));
    }
  }));
