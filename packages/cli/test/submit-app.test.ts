import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import http from 'node:http';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {decodeFunctionData, encodeFunctionResult} from 'viem';
import {
  APP_RELATIONSHIP,
  FIRST_METADATA_WRITE_RETRY_DELAYS_MS,
  MAX_CALLS_PER_TX,
  SUBMIT_APP_CATALOG_NOTE,
  batchParamOps,
  buildParamOps,
  chunkItems,
  parseSubmitAppEntry,
  paramValues,
  resolveAppStoreAddresses,
  resumableConfigError,
  withFirstMetadataWriteRetry,
} from '../src/commands/submit-app.js';
import {parseFlags} from '../src/flags.js';

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts');

function helpFor(cmd: string): string {
  const out = execFileSync('node', ['--import', 'tsx', CLI, 'help', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });
  // eslint-disable-next-line no-control-regex
  return out.replace(/\[[0-9;]*m/g, '');
}

const REQUIRED = {
  name: 'Sprite Party',
  summary: 'Draw together on a shared canvas.',
  description: 'A collaborative drawing room whose strokes settle as an ABX series.',
};

function flags(extra: Record<string, string> = {}) {
  return parseFlags(
    Object.entries({...REQUIRED, ...extra}).flatMap(([k, v]) => [`--${k}`, v]),
  );
}

test('parseSubmitAppEntry requires name, summary, and description', () => {
  assert.throws(() => parseSubmitAppEntry(parseFlags(['--name', 'X'])), /missing --summary/);
  assert.throws(
    () => parseSubmitAppEntry(parseFlags(['--name', 'X', '--summary', 'Y'])),
    /missing --description/,
  );
});

test('parseSubmitAppEntry does not invent catalog copy from empty flags', () => {
  const entry = parseSubmitAppEntry(flags());
  assert.equal(entry.name, 'Sprite Party');
  assert.equal(entry.mark, 'A/');
  assert.equal(entry.tone, 'acid');
  assert.equal(entry.category, 'Create');
  assert.equal(entry.stage, 'Prototype');
  assert.equal(paramValues(entry).relationships, APP_RELATIONSHIP);
  assert.deepEqual(entry.tags, []);
});

test('parseSubmitAppEntry accepts catalog fields an agent would pass', () => {
  const entry = parseSubmitAppEntry(
    flags({
      mark: 'SP',
      tone: 'mint',
      category: 'Games',
      stage: 'Live',
      url: 'https://sprite.example',
      'url-label': 'Play',
      tags: 'draw, collab',
    }),
  );
  assert.equal(entry.mark, 'SP');
  assert.equal(entry.tone, 'mint');
  assert.equal(entry.category, 'Games');
  assert.equal(entry.url, 'https://sprite.example');
  assert.equal(entry.urlLabel, 'Play');
  assert.deepEqual(entry.tags, ['draw', 'collab']);
});

test('parseSubmitAppEntry refuses http launch URLs and unknown tones', () => {
  assert.throws(() => parseSubmitAppEntry(flags({url: 'http://insecure.example'})), /HTTPS/);
  assert.throws(() => parseSubmitAppEntry(flags({tone: 'neon'})), /--tone must be one of/);
  assert.throws(() => parseSubmitAppEntry(flags({category: 'Finance'})), /--category must be one of/);
});

test('resolveAppStoreAddresses ships Base Sepolia and allows env/flag override', () => {
  const shipped = resolveAppStoreAddresses('base-sepolia', {}, {});
  assert.match(shipped.registry, /^0x[a-fA-F0-9]{40}$/);
  assert.match(shipped.minter, /^0x[a-fA-F0-9]{40}$/);
  assert.throws(
    () => resolveAppStoreAddresses('sepolia', {}, {}),
    /No ABX App Store registry is shipped/,
  );
  const override = resolveAppStoreAddresses(
    'sepolia',
    parseFlags([
      '--registry',
      '0x1111111111111111111111111111111111111111',
      '--minter',
      '0x2222222222222222222222222222222222222222',
    ]),
    {},
  );
  assert.equal(override.registry.toLowerCase(), '0x1111111111111111111111111111111111111111');
  assert.equal(override.minter.toLowerCase(), '0x2222222222222222222222222222222222222222');
});

test('buildParamOps writes every non-empty catalog field and batches under the gas cap', () => {
  const entry = parseSubmitAppEntry(flags({url: 'https://sprite.example', tags: 'abx'}));
  const ops = buildParamOps({
    registry: '0xBD0D5eE35075E62d970467771775c630B9FB87fa',
    tokenId: 0n,
    entry,
    chainId: 84532,
  });
  assert.ok(ops.length >= 8, `expected several param writes, got ${ops.length}`);
  assert.ok(ops.every((op) => op.to === '0xBD0D5eE35075E62d970467771775c630B9FB87fa'));
  const batches = batchParamOps(ops);
  assert.ok(batches.length >= 2, 'a full listing must not be one multicall (gas cap)');
  for (const batch of batches) {
    if (batch.op === 'multicall') {
      const count = Number(batch.fields.batched);
      assert.ok(count <= MAX_CALLS_PER_TX, `batch of ${count} exceeds cap`);
    }
  }
});

test('chunkItems splits on the App Store per-tx cap', () => {
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 3), [
    [1, 2, 3],
    [4, 5],
  ]);
});

test('abx help submit-app exists and says it is not part of deploy', () => {
  const help = helpFor('submit-app');
  assert.match(help, /abx submit-app/);
  assert.match(help, /not part of deploy/i);
  assert.match(help, /--name/);
  assert.match(help, /--summary/);
  assert.match(help, /--description/);
  assert.match(help, /\/update/);
});

test('submit-app success guidance does not promise when a hosted catalog will re-read', () => {
  assert.match(SUBMIT_APP_CATALOG_NOTE, /on-chain listing is updated/);
  assert.match(SUBMIT_APP_CATALOG_NOTE, /refresh timing is provider-owned/);
  assert.doesNotMatch(SUBMIT_APP_CATALOG_NOTE, /picks it up on the next read/);
});

// ── RPC catch-up after mint ───────────────────────────────────────────────────
// `abx submit-app` mints the listing token, then immediately estimates the first metadata write
// against the same token. If the RPC answering that estimate hasn't caught up to the mint's block
// yet, the estimate reverts and (with no `gasFloor` on a param write for `pinGas` to detect it
// against — see execute.ts) used to surface instantly, with the token minted but undocumented.

test('withFirstMetadataWriteRetry: a transient estimate failure recovers within the bound', async () => {
  let calls = 0;
  const result = await withFirstMetadataWriteRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('execution reverted: token does not exist yet');
    return 'metadata-tx-hash';
  }, [0, 0, 0]); // zero delays — this test asserts attempt COUNT and outcome, not real backoff timing
  assert.equal(result, 'metadata-tx-hash');
  assert.equal(calls, 3, 'two failures then a success is exactly 3 attempts');
});

test('withFirstMetadataWriteRetry: exhausting the bound surfaces the ORIGINAL error, unwrapped', async () => {
  let calls = 0;
  const persistent = new Error('execution reverted: token does not exist yet');
  await assert.rejects(
    withFirstMetadataWriteRetry(async () => {
      calls++;
      throw persistent;
    }, [0, 0]),
    (err: Error) => {
      assert.equal(err, persistent, 'the real revert is what a caller sees — this helper never invents one');
      return true;
    },
  );
  assert.equal(calls, 3, '1 initial attempt + 2 retries, then it gives up — never unbounded');
});

test('withFirstMetadataWriteRetry: defaults to the shipped backoff schedule when none is passed', async () => {
  // Only asserts the CONTRACT (a fixed, small, backed-off bound) — never runs it for real here.
  assert.deepEqual(FIRST_METADATA_WRITE_RETRY_DELAYS_MS, [2_000, 4_000, 8_000]);
});

test('resumableConfigError: names the token id and the exact next step, keeps the real reason', () => {
  const err = resumableConfigError({tokenId: 7n, cause: new Error('execution reverted: token does not exist')});
  assert.match(err.message, /token #7/);
  assert.match(err.message, /re-running this exact command/i);
  assert.match(err.message, /skip the mint/i);
  assert.match(err.message, /token does not exist/); // the underlying reason is preserved, not swallowed
});

test('resumableConfigError: a non-Error cause still renders (String(), never [object Object])', () => {
  const err = resumableConfigError({tokenId: 1n, cause: 'rpc timeout'});
  assert.match(err.message, /rpc timeout/);
});

// ── rerunning does not mint a duplicate listing ───────────────────────────────
// `cmdSubmitApp` reads the minter's `claimed(collection)` BEFORE either lane decides whether to
// build a `submit()` tx at all (see the read block at the top of the command). These tests drive
// that exact read against a stub RPC and assert the CLI-level consequence directly: once `claimed`
// is true, no mint tx is ever prepared — `--dry-run`'s reported `approvals` count is param batches
// ONLY, never `+1` for a mint, and the human narration says "skipping mint". A rerun therefore
// cannot construct a second `submit()` call at the CLI level, independent of whatever the minter
// contract itself also enforces — its Solidity lives in a sibling repo (abx-app-store), not here,
// so this is the layer of the guarantee this repo can actually exercise.

const REGISTRY = '0xBD0D5eE35075E62d970467771775c630B9FB87fa';
const COLLECTION = '0x1111111111111111111111111111111111111111';
const OWNER_ADDR = '0x2222222222222222222222222222222222222222';

const READ_ABI = [
  {
    type: 'function',
    name: 'claimed',
    stateMutability: 'view',
    inputs: [{name: 'collection', type: 'address'}],
    outputs: [{name: '', type: 'bool'}],
  },
  {
    type: 'function',
    name: 'entryOf',
    stateMutability: 'view',
    inputs: [{name: 'collection', type: 'address'}],
    outputs: [{name: '', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{name: '', type: 'address'}],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'address'}],
  },
] as const;

/** A minimal JSON-RPC stub answering only the reads `cmdSubmitApp` makes before its dry-run
 *  branch returns — no chain id / block reads are needed on that path (`assertChainId` runs only
 *  on the live-send path, after the dry-run return). Mirrors state-rpc-errors.test.ts's `stubRpc`. */
function stubReadRpc(reads: {claimed: boolean; entryOf?: bigint; ownerOf?: `0x${string}`; owner?: `0x${string}`}) {
  return new Promise<{url: string; close: () => Promise<void>}>((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as {id?: unknown; method?: string; params?: unknown[]};
        res.setHeader('content-type', 'application/json');
        if (parsed.method !== 'eth_call') {
          res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id ?? 1, result: '0x'}));
          return;
        }
        const call = (parsed.params?.[0] ?? {}) as {to?: string; data?: `0x${string}`};
        const {functionName} = decodeFunctionData({abi: READ_ABI, data: call.data as `0x${string}`});
        let result: string;
        if (functionName === 'claimed') result = encodeFunctionResult({abi: READ_ABI, functionName, result: reads.claimed});
        else if (functionName === 'entryOf') result = encodeFunctionResult({abi: READ_ABI, functionName, result: reads.entryOf!});
        else if (functionName === 'ownerOf') result = encodeFunctionResult({abi: READ_ABI, functionName, result: reads.ownerOf!});
        else result = encodeFunctionResult({abi: READ_ABI, functionName: 'owner', result: reads.owner!});
        res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id ?? 1, result}));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as {port: number};
      resolve({url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done()))});
    });
  });
}

const execFileAsync = promisify(execFile);

/**
 * Drives `cmdSubmitApp` as a CLI SUBPROCESS (the same technique `helpFor` above already uses) rather
 * than hijacking `process.stdout.write` in-process — that raced node's own test-runner output onto
 * the same stream and produced corrupted, unparseable bytes (caught while writing this test). A
 * subprocess's stdout is fully isolated from the parent's, so that can't happen here.
 *
 * ASYNC, not `execFileSync`: the stub RPC server this drives (`stubReadRpc`) lives in-process, as an
 * `http.createServer` on the SAME event loop as this test file. `execFileSync` blocks that entire
 * event loop for as long as the child runs — including the accept() that would answer the child's
 * requests to the stub server — so the child's HTTP client sat waiting on a parent that could never
 * respond, until its own client-side timeout gave up (~41s, reproduced while writing this test). The
 * async form keeps the parent's event loop free to serve the stub while the child runs.
 */
async function runSubmitAppDryRun(rpcUrl: string): Promise<{stdout: string; stderr: string}> {
  const args = [
    '--import', 'tsx', CLI,
    'submit-app', COLLECTION,
    '--name', 'Sprite Party',
    '--summary', 'Draw together on a shared canvas.',
    '--description', 'A collaborative drawing room whose strokes settle as an ABX series.',
    '--dry-run',
    '--json',
  ];
  try {
    const {stdout, stderr} = await execFileAsync('node', args, {
      encoding: 'utf8',
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1', ABX_RPC_URLS_BASE_SEPOLIA: rpcUrl},
    });
    return {stdout, stderr};
  } catch (err) {
    const e = err as {stdout?: string; stderr?: string};
    return {stdout: e.stdout ?? '', stderr: e.stderr ?? ''};
  }
}

test('already-claimed: dry-run reports param batches only — no mint step, ever', async () => {
  const rpc = await stubReadRpc({claimed: true, entryOf: 42n, ownerOf: OWNER_ADDR});
  try {
    const {stdout, stderr} = await runSubmitAppDryRun(rpc.url);
    const payload = JSON.parse(stdout);
    assert.equal(payload.claimed, true);
    assert.equal(payload.tokenId, '42');
    assert.equal(payload.sent, false);
    const entry = parseSubmitAppEntry(
      parseFlags([
        '--name', 'Sprite Party',
        '--summary', 'Draw together on a shared canvas.',
        '--description', 'A collaborative drawing room whose strokes settle as an ABX series.',
      ]),
    );
    const ops = buildParamOps({registry: REGISTRY, tokenId: 42n, entry, chainId: 84532});
    const expectedBatches = batchParamOps(ops).length;
    assert.equal(payload.approvals, expectedBatches, 'approvals must be batches ONLY — never +1 for a mint');
    assert.match(stderr, /already listed as token #42/);
    assert.match(stderr, /skipping mint/);
  } finally {
    await rpc.close();
  }
});

test('not yet claimed: dry-run DOES count the mint as one of the approvals', async () => {
  const rpc = await stubReadRpc({claimed: false, owner: OWNER_ADDR});
  try {
    const {stdout, stderr} = await runSubmitAppDryRun(rpc.url);
    const payload = JSON.parse(stdout);
    assert.equal(payload.claimed, false);
    assert.equal(payload.tokenId, null, 'no token exists yet — nothing to report');
    const entry = parseSubmitAppEntry(
      parseFlags([
        '--name', 'Sprite Party',
        '--summary', 'Draw together on a shared canvas.',
        '--description', 'A collaborative drawing room whose strokes settle as an ABX series.',
      ]),
    );
    const ops = buildParamOps({registry: REGISTRY, tokenId: 0n, entry, chainId: 84532});
    const expectedBatches = batchParamOps(ops).length;
    assert.equal(payload.approvals, expectedBatches + 1, 'the mint IS counted when nothing is claimed yet');
    assert.doesNotMatch(stderr, /already listed/);
  } finally {
    await rpc.close();
  }
});
