// `animation_url` is a LINK off chain, and the link has to be live.
//
// The off-chain plane used to inline on-chain animation bytes as `data:text/html;base64,…`, and then
// repeat the whole payload verbatim into the `artifacts` listing — so a multi-megabyte document shipped
// **twice** inside a JSON body marketplaces re-fetch on every view, while its sibling `image` (usually
// the smaller asset) shipped as a one-line link to this node's route. Backwards on its own logic, and
// inconsistent with the resolver's own behavior: a code project's `animation_url` has always been the
// live-view route, never a `data:` URI.
//
// Now both go through a route. Which turns a rendering question into a plumbing question — a value that
// promises bytes at a URL is a **dead link** if nothing serves that URL — so this test does it over a
// real server on a real socket rather than asserting the string and hoping.
//
// The on-chain renderer still inlines: a contract has no URL space, and that self-contained document is
// the durability floor. This is the off-chain plane alone; no contract changed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stringToHex, type Address} from 'viem';
import {resolveChain, type ProjectState} from '@artblocks/abx-sdk';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';
import type {StorageBackend, StoredContent} from '@artblocks/abx-storage';
import {createTokenApiServer} from '../src/server.js';

const CHAIN_ID = resolveChain(process.env.ABX_CHAIN).id;
const ADDR = '0xb5d472600107a56c0a36838fff7030a864439a30' as Address;
const DOC = '<html><body>the whole artwork, on chain</body></html>';

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

/** A minimal projection carrying one inline `animation_url` on token 0 — no chain calls needed, since
 *  `inline` bytes are the field value itself. */
function stateWithInlineAnimation(): ProjectState {
  return {
    address: ADDR,
    chainId: CHAIN_ID,
    abxVersion: 1,
    deployBlock: '1',
    deployTx: '0xabc',
    factory: null,
    implementation: null,
    isCanonical: true,
    name: 'Route Fixture',
    symbol: 'ROUTE',
    owner: null,
    contractURI: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: null,
    collectionFields: [],
    lockedCollectionFields: [],
    extensions: [],
    tokens: [
      {
        tokenId: '0',
        lifecycle: 'live',
        owner: null,
        tokenURI: null,
        lockedFields: [],
        fields: [{field: 'animation_url', representation: 'inline', value: stringToHex(DOC)}],
      },
    ],
    events: [],
    fromBlock: '1',
    toBlock: '2',
    eventCount: 0,
    reconstructedAt: '2026-08-17T00:00:00.000Z',
  } as unknown as ProjectState;
}

async function withNode(run: (base: string) => Promise<void>): Promise<void> {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-anim-')));
  const indexer = new SelfHostIndexer(store);
  store.putProject(stateWithInlineAnimation());
  const server = createTokenApiServer({indexer, port: 0, baseUrl: 'http://localhost', storage: memoryStorage()});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    await run(base);
  } finally {
    server.close();
    store.destroy();
  }
}

test('animation_url is a link, and following it serves the on-chain bytes as text/html', async () => {
  await withNode(async (base) => {
    const json = (await (await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`)).json()) as {
      animation_url: string;
      artifacts?: Array<{key: string; mimeType: string; uri: string}>;
    };

    // 1 · the served value is a URL, not a payload.
    assert.ok(!json.animation_url.startsWith('data:'), `expected a route, got ${json.animation_url.slice(0, 40)}…`);
    assert.match(json.animation_url, /\/data\/animation_url$/);

    // 2 · the payload appears NOWHERE in the document — not the value, not the artifacts listing. This
    //     is the duplication that made the old form cost the document twice over.
    const body = JSON.stringify(json);
    assert.ok(!body.includes('data:text/html'), 'no inlined document anywhere in the served JSON');
    const entry = json.artifacts?.find((a) => a.key === 'animation_url');
    assert.equal(entry?.uri, json.animation_url, 'the listing points at the same route, not a second copy');
    assert.equal(entry?.mimeType, 'text/html', 'the declared type still comes from the field, not the URL');

    // 3 · and the link is LIVE — the whole risk of preferring a route over bytes.
    const served = await fetch(json.animation_url.replace('http://localhost', base));
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await served.text(), DOC, 'byte-for-byte the on-chain document');
  });
});

test('provenance still says the bytes are on-chain — a link changes where they ride, not where they live', async () => {
  await withNode(async (base) => {
    const json = (await (await fetch(`${base}/t/${CHAIN_ID}/${ADDR}/0`)).json()) as {
      abx_provenance: Array<{field: string; source: string; status: string}>;
    };
    const prov = json.abx_provenance.find((p) => p.field === 'animation_url');
    assert.equal(prov?.source, 'inline');
    assert.equal(prov?.status, 'on-chain', 'serving via this node does not make on-chain content off-chain');
  });
});
