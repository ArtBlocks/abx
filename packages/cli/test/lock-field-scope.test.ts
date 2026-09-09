// `abx lock-field <addr> --field description --token 0` reported "would
// succeed" — and DID succeed — on a project where `description` is COLLECTION-scoped: locking the
// (empty) token-scope slot froze nothing a viewer actually sees, on a PERMANENT operation.
//
// `detectLockFieldScopeMismatch` and `lockFieldScopeVerdict` are the pure decision core behind the
// fix (ownerops.ts) — split out exactly like `computeAvailability` (project.ts) so the judgment call
// is unit-testable with no chain, no signer, and no console.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, PublicClient} from 'viem';
import {encodeTag} from '@artblocks/abx-sdk';
import {detectLockFieldScopeMismatch, fieldScopePresence, lockFieldScopeVerdict} from '../src/ownerops.js';

const ADDR = '0x1111111111111111111111111111111111111111' as Address;

/** Mocks `tokenField(tokenId, field)` / `contractField(field)` — mirrors state-locks.test.ts's
 *  `mockClient` idiom (no network, `abi` ignored, only `functionName`/`args` matter). `undefined`
 *  for a side means "unset" (returns empty bytes, the real on-chain default); `'revert'` means the
 *  read fails outright (RPC down / extension absent). */
function mockClient(opts: {token?: string | 'revert'; collection?: string | 'revert'}): PublicClient {
  return {
    readContract: async ({functionName}: {functionName: string}) => {
      if (functionName === 'tokenField') {
        if (opts.token === 'revert') throw new Error('execution reverted');
        return ['0x0', opts.token ? encodeTag(opts.token) : '0x'] as const;
      }
      if (functionName === 'contractField') {
        if (opts.collection === 'revert') throw new Error('execution reverted');
        return ['0x0', opts.collection ? encodeTag(opts.collection) : '0x'] as const;
      }
      throw new Error(`unexpected call: ${functionName}`);
    },
  } as unknown as PublicClient;
}

// ── fieldScopePresence: the chain-read layer, against a mocked client (no network) ───────────────

test('fieldScopePresence: token set, collection unset', async () => {
  const p = await fieldScopePresence(mockClient({token: 'hello'}), ADDR, 0n, 'description');
  assert.deepEqual(p, {token: true, collection: false});
});

test('fieldScopePresence: collection set, token unset', async () => {
  const p = await fieldScopePresence(mockClient({collection: 'hello'}), ADDR, 0n, 'description');
  assert.deepEqual(p, {token: false, collection: true});
});

test('fieldScopePresence: neither set', async () => {
  const p = await fieldScopePresence(mockClient({}), ADDR, 0n, 'description');
  assert.deepEqual(p, {token: false, collection: false});
});

test('fieldScopePresence: a read that reverts (RPC down / no on-chain-metadata extension) returns null — never a guessed false', async () => {
  assert.equal(await fieldScopePresence(mockClient({token: 'revert', collection: 'hello'}), ADDR, 0n, 'description'), null);
  assert.equal(await fieldScopePresence(mockClient({token: 'hello', collection: 'revert'}), ADDR, 0n, 'description'), null);
});

// ── detectLockFieldScopeMismatch: token-scope wins over collection, mirroring the renderer ──────

test('wrong scope: value lives at COLLECTION, caller chose (default) TOKEN scope — mismatch', () => {
  const m = detectLockFieldScopeMismatch({token: false, collection: true}, 'token');
  assert.deepEqual(m, {effective: 'collection', chosen: 'token'});
});

test('wrong scope: value lives at TOKEN (an override), caller chose --collection — mismatch even though collection ALSO has a value', () => {
  // Token wins over collection when both are set, so locking collection does not freeze what a
  // viewer actually sees for THIS token — the same bug, the other direction.
  const m = detectLockFieldScopeMismatch({token: true, collection: true}, 'collection');
  assert.deepEqual(m, {effective: 'token', chosen: 'collection'});
});

test('right scope: value lives at TOKEN, caller chose token — no mismatch', () => {
  assert.equal(detectLockFieldScopeMismatch({token: true, collection: false}, 'token'), null);
  assert.equal(detectLockFieldScopeMismatch({token: true, collection: true}, 'token'), null); // token still wins
});

test('right scope: value lives at COLLECTION only, caller chose --collection — no mismatch', () => {
  assert.equal(detectLockFieldScopeMismatch({token: false, collection: true}, 'collection'), null);
});

test('genuinely empty in BOTH scopes — no mismatch either way (a deliberate empty-slot lock is not a bug)', () => {
  assert.equal(detectLockFieldScopeMismatch({token: false, collection: false}, 'token'), null);
  assert.equal(detectLockFieldScopeMismatch({token: false, collection: false}, 'collection'), null);
});

// ── lockFieldScopeVerdict: refuse by default, loud warning (never silent) under --force-field ───

const mismatch = {effective: 'collection' as const, chosen: 'token' as const};
const opts = (forced: boolean) => ({contract: '0xCONTRACT', tokenId: 0n, field: 'description', forced});

test('default (no --force-field): REFUSE, naming the correct command with the right scope flag', () => {
  const v = lockFieldScopeVerdict(mismatch, opts(false));
  assert.equal(v.action, 'refuse');
  assert.match(v.message, /abx lock-field 0xCONTRACT --field description --collection/);
  assert.match(v.message, /--force-field/); // names the escape hatch too
});

test('--force-field: WARN (not refuse) — loud, and states plainly that the visible value stays unfrozen', () => {
  const v = lockFieldScopeVerdict(mismatch, opts(true));
  assert.equal(v.action, 'warn');
  assert.match(v.message, /LOCKING A SLOT THAT IS NOT WHAT'S DISPLAYED/);
  assert.match(v.message, /DOES NOT FREEZE THAT VALUE/);
  assert.match(v.message, /remains fully mutable/);
});

test('the reverse mismatch (collection chosen, token effective) names --token in the correct command', () => {
  const v = lockFieldScopeVerdict({effective: 'token', chosen: 'collection'}, opts(false));
  assert.match(v.message, /abx lock-field 0xCONTRACT --field description --token 0/);
});
