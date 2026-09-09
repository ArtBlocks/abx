import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, zeroAddress, type PublicClient} from 'viem';
import {prepareLockParamHooks, prepareSetParamHooks, readParamHooksLocked} from '../src/ops.ts';
import {readParamHooks} from '../src/onchain-uri.ts';
import {seriesCodeAbi, spineEventAbi} from '../src/abi/index.ts';

const CONTRACT = '0x4861cAc4B3D97903e6A0Ea1AfF3923302445298f' as const;
const CONFIGURE = '0x1111111111111111111111111111111111111111' as const;
const AUGMENT = '0x2222222222222222222222222222222222222222' as const;
const TRANSFER = '0x3333333333333333333333333333333333333333' as const;

test('prepareSetParamHooks encodes setParamHooks(configure, augment, transfer) in order', () => {
  const tx = prepareSetParamHooks({contract: CONTRACT, configureHook: CONFIGURE, augmentHook: AUGMENT, transferHook: TRANSFER, chainId: 11155111});
  assert.equal(tx.op, 'set-param-hooks');
  assert.equal(tx.to, CONTRACT);
  assert.equal(tx.value, '0x0'); // ZERO_VALUE — no ETH moves
  assert.equal(tx.chainId, 11155111);
  const {functionName, args} = decodeFunctionData({abi: seriesCodeAbi, data: tx.data});
  assert.equal(functionName, 'setParamHooks');
  // Positional order is load-bearing — the contract has no per-hook setter, so a swapped arg silently
  // wires the wrong role. Assert each slot explicitly.
  assert.deepEqual(
    (args as readonly string[]).map((a) => a.toLowerCase()),
    [CONFIGURE, AUGMENT, TRANSFER].map((a) => a.toLowerCase()),
  );
});

test('prepareSetParamHooks carries zeroAddress for a cleared role', () => {
  const tx = prepareSetParamHooks({contract: CONTRACT, configureHook: zeroAddress, augmentHook: AUGMENT, transferHook: zeroAddress, chainId: 11155111});
  const {args} = decodeFunctionData({abi: seriesCodeAbi, data: tx.data});
  assert.equal((args as readonly string[])[0].toLowerCase(), zeroAddress);
  assert.equal((args as readonly string[])[1].toLowerCase(), AUGMENT);
  assert.equal((args as readonly string[])[2].toLowerCase(), zeroAddress);
  // fields surface the human-readable trio for the sign page / dry-run preview
  assert.equal(tx.fields.augmentHook, AUGMENT);
});


// ── lockParamHooks — the one-way freeze ───────────────────────────────────────
//
// Why this lock exists at all: the transfer hook is a VETO (its revert fails the transfer, and a
// mint is a transfer from 0x0), so an unfrozen hook set is a standing power over whether a collector
// can ever sell. Freezing is how a project proves it will never arm one. It is irreversible on
// purpose — a lock a project can lift is not a lock.

test('prepareLockParamHooks encodes lockParamHooks() and moves no value', () => {
  const tx = prepareLockParamHooks({contract: CONTRACT, chainId: 11155111});
  assert.equal(tx.op, 'lock-param-hooks');
  assert.equal(tx.to, CONTRACT);
  assert.equal(tx.value, '0x0');
  assert.equal(tx.chainId, 11155111);
  const {functionName, args} = decodeFunctionData({abi: seriesCodeAbi, data: tx.data});
  assert.equal(functionName, 'lockParamHooks');
  assert.deepEqual(args ?? [], []);
  // The summary is what a sign page / dry-run shows. It must say permanence out loud.
  assert.match(tx.summary, /permanent/i);
  assert.match(tx.summary, /hooks/i);
});

test('lock-param-hooks follows the sibling one-way locks: same op-name shape, no args, no value', () => {
  // lock-script / lock-dependencies / lock-uri / lock-field are all `lock-*`, argument-free,
  // zero-value owner calls. A future edit that gives this one a parameter (a timeout, a scope) would
  // make it a different kind of thing than every other lock in the toolkit.
  const tx = prepareLockParamHooks({contract: CONTRACT, chainId: 1});
  assert.ok(tx.op.startsWith('lock-'));
  assert.deepEqual(Object.keys(tx.fields), ['contract']);
});

/** A PublicClient stub serving `paramHooksLocked` and `paramHooks`. */
function lockProbeClient(opts: {
  locked?: boolean;
  throws?: string;
  hooks?: readonly [string, string, string];
}): PublicClient {
  return {
    readContract: async ({functionName}: {functionName: string}) => {
      if (opts.throws) throw new Error(opts.throws);
      if (functionName === 'paramHooksLocked') return opts.locked;
      if (functionName === 'paramHooks') {
        if (!opts.hooks) throw new Error('execution reverted (no such function)');
        return opts.hooks;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

test('readParamHooksLocked reports the getter, both ways', async () => {
  assert.equal(await readParamHooksLocked(lockProbeClient({locked: false}), CONTRACT), false);
  assert.equal(await readParamHooksLocked(lockProbeClient({locked: true}), CONTRACT), true);
});

test('readParamHooksLocked: anything else is UNDEFINED, never a cheerful "unlocked"', async () => {
  // The dangerous failure would be reporting "not frozen" because a node refused the call: a buyer
  // would read a live power that may not exist, or miss one that does. Unknown stays unknown.
  //
  // This covers a real case right now — `paramHooksLocked()` does not exist on implementations
  // deployed before hook enumeration, so the read reverts and must surface as "unknown"
  // rather than "open". (This function used to infer the answer by simulating `setParamHooks` and
  // watching for a `ParamHooksLocked` revert, because no getter existed. One exists now, and it
  // costs one read instead of three.)
  assert.equal(await readParamHooksLocked(lockProbeClient({throws: 'fetch failed'}), CONTRACT), undefined);
  assert.equal(
    await readParamHooksLocked(lockProbeClient({throws: 'execution reverted (no such function)'}), CONTRACT),
    undefined,
  );
});

test('readParamHooks returns the trio, and null for a project without the surface', async () => {
  const hooks = await readParamHooks(lockProbeClient({hooks: [CONFIGURE, AUGMENT, TRANSFER]}) as never, CONTRACT);
  assert.deepEqual(hooks, {configureHook: CONFIGURE, augmentHook: AUGMENT, transferHook: TRANSFER});
  assert.equal(await readParamHooks(lockProbeClient({}) as never, CONTRACT), null);
});

test('ParamHooksFrozen is in the event spine — an indexer can SEE the freeze', () => {
  // The event is declared only in AbxParamsLib (the token's interface declares HooksConfigured but
  // not the freeze), so without unioning that ABI the lock would be invisible to every consumer that
  // folds the spine — while the hook it freezes can veto a transfer. See abi/index.ts.
  const names = (spineEventAbi as readonly {name?: string}[]).map((e) => e.name);
  assert.ok(names.includes('ParamHooksFrozen'), 'ParamHooksFrozen must decode from the spine ABI');
  assert.ok(names.includes('HooksConfigured'), 'and the set event alongside it');
});
