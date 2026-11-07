import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';
import {resolveChain, type ProjectState} from '@artblocks/abx-sdk';
import type {StorageBackend} from '@artblocks/abx-storage';
import {createTokenApiServer} from '../src/server.js';

const chainId = resolveChain(process.env.ABX_CHAIN).id;
const address = '0x0123456789012345678901234567890123456789';
const doc = '<!doctype html><p>collection document</p>';
const path = `/t/${chainId}/${address}/0/data/animation_url`;
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
    read: (path: string, host?: string, method?: string) => Promise<{status: number; headers: Record<string, unknown>; body: string}>,
  ) => Promise<void>,
) {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-content-origin-')));
  store.putProject(state);
  const server = createTokenApiServer({
    indexer: new SelfHostIndexer(store),
    port: 0,
    baseUrl: 'https://resolver.test',
    contentDomain: domain,
    storage,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const read = (path: string, host = 'resolver.test', method = 'GET') =>
    new Promise<{status: number; headers: Record<string, unknown>; body: string}>((resolve, reject) => {
      const req = request({hostname: '127.0.0.1', port, path, method, headers: {host}}, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (part) => {
          body += part;
        });
        res.on('end', () => resolve({status: res.statusCode!, headers: res.headers, body}));
      });
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
    assert.equal(old.headers.location, `https://${chainId}-${address}.content.test${path}`);
    const direct = await read(path, `${chainId}-${address}.content.test`);
    assert.equal(direct.status, 200);
    assert.equal(direct.body, doc);
    assert.equal(direct.headers['content-security-policy'], undefined);
    for (const p of ['/v1/projects', '/d/1/foo', '/api/projects', '/device', path.replace(`/${chainId}/`, '/1/')]) {
      assert.equal((await read(p, `${chainId}-${address}.content.test`)).status, 404, p);
    }
    assert.equal((await read(path, `${chainId}-${address}.content.test`, 'POST')).status, 404);
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
