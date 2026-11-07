import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';
import {
  resolveChain,
  contentOriginLabel,
  projectContentPolicy,
  projectContentUrl,
  contentRouteDigest,
  type ProjectState,
} from '@artblocks/abx-sdk';
import type {StorageBackend} from '@artblocks/abx-storage';
import {createTokenApiServer} from '../src/server.js';

const chainId = resolveChain(process.env.ABX_CHAIN).id;
const address = '0x0123456789012345678901234567890123456789';
const doc = '<!doctype html><p>collection document</p>';
const path = `/t/${chainId}/${address}/0/data/animation_url`;
const host = `${contentOriginLabel({chainId, address, tokenId: '0'})}.content.test`;
const state = {
  address,
  chainId,
  contractType: '1of1',
  collectionFields: [],
  abxVersion: 1,
  deployBlock: '1',
  deployTx: '0xabc',
  factory: null,
  implementation: null,
  isCanonical: true,
  name: 'Content fixture',
  symbol: 'CONTENT',
  owner: null,
  contractURI: null,
  tokenURIRenderer: null,
  tokenURILocked: false,
  contractURIRenderer: null,
  contractURILocked: false,
  royalty: null,
  lockedCollectionFields: [],
  extensions: [],
  tokens: [
    {
      tokenId: '0',
      lifecycle: 'live',
      owner: null,
      tokenURI: null,
      fields: [{field: 'animation_url', representation: 'inline', value: `0x${Buffer.from(doc).toString('hex')}`}],
      lockedFields: [],
    },
  ],
  events: [],
  fromBlock: '1',
  toBlock: '2',
  eventCount: 0,
  reconstructedAt: '2026-11-06T00:00:00.000Z',
} as unknown as ProjectState;
const storage = {id: 'memory', get: async () => null, has: async () => false} as unknown as StorageBackend;

async function fixture(
  domain: string | undefined,
  run: (
    read: (
      path: string,
      host?: string,
      method?: string,
      destination?: string,
    ) => Promise<{status: number; headers: Record<string, unknown>; body: string}>,
  ) => Promise<void>,
  project = state,
) {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-content-origin-')));
  store.putProject(project);
  const server = createTokenApiServer({
    indexer: new SelfHostIndexer(store),
    port: 0,
    baseUrl: 'https://resolver.test',
    contentDomain: domain,
    fetchContent: globalThis.fetch,
    storage,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const read = (path: string, host = 'resolver.test', method = 'GET', destination?: string) =>
    new Promise<{status: number; headers: Record<string, unknown>; body: string}>((resolve, reject) => {
      const req = request(
        {hostname: '127.0.0.1', port, path, method, headers: {host, ...(destination ? {'sec-fetch-dest': destination} : {})}},
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            body += part;
          });
          res.on('end', () => resolve({status: res.statusCode!, headers: res.headers, body}));
        },
      );
      req.on('error', reject);
      req.end();
    });
  try {
    await run(read);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.destroy();
  }
}

test('configured content hosts serve exact artifact bytes and old routes redirect', async () => {
  await fixture('content.test', async (read) => {
    const old = await read(path);
    assert.equal(old.status, 302);
    assert.equal(old.headers.location, `https://${host}${path}`);
    const direct = await read(path, host);
    assert.equal(direct.status, 200);
    assert.equal(direct.body, doc);
    assert.equal(direct.headers['content-security-policy'], undefined);
    for (const p of ['/v1/projects', '/d/1/foo', '/api/projects', '/device', path.replace(`/${chainId}/`, '/1/')]) {
      assert.equal((await read(p, host)).status, 404, p);
    }
    assert.equal((await read(path, host, 'POST')).status, 404);
    const descriptor = JSON.parse((await read('/.well-known/abx-service')).body);
    assert.equal(descriptor.content.domain, 'content.test');
  });
});

test('self-hosted documents have opaque origins when no content domain is configured', async () => {
  await fixture(undefined, async (read) => {
    const result = await read(path);
    assert.equal(result.status, 200);
    assert.equal(result.body, doc);
    assert.match(String(result.headers['content-security-policy']), /sandbox allow-scripts/);
    assert.equal(String(result.headers['content-security-policy']).includes('allow-same-origin'), false);
  });
});

test('live-view HTTP responses distinguish browser navigation from marketplace downloads', async () => {
  await fixture(
    'content.test',
    async (read) => {
      const live = `/a/${chainId}/${address}/0?mode=1`;
      const target = projectContentUrl(projectContentPolicy('https://resolver.test', 'content.test'), live);
      const download = await read(live);
      assert.equal(download.status, 200);
      assert.match(download.body, /<iframe /);
      assert.equal(download.headers.vary, 'Sec-Fetch-Dest');
      const navigation = await read(live, 'resolver.test', 'GET', 'document');
      assert.equal(navigation.status, 302);
      assert.equal(navigation.headers.location, target);
      assert.equal(navigation.headers.vary, 'Sec-Fetch-Dest');
      const frame = await read(live, 'resolver.test', 'GET', 'iframe');
      assert.equal(frame.status, 200);
      assert.match(frame.body, /<iframe /);
    },
    {...state, contractType: 'code', script: {chunkCount: 1, locked: false, digest: null}} as ProjectState,
  );
});

test('default localhost effects transport can read control data with a local content domain', async () => {
  await fixture('localhost:8787', async (read) => {
    const host = 'localhost:8787';
    assert.equal((await read('/.well-known/abx-service', host)).status, 200);
    const result = await read(`/api/project/${address}`, host);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).address, address);
    assert.equal((await read('/api/projects', `${chainId}-${address}.localhost:8787`)).status, 404);
  });
});

test('token hash lookups survive restart and remain isolated within one collection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-root-index-'));
  const original = new SqliteStore(dir);
  original.putProject({...state, tokens: [...state.tokens, {...state.tokens[0], tokenId: '1'}]});
  const oldDb = new DatabaseSync(original.path);
  oldDb.exec('UPDATE tokens SET content_digest=NULL'); // Simulate the projection before this upgrade.
  oldDb.close();
  const reopened = new SqliteStore(dir);
  try {
    for (const tokenId of ['0', '1'])
      assert.deepEqual(reopened.getContentRoute(contentRouteDigest({chainId, address, tokenId})), {chainId, address, tokenId});
    reopened.dropProjection(address);
    assert.equal(reopened.getContentRoute(contentRouteDigest({chainId, address, tokenId: '0'})), null);
  } finally {
    reopened.destroy();
    original.destroy();
  }
  await fixture('content.test', async (read) => {
    assert.equal((await read(path.replace('/0/', '/1/'), host)).status, 404);
    assert.equal((await read('/', `${contentOriginLabel({chainId, address, tokenId: '999'})}.content.test`)).status, 404);
    const legacy = await read(path, `${chainId}-${address}.content.test`);
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.location, `https://${host}${path}`);
    const root = await read('/?mode=1', host);
    assert.equal(root.status, 404); // This image-only project has no executable live view.
    assert.equal((await read('/api/projects', host)).status, 404);
  });
});

test('self-hosted token roots serve executable documents without a prior resolver visit', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><head></head><body id="root-document">live</body></html>');
  try {
    await fixture(
      'content.test',
      async (read) => {
        const result = await read('/?mode=1', host);
        assert.equal(result.status, 200);
        assert.match(result.body, /id="root-document"/);
        assert.match(result.body, /"tokenId":"0"/);
        assert.equal(result.headers['content-security-policy'], undefined);
        assert.equal((await read(path.replace('/0/', '/1/'), host)).status, 404);
      },
      {
        ...state,
        contractType: 'code',
        collectionFields: [
          {field: 'code', representation: 'url', value: `0x${Buffer.from('https://root-fixture.example/build').toString('hex')}`},
        ],
      } as ProjectState,
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});
