// The burn fold, and the two collection-policy events that shipped documented-but-unfolded.
//
// A 721 minted then burned must not reconstruct as `{minted: true, owner: 0x0}` — alive,
// held by the zero address, indistinguishable from a real holder to anything reading the field. The
// 1155 lane had been correct since editions shipped, which is what made the gap so easy to miss.
//
// What it cost downstream, all inside our own tree: the effects harness re-rendered destroyed tokens
// forever; `onchain-uri`'s probe picks the LOWEST live id, so burning token 0 made a healthy
// collection's on-chain-URI lane report as broken; the resolver served metadata (and a "still
// loading" warming placeholder) for ids the contract disowns; and `abx state` printed "not yet
// minted" for a token that had been destroyed.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import type {PublicClient} from 'viem';

import {foldSpine, reconstructIncremental} from '../src/reconstruct.js';
import type {ProjectState, SpineEvent} from '../src/types.js';

let seq = 0;
function ev(name: string, args: Record<string, string>): SpineEvent {
  seq += 1;
  return {name, register: 2, what: '', blockNumber: String(seq), logIndex: seq, txHash: `0x${seq.toString(16).padStart(64, '0')}`, args};
}

const ALICE = '0x00000000000000000000000000000000000Aaaa1';
const BOB = '0x00000000000000000000000000000000000Bbbb2';
const ZERO = '0x0000000000000000000000000000000000000000';

const transfer = (from: string, to: string, tokenId: string) => ev('Transfer', {from, to, tokenId});
const transferSingle = (from: string, to: string, id: string, amount: string) =>
  ev('TransferSingle', {operator: from, from, to, id, amount});

// ── ERC-721 ───────────────────────────────────────────────────────────────────

test('721: a token carrying fields but no Transfer yet is `unminted` — valid state, not a gap', async () => {
  // A deferred deploy (`mintTo == 0`) emits its fields at deploy and its `Transfer` later, so this is
  // the ordinary pre-mint shape a resolver must serve metadata for (warming marketplaces). The token
  // entry is created in `assembleState`, not in the pure fold, so this goes through the full path.
  const state = await stateFromEvents([
    ev('AbxDeployed', {abxVersion: '2'}),
    ev('TokenFieldSet', {tokenId: '0', field: '0x00', representation: '0x00', value: '0x01'}),
  ]);
  assert.equal(state.tokens[0]?.lifecycle, 'unminted');
  assert.equal(state.tokens[0]?.owner, null);
});

test('721: mint → live, owner is the recipient', () => {
  const t = foldSpine([transfer(ZERO, ALICE, '3')]).tokens.get('3')!;
  assert.equal(t.lifecycle, 'live');
  assert.equal(t.owner, ALICE);
});

test('721: burn → burned, and NEVER the zero address in `owner`', () => {
  const t = foldSpine([transfer(ZERO, ALICE, '3'), transfer(ALICE, ZERO, '3')]).tokens.get('3')!;
  assert.equal(t.lifecycle, 'burned');
  // The whole bug in one assertion: `0x0` in `owner` is indistinguishable from a holder.
  assert.equal(t.owner, null);
});

test('721: a transfer between holders stays live and moves the owner', () => {
  const t = foldSpine([transfer(ZERO, ALICE, '1'), transfer(ALICE, BOB, '1')]).tokens.get('1')!;
  assert.equal(t.lifecycle, 'live');
  assert.equal(t.owner, BOB);
});

test('721: burned is not sticky against the log — a re-mint of the id returns it to live', () => {
  // ABX mints from a monotonic `nextTokenId`, so this does not happen in practice. The fold owes the
  // log's meaning rather than our mint policy's, and asserting it keeps the branch honest.
  const t = foldSpine([transfer(ZERO, ALICE, '7'), transfer(ALICE, ZERO, '7'), transfer(ZERO, BOB, '7')]).tokens.get('7')!;
  assert.equal(t.lifecycle, 'live');
  assert.equal(t.owner, BOB);
});

test('721: re-folding an overlapping range is idempotent (the reorg overlap)', () => {
  const events = [transfer(ZERO, ALICE, '2'), transfer(ALICE, ZERO, '2')];
  const once = foldSpine(events).tokens.get('2')!;
  const twice = foldSpine([...events, ...events]).tokens.get('2')!;
  assert.deepEqual({l: twice.lifecycle, o: twice.owner}, {l: once.lifecycle, o: once.owner});
});

test('721: `burned` is the terminal word, and only this standard can produce it', () => {
  // The asymmetry the enum encodes: destruction is permanent here (ids come from a monotonic
  // `nextTokenId`, so no ABX mint path can reissue one) and is not on an edition. Both halves are
  // asserted — here, and in the edition sweep below — because a resolver's 410 depends on the pair.
  const t = foldSpine([transfer(ZERO, ALICE, '4'), transfer(ALICE, ZERO, '4')]).tokens.get('4')!;
  assert.equal(t.lifecycle, 'burned');
  assert.equal(t.owner, null);
});

// ── ERC-1155 editions: the counter decides, and `burned` is not in its vocabulary ─────────

test('1155: a full burn is `no-live-copies` and NEVER `burned` — the whole 410 carve-out, in the type', () => {
  const t = foldSpine([transferSingle(ZERO, ALICE, '3', '5'), transferSingle(ALICE, ZERO, '3', '5')]).tokens.get('3')!;
  assert.equal(t.lifecycle, 'no-live-copies');
  assert.equal(t.supply, '0');
  assert.deepEqual(t.holders, {});
});

test('1155: NO edition history can produce `burned` — mint, burn, re-mint, over-burn, batch', () => {
  // This is the guard that survives a refactor. `'burned'` is the word a consumer may act on
  // irreversibly (drop from a gallery, answer 410 Gone), and on this standard nothing is ever
  // permanently gone: `uri(id)` has no existence gate and the id can mint again. A resolver is
  // therefore allowed to map `lifecycle === 'burned'` straight onto 410 with no `contractType`
  // branch — but only for as long as this stays true, so it is asserted rather than documented.
  //
  // If you are here because you just made an edition fold to `'burned'`: every consumer that trusted
  // the sentence above now answers `410 Gone` for an id the contract still resolves. Add a word to
  // the enum instead.
  const histories: SpineEvent[][] = [
    [transferSingle(ZERO, ALICE, '1', '3')],
    [transferSingle(ZERO, ALICE, '1', '3'), transferSingle(ALICE, ZERO, '1', '3')],
    [transferSingle(ZERO, ALICE, '1', '1'), transferSingle(ALICE, ZERO, '1', '1'), transferSingle(ZERO, BOB, '1', '2')],
    [transferSingle(ZERO, ALICE, '1', '2'), transferSingle(ALICE, ZERO, '1', '1'), transferSingle(ALICE, ZERO, '1', '1')],
    [transferSingle(ALICE, ZERO, '1', '0')],
    [ev('TransferBatch', {operator: ZERO, from: ZERO, to: ALICE, ids: JSON.stringify(['1']), amounts: JSON.stringify(['2'])}),
     ev('TransferBatch', {operator: ALICE, from: ALICE, to: ZERO, ids: JSON.stringify(['1']), amounts: JSON.stringify(['2'])})],
  ];
  for (const events of histories) {
    const t = foldSpine(events).tokens.get('1')!;
    assert.notEqual(t.lifecycle, 'burned', `an edition folded to 'burned' — every 410 site is now wrong`);
    assert.ok(['live', 'no-live-copies'].includes(t.lifecycle), `unexpected edition lifecycle: ${t.lifecycle}`);
  }
});

test('1155: a partial burn leaves the id live', () => {
  const t = foldSpine([transferSingle(ZERO, ALICE, '3', '5'), transferSingle(ALICE, ZERO, '3', '2')]).tokens.get('3')!;
  assert.equal(t.lifecycle, 'live');
  assert.equal(t.supply, '3');
});

test('1155: a fully-burned id can mint again → live', () => {
  const t = foldSpine([
    transferSingle(ZERO, ALICE, '3', '1'),
    transferSingle(ALICE, ZERO, '3', '1'),
    transferSingle(ZERO, BOB, '3', '2'),
  ]).tokens.get('3')!;
  assert.equal(t.lifecycle, 'live');
  assert.equal(t.supply, '2');
});

test('1155: a zero-amount no-op from a stranger moves nothing', () => {
  // ERC-1155 permits `safeTransferFrom(..., 0, "")` from a caller holding nothing, so anyone can fire
  // a leg at any id. It must not fabricate supply or a holder. (It used to be able to flip a
  // never-issued id's lifecycle to `'burned'`; splitting that word out of this standard dissolved
  // that half of the concern rather than guarding it — the id reads `'no-live-copies'` either way.)
  const t = foldSpine([transferSingle(ALICE, ZERO, '9', '0')]).tokens.get('9')!;
  assert.equal(t.lifecycle, 'no-live-copies');
  assert.equal(BigInt(t.supply ?? '0'), 0n);
  assert.deepEqual(t.holders ?? {}, {});
});

// ── the two collection-policy events ─────────────────────────────────────────

test('BurnConfigured folds to `burnable` — being in SPINE_EVENT_DOC never did this', () => {
  assert.equal(foldSpine([ev('BurnConfigured', {burnable: 'true'})]).burnable, true);
  assert.equal(foldSpine([ev('BurnConfigured', {burnable: 'false'})]).burnable, false);
});

test('MaxRoyaltyBpsUpdated folds to `maxRoyaltyBps`, last-writer-wins (a later reduction beats deploy)', () => {
  const fold = foldSpine([ev('MaxRoyaltyBpsUpdated', {maxBps: '1000'}), ev('MaxRoyaltyBpsUpdated', {maxBps: '250'})]);
  assert.equal(fold.maxRoyaltyBps, 250);
});

test('both are tri-state: a spine that never stated them is null, NOT false / 1000', () => {
  // The distinction a consumer must be able to make: an implementation from before the opt-in has no
  // `burn` entrypoint at all and a hard-coded ceiling. Reporting `false` / `1000` there would be
  // asserting a policy the contract never published.
  const fold = foldSpine([transfer(ZERO, ALICE, '0')]);
  assert.equal(fold.burnable, null);
  assert.equal(fold.maxRoyaltyBps, null);
});

/** `foldSpine` → `assembleState` via `reconstructIncremental`'s no-new-logs branch, head reads
 *  stubbed to fail-closed (irrelevant here — lifecycle is folded from events alone). Same driver
 *  shape as `edition-fold.test.ts`. */
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
    address: '0x1111111111111111111111111111111111111111',
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

// ── the two lanes must agree on the same id ──────────────────────────────────
//
// One field name, one value per id, whichever lane produced it. The fold (event log) and the
// head-read lane (`listTokens`, chain-only) both answer `lifecycle`, and the first draft had them
// disagree for a fully-burned edition id — `'burned'` from the fold, `'unknown'` from head reads —
// under a `TokenRow` docstring asserting they used the same words. That is the sibling-drift class
// (see `TokenState.maxSupply`'s note, the last time one field name carried two meanings), and it was
// caught in review by the consumer the shape was written for rather than by anything here.
//
// The rule the enum now encodes: a head read may answer `'unknown'` ONLY where the chain genuinely
// cannot say (a 1/1 has no mint frontier). Everywhere both lanes can answer, they answer the same.

test('lanes agree: a fully-burned edition id is `no-live-copies` in the fold and at head', async () => {
  const folded = foldSpine([transferSingle(ZERO, ALICE, '2', '4'), transferSingle(ALICE, ZERO, '2', '4')])
    .tokens.get('2')!;

  const {listTokens} = await import('../src/tokens.js');
  const client = {
    getChainId: async () => 11155111,
    readContract: async (req: {functionName: string}) => {
      if (req.functionName === 'supportsInterface') return true; // an edition
      if (req.functionName === 'maxInvocations') return 3n;
      if (req.functionName === 'totalSupply') return 0n; // every copy burned
      if (req.functionName === 'maxSupply') return 10n;
      throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
    },
  } as never;
  const head = (await listTokens(client, '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294')).tokens[2];

  assert.equal(folded.lifecycle, 'no-live-copies');
  assert.equal(head.lifecycle, folded.lifecycle, 'the fold and the head-read lane disagree about the same id');
});

test('lanes agree: a live edition id is `live` in both', async () => {
  const folded = foldSpine([transferSingle(ZERO, ALICE, '0', '2')]).tokens.get('0')!;
  const {listTokens} = await import('../src/tokens.js');
  const client = {
    getChainId: async () => 11155111,
    readContract: async (req: {functionName: string}) => {
      if (req.functionName === 'supportsInterface') return true;
      if (req.functionName === 'maxInvocations') return 1n;
      if (req.functionName === 'totalSupply') return 2n;
      if (req.functionName === 'maxSupply') return 10n;
      throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
    },
  } as never;
  const head = (await listTokens(client, '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294')).tokens[0];
  assert.equal(folded.lifecycle, 'live');
  assert.equal(head.lifecycle, folded.lifecycle);
});

test('`unknown` is head-read-only, and only where the chain cannot say', async () => {
  // A 1/1 has no `nextTokenId`, so a reverting `ownerOf` is equally consistent with never-minted and
  // with burned — the one case a head read must refuse to guess. Verified on chain: burning the only
  // token of 0x1446717c48ED920C10346a643d2d9bc63bB7Eb55 (Sepolia) leaves exactly this observation.
  const {listTokens} = await import('../src/tokens.js');
  const client = {
    getChainId: async () => 11155111,
    readContract: async (req: {functionName: string}) => {
      if (req.functionName === 'supportsInterface') return false; // a 721
      if (req.functionName === 'totalSupply') return 0n; // burned, or never minted — no way to tell
      throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
    },
  } as never;
  const listing = await listTokens(client, '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294');
  // And it must still LIST the id: the id space of a 1/1 is {0} forever, so a burned 1/1 reporting
  // zero rows read as "this collection has no tokens" (the bug the on-chain burn surfaced).
  assert.equal(listing.tokens.length, 1, 'a burned 1/1 must still list its id, not vanish');
  assert.equal(listing.tokens[0].lifecycle, 'unknown');
  // `'unknown'` never appears in the fold's vocabulary — the log always settles it.
  const folded = foldSpine([transfer(ZERO, ALICE, '0'), transfer(ALICE, ZERO, '0')]).tokens.get('0')!;
  assert.equal(folded.lifecycle, 'burned');
});
