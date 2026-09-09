// The ERC-1155 editions fold: TransferSingle/TransferBatch supply + holder-balance bigint math
// (mint/transfer/burn), MaxSupplyUpdated per-id caps, and contractType detection for all three
// edition kinds (via the full reconstructIncremental → assembleState pipeline, since contractType
// detection lives there, not in the pure foldSpine). Mirrors code-fold.test.ts's style.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PublicClient} from 'viem';

import {foldSpine, reconstructIncremental} from '../src/reconstruct.js';
import {editionCapOf} from '../src/tokens.js';
import {EXTENSION_ID} from '../src/spine.js';
import type {ProjectState, SpineEvent} from '../src/types.js';

let seq = 0;
function ev(name: string, args: Record<string, string>): SpineEvent {
  seq += 1;
  return {
    name,
    register: 2,
    what: '',
    blockNumber: String(seq),
    logIndex: seq,
    txHash: `0x${seq.toString(16).padStart(64, '0')}`,
    args,
  };
}

const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const ALICE = '0x00000000000000000000000000000000000Aaaa1';
const BOB = '0x00000000000000000000000000000000000Bbbb2';
const ZERO = '0x0000000000000000000000000000000000000000';

// ── TransferSingle / TransferBatch / MaxSupplyUpdated fold (pure, via foldSpine) ─────────────

test('TransferSingle: mint sets supply + lifecycle live + holder balance', () => {
  const fold = foldSpine([ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '0', amount: '5'})]);
  const t = fold.tokens.get('0')!;
  assert.equal(t.supply, '5');
  assert.equal(t.lifecycle, 'live');
  assert.deepEqual(t.holders, {[ALICE]: '5'});
  assert.equal(t.owner, null); // editions never set per-token `owner` from a 1155 leg
});

test('TransferSingle: a transfer between two live holders touches no supply, only balances', () => {
  const fold = foldSpine([
    ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '0', amount: '5'}),
    ev('TransferSingle', {operator: ALICE, from: ALICE, to: BOB, id: '0', amount: '2'}),
  ]);
  const t = fold.tokens.get('0')!;
  assert.equal(t.supply, '5'); // unchanged — a holder-to-holder move, not a mint/burn
  assert.deepEqual(t.holders, {[ALICE]: '3', [BOB]: '2'});
});

test('TransferSingle: burn decrements supply, deletes a zero balance, and flips lifecycle to no-live-copies', () => {
  const fold = foldSpine([
    ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '0', amount: '3'}),
    ev('TransferSingle', {operator: ALICE, from: ALICE, to: ZERO, id: '0', amount: '3'}),
  ]);
  const t = fold.tokens.get('0')!;
  assert.equal(t.supply, '0');
  // Recomputed from the counter, never latched. `'no-live-copies'` rather than `'burned'`: on this
  // standard nothing is permanently gone (the id can mint again), and `'burned'` is reserved for the
  // terminal 721 case so a resolver can act on it without a per-standard branch.
  assert.equal(t.lifecycle, 'no-live-copies');
  assert.equal(t.holders?.[ALICE], undefined); // zero balance is deleted, not kept at "0"
});

test('TransferSingle: an id can return to zero supply and mint again (lifecycle returns to live)', () => {
  const fold = foldSpine([
    ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '0', amount: '1'}),
    ev('TransferSingle', {operator: ALICE, from: ALICE, to: ZERO, id: '0', amount: '1'}),
    ev('TransferSingle', {operator: BOB, from: ZERO, to: BOB, id: '0', amount: '4'}),
  ]);
  const t = fold.tokens.get('0')!;
  assert.equal(t.supply, '4');
  assert.equal(t.lifecycle, 'live');
  assert.deepEqual(t.holders, {[BOB]: '4'});
});

test('TransferBatch: each id in the batch is folded as its own mint leg', () => {
  const fold = foldSpine([
    ev('TransferBatch', {
      operator: ALICE,
      from: ZERO,
      to: ALICE,
      ids: JSON.stringify(['0', '1', '2']),
      amounts: JSON.stringify(['10', '1', '7']),
    }),
  ]);
  assert.equal(fold.tokens.get('0')!.supply, '10');
  assert.equal(fold.tokens.get('1')!.supply, '1');
  assert.equal(fold.tokens.get('2')!.supply, '7');
  for (const id of ['0', '1', '2']) assert.equal(fold.tokens.get(id)!.lifecycle, 'live');
  assert.deepEqual(fold.tokens.get('1')!.holders, {[ALICE]: '1'});
});

test('MaxSupplyUpdated: per-id cap folds onto that token, last-writer-wins', () => {
  const fold = foldSpine([
    ev('MaxSupplyUpdated', {id: '3', cap: '100'}),
    ev('MaxSupplyUpdated', {id: '3', cap: '40'}), // owner lowered it — monotonic on-chain, we just fold the latest
    ev('MaxSupplyUpdated', {id: '9', cap: '0'}), // an explicit 0 = closed, not "open" — see EditionSupply's dev note
  ]);
  assert.equal(fold.tokens.get('3')!.maxSupply, '40');
  assert.equal(fold.tokens.get('9')!.maxSupply, '0');
  // The override latches — it is what makes that '0' mean "closed" rather than "open".
  assert.equal(fold.tokens.get('3')!.maxSupplyOverridden, true);
  assert.equal(fold.tokens.get('9')!.maxSupplyOverridden, true);
});

test('DefaultMaxSupplySet: the collection-wide default folds onto the project', () => {
  const fold = foldSpine([ev('DefaultMaxSupplySet', {cap: '10'})]);
  assert.equal(fold.defaultMaxSupply, '10');
  // Absent for a 721 (only an edition emits it) — never a fabricated '0'.
  assert.equal(foldSpine([ev('AbxDeployed', {abxVersion: '5'})]).defaultMaxSupply, null);
});

// ── contractType detection (via the full assembleState pipeline) ────────────────────────────

/** Drive `foldSpine` → `assembleState` through `reconstructIncremental`'s no-new-logs branch
 *  (prior.toBlock === the mocked head, so it never calls `getLogs`), with head reads stubbed to
 *  fail-closed (irrelevant to contractType, which is folded from events alone). */
async function stateFromEvents(events: SpineEvent[]): Promise<ProjectState> {
  const HEAD = 100n;
  const client = {
    chain: {id: 11155111},
    transport: {},
    getBlockNumber: async () => HEAD,
    multicall: async ({contracts}: {contracts: unknown[]}) =>
      contracts.map(() => ({status: 'failure' as const, error: new Error('not mocked')})),
    readContract: async () => {
      throw new Error('not mocked');
    },
  } as unknown as PublicClient;

  const prior: ProjectState = {
    address: CONTRACT,
    chainId: 11155111,
    abxVersion: null,
    deployBlock: null,
    deployTx: null,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: null,
    symbol: null,
    owner: null,
    contractURI: null,
    royalty: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    collectionFields: [],
    lockedCollectionFields: [],
    extensions: [],
    tokens: [],
    events,
    fromBlock: '1',
    toBlock: String(HEAD),
    eventCount: events.length,
    reconstructedAt: new Date().toISOString(),
  };
  return reconstructIncremental(client, prior, {});
}

const deployed = () => ev('AbxDeployed', {abxVersion: '5'});
const extSet = (id: string) => ev('AbxExtensionVersionSet', {extensionId: id, version: '1'});

test('contractType: edition-supply alone (no maxInvocations, no params) → 1of1-edition', async () => {
  const state = await stateFromEvents([deployed(), extSet(EXTENSION_ID.editionSupply)]);
  assert.equal(state.contractType, '1of1-edition');
});

test('contractType: edition-supply + max-invocations (no params) → edition', async () => {
  const state = await stateFromEvents([
    deployed(),
    extSet(EXTENSION_ID.editionSupply),
    extSet(EXTENSION_ID.maxInvocations),
  ]);
  assert.equal(state.contractType, 'edition');
});

test('contractType: edition-supply + max-invocations + params → edition-code', async () => {
  const state = await stateFromEvents([
    deployed(),
    extSet(EXTENSION_ID.editionSupply),
    extSet(EXTENSION_ID.maxInvocations),
    extSet(EXTENSION_ID.params),
  ]);
  assert.equal(state.contractType, 'edition-code');
});

// The 721 ladder must be completely unaffected by the new discriminator — same three cases,
// none composing edition-supply.

test('contractType: the 721 ladder is untouched (1of1 / series / code)', async () => {
  const oneOfOne = await stateFromEvents([deployed()]);
  assert.equal(oneOfOne.contractType, '1of1');

  const series = await stateFromEvents([deployed(), extSet(EXTENSION_ID.maxInvocations)]);
  assert.equal(series.contractType, 'series');

  const code = await stateFromEvents([
    deployed(),
    extSet(EXTENSION_ID.maxInvocations),
    extSet(EXTENSION_ID.params),
  ]);
  assert.equal(code.contractType, 'code');
});

test('contractType: undefined before any AbxDeployed (not yet reconstructed as a real project)', async () => {
  const state = await stateFromEvents([]);
  assert.equal(state.contractType, undefined);
});

// ── the effective per-id cap (DefaultMaxSupplySet × MaxSupplyUpdated) ───────────────────────
// The default shape of a capped edition is `--copies N`: the cap is set at `initialize` and
// `setMaxSupply` is NEVER called, so no id has a `MaxSupplyUpdated` of its own. Folding that event
// alone therefore reported every capped edition ever deployed as OPEN, while the head-read lane
// (`listTokens`, which calls `maxSupply(id)`) said N — one field name, two answers.

const edition = (events: SpineEvent[]) =>
  stateFromEvents([deployed(), extSet(EXTENSION_ID.editionSupply), ...events]);

test('an id that inherits the collection default carries it as its effective cap', async () => {
  const state = await edition([
    ev('DefaultMaxSupplySet', {cap: '10'}),
    ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '0', amount: '3'}),
  ]);
  assert.equal(state.defaultMaxSupply, '10');
  const t = state.tokens.find((x) => x.tokenId === '0')!;
  assert.equal(t.maxSupply, '10', 'the un-overridden id reads the default, exactly as maxSupply(id) does');
  assert.equal(t.maxSupplyOverridden, undefined, 'nothing overrode it');
  assert.deepEqual(editionCapOf(t), {kind: 'capped', cap: '10'});
});

test('a per-id override beats the default, and is marked as overridden', async () => {
  const state = await edition([
    ev('DefaultMaxSupplySet', {cap: '10'}),
    ev('MaxSupplyUpdated', {id: '0', cap: '4'}),
    ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '1', amount: '1'}),
  ]);
  const overridden = state.tokens.find((x) => x.tokenId === '0')!;
  const inherits = state.tokens.find((x) => x.tokenId === '1')!;
  assert.deepEqual(editionCapOf(overridden), {kind: 'capped', cap: '4'});
  assert.equal(overridden.maxSupplyOverridden, true);
  assert.deepEqual(editionCapOf(inherits), {kind: 'capped', cap: '10'}, 'a sibling id still inherits');
});

test('closed vs open: the distinction only the log can make', async () => {
  // An id explicitly closed inside a capped collection.
  const closed = await edition([ev('DefaultMaxSupplySet', {cap: '10'}), ev('MaxSupplyUpdated', {id: '0', cap: '0'})]);
  assert.deepEqual(editionCapOf(closed.tokens.find((x) => x.tokenId === '0')!), {kind: 'closed'});

  // An open collection (`--copies open` ⇒ editionSize 0): the same '0' cap, never overridden.
  const open = await edition([
    ev('DefaultMaxSupplySet', {cap: '0'}),
    ev('TransferSingle', {operator: ALICE, from: ZERO, to: ALICE, id: '0', amount: '1'}),
  ]);
  assert.equal(open.defaultMaxSupply, '0');
  assert.deepEqual(editionCapOf(open.tokens.find((x) => x.tokenId === '0')!), {kind: 'open'});
});

test('the 721 ladder carries no cap fields at all (never a fabricated 0)', async () => {
  const state = await stateFromEvents([deployed(), ev('Transfer', {from: ZERO, to: ALICE, tokenId: '0'})]);
  assert.equal(state.defaultMaxSupply, null);
  const t = state.tokens.find((x) => x.tokenId === '0')!;
  assert.equal(t.maxSupply, undefined);
  assert.equal(t.maxSupplyOverridden, undefined);
  assert.equal(editionCapOf(t), null, 'no cap information ⇒ null, not "open"');
});

test('the default is not applied without the Edition Supply extension announced', async () => {
  // Belt-and-braces: `_initEditionSupply` always emits both, so this pairing cannot occur on chain.
  // The gate exists so a malformed/partial log can never hand a 721 an edition cap.
  const state = await stateFromEvents([deployed(), ev('DefaultMaxSupplySet', {cap: '10'})]);
  assert.equal(state.defaultMaxSupply, null);
  assert.equal(state.tokens.find((x) => x.tokenId === '0')?.maxSupply, undefined);
});
