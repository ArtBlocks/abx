// The abx-effects entrypoint's argument handling. `--help` and a mistyped flag used to fall through
// to the long-running runner (HTTP server + sweep loop); these run the real entrypoint in a child
// process with an isolated cwd/data dir and a free port.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
// Resolved here, not by the child: the child runs in a temp cwd where a bare `tsx` would not resolve.
const TSX_LOADER = import.meta.resolve('tsx');

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const {port} = srv.address() as {port: number};
  await new Promise<void>((ok) => srv.close(() => ok()));
  return port;
}

function listening(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), ok(true)));
    s.once('error', () => ok(false));
  });
}

function sandbox(port: number) {
  const dir = mkdtempSync(join(tmpdir(), 'abx-effects-args-'));
  // Drop inherited ABX_* settings (RPC, storage, tokens) so the developer's own config can't change
  // what the child does; keep the rest of the environment so Node itself still launches.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ABX_')));
  const env = {
    ...inherited,
    ABX_DATA_DIR: dir,
    ABX_EFFECTS_PORT: String(port),
    ABX_RESOLVER_URL: 'http://127.0.0.1:9',
    ABX_STORAGE_BACKEND: 'fs',
  };
  return {dir, env, done: () => rmSync(dir, {recursive: true, force: true})};
}

function runOnce(args: string[], port: number) {
  const box = sandbox(port);
  try {
    return spawnSync(process.execPath, ['--import', TSX_LOADER, MAIN, ...args], {
      cwd: box.dir,
      env: box.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    box.done();
  }
}

for (const flag of ['--help', '-h']) {
  test(`abx-effects ${flag} prints usage and exits 0 without starting the runner`, async () => {
    const port = await freePort();
    const r = runOnce([flag], port);
    assert.equal(r.signal, null, `${flag} did not exit on its own (runner started?)`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: abx-effects/);
    assert.doesNotMatch(r.stdout + r.stderr, /runner up/);
    assert.equal(await listening(port), false);
  });
}

test('abx-effects rejects an unknown argument with usage and a non-zero exit', async () => {
  const port = await freePort();
  const r = runOnce(['--onec', '0xAbCd000000000000000000000000000000000001'], port);
  assert.equal(r.signal, null, 'unknown argument did not exit on its own (runner started?)');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument '--onec'/);
  assert.match(r.stderr, /usage: abx-effects/);
  assert.doesNotMatch(r.stdout + r.stderr, /runner up/);
});

test('abx-effects --once still requires an address (unchanged)', async () => {
  const port = await freePort();
  const r = runOnce(['--once'], port);
  assert.equal(r.signal, null);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: abx-effects --once <address> \[tokenId…\]/);
  assert.doesNotMatch(r.stdout + r.stderr, /runner up/);
});

test('abx-effects with no arguments still starts the runner on ABX_EFFECTS_PORT (unchanged)', async () => {
  const port = await freePort();
  const box = sandbox(port);
  const child = spawn(process.execPath, ['--import', TSX_LOADER, MAIN], {cwd: box.dir, env: box.env});
  try {
    let out = '';
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`runner did not come up:\n${out}`)), 30_000);
      const onData = (b: Buffer) => {
        out += b.toString();
        if (/runner up/.test(out)) (clearTimeout(timer), ok());
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => (clearTimeout(timer), fail(new Error(`exited ${code}:\n${out}`))));
    });
    assert.match(out, new RegExp(`port=${port}`));
    assert.equal(await listening(port), true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((ok) => (child.exitCode !== null || child.signalCode !== null ? ok(null) : child.once('exit', ok)));
    box.done();
  }
});
