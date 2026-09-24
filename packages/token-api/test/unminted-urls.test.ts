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

const token = (tokenId: string, lifecycle: 'live' | 'unminted') => ({
  tokenId,
  lifecycle,
  owner: lifecycle === 'live' ? ADDR : null,
  tokenURI: null,
  fields: [],
  lockedFields: [],
});

function seriesState(): ProjectState {
  return {
    address: ADDR,
    chainId: CHAIN_ID,
    abxVersion: 2,
    deployBlock: '100',
    deployTx: null,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: 'Pending Works',
    symbol: 'PEND',
    owner: ADDR,
    contractURI: null,
    royalty: null,
    maxRoyaltyBps: 1000,
    burnable: false,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    collectionFields: [],
    lockedCollectionFields: [],
    contractType: 'series',
    maxInvocations: '3',
    extensions: [],
    // Token 1 is an explicit folded row. Token 2 is absent and synthesized from maxInvocations.
    tokens: [token('0', 'live'), token('1', 'unminted')],
    events: [],
    fromBlock: '100',
    toBlock: '105',
    eventCount: 0,
    reconstructedAt: '2026-09-24T00:00:00.000Z',
  } as unknown as ProjectState;
}

async function withNode(run: (base: string) => Promise<void>, state: ProjectState = seriesState()): Promise<void> {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-unminted-')));
  const indexer = new SelfHostIndexer(store);
  indexer.store.putProject(state);
  const server: Server = createTokenApiServer({indexer, port: 0, baseUrl: 'http://localhost', storage: memoryStorage()});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    await run(base);
  } finally {
    server.close();
    store.destroy();
  }
}

test('in-range unminted token metadata is a minimal lifecycle response', async () => {
  await withNode(async (base) => {
    for (const tokenId of ['1', '2']) {
      const res = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/${tokenId}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {minted: false});
    }
  });
});

test('an unminted 1/1 gets the same minimal response without an id-space cap', async () => {
  // A 1/1's id space is fixed to token 0, so its projection carries the unminted row directly
  // rather than relying on maxInvocations to synthesize it.
  const state = {
    ...seriesState(),
    contractType: '1of1',
    maxInvocations: null,
    tokens: [token('0', 'unminted')],
  } as unknown as ProjectState;
  await withNode(async (base) => {
    const metadata = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), {minted: false});
    assert.equal((await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0/image`)).status, 404);
  }, state);
});

test('unminted token image, data, and live-view routes are absent', async () => {
  await withNode(async (base) => {
    for (const path of [
      `/t/${CHAIN_ID}/${ADDR}/1/image`,
      `/t/${CHAIN_ID}/${ADDR}/1/data/animation_url`,
      `/a/${CHAIN_ID}/${ADDR}/1`,
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, `${path} should be unavailable before mint`);
      assert.deepEqual(await res.json(), {
        error: 'token 1 has not been minted',
        code: 'not_minted',
        minted: false,
      });
    }
  });
});

test('minted tokens keep full metadata and image responses', async () => {
  await withNode(async (base) => {
    const metadata = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`);
    assert.equal(metadata.status, 200);
    const json = (await metadata.json()) as Record<string, unknown>;
    assert.equal(json.name, 'Pending Works #0');
    assert.equal(typeof json.image, 'string');
    assert.equal('minted' in json, false, 'the new marker is only the unminted lifecycle response');

    const image = await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0/image`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type') ?? '', /image\/svg\+xml/);
  });
});

test('out-of-range token IDs remain not_registered 404s', async () => {
  await withNode(async (base) => {
    for (const path of [
      `/t/${CHAIN_ID}/${ADDR}/3`,
      `/t/${CHAIN_ID}/${ADDR}/3/image`,
      `/a/${CHAIN_ID}/${ADDR}/3`,
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as {code?: string}).code, 'not_registered');
    }
  });
});
