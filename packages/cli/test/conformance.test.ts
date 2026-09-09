// The conformance module drives `abx remote <url> --conformance`. Two levels: unit tests of
// `runConformance` against a hand-rolled mock service
// (happy path, and a single deliberate failure), then one CLI-level check that a failed assertion
// actually sets a non-zero exit code — the contract `scripts/e2e-remote-resolver.sh` and any
// integrator's CI gate depends on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runConformance} from '../src/conformance.js';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const CHAIN_ID = 11155111; // sepolia
const ZERO_ADDR = '0x' + '0'.repeat(40);

/**
 * A minimal service that answers every probe `runConformance` makes on its UNAUTHENTICATED tier
 * conformantly by default — descriptor, the read-plane's error taxonomy (400 invalid_request / 404
 * unknown_route / 404 not_registered / unsupported_chain), and every route a declared
 * `abx-token-api/v1` interface names (all answered `404 not_registered`, a legitimate "nothing
 * indexed" rather than a bare/code-less 404). `acceptUnauthenticatedRegister` flips the ONE probe
 * this suite uses to manufacture a failing assertion: a control plane that accepts a register with
 * no bearer token, which every conforming service must refuse.
 */
function mockService(opts: {acceptUnauthenticatedRegister?: boolean} = {}): Promise<{server: Server; port: number}> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/.well-known/abx-service') {
      return send(200, {service: {name: 'mock', version: '0.0.0'}, interfaces: ['abx-token-api/v1'], chains: [CHAIN_ID]});
    }
    if (req.method === 'POST' && path === '/v1/projects') {
      if (opts.acceptUnauthenticatedRegister) {
        return send(200, {ok: true, mode: 'full', elapsedMs: 1, project: {address: ZERO_ADDR, name: null, eventCount: 0, tokenCount: 0, mintedCount: 0}});
      }
      return send(404, {error: 'control plane disabled on this node', code: 'disabled'});
    }
    if (path === '/abx-conformance-no-such-route') return send(404, {error: 'no such route', code: 'unknown_route'});
    if (/^\/t\/999999999\//.test(path)) return send(400, {error: 'chain not served', code: 'unsupported_chain', chains: [CHAIN_ID]});
    if (/^\/t\/\d+\/[^/]+$/.test(path)) {
      // the malformed shape: /t/{chainId}/{address} with the tokenId dropped
      return send(400, {error: 'missing tokenId — see /c/{chainId}/{address} for collection metadata', code: 'invalid_request'});
    }
    if (/^\/t\//.test(path) || /^\/c\//.test(path) || /^\/api\/project\//.test(path)) {
      return send(404, {error: 'not registered', code: 'not_registered'});
    }
    return send(404, {error: 'not found'});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({server, port: (server.address() as {port: number}).port})));
}

test('runConformance: a conformant unauthenticated tier reports zero failures', async () => {
  const {server, port} = await mockService();
  try {
    const report = await runConformance({baseUrl: `http://127.0.0.1:${port}`});
    assert.equal(report.failures, 0, JSON.stringify(report.assertions, null, 2));
    assert.ok(report.assertions.some((a) => a.status === 'pass' && /unauthenticated register → 401|control plane disabled/.test(a.message)));
    // no token given — the authed tiers are explicitly skipped, not silently omitted
    assert.ok(report.assertions.some((a) => a.status === 'note' && /no token/.test(a.message)));
  } finally {
    server.close();
  }
});

test('runConformance: a service that ACCEPTS an unauthenticated register is exactly one failed assertion', async () => {
  const {server, port} = await mockService({acceptUnauthenticatedRegister: true});
  try {
    const report = await runConformance({baseUrl: `http://127.0.0.1:${port}`});
    assert.equal(report.failures, 1, JSON.stringify(report.assertions, null, 2));
    const failure = report.assertions.find((a) => a.status === 'fail');
    assert.match(failure!.message, /unauthenticated POST \/v1\/projects was ACCEPTED/);
  } finally {
    server.close();
  }
});

test('runConformance: a token present but never used still resolves without error when no address is given', async () => {
  // Exercises the authed branch (GET /v1/projects) — add a route for it rather than skip the tier.
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/.well-known/abx-service') return send(200, {service: {name: 'mock'}, interfaces: ['abx-token-api/v1'], chains: [CHAIN_ID]});
    if (req.method === 'POST' && path === '/v1/projects') return send(404, {error: 'disabled', code: 'disabled'});
    if (path === '/v1/projects') return send(200, {projects: []});
    if (path === '/abx-conformance-no-such-route') return send(404, {error: 'no such route', code: 'unknown_route'});
    if (/^\/t\/999999999\//.test(path)) return send(400, {error: 'chain not served', code: 'unsupported_chain', chains: [CHAIN_ID]});
    if (/^\/t\/\d+\/[^/]+$/.test(path)) return send(400, {error: 'see /c/{chainId}/{address}', code: 'invalid_request'});
    if (/^\/t\//.test(path) || /^\/c\//.test(path) || /^\/api\/project\//.test(path)) return send(404, {error: 'not registered', code: 'not_registered'});
    return send(404, {error: 'not found'});
  });
  const port: number = await new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as {port: number}).port)));
  try {
    const report = await runConformance({baseUrl: `http://127.0.0.1:${port}`, token: 'k'});
    assert.equal(report.failures, 0, JSON.stringify(report.assertions, null, 2));
    assert.ok(report.assertions.some((a) => a.status === 'pass' && /GET \/v1\/projects with the token → 0 project/.test(a.message)));
    // no --address given — the write loop is skipped, not silently omitted
    assert.ok(report.assertions.some((a) => a.status === 'note' && /no address/.test(a.message)));
  } finally {
    server.close();
  }
});

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'sepolia',
    ABX_DATA_DIR: mkdtempSync(join(tmpdir(), 'abx-conformance-')),
    ABX_REMOTE_SELF_TOKEN: '',
    ABX_PUBLIC_BASE_URL: '',
    ...extraEnv,
  };
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const c = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code: c, out: `${stdout}\n${stderr}`});
    });
  });
}

// The exit-code contract: `abx remote <url> --conformance` must exit 0 on a clean report and
// non-zero on any failed assertion — the thing an integrator's CI gate (and
// `scripts/e2e-remote-resolver.sh`) actually depends on, not just the printed text.
test('abx remote --conformance: exit 0 with a ✓ conformant verdict against a conformant service', async () => {
  const {server, port} = await mockService();
  try {
    const {code, out} = await runCli(['remote', `http://127.0.0.1:${port}`, '--conformance']);
    assert.equal(code, 0, out);
    assert.match(out, /✓ conformant/);
  } finally {
    server.close();
  }
});

test('abx remote --conformance: non-zero exit + failure count against a non-conformant service', async () => {
  const {server, port} = await mockService({acceptUnauthenticatedRegister: true});
  try {
    const {code, out} = await runCli(['remote', `http://127.0.0.1:${port}`, '--conformance']);
    assert.notEqual(code, 0, out);
    assert.match(out, /✗ 1 conformance failure/);
    assert.match(out, /unauthenticated POST \/v1\/projects was ACCEPTED/);
  } finally {
    server.close();
  }
});
