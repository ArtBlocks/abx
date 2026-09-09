// `abx add --remote` against a service that DEFERS catch-up (HTTP 202 + a lifecycle state), which
// is one of the two conformant register shapes. The CLI must reproduce the same "waits, then tells
// you what happened" outcome it gives against a synchronous service — and `--no-wait` must return
// immediately while still naming the command that checks later. Fully offline: a mock service plays
// the provider, and the seeded local registration supplies the scan floor so no chain is touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const ADDR = '0xb5D472600107a56c0A36838FFf7030A864439a30';
const DEPLOY_BLOCK = '11238537';

/**
 * A mock service whose register is async: `POST /v1/projects` → 202 `backfilling`, and the status
 * route walks `backfilling` → `live` after `pollsUntilLive` reads. Records every request path so a
 * test can assert the CLI polled rather than re-POSTed.
 */
function mockAsyncService(opts: {pollsUntilLive: number; endStatus?: string; registerStatus?: string}): Promise<{server: Server; port: number; seen: string[]}> {
  const seen: string[] = [];
  let statusReads = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, {'content-type': 'application/json'});
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && req.url === '/v1/projects') {
        return json(202, {ok: true, accepted: true, project: {address: ADDR, name: null, status: opts.registerStatus ?? 'backfilling'}});
      }
      if (req.method === 'GET' && req.url === '/v1/projects') {
        return json(200, {projects: [{chainId: 11155111, address: ADDR, name: 'X', status: 'live', tokenCount: 1}]});
      }
      if (req.url?.endsWith('/status')) {
        statusReads += 1;
        const done = statusReads > opts.pollsUntilLive;
        const status = opts.registerStatus === 'failed' ? 'failed' : done ? opts.endStatus ?? 'live' : 'backfilling';
        return json(200, {
          chainId: 11155111,
          address: ADDR,
          status,
          fromBlock: DEPLOY_BLOCK,
          toBlock: done ? '11238600' : '11238560',
          headBlock: '11238600',
          eventCount: done ? 4 : 1,
          tokenCount: done ? 1 : 0,
          mintedCount: done ? 1 : 0,
          reconstructedAt: '2026-07-28T00:00:00.000Z',
          attempts: status === 'failed' ? 3 : 0,
          ...(status === 'failed' ? {error: {class: 'rpc_rate_limited', message: 'upstream RPC rate-limited; will retry'}} : {}),
        });
      }
      return json(404, {error: 'not found', code: 'invalid_request'});
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({server, port: (server.address() as {port: number}).port, seen})));
}

function seededStore(): {dataDir: string; store: SqliteStore} {
  const dataDir = mkdtempSync(join(tmpdir(), 'abx-add-async-'));
  const store = new SqliteStore(dataDir);
  new SelfHostIndexer(store).register({address: ADDR, chainKey: 'sepolia', fromBlock: DEPLOY_BLOCK, factory: null});
  return {dataDir, store};
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{code: number | null; out: string}> {
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const c = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code: c, out: `${stdout}\n${stderr}`});
    });
  });
}

function env(dataDir: string, port: number): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'sepolia',
    ABX_DATA_DIR: dataDir,
    ABX_REMOTE_PROVIDER_URL: `http://127.0.0.1:${port}`,
    ABX_REMOTE_PROVIDER_TOKEN: 'provider-key',
  };
  delete e.ABX_PUBLIC_BASE_URL;
  delete e.ABX_REMOTE_SELF_TOKEN;
  return e;
}

test('a 202 register is polled to live, and reports the SAME outcome a synchronous service gives', async () => {
  const {dataDir, store} = seededStore();
  const {server, port, seen} = await mockAsyncService({pollsUntilLive: 1});
  try {
    const {code, out} = await runCli(['add', ADDR, '--remote', 'provider'], env(dataDir, port));
    assert.equal(code, 0, `expected success; got ${code}\n${out}`);
    assert.match(out, /backfilling/, 'the deferred state is named, not hidden behind a spinner');
    assert.match(out, /4 events/, 'the final summary comes from the terminal status read');
    assert.match(out, /live/);
    // Exactly one POST: waiting is polling the status route, never re-registering.
    assert.equal(seen.filter((s) => s === 'POST /v1/projects').length, 1);
    assert.ok(seen.filter((s) => s.endsWith('/status')).length >= 2, `expected polling, saw ${JSON.stringify(seen)}`);
  } finally {
    server.close();
    store.destroy();
  }
});

test('--no-wait returns at the 202 without polling, and names the command that checks later', async () => {
  const {dataDir, store} = seededStore();
  const {server, port, seen} = await mockAsyncService({pollsUntilLive: 99});
  try {
    const {code, out} = await runCli(['add', ADDR, '--remote', 'provider', '--no-wait'], env(dataDir, port));
    assert.equal(code, 0, `expected success; got ${code}\n${out}`);
    assert.match(out, /backfilling/);
    assert.match(out, /abx status .* --remote provider/, 'a returning-early command must say how to finish the thought');
    assert.equal(seen.filter((s) => s.endsWith('/status')).length, 0, '--no-wait must not poll at all');
  } finally {
    server.close();
    store.destroy();
  }
});

test('a catch-up that ends in `failed` exits non-zero and reports the class — never a ✓ on a broken index', async () => {
  const {dataDir, store} = seededStore();
  const {server, port} = await mockAsyncService({pollsUntilLive: 1, endStatus: 'failed'});
  try {
    const {code, out} = await runCli(['add', ADDR, '--remote', 'provider'], env(dataDir, port));
    assert.notEqual(code, 0, `a failed catch-up must not exit 0\n${out}`);
    assert.match(out, /rpc_rate_limited/);
    assert.match(out, /registration is durable/, 'the registration survived — say so, or the operator re-adds pointlessly');
  } finally {
    server.close();
    store.destroy();
  }
});

// `--no-wait` means "don't block", NOT "don't tell me". When the service has ALREADY reported a
// failed catch-up there is nothing left to wait for, so it must still be an error — never a ✓ (or a
// silent exit 0) over an index that is known broken.
test('--no-wait over an ALREADY-failed catch-up still reports failure, with the cause and whose it is', async () => {
  const {dataDir, store} = seededStore();
  const {server, port} = await mockAsyncService({pollsUntilLive: 0, registerStatus: 'failed'});
  try {
    const {code, out} = await runCli(['add', ADDR, '--remote', 'provider', '--no-wait'], env(dataDir, port));
    assert.notEqual(code, 0, `a known-failed catch-up must not exit 0 even with --no-wait\n${out}`);
    assert.match(out, /rpc_rate_limited/);
    assert.match(out, /not your key, address, or chain/, 'a failure class has to say WHOSE problem it is');
    assert.doesNotMatch(out, /it now serves/, 'never claim a URL serves a project whose index failed');
    assert.doesNotMatch(out, /is catching up/, 'a terminal failure is not "catching up"');
  } finally {
    server.close();
    store.destroy();
  }
});

// `abx status --remote <name>` takes no address. Without a guard the flag itself lands in argv[0] and
// gets sent as the address path segment (a 400 from the service about "--remote" not being an address).
test('status --remote with no address lists the token\'s projects instead of treating the flag as an address', async () => {
  const {dataDir, store} = seededStore();
  const {server, port, seen} = await mockAsyncService({pollsUntilLive: 0});
  try {
    const {code, out} = await runCli(['status', '--remote', 'provider'], env(dataDir, port));
    assert.equal(code, 0, `expected the list view; got ${code}\n${out}`);
    assert.ok(
      seen.some((s) => s === 'GET /v1/projects'),
      `expected the list route, saw ${JSON.stringify(seen)}`,
    );
    assert.ok(!seen.some((s) => s.includes('--remote')), 'the flag must never reach the URL');
  } finally {
    server.close();
    store.destroy();
  }
});
