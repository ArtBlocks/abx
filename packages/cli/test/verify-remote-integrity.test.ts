// `abx verify <addr> --remote` has to answer TWO different questions and never let one stand in for
// the other: (1) are the RENDERS current, and (2) do the served BYTES still hash to the on-chain
// commitment. A cold-agent review caught the second one being skipped while a green ✓ from the first
// implied it had passed — on a project whose bytes genuinely did not match. That is the worst possible
// direction for this command to be wrong in, so it is pinned here.
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

/** A resolver that serves one minted token and answers the credentialed verify route however the
 *  test wants (`verified`), plus the effects report for a project with no renders. */
function mockResolver(opts: {verified: boolean | 'unauthorized' | 'missing'}): Promise<{server: Server; port: number; seen: string[]}> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    if (req.url === `/api/project/${ADDR}`) return json(200, {name: 'Amber', tokens: [{tokenId: '0', lifecycle: 'live'}]});
    if (req.url === '/api/watch') return json(200, {watching: false, intervalMs: 0, pollAt: null, lastDeltaAt: null, chains: {}});
    if (req.url === `/api/project/${ADDR}/effects`) {
      // a static-image project: nothing to render, so the render lane has nothing to report
      return json(200, {counts: {upToDate: 0, stale: 0, rendering: 0, failed: 0}, tokens: []});
    }
    if (req.url === `/api/project/${ADDR}/verify`) {
      if (opts.verified === 'unauthorized') return json(401, {error: 'unauthorized', code: 'unauthorized'});
      if (opts.verified === 'missing') return json(404, {error: 'not found'});
      if (!req.headers.authorization) return json(401, {error: 'unauthorized', code: 'unauthorized'});
      return json(200, {tokens: [{tokenId: '0', checks: [{kind: 'keccak256', committed: '0xabc', verified: opts.verified}]}]});
    }
    return json(404, {error: 'not found'});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({server, port: (server.address() as {port: number}).port, seen})));
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{code: number | null; out: string; stdout: string}> {
  // Empty, not deleted: the CLI fills UNSET keys from the repo's own .env, which would hand the
  // "no credential" case a real token and quietly invalidate it (the same env-bleed that invalidates
  // a sandbox sweep run).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'sepolia',
    ABX_DATA_DIR: mkdtempSync(join(tmpdir(), 'abx-vr-')),
    ABX_REMOTE_SELF_TOKEN: '',
    ABX_PUBLIC_BASE_URL: '',
    ...extraEnv,
  };
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const c = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      // `stdout` kept SEPARATE (not just folded into `out`) so a `--json` test can `JSON.parse` it
      // directly — under `withJson`, human narration is routed to stderr and stdout carries exactly
      // one JSON document, so mixing the two back together (as `out` does, for the prose assertions
      // every other test here makes) would break the parse.
      res({code: c, out: `${stdout}\n${stderr}`, stdout});
    });
  });
}

test('a byte MISMATCH on a remote is reported and FAILS the command, even with renders "fine"', async () => {
  const {server, port, seen} = await mockResolver({verified: false});
  try {
    const {code, out} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--remote-token', 'k']);
    assert.notEqual(code, 0, `an integrity mismatch must fail the command\n${out}`);
    assert.match(out, /BYTE MISMATCH/);
    assert.doesNotMatch(out, /✓ nothing to render/, 'a render summary must never stand in for byte integrity');
    assert.ok(seen.some((s) => s.endsWith('/verify')), `the credentialed verify route must be consulted, saw ${JSON.stringify(seen)}`);
  } finally {
    server.close();
  }
});

test('bytes that hash-match report ✓ and exit 0 — no false alarm on a healthy project', async () => {
  const {server, port} = await mockResolver({verified: true});
  try {
    const {code, out} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--remote-token', 'k']);
    assert.equal(code, 0, `a healthy project must not fail\n${out}`);
    assert.match(out, /hash-match their on-chain commitment/);
  } finally {
    server.close();
  }
});

test('with no credential (or an older node) it says byte integrity was NOT checked, rather than implying it passed', async () => {
  for (const [label, args, mock] of [
    ['no token', ['verify', ADDR, '--remote', 'PORT'], {verified: true as const}],
    ['rejected', ['verify', ADDR, '--remote', 'PORT', '--remote-token', 'k'], {verified: 'unauthorized' as const}],
    ['no route', ['verify', ADDR, '--remote', 'PORT', '--remote-token', 'k'], {verified: 'missing' as const}],
  ] as const) {
    const {server, port} = await mockResolver(mock);
    try {
      const {out} = await runCli(args.map((a) => (a === 'PORT' ? `http://127.0.0.1:${port}` : a)));
      assert.match(out, /byte integrity NOT checked/, `${label}: must not leave the ✓ implying integrity`);
    } finally {
      server.close();
    }
  }
});

// ── `--remote --json` integrity reporting ────────────────────────────────────────────────────────
//
// `abx verify --remote <r> --json` used to route AROUND `withJson` entirely: `cmdVerify` called
// `cmdVerifyRemote(address, remote)` directly and returned, so `--json` was silently ignored —
// stdout carried the same human prose as without the flag, and a caller parsing it as JSON got a
// syntax error. These pin the fix: stdout is a single JSON document, shaped like the local lane's
// (`ok`/`contentIntegrity`/`availability`), for every byte-integrity outcome the mock resolver above
// already covers.

test('--remote --json: a byte MISMATCH still emits JSON on stdout (ok:false, contentIntegrity:"mismatch")', async () => {
  const {server, port} = await mockResolver({verified: false});
  try {
    const {code, stdout} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--remote-token', 'k', '--json']);
    assert.notEqual(code, 0);
    const payload = JSON.parse(stdout) as {ok: boolean; contentIntegrity: string; availability: {status: string}};
    assert.equal(payload.ok, false);
    assert.equal(payload.contentIntegrity, 'mismatch');
  } finally {
    server.close();
  }
});

test('--remote --json: a healthy project emits JSON with ok:true, contentIntegrity:"ok"', async () => {
  const {server, port} = await mockResolver({verified: true});
  try {
    const {code, stdout} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--remote-token', 'k', '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout) as {ok: boolean; contentIntegrity: string; address: string; remote: string};
    assert.equal(payload.ok, true);
    assert.equal(payload.contentIntegrity, 'ok');
    assert.equal(payload.address.toLowerCase(), ADDR.toLowerCase());
  } finally {
    server.close();
  }
});

test('--remote --json: no credential emits JSON with contentIntegrity:"not-checked" — a THIRD state, never collapsed into "ok" or "mismatch"', async () => {
  const {server, port} = await mockResolver({verified: true});
  try {
    // No --remote-token: the credentialed verify route is never even asked.
    const {code, stdout} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--json']);
    assert.equal(code, 0); // not-checked must not fail the command — it isn't a finding either way
    const payload = JSON.parse(stdout) as {ok: boolean; contentIntegrity: string};
    assert.equal(payload.contentIntegrity, 'not-checked');
    assert.equal(payload.ok, true);
  } finally {
    server.close();
  }
});

test('--remote --json: renders + availability are present in the payload, same shape as the local lane', async () => {
  const {server, port} = await mockResolver({verified: true});
  try {
    const {stdout} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--remote-token', 'k', '--json']);
    const payload = JSON.parse(stdout) as {renders: unknown; availability: {status: string; note: string}};
    assert.ok(payload.renders, 'renders must be present in the JSON payload');
    assert.ok(payload.availability?.status, 'availability must be present in the JSON payload');
  } finally {
    server.close();
  }
});

// A run that never got to check anything must NOT print `"ok": true`.
//
// Caught by a cold-agent sweep: `verify <unregistered> --remote --json` printed `"ok": true` on
// stdout while exiting 1 and saying "register it first" on stderr. The payload is built and handed
// to `emit` up front, then MUTATED as facts arrive and printed in its final state — so a path that
// throws (a 404, a dead endpoint) left the optimistic initial `true` standing. `ok` is documented as
// the field CI gates on, which makes an un-earned `true` the one answer this command must never
// give: "could not check" is not "fine". Fixed by initializing fail-closed; every terminal path now
// states its own verdict.
test('verify --remote --json on an UNREGISTERED project never claims ok, and agrees with its exit code', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'not_registered'}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as {port: number}).port;
  try {
    const {code, stdout, out} = await runCli(['verify', ADDR, '--remote', `http://127.0.0.1:${port}`, '--json']);
    assert.notEqual(code, 0, 'a project the resolver does not serve must fail the command');
    const doc = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as {
      ok: boolean;
      contentIntegrity: string;
    };
    assert.equal(doc.ok, false, `ok must not be true when nothing was checked (exit was ${code})`);
    assert.equal(doc.contentIntegrity, 'not-checked', 'and it must say so rather than implying "no commitments"');
    // the human lane still names the fix
    assert.match(out, /register it first/);
  } finally {
    server.close();
  }
});
