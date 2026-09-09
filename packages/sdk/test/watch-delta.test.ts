// Multi-address getLogsAdaptive + reconstructFromLogs. No chain: a mock
// PublicClient records the getLogs / multicall shape.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters, encodeEventTopics, getAddress, type Log, type PublicClient} from 'viem';
import {
  DEFAULT_GETLOGS_ADDRESS_BATCH,
  getLogsAdaptive,
  reconstructFromLogs,
  reconstructIncremental,
  GetLogsScanTooLargeError,
} from '../src/reconstruct.js';
import {EXTENSION_ID} from '../src/spine.js';
import {spineEventAbi} from '../src/abi/index.js';
import type {ProjectState, SpineEvent} from '../src/types.js';

const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const THIRD = '0x3333333333333333333333333333333333333333' as const;
const ALICE = getAddress('0x000000000000000000000000000000000000aaaa');
const ZERO = '0x0000000000000000000000000000000000000000';
const DIGEST = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

function ev(name: string, args: Record<string, string>, block = '1', logIndex = 0): SpineEvent {
  return {
    name,
    register: 2,
    what: '',
    blockNumber: block,
    logIndex,
    txHash: `0x${logIndex.toString(16).padStart(64, '0')}`,
    args,
  };
}

function priorWithScript(digest: `0x${string}` | null = DIGEST): ProjectState {
  return {
    address: CONTRACT,
    chainId: 11155111,
    abxVersion: 5,
    deployBlock: '1',
    deployTx: '0x01',
    factory: null,
    implementation: null,
    isCanonical: null,
    name: null,
    symbol: null,
    owner: null,
    contractURI: null,
    royalty: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    collectionFields: [],
    lockedCollectionFields: [],
    extensions: [],
    tokens: [],
    script: {chunkCount: 2, locked: false, digest},
    events: [
      ev('AbxDeployed', {abxVersion: '5'}),
      ev('AbxExtensionVersionSet', {extensionId: EXTENSION_ID.onChainScript, version: '1'}, '1', 1),
    ],
    fromBlock: '1',
    toBlock: '100',
    eventCount: 2,
    reconstructedAt: new Date(0).toISOString(),
  };
}

function trackingClient(opts: {
  head?: bigint;
  getLogs?: PublicClient['getLogs'];
  answers?: Record<string, unknown>;
}): {client: PublicClient; legs: () => string[]; logCalls: () => Array<{address: unknown; from: bigint; to: bigint}>} {
  const legs: string[] = [];
  const logCalls: Array<{address: unknown; from: bigint; to: bigint}> = [];
  const answers = opts.answers ?? {};
  const client = {
    chain: {id: 11155111},
    transport: {},
    getBlockNumber: async () => opts.head ?? 100n,
    getLogs: async (args: {address: unknown; fromBlock: bigint; toBlock: bigint}) => {
      logCalls.push({address: args.address, from: args.fromBlock, to: args.toBlock});
      if (opts.getLogs) return opts.getLogs(args as never);
      return [];
    },
    multicall: async ({contracts}: {contracts: Array<{functionName: string; args?: readonly unknown[]}>}) => {
      legs.push(...contracts.map((c) => c.functionName));
      return contracts.map((c) => {
        const v = answers[c.functionName];
        if (v === undefined) return {status: 'success' as const, result: null};
        return {status: 'success' as const, result: typeof v === 'function' ? (v as (a: unknown) => unknown)(c.args?.[0]) : v};
      });
    },
    readContract: async ({functionName}: {functionName: string}) => answers[functionName] ?? null,
  } as unknown as PublicClient;
  return {client, legs: () => legs, logCalls: () => logCalls};
}

function scriptUpdatedLog(index: bigint, blockNumber: bigint): Log {
  const [topic0] = encodeEventTopics({abi: spineEventAbi, eventName: 'ScriptUpdated'} as never) as [`0x${string}`];
  return {
    address: CONTRACT,
    topics: [topic0],
    data: encodeAbiParameters([{type: 'uint256'}], [index]),
    blockNumber,
    logIndex: 0,
    transactionHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
  } as never;
}

function transferLog(blockNumber: bigint): Log {
  const topics = encodeEventTopics({
    abi: spineEventAbi,
    eventName: 'Transfer',
    args: {from: ZERO, to: ALICE, id: 0n},
  });
  return {
    address: CONTRACT,
    topics,
    data: '0x',
    blockNumber,
    logIndex: 0,
    transactionHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
  } as never;
}

test('getLogsAdaptive: a single address is one filter, not a one-element array', async () => {
  const {client, logCalls} = trackingClient({});
  await getLogsAdaptive(client, CONTRACT, 1n, 10n);
  assert.equal(logCalls().length, 1);
  assert.equal(logCalls()[0]!.address, CONTRACT);
});

test('getLogsAdaptive: splits an address list at the RPC-tier batch, not a protocol constant', async () => {
  const {client, logCalls} = trackingClient({});
  const many = Array.from({length: DEFAULT_GETLOGS_ADDRESS_BATCH + 1}, (_, i) =>
    (`0x${(i + 1).toString(16).padStart(40, '0')}`) as `0x${string}`,
  );
  await getLogsAdaptive(client, many, 1n, 10n);
  assert.equal(logCalls().length, 2);
  assert.equal((logCalls()[0]!.address as string[]).length, DEFAULT_GETLOGS_ADDRESS_BATCH);
  assert.equal(logCalls()[1]!.address, many[DEFAULT_GETLOGS_ADDRESS_BATCH]);
});

test('getLogsAdaptive: addressBatch is caller-owned (2 with 3 addresses → two filters)', async () => {
  const {client, logCalls} = trackingClient({});
  await getLogsAdaptive(client, [CONTRACT, OTHER, THIRD], 1n, 5n, {addressBatch: 2});
  assert.equal(logCalls().length, 2);
  assert.deepEqual(logCalls()[0]!.address, [CONTRACT, OTHER]);
  assert.equal(logCalls()[1]!.address, THIRD); // last batch of one is a single Address
});

test('getLogsAdaptive: empty list is a no-op', async () => {
  const {client, logCalls} = trackingClient({});
  const logs = await getLogsAdaptive(client, [], 1n, 10n);
  assert.deepEqual(logs, []);
  assert.equal(logCalls().length, 0);
});

test('getLogsAdaptive: onChunk fires once per chunk with running progress, and never for a small span', async () => {
  // 4 chunks of 3 blocks each over a 12-block span (1..12).
  const {client} = trackingClient({});
  const progress: Array<Record<string, unknown>> = [];
  await getLogsAdaptive(client, CONTRACT, 1n, 12n, {range: 3n, onChunk: (p) => progress.push(p)});
  assert.deepEqual(progress, [
    {scanned: 3n, span: 12n, scannedBlocks: 3n, blockSpan: 12n, addressBatch: 0, addressBatches: 1},
    {scanned: 6n, span: 12n, scannedBlocks: 6n, blockSpan: 12n, addressBatch: 0, addressBatches: 1},
    {scanned: 9n, span: 12n, scannedBlocks: 9n, blockSpan: 12n, addressBatch: 0, addressBatches: 1},
    {scanned: 12n, span: 12n, scannedBlocks: 12n, blockSpan: 12n, addressBatch: 0, addressBatches: 1},
  ]);

  // Below the CLI's own "worth telling a human about" threshold, no onChunk plumbing
  // exists to skip (a caller decides whether/how to throttle; this only proves it's WIRED).
  const small: Array<unknown> = [];
  await getLogsAdaptive(client, CONTRACT, 1n, 2n, {onChunk: (p) => small.push(p)});
  assert.equal(small.length, 1, 'a single-chunk scan still reports its one chunk — throttling is the caller\'s job, not this function\'s');
});

test('getLogsAdaptive: progress is globally monotonic across address batches', async () => {
  const {client} = trackingClient({});
  const progress: Array<{scanned: bigint; span: bigint; addressBatch: number; addressBatches: number}> = [];
  await getLogsAdaptive(client, [CONTRACT, OTHER, THIRD], 1n, 4n, {
    range: 2n,
    addressBatch: 2,
    onChunk: (p) => progress.push(p),
  });
  assert.deepEqual(progress.map(({scanned, span, addressBatch, addressBatches}) => ({scanned, span, addressBatch, addressBatches})), [
    {scanned: 2n, span: 8n, addressBatch: 0, addressBatches: 2},
    {scanned: 4n, span: 8n, addressBatch: 0, addressBatches: 2},
    {scanned: 6n, span: 8n, addressBatch: 1, addressBatches: 2},
    {scanned: 8n, span: 8n, addressBatch: 1, addressBatches: 2},
  ]);
});

test('getLogsAdaptive: a range rejection shrinks the window and retries', async () => {
  let attempts = 0;
  const {client, logCalls} = trackingClient({
    getLogs: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('block range too large');
      return [];
    },
  });
  await getLogsAdaptive(client, CONTRACT, 1n, 10n);
  assert.ok(logCalls().length >= 2);
  assert.ok(logCalls()[1]!.to - logCalls()[1]!.from < logCalls()[0]!.to - logCalls()[0]!.from);
});

test('getLogsAdaptive: refuses a grind over the chunk cap before spending it', async () => {
  const {client} = trackingClient({});
  await assert.rejects(
    () => getLogsAdaptive(client, CONTRACT, 1n, 10_000n, {range: 1n, maxChunks: 2}),
    GetLogsScanTooLargeError,
  );
});

test('reconstructFromLogs: does not getLogs, stamps the caller toBlock, merges the delta', async () => {
  const {client, logCalls} = trackingClient({head: 500n});
  const prior = priorWithScript();
  const state = await reconstructFromLogs(client, prior, [transferLog(150n)], {toBlock: 200n});
  assert.equal(logCalls().length, 0);
  assert.equal(state.toBlock, '200');
  assert.equal(state.tokens.length, 1);
  assert.equal(state.tokens[0]!.owner?.toLowerCase(), ALICE.toLowerCase());
});

test('a quiet incremental with a prior script digest does not re-read chunks', async () => {
  const {client, legs} = trackingClient({head: 100n});
  const state = await reconstructIncremental(client, priorWithScript(), {});
  assert.equal(state.script?.digest, DIGEST);
  assert.equal(state.script?.chunkCount, 2);
  assert.equal(legs().includes('scriptChunkCount'), false);
  assert.equal(legs().includes('scriptChunk'), false);
});

test('a Transfer in reconstructFromLogs still keeps the prior script digest', async () => {
  const {client, legs} = trackingClient({});
  const state = await reconstructFromLogs(client, priorWithScript(), [transferLog(150n)], {toBlock: 200n});
  assert.equal(state.script?.digest, DIGEST);
  assert.equal(legs().includes('scriptChunk'), false);
});

test('ScriptUpdated in the fresh logs re-reads chunks (the ping that means content changed)', async () => {
  const {client, legs} = trackingClient({
    answers: {
      scriptChunkCount: 1n,
      scriptChunk: () => '0x646261', // "dba"
    },
  });
  const state = await reconstructFromLogs(client, priorWithScript(), [scriptUpdatedLog(0n, 150n)], {toBlock: 200n});
  assert.equal(legs().includes('scriptChunkCount'), true);
  assert.equal(legs().includes('scriptChunk'), true);
  assert.notEqual(state.script?.digest, DIGEST);
  assert.equal(state.script?.chunkCount, 1);
});

test('no prior digest still head-reads chunks (first populate, not a skip)', async () => {
  const {client, legs} = trackingClient({head: 100n, answers: {scriptChunkCount: 0n}});
  await reconstructIncremental(client, priorWithScript(null), {});
  assert.equal(legs().includes('scriptChunkCount'), true);
});
