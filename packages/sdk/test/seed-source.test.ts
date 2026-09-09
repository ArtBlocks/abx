// The seed-source surface: the owner op that re-points it, and the probe that stands in front of
// every write of it.
//
// Why the probe is worth a test file of its own: `seedSource` is the one setting whose
// misconfiguration is completely SILENT. The write succeeds, `seedSource()` reads back exactly what
// you set, `SeedSourceSet` fires, `abx state` prints it — and then every mint of the collection
// reverts, because the token decodes the source's return as `bytes32` inside the mint. `code.length
// > 0` does not catch that: a Safe, an uninitialised proxy, and a 7702-delegated EOA all have code
// and all answer an unknown selector with empty success. So the probe asks the real question
// (`seed(uint256,address)` → 32 bytes) and each way of failing it has its own verdict here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, encodeFunctionData, zeroAddress, type PublicClient} from 'viem';
import {
  assertSeedSourceUsable,
  prepareSetSeedSource,
  probeSeedSource,
  readSeedSource,
} from '../src/ops.ts';
import {SeedSourceUnusableError} from '../src/errors.ts';
import {abxSeedSourceAbi, seriesCodeAbi} from '../src/abi/index.ts';

const SEPOLIA = 11155111;
const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const SOURCE = '0x2222222222222222222222222222222222222222' as const;
const SEED = `0x${'ab'.repeat(32)}` as const;

/** A PublicClient stub: `getCode` answers `code`, `call` answers `ret` (or throws it). */
function fakeClient(opts: {
  code?: string;
  ret?: string;
  throwOn?: 'code' | 'call';
  onCall?: (args: {to: string; data: string; account?: unknown}) => void;
}): PublicClient {
  return {
    getCode: async () => {
      if (opts.throwOn === 'code') throw new Error('fetch failed: ECONNREFUSED');
      return opts.code;
    },
    call: async (args: {to: string; data: string; account?: unknown}) => {
      opts.onCall?.(args);
      if (opts.throwOn === 'call') throw new Error('execution reverted: NotArmed()\nRequest Arguments: …');
      return {data: opts.ret};
    },
  } as unknown as PublicClient;
}

// ── the probe ────────────────────────────────────────────────────────────────

test('probe: a real source (32 bytes back) is ok', async () => {
  const probe = await probeSeedSource(fakeClient({code: '0x60006000', ret: SEED}), SOURCE);
  assert.equal(probe.verdict, 'ok');
  assert.equal(probe.address, SOURCE);
  assert.equal(probe.returnedBytes, 32);
});

test('probe: no code — the address is empty, so the mint would revert in the decode', async () => {
  for (const code of [undefined, '0x'] as const) {
    const probe = await probeSeedSource(fakeClient({code}), SOURCE);
    assert.equal(probe.verdict, 'no-code', `code ${String(code)} should read as no-code`);
  }
});

// The whole reason a has-code check is not enough. A Safe's FallbackManager returns empty success
// for an unset handler, so it passes `code.length > 0` and fails every mint.
test('probe: has code but returns NOTHING (the Safe / uninitialised-proxy / 7702 shape) is rejected', async () => {
  for (const ret of [undefined, '0x'] as const) {
    const probe = await probeSeedSource(fakeClient({code: '0x6080604052', ret}), SOURCE);
    assert.equal(probe.verdict, 'empty-return');
    assert.equal(probe.returnedBytes, 0);
  }
});

test('probe: a return shorter than 32 bytes is not a bytes32, whatever else it is', async () => {
  const probe = await probeSeedSource(fakeClient({code: '0x60', ret: '0xdeadbeef'}), SOURCE);
  assert.equal(probe.verdict, 'short-return');
  assert.equal(probe.returnedBytes, 4);
});

test('probe: a revert is a refusal, and the reason is kept to one line', async () => {
  const probe = await probeSeedSource(fakeClient({code: '0x60', throwOn: 'call'}), SOURCE);
  assert.equal(probe.verdict, 'reverted');
  assert.equal(probe.error, 'execution reverted: NotArmed()'); // no viem multi-line dump
});

// A transport failure says nothing about the address — it must NOT be reported as a bad source
// (that would send a creator chasing a contract that is fine), and must not read as ok either.
test('probe: an unreachable RPC is its own verdict, not a verdict about the address', async () => {
  const probe = await probeSeedSource(fakeClient({throwOn: 'code'}), SOURCE);
  assert.equal(probe.verdict, 'unreachable');
  assert.match(probe.error!, /ECONNREFUSED/);
});

// `msg.sender` namespaces the canonical seed and is what a caller-gating custom source checks, so
// probing from a random address would false-negative a legitimate source.
test('probe: `as` becomes the eth_call `from`, and the calldata is seed(tokenId, to)', async () => {
  let seen: {to: string; data: string; account?: unknown} | undefined;
  await probeSeedSource(fakeClient({code: '0x60', ret: SEED, onCall: (a) => { seen = a; }}), SOURCE, {
    as: TOKEN,
    tokenId: 7n,
  });
  assert.equal(seen!.to, SOURCE);
  assert.equal(seen!.account, TOKEN);
  const {functionName, args} = decodeFunctionData({abi: [{
    type: 'function',
    name: 'seed',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}, {name: 'to', type: 'address'}],
    outputs: [{type: 'bytes32'}],
  }] as const, data: seen!.data as `0x${string}`});
  assert.equal(functionName, 'seed');
  assert.deepEqual(args, [7n, TOKEN]);
});

// Without `as` there is no `from` to pin (the deploy lane: the clone's address isn't reserved yet),
// and `to` must still be a plausible non-zero address — a source that validates its recipient would
// otherwise reject a probe for reasons that have nothing to do with whether it works.
test('probe: with no `as`, no account is sent and `to` is never the zero address', async () => {
  let seen: {to: string; data: string; account?: unknown} | undefined;
  await probeSeedSource(fakeClient({code: '0x60', ret: SEED, onCall: (a) => { seen = a; }}), SOURCE);
  assert.equal(seen!.account, undefined);
  const {args} = decodeFunctionData({abi: abxSeedSourceAbi, data: seen!.data as `0x${string}`});
  assert.deepEqual(args, [0n, SOURCE]); // `to` falls back to the source itself, never 0x0
});

test('assertSeedSourceUsable: throws SeedSourceUnusableError carrying the verdict, or nothing at all', async () => {
  await assertSeedSourceUsable(fakeClient({code: '0x60', ret: SEED}), SOURCE); // ok → resolves
  await assert.rejects(
    () => assertSeedSourceUsable(fakeClient({code: '0x'}), SOURCE),
    (e: unknown) => {
      assert.ok(e instanceof SeedSourceUnusableError);
      assert.equal(e.verdict, 'no-code');
      assert.equal(e.address, SOURCE);
      assert.equal(e.probe.verdict, 'no-code');
      return true;
    },
  );
});

// ── the op ───────────────────────────────────────────────────────────────────

test('prepareSetSeedSource: encodes setSeedSource(address) at the token, value-free', () => {
  const tx = prepareSetSeedSource({contract: TOKEN, seedSource: SOURCE, chainId: SEPOLIA});
  assert.equal(tx.op, 'set-seed-source');
  assert.equal(tx.to, TOKEN);
  assert.equal(tx.value, '0x0');
  assert.equal(tx.chainId, SEPOLIA);
  const {functionName, args} = decodeFunctionData({abi: seriesCodeAbi, data: tx.data});
  assert.equal(functionName, 'setSeedSource');
  assert.deepEqual(args, [SOURCE]);
  assert.equal(tx.fields.seedSource, SOURCE);
  // The summary has to carry the one thing a signer could get wrong about this op.
  assert.match(tx.summary, /future mints only/i);
});

test('prepareSetSeedSource: zero reads as CLEARING, and says so — not as "set to 0x0"', () => {
  const tx = prepareSetSeedSource({contract: TOKEN, seedSource: zeroAddress, chainId: SEPOLIA});
  assert.match(tx.summary, /[Cc]lear/);
  assert.match(tx.summary, /no seed/i);
  assert.equal(tx.fields.seedSource, zeroAddress);
});

test('readSeedSource: an absent getter (image token) is undefined, NOT zeroAddress', async () => {
  const client = {readContract: async () => { throw new Error('returned no data ("0x")'); }} as unknown as PublicClient;
  assert.equal(await readSeedSource(client, TOKEN), undefined);
  const set = {readContract: async () => SOURCE} as unknown as PublicClient;
  assert.equal(await readSeedSource(set, TOKEN), SOURCE);
  // "opted out" is a real, different answer from "has no such knob" — collapsing them is what makes
  // a readout lie, and it is what a caller branches on before offering `abx set-seed-source`.
  const cleared = {readContract: async () => zeroAddress} as unknown as PublicClient;
  assert.equal(await readSeedSource(cleared, TOKEN), zeroAddress);
});

// The probe encodes against the CANONICAL source's ABI, where `seed` is `view` — but
// `IAbxSeedSource.seed` is deliberately non-`view` (sources may keep state: commit-reveal, curated
// queues, oracle-fed). That only works because a selector is mutability-independent and `eth_call`
// simulates a state-changing function fine: the identical calldata reaches both kinds. If this ever
// diverged, the probe would silently only be able to check the canonical source — i.e. only the one
// case that never needed checking.
test('the probe calldata is identical for a view and a non-view seed(), so it reaches custom sources', () => {
  const nonView = encodeFunctionData({
    abi: [{
      type: 'function',
      name: 'seed',
      stateMutability: 'nonpayable',
      inputs: [{name: 'tokenId', type: 'uint256'}, {name: 'to', type: 'address'}],
      outputs: [{type: 'bytes32'}],
    }] as const,
    functionName: 'seed',
    args: [0n, TOKEN],
  });
  const canonical = encodeFunctionData({abi: abxSeedSourceAbi, functionName: 'seed', args: [0n, TOKEN]});
  assert.equal(canonical, nonView);
  const seedFn = (abxSeedSourceAbi as readonly {type: string; name?: string; stateMutability?: string}[]).find(
    (e) => e.type === 'function' && e.name === 'seed',
  );
  assert.equal(seedFn!.stateMutability, 'view'); // …and the canonical one really is view
});
