// A burned token gets `410 Gone`, on a real server, on every token route — and an edition with zero
// live copies never does.
//
// The rule under test is the contract's, not a preference: a burned ERC-721's `tokenURI` reverts
// `NonexistentToken` (`TokenURI.sol`), so a resolver that composed a document for that id would be in
// direct contradiction with the contract it speaks for. `404` would be wrong twice — it reads as
// "wrong URL / not indexed yet" and invites a retry that can never succeed, and on `/image` an
// unknown-but-in-cap id gets the WARMING PLACEHOLDER, so a destroyed token would say "still loading"
// forever. `AbxEditionLib.uri(id)` has no existence gate and a zero-supply id can mint again, so
// nothing there is permanently gone and `410` would be the lie instead.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Server} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveChain, type ProjectState} from '@artblocks/abx-sdk';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';
import type {StorageBackend, StoredContent} from '@artblocks/abx-storage';
import {createTokenApiServer} from '../src/server.js';
import {summarize} from '../src/control-plane.js';

const CHAIN_KEY = process.env.ABX_CHAIN ?? 'base-sepolia';
const CHAIN_ID = resolveChain(process.env.ABX_CHAIN).id;
const ADDR = '0xb5d472600107a56c0a36838fff7030a864439a30';

function memoryStorage(): StorageBackend {
  const map = new Map<string, StoredContent>();
  return {
    id: 'memory',
    async put(hash, content) {
      map.set(hash, content);
    },
    async get(hash) {
      return map.get(hash) ?? null;
    },
    async has(hash) {
      return map.has(hash);
    },
  };
}

async function withNode(run: (base: string, indexer: SelfHostIndexer) => Promise<void>): Promise<void> {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-burn-')));
  const indexer = new SelfHostIndexer(store);
  const server: Server = createTokenApiServer({indexer, port: 0, baseUrl: 'http://localhost', storage: memoryStorage()});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    await run(base, indexer);
  } finally {
    server.close();
    store.destroy();
  }
}

/** A Series with three ids: 0 live, 1 burned, 2 never minted (inside the cap). */
function seriesState(tokens: unknown[], contractType = 'series'): ProjectState {
  return {
    address: ADDR,
    chainId: CHAIN_ID,
    abxVersion: 2,
    deployBlock: '100',
    deployTx: null,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: 'Burnable',
    symbol: 'BRN',
    owner: ADDR,
    contractURI: null,
    royalty: null,
    maxRoyaltyBps: 1000,
    burnable: true,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    collectionFields: [],
    lockedCollectionFields: [],
    contractType,
    maxInvocations: '3',
    extensions: [],
    tokens,
    events: [],
    fromBlock: '100',
    toBlock: '105',
    eventCount: 0,
    reconstructedAt: '2026-08-20T00:00:00.000Z',
  } as unknown as ProjectState;
}

const tok = (tokenId: string, lifecycle: string, owner: string | null = null) => ({
  tokenId,
  lifecycle,
  owner,
  tokenURI: null,
  fields: [],
  lockedFields: [],
});

test('every 721 token route answers 410 `burned` for a destroyed id', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'burn'});
    indexer.store.putProject(seriesState([tok('0', 'live', ADDR), tok('1', 'burned'), tok('2', 'unminted')]));

    for (const path of [
      `/t/${CHAIN_ID}/${ADDR}/1`,
      `/t/${CHAIN_ID}/${ADDR}/1/image`,
      `/t/${CHAIN_ID}/${ADDR}/1/data/image`,
      `/a/${CHAIN_ID}/${ADDR}/1`,
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 410, `${path} should be 410 Gone`);
      const body = (await res.json()) as {code?: string; burned?: boolean};
      assert.equal(body.code, 'burned', `${path} should carry code "burned", not a statement about the contract`);
      assert.equal(body.burned, true);
    }
  });
});

test('a live id and an unminted-but-in-cap id are untouched — only the burn changes', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'burn'});
    indexer.store.putProject(seriesState([tok('0', 'live', ADDR), tok('1', 'burned'), tok('2', 'unminted')]));

    const live = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`);
    assert.equal(live.status, 200);
    // The pre-mint warming view still works: that path is exactly the one a burned id must not reach.
    const warming = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/2`);
    assert.equal(warming.status, 200);
    // And an id outside the cap is still a 404 about the CONTRACT's id space, not a 410.
    const outside = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/99`);
    assert.equal(outside.status, 404);
    assert.equal(((await outside.json()) as {code?: string}).code, 'not_registered');
  });
});

test('an edition id with zero live copies is NOT gone — it serves, and can mint again', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'burn'});
    // What the fold actually produces for a fully-burned edition id: `'no-live-copies'`, never
    // `'burned'`. `uri(id)` has no existence gate on chain and the id can mint again, so the truthful
    // answer is the document with `supply: 0`.
    indexer.store.putProject(
      seriesState([{...tok('0', 'no-live-copies'), supply: '0', maxSupply: '10', holders: {}}], 'edition'),
    );
    const res = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`);
    assert.equal(res.status, 200, 'an edition must never 410 — nothing is permanently gone there');
  });
});

test('the 410 needs no contractType branch: the route reads only `burned`, which editions cannot be', async () => {
  // The carve-out used to live twice — once in the type and once as an `isEditionState` guard beside
  // the status check — which is one place too many for a rule that decides whether a resolver
  // contradicts its own contract. This asserts the route in its post-guard form: an edition state
  // carrying the edition zero-word serves, a 721 state carrying the terminal word does not, and the
  // route never asks which standard it is looking at.
  //
  // The other half of the invariant — that no edition history can fold to `'burned'` — is pinned in
  // `packages/sdk/test/burn-fold.test.ts`. Both are needed: this one would keep passing if the fold
  // started producing `'burned'` for editions, and that is exactly the edit that would break it.
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'burn'});

    for (const contractType of ['edition', 'edition-code', '1of1-edition']) {
      indexer.store.putProject(
        seriesState([{...tok('0', 'no-live-copies'), supply: '0', maxSupply: '10', holders: {}}], contractType),
      );
      const res = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`);
      assert.equal(res.status, 200, `${contractType} with zero live copies must serve, not 410`);
    }

    for (const contractType of ['1of1', 'series', 'code']) {
      indexer.store.putProject(seriesState([tok('0', 'burned')], contractType));
      const res = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`);
      assert.equal(res.status, 410, `${contractType} with a burned id must 410`);
      assert.equal(((await res.json()) as {code?: string}).code, 'burned');
    }
  });
});

test('a burned token does not take its COLLECTION with it', async () => {
  // Verified on chain first (0x1446717c48ED920C10346a643d2d9bc63bB7Eb55, Sepolia, token 0 burned):
  // the three token routes answer 410 and `/c` still answers 200. Worth an assertion because the
  // 410 branch sits in the shared token-route prologue, and a collection whose only token was burned
  // is exactly the state where an over-broad guard would take the contract-level document down too.
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'burn'});
    indexer.store.putProject(seriesState([tok('0', 'burned')], '1of1'));
    assert.equal((await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`)).status, 410);
    assert.equal((await fetch(`${base}/c/${CHAIN_ID}/${ADDR}`)).status, 200);
    assert.equal((await fetch(`${base}/api/project/${ADDR}`)).status, 200);
  });
});

test('mintedCount counts LIVE ids; burnedCount appears only when there are burns', () => {
  const withBurn = summarize(seriesState([tok('0', 'live', ADDR), tok('1', 'burned'), tok('2', 'unminted')]));
  assert.equal(withBurn.mintedCount, 1, 'mintedCount kept its name and now means live — it used to never go down');
  assert.equal((withBurn as {burnedCount?: number}).burnedCount, 1);

  // Omitted when zero, deliberately: a project with no burns serves byte-identical JSON to before,
  // so a consumer's fixtures keep telling the truth about what actually changed.
  const noBurn = summarize(seriesState([tok('0', 'live', ADDR), tok('1', 'unminted')]));
  assert.equal(noBurn.mintedCount, 1);
  assert.equal('burnedCount' in noBurn, false);
});

test('the served state carries the lifecycle, so no consumer infers it from a sentinel address', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'burn'});
    indexer.store.putProject(seriesState([tok('0', 'live', ADDR), tok('1', 'burned'), tok('2', 'unminted')]));
    const res = await fetch(`${base}/api/project/${ADDR}`);
    const body = (await res.json()) as {tokens?: Array<{lifecycle?: string; owner?: string | null}>};
    assert.deepEqual(body.tokens?.map((t) => t.lifecycle), ['live', 'burned', 'unminted']);
    assert.equal(body.tokens?.[1].owner, null, 'a burned token has no holder — never the zero address');
  });
});
