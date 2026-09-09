import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {ProjectState} from '@artblocks/abx-sdk';
import {SqliteStore} from '../src/index.js';

// Built on node:test + node:assert (both in the runtime) — zero added deps, no
// chain, no Docker. Exercises the Store contract that the indexer and token API
// depend on; this is where schema/fold regressions would otherwise hide.

function freshStore(): {store: SqliteStore; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-store-'));
  const store = new SqliteStore(dir);
  return {store, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

const ADDR = '0x00085b0ED14297a15A07c9ECd840c3d42815Ca40' as `0x${string}`; // mixed case on purpose

// A rich 1/1: two tokens, multiple commitments, locked flags, royalty, and nulls.
function sampleState(address = ADDR, over: Partial<ProjectState> = {}): ProjectState {
  return {
    address,
    chainId: 11155111,
    abxVersion: 1,
    deployBlock: '11090553',
    deployTx: '0xdeadbeef' as `0x${string}`,
    factory: '0x865913455c0AFF8d5027c54E9b1c7F4301c55A52' as `0x${string}`,
    implementation: null, // null branch
    isCanonical: true,
    name: 'Genesis Block',
    symbol: 'GEN',
    owner: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as `0x${string}`,
    contractURI: 'https://node.example/c/' + address,
    tokenURIRenderer: null, // off-chain by default
    tokenURILocked: false,
    contractURIRenderer: '0x00000000000000000000000000000000000000Ab' as `0x${string}`, // on-chain branch
    contractURILocked: null, // null branch
    royalty: {receiver: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as `0x${string}`, bps: 500},
    collectionFields: [
      {field: 'description', representation: 'inline', value: '0x4869' as `0x${string}`},
    ],
    lockedCollectionFields: ['image'],
    contractType: '1of1',
    maxInvocations: null,
    defaultMaxSupply: null, // 721 — the 1155 default per-id cap never applies
    minter: null,
    paused: false,
    primaryPayee: null,
    // code-project state — the static-token identity values assembleState/hydrate produce
    contractParams: undefined,
    paramSchemas: undefined,
    paramHooks: null,
    delegateRegistry: null,
    seedSource: null,
    script: null,
    dependencies: null,
    extensions: [
      {id: '0x01' as `0x${string}`, name: 'On-Chain Metadata', version: 1},
      {id: '0x02' as `0x${string}`, name: 'Royalty', version: 1},
    ],
    tokens: [
      {
        tokenId: '0',
        lifecycle: 'live',
        owner: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as `0x${string}`,
        tokenURI: 'https://node.example/t/' + address + '/0',
        fields: [
          {field: 'image', representation: 'keccak256', value: '0xf833' as `0x${string}`},
          {field: 'description', representation: 'inline', value: '0x9001' as `0x${string}`},
        ],
        lockedFields: ['image'],
      },
      {tokenId: '1', lifecycle: 'unminted', owner: null, tokenURI: null, fields: [], lockedFields: []},
    ],
    events: [
      {name: 'AbxDeployed', register: 2, what: 'discovery beacon', blockNumber: '11090553', logIndex: 1, txHash: '0xtx1' as `0x${string}`, args: {abxVersion: '1'}},
      {name: 'Transfer', register: 1, what: 'mint', blockNumber: '11090553', logIndex: 7, txHash: '0xtx1' as `0x${string}`, args: {from: '0x0', to: address, tokenId: '0'}},
    ],
    fromBlock: '11090553',
    toBlock: '11090558',
    eventCount: 2,
    reconstructedAt: '2026-06-22T00:00:00.000Z',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    ...over,
  };
}

const EDITION_ADDR = '0x00085b0ED14297a15A07c9ECd840c3d42815Ca41' as `0x${string}`;

// An ERC-1155 edition (EditionImage): id 0 carries real supply/cap/holders (folded from
// TransferSingle + MaxSupplyUpdated); id 1 has never been touched by an edition-specific event,
// so those three fields stay ABSENT — exactly like a 721 token — proving the roundtrip doesn't
// fabricate '0'/'{}' where the fold never wrote anything.
function editionState(address = EDITION_ADDR, over: Partial<ProjectState> = {}): ProjectState {
  return {
    address,
    chainId: 11155111,
    abxVersion: 1,
    deployBlock: '11090600',
    deployTx: '0xed171040' as `0x${string}`,
    factory: '0x865913455c0AFF8d5027c54E9b1c7F4301c55A52' as `0x${string}`,
    implementation: null,
    isCanonical: true,
    name: 'Copies of Everything',
    symbol: 'COPY',
    owner: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as `0x${string}`,
    contractURI: 'https://node.example/c/' + address,
    tokenURIRenderer: null,
    tokenURILocked: false,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: null,
    collectionFields: [],
    lockedCollectionFields: [],
    contractType: 'edition',
    maxInvocations: '10',
    // `--copies 100`: the collection-wide default, announced once by DefaultMaxSupplySet.
    defaultMaxSupply: '100',
    minter: '0x00000000000000000000000000000000000fee' as `0x${string}`,
    paused: false,
    primaryPayee: null,
    contractParams: undefined,
    paramSchemas: undefined,
    paramHooks: null,
    delegateRegistry: null,
    seedSource: null,
    script: null,
    dependencies: null,
    extensions: [
      {id: '0x03' as `0x${string}`, name: 'Edition Supply', version: 1},
      {id: '0x04' as `0x${string}`, name: 'Max Invocations', version: 1},
    ],
    tokens: [
      {
        tokenId: '0',
        lifecycle: 'live',
        owner: null, // editions never carry a single owner (see holders)
        tokenURI: 'https://node.example/t/' + address + '/0',
        fields: [{field: 'image', representation: 'keccak256', value: '0xf833' as `0x${string}`}],
        lockedFields: [],
        supply: '12',
        // 100 is this id's OWN override (`abx set-max-supply 0 100`), which is why the flag rides
        // beside it: without the flag a stored '0' could not say whether an id is open or closed.
        maxSupply: '100',
        maxSupplyOverridden: true,
        holders: {
          '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C': '9',
          '0x1111111111111111111111111111111111111111': '3',
        },
      },
      // Id 1 has no override of its own — no flag, and nothing fabricated in its place.
      {tokenId: '1', lifecycle: 'unminted', owner: null, tokenURI: null, fields: [], lockedFields: []},
    ],
    events: [
      {name: 'AbxDeployed', register: 2, what: 'discovery beacon', blockNumber: '11090600', logIndex: 1, txHash: '0xed171040' as `0x${string}`, args: {abxVersion: '1'}},
      {
        name: 'TransferSingle',
        register: 1,
        what: 'mint',
        blockNumber: '11090601',
        logIndex: 2,
        txHash: '0xed171041' as `0x${string}`,
        args: {operator: address, from: '0x0', to: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C', id: '0', value: '9'},
      },
    ],
    fromBlock: '11090600',
    toBlock: '11090605',
    eventCount: 2,
    reconstructedAt: '2026-08-05T00:00:00.000Z',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    ...over,
  };
}

// The store never persists composed URI documents: `contractURI`/`token.tokenURI` come back NULL on
// every round-trip regardless of what went
// in. Every fixture above still carries realistic values for those fields (a caller CAN pass a
// state with them populated — e.g. a reconstruct run with `readUriDocuments: true` — and the store
// must still refuse to cache it), so round-trip assertions compare against this nulled projection
// of the input rather than the input itself.
function nulledUris(state: ProjectState): ProjectState {
  return {...state, contractURI: null, tokens: state.tokens.map((t) => ({...t, tokenURI: null}))};
}

test('round-trips a project byte-for-byte (nested tokens/commitments/events)', () => {
  const {store, cleanup} = freshStore();
  try {
    const state = sampleState();
    store.putProject(state);
    assert.deepEqual(store.getProject(ADDR), nulledUris(state));
  } finally {
    cleanup();
  }
});

test('round-trips the empty-extension / no-royalty / undefined-rpc branches', () => {
  const {store, cleanup} = freshStore();
  try {
    const state = sampleState(ADDR, {royalty: null, extensions: [], tokens: [], events: [], eventCount: 0, rpcUrl: undefined});
    store.putProject(state);
    assert.deepEqual(store.getProject(ADDR), nulledUris(state));
  } finally {
    cleanup();
  }
});

test('token_uri/contract_uri are always NULL in storage, even when the input state has real values', () => {
  // The store's own guarantee, isolated from the byte-for-byte roundtrip tests above: a caller
  // handing it a state with composed documents populated (e.g. a reconstruct run with
  // `readUriDocuments: true`) must not have them cached. There is no settled value to cache — a
  // renderer can change the composed document with no log at all — so the store refuses regardless
  // of what it's given.
  const {store, cleanup} = freshStore();
  try {
    const state = sampleState(ADDR, {contractURI: 'data:application/json;base64,eyJuYW1lIjoiaGVhdnkifQ=='});
    assert.ok(state.contractURI, 'fixture sanity: contractURI is actually populated going in');
    assert.ok(state.tokens[0]?.tokenURI, 'fixture sanity: tokens[0].tokenURI is actually populated going in');
    store.putProject(state);
    const got = store.getProject(ADDR);
    assert.equal(got?.contractURI, null);
    assert.equal(got?.tokens[0]?.tokenURI, null);
    // a raw column read, bypassing hydrate(), proves it's NULL in the row — not merely stripped on
    // the way out.
    const db = (store as unknown as {db: import('node:sqlite').DatabaseSync}).db;
    const projectRow = db.prepare(`SELECT contract_uri FROM projects WHERE address = ?`).get(ADDR.toLowerCase()) as {contract_uri: string | null};
    const tokenRow = db.prepare(`SELECT token_uri FROM tokens WHERE project_address = ? AND token_id = '0'`).get(ADDR.toLowerCase()) as {token_uri: string | null};
    assert.equal(projectRow.contract_uri, null);
    assert.equal(tokenRow.token_uri, null);
  } finally {
    cleanup();
  }
});

test('lookups are case-insensitive', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState());
    assert.ok(store.getProject(ADDR.toLowerCase()));
    assert.ok(store.getProject(ADDR.toUpperCase()));
  } finally {
    cleanup();
  }
});

test('putProject is an upsert, not a duplicate insert', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState());
    store.putProject(sampleState());
    assert.equal(store.listProjects().length, 1);
  } finally {
    cleanup();
  }
});

test('listProjects orders by reconstructedAt', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState(ADDR, {reconstructedAt: '2026-06-22T02:00:00.000Z', name: 'B'}));
    store.putProject(sampleState('0x1111111111111111111111111111111111111111' as `0x${string}`, {reconstructedAt: '2026-06-22T01:00:00.000Z', name: 'A'}));
    assert.deepEqual(store.listProjects().map((s) => s.name), ['A', 'B']);
  } finally {
    cleanup();
  }
});

test('wipeProjections clears the projection but keeps registrations', () => {
  const {store, cleanup} = freshStore();
  try {
    store.register({address: ADDR, chainKey: 'sepolia', fromBlock: '11090553', factory: null, label: 'Genesis', registeredAt: '2026-06-22T00:00:00.000Z'});
    store.putProject(sampleState());
    store.wipeProjections();
    assert.equal(store.getProject(ADDR), null);
    assert.equal(store.listRegistrations().length, 1);
  } finally {
    cleanup();
  }
});

test('replay after wipe is idempotent (identical state)', () => {
  const {store, cleanup} = freshStore();
  try {
    const state = sampleState();
    store.putProject(state);
    store.wipeProjections();
    store.putProject(state);
    assert.deepEqual(store.getProject(ADDR), nulledUris(state));
  } finally {
    cleanup();
  }
});

test('round-trips an ERC-1155 edition project (supply/maxSupply/holders present on one token, absent on the other)', () => {
  const {store, cleanup} = freshStore();
  try {
    const state = editionState();
    store.putProject(state);
    assert.deepEqual(store.getProject(EDITION_ADDR), nulledUris(state));
  } finally {
    cleanup();
  }
});

// ── append-only events: chain-derived seq, O(delta) writes ─────────────────────
// `seq = (blockNumber << 32) | logIndex`
// (see `eventSeq` in ../src/store.ts) routinely exceeds `Number.MAX_SAFE_INTEGER` — a real chain
// height already does — so every assertion here that touches the raw column goes through
// `setReadBigInts(true)`; anything that doesn't need the value avoids selecting it at all (the same
// rule `hydrate()` itself follows).

const rawDb = (store: SqliteStore) => (store as unknown as {db: import('node:sqlite').DatabaseSync}).db;

test('seq is chain-derived and exact for a block number that pushes it past 2^53, and events order correctly', () => {
  const {store, cleanup} = freshStore();
  try {
    // A block height of 20,000,000 pushes (block << 32) well past Number.MAX_SAFE_INTEGER
    // (2^53 ≈ 9.007e15); 20_000_000 << 32 ≈ 8.59e16.
    const bigBlock = 20_000_000n;
    const state = sampleState(ADDR, {
      deployBlock: bigBlock.toString(),
      fromBlock: bigBlock.toString(),
      toBlock: (bigBlock + 1n).toString(),
      events: [
        {name: 'AbxDeployed', register: 2, what: 'discovery beacon', blockNumber: bigBlock.toString(), logIndex: 3, txHash: '0xaa' as `0x${string}`, args: {}},
        // Same block, a LOWER logIndex — must still sort BEFORE the one above despite being
        // written to the table second, proving the ORDER BY is on the real chain position, not
        // insertion order.
        {name: 'OwnershipTransferred', register: 2, what: 'owner', blockNumber: bigBlock.toString(), logIndex: 1, txHash: '0xbb' as `0x${string}`, args: {}},
        {name: 'Transfer', register: 1, what: 'mint', blockNumber: (bigBlock + 1n).toString(), logIndex: 0, txHash: '0xcc' as `0x${string}`, args: {}},
      ],
      eventCount: 3,
    });
    store.putProject(state);

    // Round-trip through the public API: no RangeError, and chain order — not insertion order —
    // wins (logIndex 1 before logIndex 3 within the same block).
    const got = store.getProject(ADDR);
    assert.deepEqual(
      got?.events.map((e) => `${e.blockNumber}:${e.logIndex}`),
      [`${bigBlock}:1`, `${bigBlock}:3`, `${bigBlock + 1n}:0`],
    );

    // And the raw column carries the EXACT expected bigint — not a rounded/overflowed double.
    const stmt = rawDb(store).prepare(
      `SELECT seq, block_number, log_index FROM events WHERE project_address = ? ORDER BY seq`,
    );
    stmt.setReadBigInts(true);
    const rows = stmt.all(ADDR.toLowerCase()) as Array<{seq: bigint; block_number: string; log_index: bigint}>;
    assert.equal(rows[1].seq, (bigBlock << 32n) | 3n);
    assert.equal(rows[0].seq, (bigBlock << 32n) | 1n);
    assert.equal(rows[2].seq, ((bigBlock + 1n) << 32n) | 0n);
  } finally {
    cleanup();
  }
});

test('putProject twice with an identical state never rewrites an event row (rowid-stable — a true no-op, not delete+reinsert)', () => {
  const {store, cleanup} = freshStore();
  try {
    const state = sampleState();
    store.putProject(state);
    const before = rawDb(store)
      .prepare(`SELECT rowid, block_number, log_index FROM events WHERE project_address = ? ORDER BY block_number, log_index`)
      .all(ADDR.toLowerCase());

    store.putProject(state); // identical re-fold — every event's seq already exists

    const after = rawDb(store)
      .prepare(`SELECT rowid, block_number, log_index FROM events WHERE project_address = ? ORDER BY block_number, log_index`)
      .all(ADDR.toLowerCase());
    assert.deepEqual(after, before, 'the exact same rows, same rowids — ON CONFLICT DO NOTHING touched nothing');
  } finally {
    cleanup();
  }
});

test('an incremental-style putProject with one appended event only inserts the new row — existing rowids untouched', () => {
  const {store, cleanup} = freshStore();
  try {
    const state = sampleState();
    store.putProject(state);
    const before = rawDb(store)
      .prepare(`SELECT rowid, block_number, log_index FROM events WHERE project_address = ? ORDER BY rowid`)
      .all(ADDR.toLowerCase()) as Array<{rowid: number}>;
    assert.equal(before.length, state.events.length);

    // One new mint's worth of events, appended — mirrors what a real reconstructIncremental hands
    // `putProject`: the full prior log plus a small fresh tail.
    const appended = sampleState(ADDR, {
      events: [...state.events, {name: 'Transfer', register: 1, what: 'mint', blockNumber: '11090560', logIndex: 2, txHash: '0xnew' as `0x${string}`, args: {from: '0x0', to: ADDR, tokenId: '1'}}],
      eventCount: state.events.length + 1,
    });
    store.putProject(appended);

    const after = rawDb(store)
      .prepare(`SELECT rowid, block_number, log_index FROM events WHERE project_address = ? ORDER BY rowid`)
      .all(ADDR.toLowerCase()) as Array<{rowid: number}>;
    assert.equal(after.length, before.length + 1, 'exactly one new row, not a rewrite of the rest');
    assert.deepEqual(after.slice(0, before.length), before, 'every pre-existing row keeps its rowid — never deleted and recreated');
  } finally {
    cleanup();
  }
});

test('project and token rows are upserted in place, not delete-and-reinserted (rowid-stable across an update)', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState());
    const projectRowidBefore = (rawDb(store).prepare(`SELECT rowid FROM projects WHERE address = ?`).get(ADDR.toLowerCase()) as {rowid: number}).rowid;
    const tokenRowidBefore = (
      rawDb(store).prepare(`SELECT rowid FROM tokens WHERE project_address = ? AND token_id = '0'`).get(ADDR.toLowerCase()) as {rowid: number}
    ).rowid;

    // A real delta: token #0 changes owner, the project's name changes — same rows, new values.
    const changed = sampleState(ADDR, {
      name: 'Genesis Block (renamed)',
      tokens: [
        {...sampleState().tokens[0], owner: '0x1111111111111111111111111111111111111111' as `0x${string}`},
        sampleState().tokens[1],
      ],
    });
    store.putProject(changed);

    const projectRowidAfter = (rawDb(store).prepare(`SELECT rowid FROM projects WHERE address = ?`).get(ADDR.toLowerCase()) as {rowid: number}).rowid;
    const tokenRowidAfter = (
      rawDb(store).prepare(`SELECT rowid FROM tokens WHERE project_address = ? AND token_id = '0'`).get(ADDR.toLowerCase()) as {rowid: number}
    ).rowid;
    assert.equal(projectRowidAfter, projectRowidBefore, 'the project row was UPDATEd, not deleted + reinserted');
    assert.equal(tokenRowidAfter, tokenRowidBefore, 'the token row was UPDATEd, not deleted + reinserted');
    assert.equal(store.getProject(ADDR)?.name, 'Genesis Block (renamed)');
    assert.equal(store.getProject(ADDR)?.tokens[0]?.owner, '0x1111111111111111111111111111111111111111');
  } finally {
    cleanup();
  }
});

test('a token whose id vanishes from the new state is removed, not left behind', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState()); // tokens '0' and '1'
    assert.equal(store.getProject(ADDR)?.tokens.length, 2);

    store.putProject(sampleState(ADDR, {tokens: [sampleState().tokens[0]]})); // '1' vanished
    const tokens = store.getProject(ADDR)?.tokens ?? [];
    assert.deepEqual(tokens.map((t) => t.tokenId), ['0']);
  } finally {
    cleanup();
  }
});

test('token/project upsert roundtrip on an edition-shaped state (supply/holders survive an in-place update)', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(editionState());
    const rowidBefore = (rawDb(store).prepare(`SELECT rowid FROM tokens WHERE project_address = ? AND token_id = '0'`).get(EDITION_ADDR.toLowerCase()) as {rowid: number}).rowid;

    // A real edition delta: id 0 gets more supply and a new holder.
    const updated = editionState(EDITION_ADDR, {
      tokens: [
        {...editionState().tokens[0], supply: '15', holders: {...editionState().tokens[0].holders, '0x2222222222222222222222222222222222222222': '3'}},
        editionState().tokens[1],
      ],
    });
    store.putProject(updated);

    const rowidAfter = (rawDb(store).prepare(`SELECT rowid FROM tokens WHERE project_address = ? AND token_id = '0'`).get(EDITION_ADDR.toLowerCase()) as {rowid: number}).rowid;
    assert.equal(rowidAfter, rowidBefore, 'upserted in place');
    assert.deepEqual(store.getProject(EDITION_ADDR), nulledUris(updated));
  } finally {
    cleanup();
  }
});

test('user_version migration recomputes positional seq to chain-derived seq on an existing (pre-migration) DB', () => {
  const {store, cleanup} = freshStore();
  try {
    const dir = dirname(store.path);
    // A fresh store already ran the migration once (a no-op on an empty table) and stamped
    // user_version = 1. Roll it back to 0 and overwrite the events with the OLD shape — positional
    // seq (the array index a re-fold used to write) — to simulate a store created before this
    // change ever shipped.
    store.putProject(sampleState()); // 2 events, seq already chain-derived by THIS store's writer
    const db = rawDb(store);
    db.exec(`UPDATE events SET seq = 0 WHERE block_number = '11090553' AND log_index = 1`);
    db.exec(`UPDATE events SET seq = 1 WHERE block_number = '11090553' AND log_index = 7`);
    db.exec(`PRAGMA user_version = 0`);

    const reopened = new SqliteStore(dir);
    const stmt = rawDb(reopened).prepare(`SELECT seq, block_number, log_index FROM events WHERE project_address = ? ORDER BY seq`);
    stmt.setReadBigInts(true);
    const rows = stmt.all(ADDR.toLowerCase()) as Array<{seq: bigint; block_number: string; log_index: bigint}>;
    assert.deepEqual(
      rows.map((r) => r.seq),
      [(11090553n << 32n) | 1n, (11090553n << 32n) | 7n],
      'the migration recomputed both rows from (block_number, log_index), not their old positional 0/1',
    );
    assert.equal((rawDb(reopened).prepare(`PRAGMA user_version`).get() as {user_version: number}).user_version, 1);
    // And the store keeps working normally afterward — the migration doesn't just stamp the
    // version, it leaves a store a normal putProject can build on.
    reopened.putProject(sampleState(ADDR, {name: 'after migration'}));
    assert.equal(reopened.getProject(ADDR)?.name, 'after migration');
  } finally {
    cleanup();
  }
});

test('edition fields with nothing folded stay NULL in storage — never a fabricated 0 or {}', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(editionState());
    const db = (store as unknown as {db: import('node:sqlite').DatabaseSync}).db;
    // node:sqlite rows are null-prototype objects — spread into a plain one so deepEqual compares
    // values, not prototypes.
    const row = {
      ...(db.prepare(`SELECT supply, max_supply, max_supply_overridden, holders FROM tokens WHERE project_address = ? AND token_id = '1'`).get(EDITION_ADDR.toLowerCase()) as {
        supply: string | null;
        max_supply: string | null;
        max_supply_overridden: number | null;
        holders: string | null;
      }),
    };
    // `max_supply_overridden` NULL, not 0: "no override event for this id" is a different fact from
    // "an override said false", and only NULL can say the first.
    assert.deepEqual(row, {supply: null, max_supply: null, max_supply_overridden: null, holders: null});
  } finally {
    cleanup();
  }
});

test('supply/max_supply/holders are migration-added to a pre-edition tokens table (old row stays absent, not fabricated)', () => {
  const {store, cleanup} = freshStore();
  try {
    const dir = dirname(store.path);
    const db = (store as unknown as {db: import('node:sqlite').DatabaseSync}).db;
    // Simulate a DB from before this feature: the tokens table without supply/max_supply/holders,
    // carrying one pre-existing 721 row.
    db.exec(`DROP TABLE tokens`);
    db.exec(`CREATE TABLE tokens (
      project_address TEXT NOT NULL, token_id TEXT NOT NULL, minted INTEGER NOT NULL DEFAULT 0,
      owner TEXT, token_uri TEXT, fields TEXT, locked_fields TEXT, params TEXT,
      PRIMARY KEY (project_address, token_id))`);
    db.exec(
      `INSERT INTO tokens (project_address, token_id, minted, owner, token_uri, fields, locked_fields) VALUES ('${ADDR.toLowerCase()}', '0', 1, NULL, NULL, '[]', '[]')`,
    );

    const reopened = new SqliteStore(dir);
    // node:sqlite rows are null-prototype objects — spread into a plain one so deepEqual compares
    // values, not prototypes.
    const rawRow = {
      ...((reopened as unknown as {db: import('node:sqlite').DatabaseSync}).db
        .prepare(
          `SELECT supply, max_supply, max_supply_overridden, holders FROM tokens WHERE project_address = ? AND token_id = '0'`,
        )
        .get(ADDR.toLowerCase()) as {
        supply: string | null;
        max_supply: string | null;
        max_supply_overridden: number | null;
        holders: string | null;
      }),
    };
    // migrated in; old row untouched
    assert.deepEqual(rawRow, {supply: null, max_supply: null, max_supply_overridden: null, holders: null});
    // a fresh edition write against the now-migrated table gets real values
    reopened.putProject(editionState());
    const project = reopened.getProject(EDITION_ADDR);
    assert.equal(project?.tokens[0]?.supply, '12');
    // The two columns this pass added round-trip through the same migration path.
    assert.equal(project?.tokens[0]?.maxSupplyOverridden, true);
    assert.equal(project?.defaultMaxSupply, '100');
  } finally {
    cleanup();
  }
});

test('registrations round-trip case-insensitively', () => {
  const {store, cleanup} = freshStore();
  try {
    store.register({address: ADDR, chainKey: 'sepolia', fromBlock: '11090553', factory: null, label: 'Genesis', registeredAt: '2026-06-22T00:00:00.000Z'});
    assert.equal(store.getRegistration(ADDR.toLowerCase())?.label, 'Genesis');
  } finally {
    cleanup();
  }
});

test('registrations round-trip per-token off-chain attributes (the Series traits column)', () => {
  const {store, cleanup} = freshStore();
  try {
    const tokenAttributes = JSON.stringify({'0': [{trait_type: 'Subject', value: 'Astronaut'}], '2': [{trait_type: 'Subject', value: 'Cat'}]});
    store.register({address: ADDR, chainKey: 'sepolia', fromBlock: '1', factory: null, label: 'S', tokenAttributes, registeredAt: '2026-07-22T00:00:00.000Z'});
    assert.equal(store.getRegistration(ADDR)?.tokenAttributes, tokenAttributes);
    // upsert without the field preserves nothing it wasn't given — an explicit re-register clears it
    store.register({address: ADDR, chainKey: 'sepolia', fromBlock: '1', factory: null, label: 'S', registeredAt: '2026-07-22T00:00:01.000Z'});
    assert.equal(store.getRegistration(ADDR)?.tokenAttributes, undefined);
  } finally {
    cleanup();
  }
});

test('destroy removes the db file (and wal/shm)', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState());
    const p = store.path;
    store.destroy();
    assert.equal(existsSync(p), false);
    assert.equal(existsSync(p + '-wal'), false);
  } finally {
    cleanup();
  }
});

const HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const artifactRow = (key: string, over: Partial<import('../src/store.js').EffectArtifactRow> = {}) => ({
  key,
  address: ADDR,
  tokenId: '3',
  effectKey: 'render',
  outputKey: 'image',
  inputsHash: HASH,
  contentType: 'image/png',
  locator: 'ipfs://cid-one' as string | null,
  ...over,
});

test('effect artifacts: round-trip, idempotent overwrite, and deregister cleanup', () => {
  const {store, cleanup} = freshStore();
  const KEY = '0x' + 'ab'.repeat(32); // a renderArtifactKey (keccak hex)
  try {
    assert.equal(store.getEffectArtifact(KEY), null);
    store.putEffectArtifact(artifactRow(KEY));
    const row = store.getEffectArtifact(KEY)!;
    assert.equal(row.locator, 'ipfs://cid-one');
    assert.equal(row.contentType, 'image/png');
    assert.equal(row.tokenId, '3');
    assert.equal(row.effectKey, 'render');
    assert.equal(row.outputKey, 'image');
    assert.equal(row.inputsHash, HASH);
    // idempotent last-write-wins (a re-render at the same address updates the pointer)
    store.putEffectArtifact(artifactRow(KEY, {locator: 'ar://tx-two'}));
    assert.equal(store.getEffectArtifact(KEY)?.locator, 'ar://tx-two');
    // bytes-mode rows are legal: locator NULL = bytes live in custody at the key
    store.putEffectArtifact(artifactRow('0x' + 'ee'.repeat(32), {outputKey: 'traits', contentType: 'application/json', locator: null}));
    assert.equal(store.getEffectArtifact('0x' + 'ee'.repeat(32))?.locator, null);
    // survives a projection wipe (producer-published, not chain-derived)
    store.wipeProjections();
    assert.equal(store.getEffectArtifact(KEY)?.locator, 'ar://tx-two');
    // deregister drops the project's rows
    store.deregister(ADDR);
    assert.equal(store.getEffectArtifact(KEY), null);
  } finally {
    cleanup();
  }
});

test('effect artifacts: listEffectArtifacts enumerates a token\'s rows (the manifest source), ordered', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putEffectArtifact(artifactRow('0x' + '01'.repeat(32), {effectKey: 'world.rebuild', outputKey: 'model', contentType: 'model/gltf-binary'}));
    store.putEffectArtifact(artifactRow('0x' + '02'.repeat(32), {outputKey: 'traits', contentType: 'application/json', locator: null}));
    store.putEffectArtifact(artifactRow('0x' + '03'.repeat(32)));
    store.putEffectArtifact(artifactRow('0x' + '04'.repeat(32), {tokenId: '9'})); // another token — excluded
    const rows = store.listEffectArtifacts(ADDR, '3');
    assert.deepEqual(
      rows.map((r) => `${r.effectKey}/${r.outputKey}`),
      ['render/image', 'render/traits', 'world.rebuild/model'],
    );
    assert.equal(store.listEffectArtifacts(ADDR, '9').length, 1);
    assert.equal(store.listEffectArtifacts('0x' + '00'.repeat(20), '3').length, 0);
  } finally {
    cleanup();
  }
});

test('effect artifacts: a pre-data-plane table shape is dropped + recreated by the migration', () => {
  const {store, cleanup} = freshStore();
  try {
    // Simulate the OLD shape (key/address/locator NOT NULL, no token columns) under a live store,
    // then reopen: the migration must detect the missing token_id and rebuild the table empty.
    const db = (store as unknown as {db: import('node:sqlite').DatabaseSync}).db;
    db.exec(`DROP TABLE effect_artifacts`);
    db.exec(`CREATE TABLE effect_artifacts (
      key TEXT PRIMARY KEY, address TEXT NOT NULL, locator TEXT NOT NULL,
      content_type TEXT, updated_at TEXT NOT NULL)`);
    db.exec(`INSERT INTO effect_artifacts VALUES ('0xabc', '${ADDR}', 'ipfs://old', 'image/png', 'then')`);
    const reopened = new SqliteStore(dirname(store.path));
    assert.equal(reopened.getEffectArtifact('0xabc'), null); // old rows dropped (self-heal on next sweep)
    reopened.putEffectArtifact(artifactRow('0x' + 'aa'.repeat(32))); // new shape works
    assert.equal(reopened.getEffectArtifact('0x' + 'aa'.repeat(32))?.tokenId, '3');
  } finally {
    cleanup();
  }
});

test('meta: key/value round-trip + overwrite (the watcher watermark home)', () => {
  const {store, cleanup} = freshStore();
  try {
    assert.equal(store.getMeta('watch:sepolia'), null);
    store.putMeta('watch:sepolia', '11266000');
    assert.equal(store.getMeta('watch:sepolia'), '11266000');
    store.putMeta('watch:sepolia', '11266123'); // watermark advances in place
    assert.equal(store.getMeta('watch:sepolia'), '11266123');
    // survives a projection wipe (node metadata, not chain-derived projection)
    store.wipeProjections();
    assert.equal(store.getMeta('watch:sepolia'), '11266123');
  } finally {
    cleanup();
  }
});

test('effect status: upsert → clear lifecycle, per-project list, deregister cleanup', () => {
  const {store, cleanup} = freshStore();
  const KEY = '0x' + 'cd'.repeat(32);
  try {
    assert.deepEqual(store.listEffectStatuses(ADDR), []);
    store.putEffectStatus({key: KEY, address: ADDR, tokenId: '3', effectKey: 'render', status: 'rendering'});
    let rows = store.listEffectStatuses(ADDR);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'rendering');
    assert.equal(rows[0].tokenId, '3');
    // a failure overwrites in place with the error + attempt count
    store.putEffectStatus({key: KEY, address: ADDR, tokenId: '3', effectKey: 'render', status: 'failed', error: 'browser exploded', attempts: 2});
    rows = store.listEffectStatuses(ADDR);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].error, 'browser exploded');
    assert.equal(rows[0].attempts, 2);
    // done ⇒ cleared — artifact presence takes over as the source of truth
    store.clearEffectStatus(KEY);
    assert.deepEqual(store.listEffectStatuses(ADDR), []);
    // deregister drops any leftovers
    store.putEffectStatus({key: KEY, address: ADDR, tokenId: '3', effectKey: 'render', status: 'rendering'});
    store.deregister(ADDR);
    assert.deepEqual(store.listEffectStatuses(ADDR), []);
  } finally {
    cleanup();
  }
});

test('dropProjection clears the projection but KEEPS the registration', () => {
  // The projection is a disposable cache of chain state, never a source of truth. `abx demo`
  // demonstrates that by deleting it and replaying — which only works if the registration (the
  // address + deploy block needed to replay) survives the drop.
  const {store, cleanup} = freshStore();
  try {
    store.register({
      address: ADDR,
      chainKey: 'base-sepolia',
      fromBlock: '100',
      factory: null,
      registeredAt: new Date(0).toISOString(),
    });
    store.putProject(sampleState());
    assert.ok(store.getProject(ADDR), 'projection present before the drop');

    store.dropProjection(ADDR);

    assert.equal(store.getProject(ADDR), null, 'projection gone');
    const reg = store.getRegistration(ADDR);
    assert.ok(reg, 'registration survives — otherwise there is nothing to replay from');
    assert.equal(reg.fromBlock, '100');
  } finally {
    cleanup();
  }
});

test('dropProjection deliberately LEAVES events in place (append-only, chain-derived, self-heals on re-fold)', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState()); // 2 events
    store.dropProjection(ADDR);
    const remaining = rawDb(store).prepare(`SELECT COUNT(*) AS n FROM events WHERE project_address = ?`).get(ADDR.toLowerCase()) as {n: number};
    assert.equal(remaining.n, 2, 'events survive a projection drop — a re-fold re-derives the same rows as a no-op, not a rewrite');
  } finally {
    cleanup();
  }
});

test('deregister — forgetting a project entirely — DOES delete its events (the one place the append-only rule stops)', () => {
  const {store, cleanup} = freshStore();
  try {
    store.register({address: ADDR, chainKey: 'sepolia', fromBlock: '11090553', factory: null, registeredAt: new Date(0).toISOString()});
    store.putProject(sampleState());
    assert.equal((rawDb(store).prepare(`SELECT COUNT(*) AS n FROM events WHERE project_address = ?`).get(ADDR.toLowerCase()) as {n: number}).n, 2);

    store.deregister(ADDR);

    assert.equal(store.getRegistration(ADDR), null);
    assert.equal(
      (rawDb(store).prepare(`SELECT COUNT(*) AS n FROM events WHERE project_address = ?`).get(ADDR.toLowerCase()) as {n: number}).n,
      0,
      'forgetting the project must not leave stale events behind for a later re-add at a different block to inherit',
    );
  } finally {
    cleanup();
  }
});

test('dropProjection is idempotent and case-insensitive on the address', () => {
  const {store, cleanup} = freshStore();
  try {
    store.putProject(sampleState());
    store.dropProjection(ADDR.toUpperCase());
    assert.equal(store.getProject(ADDR), null);
    store.dropProjection(ADDR); // second drop must not throw
  } finally {
    cleanup();
  }
});

test('a full replay purges a reorg-replaced event; an incremental write preserves the append-only log', () => {
  // The repair-path carve-out: `ON CONFLICT DO NOTHING` means a reorg that
  // replaces the event at one (block, logIndex) with different content would survive as a stale
  // row forever under append-only writes. `putProject(state, {fullReplay: true})` — what
  // `abx index --full` reaches — purges the project's log first, keeping the documented
  // "full replay repairs everything" promise true.
  const {store, cleanup} = freshStore();
  try {
    const ev = (name: string, txHash: string) => ({
      name, register: 2 as const, what: 'x', blockNumber: '100', logIndex: 0, txHash: txHash as `0x${string}`, args: {},
    });
    store.putProject(sampleState(ADDR, {events: [ev('AbxDeployed', '0xaa')], eventCount: 1}));

    // Same (block, logIndex), different content — a reorg's signature.
    const reorged = sampleState(ADDR, {events: [ev('OwnershipTransferred', '0xbb')], eventCount: 1});

    store.putProject(reorged); // incremental-style write: append-only, stale row survives
    assert.equal(store.getProject(ADDR)?.events[0]?.txHash, '0xaa');

    store.putProject(reorged, {fullReplay: true}); // the repair path: purge + rebuild
    const after = store.getProject(ADDR)?.events;
    assert.equal(after?.length, 1);
    assert.equal(after?.[0]?.txHash, '0xbb');
    assert.equal(after?.[0]?.name, 'OwnershipTransferred');
  } finally {
    cleanup();
  }
});
