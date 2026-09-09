// `abx state` used to report only `paramHooks.locked` — script/dependency locks appeared
// solely in `verify` (code projects only), and token/contract-URI + field locks appeared nowhere.
// `readCollectionLocks` is the one function that now reads every applicable irreversible lock in
// one shot, following the same head-read pattern `readParamHooksLocked` (ops.ts) already used —
// this is a proven port, not new design. Pure unit tests against a MOCKED client (no network),
// covering the three-way distinction (`true` frozen · `false` open · `null` unread) the acceptance
// criteria named explicitly, plus the `isCode` gate that makes script/dependencies "not applicable"
// (a `null` OBJECT) rather than "unknown" (a `null` boolean) on a plain image/Series contract.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, PublicClient} from 'viem';
import {encodeTag, METADATA_FIELD} from '@artblocks/abx-sdk';
import {readCollectionLocks} from '../src/commands/project.js';

const ADDR = '0x1111111111111111111111111111111111111111' as Address;
const FAKE_ABI = [] as const; // the mock ignores `abi` entirely — only `functionName`/`args` matter

type Resp = boolean | 'revert';

/** Every field `readCollectionLocks` scans, keyed by its ENCODED bytes32 tag, so the mock can
 *  answer `contractFieldLocked(field)` without re-implementing `decodeTag`. */
const FIELD_TAGS = Object.fromEntries(Object.values(METADATA_FIELD).map((f) => [encodeTag(f), f]));

function mockClient(opts: {
  tokenURILocked?: Resp;
  contractURILocked?: Resp;
  scriptLocked?: Resp;
  dependenciesLocked?: Resp;
  /** keyed by the DECODED field name (e.g. 'image'), not the encoded tag */
  fieldLocked?: Record<string, Resp>;
}): {client: PublicClient; calls: string[]} {
  const calls: string[] = [];
  const client = {
    readContract: async ({functionName, args}: {functionName: string; args?: readonly unknown[]}) => {
      calls.push(functionName);
      if (functionName === 'contractFieldLocked') {
        const tag = args?.[0] as string;
        const fieldName = FIELD_TAGS[tag];
        const r = fieldName ? opts.fieldLocked?.[fieldName] : undefined;
        if (r === undefined || r === 'revert') throw new Error('execution reverted (no such getter on this mock)');
        return r;
      }
      const r = (opts as Record<string, Resp | undefined>)[functionName];
      if (r === undefined || r === 'revert') throw new Error('execution reverted (no such getter on this mock)');
      return r;
    },
  } as unknown as PublicClient;
  return {client, calls};
}

test('readCollectionLocks: every lock reads true → all report frozen', async () => {
  const {client} = mockClient({
    tokenURILocked: true,
    contractURILocked: true,
    scriptLocked: true,
    dependenciesLocked: true,
    fieldLocked: Object.fromEntries(Object.values(METADATA_FIELD).map((f) => [f, true as const])),
  });
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, true);
  assert.equal(locks.tokenURI, true);
  assert.equal(locks.contractURI, true);
  assert.deepEqual(locks.script, {locked: true});
  assert.deepEqual(locks.dependencies, {locked: true});
  assert.ok(locks.fields.every((f) => f.locked === true));
  // The bounded scan covers EVERY declared METADATA_FIELD key — not a subset.
  assert.equal(locks.fields.length, Object.values(METADATA_FIELD).length);
});

test('readCollectionLocks: every lock reads false → all report open, never collapsed to frozen', async () => {
  const {client} = mockClient({
    tokenURILocked: false,
    contractURILocked: false,
    scriptLocked: false,
    dependenciesLocked: false,
    fieldLocked: Object.fromEntries(Object.values(METADATA_FIELD).map((f) => [f, false as const])),
  });
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, true);
  assert.equal(locks.tokenURI, false);
  assert.equal(locks.contractURI, false);
  assert.deepEqual(locks.script, {locked: false});
  assert.deepEqual(locks.dependencies, {locked: false});
  assert.ok(locks.fields.every((f) => f.locked === false));
});

test('readCollectionLocks: a refused read reports `null` (unknown), never `false` — the core tri-state rule', async () => {
  // tokenURILocked/contractURILocked exist on every ABX contract, so a throw here is a genuine RPC
  // refusal (or a wrong dialect) — the exact case that must never read as "unlocked".
  const {client} = mockClient({contractURILocked: false}); // tokenURILocked left unanswered → throws
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, false);
  assert.equal(locks.tokenURI, null);
  assert.equal(locks.contractURI, false);
});

test('readCollectionLocks: isCode=false makes script/dependencies "not applicable" (null OBJECT), not "unknown"', async () => {
  const {client, calls} = mockClient({tokenURILocked: true, contractURILocked: true});
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, false);
  assert.equal(locks.script, null);
  assert.equal(locks.dependencies, null);
  // The distinguishing behavior: a plain image/Series contract is never even ASKED for these two —
  // there's no surface to refuse the call, so this must not cost an `eth_call` that would just
  // revert and get reported as "unknown" (a different, wrong fact from "not applicable").
  assert.ok(!calls.includes('scriptLocked'));
  assert.ok(!calls.includes('dependenciesLocked'));
});

test('readCollectionLocks: isCode=true reads script/dependencies for real, independently of each other', async () => {
  const {client} = mockClient({tokenURILocked: false, contractURILocked: false, scriptLocked: true, dependenciesLocked: false});
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, true);
  assert.deepEqual(locks.script, {locked: true});
  assert.deepEqual(locks.dependencies, {locked: false}); // NOT frozen just because script is
});

test('readCollectionLocks: isCode=true but the getters themselves are unreadable → {locked: null}, not {locked: false}', async () => {
  const {client} = mockClient({tokenURILocked: true, contractURILocked: true}); // scriptLocked/dependenciesLocked unanswered
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, true);
  assert.deepEqual(locks.script, {locked: null});
  assert.deepEqual(locks.dependencies, {locked: null});
});

test('readCollectionLocks: the bounded field scan reports each field independently, with an unreadable one as null', async () => {
  const {client} = mockClient({
    tokenURILocked: false,
    contractURILocked: false,
    fieldLocked: {[METADATA_FIELD.image]: true, [METADATA_FIELD.name]: false}, // every other field left unanswered
  });
  const locks = await readCollectionLocks(client, ADDR, FAKE_ABI, false);
  const byField = new Map(locks.fields.map((f) => [f.field, f.locked]));
  assert.equal(byField.get(METADATA_FIELD.image), true);
  assert.equal(byField.get(METADATA_FIELD.name), false);
  assert.equal(byField.get(METADATA_FIELD.description), null); // unanswered → unknown, not "not locked"
});
