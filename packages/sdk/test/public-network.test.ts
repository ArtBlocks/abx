import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  fetchPublicContent,
  contentDestination,
  isPublicAddress,
  contentBrowserEnvironment,
  startContentProxy,
} from '../src/public-network.js';
import { publicProjectState } from '../src/public-state.js';

async function local(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}
const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

test('content destinations reject non-public IPv4, IPv6, mapped and translated address ranges', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://foo.localhost/', 'file:///tmp/test'])
    await assert.rejects(contentDestination(new URL(url)));
  const credentialed = new URL('https://example.com/');
  credentialed.username = 'dummy';
  credentialed.password = 'dummy';
  await assert.rejects(contentDestination(credentialed));
  await assert.rejects(
    contentDestination(new URL('https://mixed.test/'), {
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
  );
});

test('transport checks redirect hops and caps decompressed bytes', async () => {
  let privateHits = 0;
  const internal = await local((_req, res) => {
    privateHits++;
    res.end('private');
  });
  const entry = await local((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: internal.origin });
      res.end();
    } else {
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync('x'.repeat(2048)));
    }
  });
  try {
    const opts = { allowOrigins: [entry.origin] };
    await assert.rejects(fetchPublicContent(`${entry.origin}/redirect`, {}, opts), /public HTTP/);
    assert.equal(privateHits, 0);
    await assert.rejects(fetchPublicContent(entry.origin, {}, { ...opts, maxBytes: 1024 }), /byte limit/);
    const res = await fetchPublicContent(entry.origin, {}, { ...opts, maxBytes: 4096 });
    assert.equal((await res.text()).length, 2048);
    assert.equal(res.headers.has('content-encoding'), false);
  } finally {
    await close(entry.server);
    await close(internal.server);
  }
});

test('deadline also bounds DNS and private DNS answers never connect', async () => {
  await assert.rejects(
    fetchPublicContent('https://slow.test/', {}, { timeoutMs: 20, lookup: () => new Promise(() => {}) }),
    /timeout/i,
  );
  await assert.rejects(
    fetchPublicContent('http://private.test/', {}, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    /public HTTP/,
  );
});

test('forward proxy refuses private HTTP and CONNECT destinations, including client loopback', async () => {
  const proxy = await startContentProxy();
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(proxy.url, { path: 'http://127.0.0.1:1/' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    const connectStatus = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1', () =>
        socket.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n'),
      );
      socket.once('data', (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.once('error', reject);
    });
    assert.match(connectStatus, /^HTTP\/1.1 403/);
  } finally {
    await proxy.close();
  }
});

test('public projections omit legacy transport configuration without mutating caller state', () => {
  const state = { rpcUrl: 'https://rpc.test/DUMMY_KEY', name: 'Art' };
  assert.deepEqual(publicProjectState(state as never), { name: 'Art' });
  assert.ok(state.rpcUrl);
});

test('HTTP connects to the checked DNS answer once while preserving the requested Host', async () => {
  let host = '';
  let lookups = 0;
  const fixture = await local((req, res) => {
    host = req.headers.host ?? '';
    res.end('ok');
  });
  try {
    const url = fixture.origin.replace('127.0.0.1', 'fixture.test');
    const res = await fetchPublicContent(
      url,
      {},
      {
        allowOrigins: [url],
        lookup: async () => {
          lookups++;
          return [{ address: '127.0.0.1', family: 4 }];
        },
      },
    );
    assert.equal(await res.text(), 'ok');
    assert.equal(lookups, 1);
    assert.equal(host, new URL(url).host);
  } finally {
    await close(fixture.server);
  }
});

test('browser child environments exclude service credentials and ambient proxy bypasses', () => {
  assert.deepEqual(
    contentBrowserEnvironment({
      PATH: '/usr/bin',
      TZ: 'UTC',
      DATABASE_URL: 'DUMMY',
      ABX_EFFECTS_TOKEN: 'DUMMY',
      NO_PROXY: '*',
    }),
    { PATH: '/usr/bin', TZ: 'UTC' },
  );
});
