// `GET /api/project/:addr/artifacts?token=<id>` — the served half of the artifact-manifest read.
//
// `abx artifacts --remote` asks a resolver this question. The reference resolver has to answer it,
// or a self-hosted node is the one topology where the command silently degrades: the CLI's remote
// lane reports a 404 gracefully, so a missing route looks like "this project has no artifacts"
// rather than "this node is too old to say". These tests pin the shape a client may rely on, and
// the three negative answers that are NOT "no artifacts": bad shape, unknown token, burned token.
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
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-artifacts-')));
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

const tok = (tokenId: string, lifecycle: string, owner: string | null = null) => ({
  tokenId,
  lifecycle,
  owner,
  tokenURI: null,
  fields: [],
  lockedFields: [],
});

function seriesState(tokens: unknown[]): ProjectState {
  return {
    address: ADDR,
    chainId: CHAIN_ID,
    abxVersion: 2,
    deployBlock: '100',
    deployTx: null,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: 'Artifacts',
    symbol: 'ART',
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
    contractType: 'series',
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

async function withProject(run: (base: string) => Promise<void>): Promise<void> {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'artifacts'});
    indexer.store.putProject(seriesState([tok('0', 'live', ADDR), tok('1', 'burned'), tok('2', 'unminted')]));
    await run(base);
  });
}

test('a live token answers with the manifest shape the remote lane consumes', async () => {
  await withProject(async (base) => {
    const res = await fetch(`${base}/api/project/${ADDR}/artifacts?token=0`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    // The CLI's remote lane destructures exactly these — a rename here is a client break.
    assert.ok(Array.isArray(body.entries), 'entries must be an array');
    assert.ok(Array.isArray(body.effects), 'effects must be an array');
    assert.ok('currentInputsHash' in body, 'currentInputsHash must be present (null is a real answer)');
  });
});

test('artifacts is per-token: a missing or non-numeric ?token is a 400 about the SHAPE, not a 404', async () => {
  await withProject(async (base) => {
    for (const q of ['', '?token=', '?token=abc', '?token=1.5', '?token=-1']) {
      const res = await fetch(`${base}/api/project/${ADDR}/artifacts${q}`);
      assert.equal(res.status, 400, `"${q}" should be 400, not 404 — the route exists, the call was malformed`);
      const body = (await res.json()) as {code?: string};
      assert.equal(body.code, 'invalid_request');
    }
  });
});

test('an unknown token id reuses the metadata routes own not_registered answer', async () => {
  await withProject(async (base) => {
    const res = await fetch(`${base}/api/project/${ADDR}/artifacts?token=99`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as {code?: string};
    // Not a new code: `unknown_token` is not in ServiceErrorCode, and that union is compiler-coupled
    // to the hosted service. The metadata routes already answer this condition this way.
    assert.equal(body.code, 'not_registered');
  });
});

test('a burned 721 is 410 here too — an empty manifest would read as "nothing rendered yet"', async () => {
  await withProject(async (base) => {
    const res = await fetch(`${base}/api/project/${ADDR}/artifacts?token=1`);
    assert.equal(res.status, 410);
    const body = (await res.json()) as {code?: string; burned?: boolean};
    assert.equal(body.code, 'burned');
    assert.equal(body.burned, true);
  });
});

test('an unindexed contract is a statement about the CONTRACT, not the token', async () => {
  await withNode(async (base) => {
    const res = await fetch(`${base}/api/project/${ADDR}/artifacts?token=0`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as {code?: string};
    assert.equal(body.code, 'not_registered');
  });
});

test('the unknown-route listing advertises artifacts, so a client can discover it', async () => {
  await withNode(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as {routes?: string[]};
    assert.ok(body.routes?.includes('/api/project/:address/artifacts'), 'route listing must include artifacts');
  });
});
