// `abx artifacts` — the direct, typed read for a token's `artifacts` manifest. Two negative
// cases must be USEFUL RESULTS, never thrown errors (unlike `abx verify --remote`, which hard-fails
// on the same "resolver doesn't know this project" condition): a project this node never indexed, and
// a resolver that doesn't serve the project either. Both exit 0 and print a stable JSON shape so a
// caller can branch on `available`/`reason` instead of parsing an error message.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const ADDR = '0xb5D472600107a56c0A36838FFf7030A864439a30';

function mockResolver(opts: {registered: boolean}): Promise<{server: Server; port: number; seen: string[]}> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    if (!opts.registered) return json(404, {error: 'not found', code: 'not_registered'});
    if (req.url === `/api/project/${ADDR}`) return json(200, {name: 'Amber', tokens: [{tokenId: '0', lifecycle: 'live'}]});
    if (req.url?.startsWith(`/api/project/${ADDR}/artifacts`)) {
      return json(200, {
        entries: [{key: 'image', mimeType: 'image/png', uri: 'ipfs://QmCurrent'}],
        effects: [
          {key: 'render/image', effectKey: 'render', outputKey: 'image', status: 'current', inputsHash: '0xcurrent', contentType: 'image/png', uri: 'ipfs://QmCurrent'},
          {key: 'render/traits', effectKey: 'render', outputKey: 'traits', status: 'stale', inputsHash: '0xold', contentType: 'application/json', uri: 'http://node/data/render/traits'},
        ],
        planeConsulted: true,
        currentInputsHash: '0xcurrent',
      });
    }
    return json(404, {error: 'not found'});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({server, port: (server.address() as {port: number}).port, seen})));
}

// `--json` swaps ALL human narration to stderr and leaves stdout carrying exactly one JSON document
// (jsonout.ts) — so, unlike the other CLI integration tests in this directory that grep combined
// output for prose, this one parses stdout directly rather than hunting a `{` line out of a
// multi-line pretty-printed object glued to stderr narration.
function runCli(args: string[]): Promise<{code: number | null; stdout: string; stderr: string}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'sepolia',
    ABX_DATA_DIR: mkdtempSync(join(tmpdir(), 'abx-artifacts-')),
    ABX_REMOTE_SELF_TOKEN: '',
    ABX_PUBLIC_BASE_URL: '',
    ABX_NO_UPDATE_CHECK: '1',
  };
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const c = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code: c, stdout, stderr});
    });
  });
}

test('local: a project this node never indexed is a graceful not-registered result, not a thrown error', async () => {
  const {code, stdout, stderr} = await runCli(['artifacts', ADDR, '--json']);
  assert.equal(code, 0, `must NOT fail the command\n${stderr}`);
  const payload = JSON.parse(stdout);
  assert.equal(payload.surface, 'local');
  assert.equal(payload.registered, false);
  assert.equal(payload.available, false);
  assert.equal(payload.reason, 'not-registered');
  assert.deepEqual(payload.entries, []);
  assert.deepEqual(payload.effects, []);
});

test('remote: a resolver that does not serve this project is a graceful not-registered result', async () => {
  const {server, port} = await mockResolver({registered: false});
  try {
    const {code, stdout, stderr} = await runCli(['artifacts', ADDR, '--remote', `http://127.0.0.1:${port}`, '--json']);
    assert.equal(code, 0, `must NOT fail the command\n${stderr}`);
    const payload = JSON.parse(stdout);
    assert.equal(payload.surface, 'remote');
    assert.equal(payload.registered, false);
    assert.equal(payload.available, false);
    assert.equal(payload.reason, 'not-registered-on-remote');
  } finally {
    server.close();
  }
});

test('remote: current AND stale effect rows are both reported, distinctly labeled, matching the resolver verbatim', async () => {
  const {server, port, seen} = await mockResolver({registered: true});
  try {
    const {code, stdout, stderr} = await runCli(['artifacts', ADDR, '--remote', `http://127.0.0.1:${port}`, '--json']);
    assert.equal(code, 0, stderr);
    const payload = JSON.parse(stdout);
    assert.equal(payload.surface, 'remote');
    assert.equal(payload.available, true);
    assert.equal(payload.currentInputsHash, '0xcurrent');
    assert.deepEqual(payload.entries, [{key: 'image', mimeType: 'image/png', uri: 'ipfs://QmCurrent'}]);
    assert.equal(payload.effects.length, 2);
    assert.equal(payload.effects.find((e: {key: string}) => e.key === 'render/image').status, 'current');
    assert.equal(payload.effects.find((e: {key: string}) => e.key === 'render/traits').status, 'stale');
    assert.ok(seen.some((s) => s.startsWith(`GET /api/project/${ADDR}/artifacts`)), `the artifacts route must be consulted, saw ${JSON.stringify(seen)}`);
  } finally {
    server.close();
  }
});
