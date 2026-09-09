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
const SEPOLIA_CHAIN_ID = 11155111;

interface Captured {
  url: string;
  auth: string | undefined;
  body: {chainId?: number; fromBlock?: string};
}

/** A mock resolver capturing the control-plane POST; answers the register shape on any path. */
function mockResolver(sink: Captured[]): Promise<{server: Server; port: number}> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sink.push({url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw || '{}')});
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true, mode: 'full', elapsedMs: 1, project: {address: ADDR, name: 'X', eventCount: 0, tokenCount: 0, mintedCount: 0}}));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({server, port: (server.address() as {port: number}).port})));
}

/** Seed a temp store with exactly what a deploy stores: a registration whose floor IS the deploy block. */
function seededStore(): {dataDir: string; store: SqliteStore} {
  const dataDir = mkdtempSync(join(tmpdir(), 'abx-add-'));
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

// THE regression. `abx add <addr> --remote <url>` with NO --from-block must FORWARD the deploy
// block the local deploy already stored — not drop it (which defaulted the hosted resolver to
// genesis and sent it scanning ~11M Sepolia blocks: the "resolver won't index" failure that got
// mis-diagnosed as an RPC limit). Fully offline: the local registration provides the floor, so the
// CLI never touches a chain; a mock resolver captures the control-plane POST body.
test('abx add --remote forwards the locally-stored deploy block when --from-block is omitted', async () => {
  const {dataDir, store} = seededStore();
  const captured: Captured[] = [];
  const {server, port} = await mockResolver(captured);
  try {
    // ABX_DATA_DIR points the CLI at the seeded store. The subprocess env overrides matter more than
    // any repo .env (loadDotEnv only fills UNSET keys), but ABX_PUBLIC_BASE_URL is stripped so the
    // resolver URL can only come from --remote.
    const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia', ABX_DATA_DIR: dataDir, ABX_REMOTE_SELF_TOKEN: 'test-token'};
    delete env.ABX_PUBLIC_BASE_URL;
    const {code, out} = await runCli(['add', ADDR, '--remote', `http://127.0.0.1:${port}`], env);
    assert.equal(code, 0, `expected success; got ${code}\n${out}`);
    assert.equal(captured.length, 1, 'the resolver never received the control-plane POST');
    const req = captured[0];
    assert.equal(req.url, '/v1/projects'); // the versioned, role-neutral control plane
    assert.equal(req.auth, 'Bearer test-token');
    assert.equal(req.body.chainId, SEPOLIA_CHAIN_ID); // chain-explicit — the server validates it
    assert.equal(req.body.fromBlock, DEPLOY_BLOCK, `expected fromBlock ${DEPLOY_BLOCK} to be forwarded, got ${req.body.fromBlock}`);
  } finally {
    server.close();
    store.destroy();
  }
});

// The named-remote lane: `--remote staging` resolves ABX_REMOTE_STAGING_URL/_TOKEN — and must use
// the NAMED token, never fall back to ABX_REMOTE_SELF_TOKEN (a provider must never silently
// receive your own node's secret).
test('abx add --remote <name> resolves ABX_REMOTE_<NAME>_URL/_TOKEN and sends the NAMED token', async () => {
  const {dataDir, store} = seededStore();
  const captured: Captured[] = [];
  const {server, port} = await mockResolver(captured);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ABX_CHAIN: 'sepolia',
      ABX_DATA_DIR: dataDir,
      ABX_REMOTE_STAGING_URL: `http://127.0.0.1:${port}`,
      ABX_REMOTE_STAGING_TOKEN: 'staging-key',
      ABX_REMOTE_SELF_TOKEN: 'self-secret', // must NOT be what the provider receives
    };
    delete env.ABX_PUBLIC_BASE_URL;
    const {code, out} = await runCli(['add', ADDR, '--remote', 'staging'], env);
    assert.equal(code, 0, `expected success; got ${code}\n${out}`);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, '/v1/projects');
    assert.equal(captured[0].auth, 'Bearer staging-key');
  } finally {
    server.close();
    store.destroy();
  }
});
