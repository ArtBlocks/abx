// `abx verify <addr>` (the LOCAL lane, no `--remote`) used to fail fast with a correct message —
// but that message never named `--remote <name>` as the alternative for a project a resolver
// already serves. A cold-agent sweep followed the old message literally (`abx add <addr>`) on a
// project that was actually meant to be checked against a hosted resolver, and THAT command is the
// one with no fail-fast guard: it walked straight into a full historical log scan on a public RPC
// and died to repeated HTTP 429s — minutes wasted, reading like an outage.
//
// This pins two things: (1) the unregistered path still fails BEFORE any scan, now naming both
// `abx add <addr>` and `--remote <name>`; (2) a REGISTERED project is unaffected — it still reaches
// the reindex branch (proven by a *different* failure, an unreachable RPC, rather than the
// "isn't registered" message this change edited).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const ADDR = '0xb5D472600107a56c0A36838FFf7030A864439a30';

function runCli(args: string[], dataDir: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'sepolia',
    ABX_DATA_DIR: dataDir,
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

test('verify on an UNREGISTERED project fails fast (no scan) and names BOTH `abx add` and `--remote <name>`', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abx-verify-local-'));
  // No `abx add` ever ran against this data dir — the store has no registration for ADDR at all.
  const {code, out} = await runCli(['verify', ADDR], dataDir);
  assert.notEqual(code, 0, `an unregistered project must fail the command\n${out}`);
  assert.match(out, new RegExp(`abx add ${ADDR}`), 'must name the local fix');
  assert.match(out, /--remote <name>/, 'must name the remote alternative — the gap that let an agent scan-then-429 by following the OLD message literally');
  // The scan-avoidance claim: an indexer that ever reached `reconstructProject` against a live
  // Sepolia RPC (see clients.ts) with no override configured would take real network time and could
  // itself surface a `429`/timeout — neither of which is the message asserted above. Its absence
  // here is the fail-fast proof.
  assert.doesNotMatch(out, /429|Too Many Requests|ETIMEDOUT/, 'must not have attempted any RPC scan at all');
});

test('verify on a REGISTERED project is UNCHANGED: it still reaches reindex, never the "isn\'t registered" message', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abx-verify-local-reg-'));
  // Seed a registration directly (no live chain needed to prove which BRANCH `cmdVerifyBody` takes)
  // — mirrors packages/indexer/test's own idiom of writing straight to the store.
  const indexer = new SelfHostIndexer(new SqliteStore(dataDir));
  indexer.register({address: ADDR, chainKey: 'sepolia', fromBlock: '9999999999', factory: null});
  // Point Sepolia at a port nothing listens on: `reindex()` reaches a real client call and fails
  // FAST (connection refused) with an error distinct from the registration guard's message — proof
  // this run took the `reindex` branch, not the early-throw one, exactly as before this change.
  const {code, out} = await runCli(['verify', ADDR], dataDir, {ABX_RPC_URLS_SEPOLIA: 'http://127.0.0.1:1'});
  assert.notEqual(code, 0, `an unreachable RPC must still fail the command\n${out}`);
  assert.doesNotMatch(out, /isn't registered on this node/, 'a REGISTERED project must never see the unregistered-path message');
});
