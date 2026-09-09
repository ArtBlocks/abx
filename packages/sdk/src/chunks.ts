import {bytesToHex, encodeFunctionData, parseEventLogs, type Address, type Hex, type PublicClient} from 'viem';
import {abxChunkStoreAbi, abxChunkStoreBytecode} from './abi/index.js';
import {resolveChunkStore} from './deployments.js';
import {predictChunkStore} from './create2.js';
import {flzCompress} from './fastlz.js';
import {ABX_SALT, CREATE2_PROXY, create2Calldata, predictCreate2Address} from './create2.js';
import type {SendTx} from './execute.js';

/**
 * Multi-chunk on-chain content — the off-chain side of {@link AbxChunkStore}.
 *
 * Large content (a 30 kB image, a long description) is split into SSTORE2-sized chunks,
 * optionally FastLZ-compressed **per chunk** off-chain (the chunk store decompresses on
 * read, so it stays on-chain-renderable), written as immutable data contracts, and tied
 * together by a manifest. The field then carries the `reader` representation with
 * `value = abi.encode(chunkStore, manifest)`. gzip is *not* handled here — it's an
 * off-chain decode signaled by the `-gzip` representation, applied to the assembled bytes.
 */

/** SSTORE2 data-contract code limit is 24576 bytes (EIP-170) minus the STOP byte; chunk
 *  conservatively so even an incompressible FastLZ chunk (slight expansion) still fits. */
export const DEFAULT_CHUNK_SIZE = 22_000;

/** One planned chunk: the bytes to store + whether they're FastLZ-compressed. */
export interface PlannedChunk {
  data: Uint8Array;
  compressed: boolean;
}

/**
 * Chunk-store writes are staged in the SAME lane-agnostic terms as every other write: the SDK
 * builds a {@link PreparedTx}, the caller decides how it's signed via a {@link SendTx}. These writes
 * are **ownerless**, so they can be signed by any funded signer — the env key (hot lane) *or* a
 * connected browser wallet (wallet lane). Keeping the signer out of this module is what lets
 * on-chain staging work under every signing lane instead of assuming a hot key.
 */

/**
 * Split content into chunks, FastLZ-compressing each when `fastlz` is set (per-chunk — the
 * convention the store + reader expect). Pure: no chain, no I/O. A chunk is only stored
 * compressed when that actually shrinks it (so the reader never wastes a decompress).
 */
export function planChunks(
  content: Uint8Array,
  opts: {fastlz?: boolean; chunkSize?: number} = {},
): PlannedChunk[] {
  const size = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks: PlannedChunk[] = [];
  for (let i = 0; i < content.length; i += size) {
    const raw = content.subarray(i, i + size);
    if (opts.fastlz) {
      const packed = flzCompress(raw);
      if (packed.length < raw.length) {
        chunks.push({data: packed, compressed: true});
        continue;
      }
    }
    chunks.push({data: raw, compressed: false});
  }
  return chunks;
}

const toHex = (b: Uint8Array): Hex => bytesToHex(b);

/**
 * A per-transaction gas ceiling for packing chunk writes; the planner splits content across
 * multiple transactions to stay beneath it.
 *
 * **The binding constraint is `eth_estimateGas`, not the block gas limit.** Every send estimates
 * first; a batch planned above the provider allowance fails before anything is sent.
 *
 * 8M leaves room for the base + calldata cost under that 16.7M ceiling. **Do not raise it toward a
 * block limit.** If you raise it at all, measure the estimate allowance first — and note that these
 * are third-party numbers that move.
 */
export const DEFAULT_TX_GAS_BUDGET = 8_000_000;

/**
 * Reference `eth_estimateGas` allowance — 2^24 — used to justify
 * {@link DEFAULT_TX_GAS_BUDGET} against the limit that binds it rather than the block limit.
 */
export const MEASURED_ESTIMATE_GAS_ALLOWANCE = 16_777_216;

/**
 * Rough gas for writing `byteLength` bytes as an SSTORE2 data contract: a fixed CREATE + base
 * overhead plus the code-deposit cost (~200 gas/byte) and calldata. Deliberately an over-estimate so
 * packed batches land safely inside {@link DEFAULT_TX_GAS_BUDGET}; the wallet still does the real
 * `eth_estimateGas` before sending. Takes a byte length directly (not a {@link PlannedChunk}) for a
 * caller that already knows the size and has no content to allocate just to ask — a code project's
 * on-chain SCRIPT chunk (`OnChainScript.setScriptChunk`, `contracts/src/libraries/AbxCodeLib.sol`) is
 * the same SSTORE2 write as a content chunk, so it reuses this estimate rather than inventing a
 * second one — see `commands/deploy.ts`'s code-setup transaction splitting.
 */
export function estimateChunkGasForBytes(byteLength: number): number {
  return 40_000 + byteLength * 240;
}

/** {@link estimateChunkGasForBytes}, from a {@link PlannedChunk} already in hand. */
export function estimateChunkGas(chunk: PlannedChunk): number {
  return estimateChunkGasForBytes(chunk.data.length);
}

/**
 * Rough, deliberately-conservative gas for the code-project setup legs that are NOT raw content
 * chunks — a `setParamSchema`, a `setDependency`/`setDependencyRegistry`, an on-chain-URI wiring
 * call, a reserve `mint`. Unlike {@link estimateChunkGasForBytes} these are flat per-call estimates:
 * none of them pays an EVM code-deposit, so their cost doesn't scale with a byte length. Shared by
 * `commands/deploy.ts`'s fresh-deploy cost-guidance heuristic AND its setup-transaction gas-bounded
 * batching, so the two can never disagree about what one of these calls costs.
 */
export const SETUP_LEG_GAS = {
  schema: 45_000,
  dependency: 55_000,
  onchainUri: 60_000,
  mint: 65_000,
} as const;

/**
 * Pack arbitrary gas-costed items into gas-bounded batches, preserving order — the call-level
 * sibling of {@link planContentTxs}'s own greedy bin-packing loop, generalized so a caller whose
 * "chunk" is a setup CALL (a schema declare, a dependency pointer, a mint) rather than a content byte
 * range can reuse the identical algorithm and budget instead of inventing a second one. Splits only
 * BETWEEN items — an item whose own `.gas` alone exceeds `gasBudget` still rides alone in its own
 * batch (that batch is simply over-budget, not necessarily over the harder `eth_estimateGas` ceiling
 * — a caller that must refuse an indivisible-too-large leg checks {@link MEASURED_ESTIMATE_GAS_ALLOWANCE}
 * itself, separately, BEFORE calling this).
 */
export function packCallsByGas<T extends {gas: number}>(
  items: readonly T[],
  opts: {gasBudget?: number} = {},
): T[][] {
  const budget = opts.gasBudget ?? DEFAULT_TX_GAS_BUDGET;
  const batches: T[][] = [];
  let cur: T[] = [];
  let curGas = 0;
  for (const item of items) {
    if (cur.length > 0 && curGas + item.gas > budget) {
      batches.push(cur);
      cur = [];
      curGas = 0;
    }
    cur.push(item);
    curGas += item.gas;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** How content will be written on-chain — one atomic tx, or several batched ones. */
export type ContentTxPlan =
  | {mode: 'single'; chunks: PlannedChunk[]; txCount: 1}
  | {mode: 'split'; batches: PlannedChunk[][]; txCount: number};

/**
 * Decide the transaction shape for a piece of content. When the whole thing fits one
 * tx's gas budget it's a single atomic {@link writeContent} (no address prediction, no
 * follow-up). Otherwise it's split into gas-bounded batches of {@link writeChunk} calls
 * (each batch one `multicall`), followed by a single {@link writeManifest} — so
 * `txCount` is `batches.length + 1`. Pure: no chain, no I/O.
 */
export function planContentTxs(
  chunks: PlannedChunk[],
  opts: {gasBudget?: number} = {},
): ContentTxPlan {
  const budget = opts.gasBudget ?? DEFAULT_TX_GAS_BUDGET;
  const total = chunks.reduce((g, c) => g + estimateChunkGas(c), 0);
  // writeContent also pays for the manifest write; approximate it as one more chunk.
  if (total + 60_000 <= budget) return {mode: 'single', chunks, txCount: 1};

  const batches: PlannedChunk[][] = [];
  let cur: PlannedChunk[] = [];
  let curGas = 0;
  for (const c of chunks) {
    const g = estimateChunkGas(c);
    if (cur.length > 0 && curGas + g > budget) {
      batches.push(cur);
      cur = [];
      curGas = 0;
    }
    cur.push(c);
    curGas += g;
  }
  if (cur.length > 0) batches.push(cur);
  return {mode: 'split', batches, txCount: batches.length + 1};
}

/**
 * Deploy `AbxChunkStore` — the shared, stateless multi-chunk store + reader. Deploy once
 * per chain (like the renderer); every chunked field references it as its `reader`.
 */
export async function deployChunkStore(
  send: SendTx,
  opts: {chainId: number},
): Promise<{chunkStore: Address; txHash: Hex; blockNumber: bigint}> {
  // CREATE2 via the keyless proxy + canonical salt → the SAME address on every chain (matches the
  // forge `DeployChunkStore` script and the manifest). The address is deterministic, so we compute
  // it rather than read `receipt.contractAddress` (which is null — the tx targets the proxy, not a
  // contract creation). Deploy only when the store isn't already there (the caller checks first).
  const chunkStore = predictCreate2Address(ABX_SALT.chunkStore, abxChunkStoreBytecode);
  const receipt = await send({
    op: 'deploy-chunk-store',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.chunkStore, abxChunkStoreBytecode),
    value: '0x0',
    chainId: opts.chainId,
    summary: 'Deploy the shared on-chain chunk store (AbxChunkStore) — CREATE2, deterministic address',
    fields: {contract: 'AbxChunkStore', address: chunkStore, note: 'one-time, ownerless, shared by every chunked field'},
  });
  return {chunkStore, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Does `store` expose the current `writeContent(bytes[],bool[])` ABI? A chunk store deployed
 * before `writeContent` existed (an older `AbxChunkStore`) still *has code*, so a bare
 * `getCode` check passes — but the call reverts, silently breaking the `--onchain-image`
 * path. We probe with an empty `writeContent([],[])`: the current store returns a manifest
 * address, a stale/incompatible one reverts. This is a pure `eth_call` (no tx, no state
 * change, no gas spent), so it's safe to run on every staging path as a guard.
 */
export async function storeSupportsWriteContent(
  publicClient: PublicClient,
  store: Address,
): Promise<boolean> {
  try {
    await publicClient.call({
      to: store,
      data: encodeFunctionData({abi: abxChunkStoreAbi, functionName: 'writeContent', args: [[], []]}),
    });
    return true;
  } catch {
    return false;
  }
}

/** Write one chunk as an SSTORE2 data contract; returns its address (from `ChunkWritten`). */
export async function writeChunk(
  send: SendTx,
  args: {store: Address; data: Uint8Array; chainId: number},
): Promise<{pointer: Address; txHash: Hex}> {
  const receipt = await send({
    op: 'write-chunk',
    to: args.store,
    data: encodeFunctionData({abi: abxChunkStoreAbi, functionName: 'writeChunk', args: [toHex(args.data)]}),
    value: '0x0',
    chainId: args.chainId,
    summary: 'Stage one on-chain content chunk',
    fields: {store: args.store, bytes: String(args.data.length)},
  });
  const ev = parseEventLogs({abi: abxChunkStoreAbi, eventName: 'ChunkWritten', logs: receipt.logs});
  const pointer = (ev[0] as {args: {pointer: Address}} | undefined)?.args.pointer;
  if (!pointer) throw new Error('writeChunk emitted no ChunkWritten event');
  return {pointer, txHash: receipt.transactionHash};
}

/**
 * Write a whole piece of content — every chunk plus the manifest — in ONE transaction
 * via `AbxChunkStore.writeContent`. The atomic, prediction-free path for content that
 * fits a single tx's gas (see {@link planContentTxs}); returns the manifest address (the
 * `reader` pointer) from the `ManifestWritten` event.
 */
export async function writeContent(
  send: SendTx,
  args: {store: Address; chunks: ReadonlyArray<PlannedChunk>; chainId: number},
): Promise<{manifest: Address; txHash: Hex}> {
  const receipt = await send({
    op: 'write-content',
    to: args.store,
    data: encodeFunctionData({
      abi: abxChunkStoreAbi,
      functionName: 'writeContent',
      args: [args.chunks.map((c) => toHex(c.data)), args.chunks.map((c) => c.compressed)],
    }),
    value: '0x0',
    chainId: args.chainId,
    summary: `Stage on-chain content (${args.chunks.length} chunk${args.chunks.length === 1 ? '' : 's'}, atomic)`,
    fields: {store: args.store, chunks: String(args.chunks.length)},
  });
  const ev = parseEventLogs({abi: abxChunkStoreAbi, eventName: 'ManifestWritten', logs: receipt.logs});
  const manifest = (ev[0] as {args: {manifest: Address}} | undefined)?.args.manifest;
  if (!manifest) throw new Error('writeContent emitted no ManifestWritten event');
  return {manifest, txHash: receipt.transactionHash};
}

/**
 * Write a batch of chunks in ONE transaction via the store's `multicall`, returning their
 * pointer addresses **in order** (parsed from the `ChunkWritten` events). Used by the
 * split path for content too large for a single tx: the caller writes one or more such
 * batches, concatenates the returned pointers, then calls {@link writeManifest}. Pairs
 * each pointer with its planned `compressed` flag for manifest assembly.
 */
export async function writeChunkBatch(
  send: SendTx,
  args: {store: Address; chunks: ReadonlyArray<PlannedChunk>; chainId: number},
): Promise<{written: Array<{pointer: Address; compressed: boolean}>; txHash: Hex}> {
  const calls = args.chunks.map((c) =>
    encodeFunctionData({abi: abxChunkStoreAbi, functionName: 'writeChunk', args: [toHex(c.data)]}),
  );
  const receipt = await send({
    op: 'write-chunk-batch',
    to: args.store,
    data: encodeFunctionData({abi: abxChunkStoreAbi, functionName: 'multicall', args: [calls]}),
    value: '0x0',
    chainId: args.chainId,
    summary: `Stage ${args.chunks.length} on-chain content chunk${args.chunks.length === 1 ? '' : 's'} (batch)`,
    fields: {store: args.store, chunks: String(args.chunks.length)},
  });
  const txHash = receipt.transactionHash;
  const evs = parseEventLogs({abi: abxChunkStoreAbi, eventName: 'ChunkWritten', logs: receipt.logs});
  if (evs.length !== args.chunks.length) {
    throw new Error(
      `writeChunkBatch: expected ${args.chunks.length} ChunkWritten events, got ${evs.length}`,
    );
  }
  const written = evs.map((e, i) => ({
    pointer: (e as {args: {pointer: Address}}).args.pointer,
    compressed: args.chunks[i].compressed,
  }));
  return {written, txHash};
}

/**
 * Stage a whole piece of content on the chunk store and return its manifest — the
 * `pointer` half of a `reader` field's value. Plans the chunks, then executes the
 * minimal transaction set ({@link planContentTxs}): one atomic {@link writeContent} when
 * it fits, else gas-bounded {@link writeChunkBatch} multicalls plus a final
 * {@link writeManifest}. Returns every tx hash so a UX can report the count honestly.
 *
 * This is the same path whether the manifest is later baked into a deploy's `InitParams`
 * or set on a live token — staging always precedes the contract that references it.
 */
export async function stageContent(
  send: SendTx,
  args: {store: Address; content: Uint8Array; chainId: number; fastlz?: boolean; chunkSize?: number; gasBudget?: number},
): Promise<{manifest: Address; txHashes: Hex[]; chunkCount: number}> {
  const chunks = planChunks(args.content, {fastlz: args.fastlz, chunkSize: args.chunkSize});
  const plan = planContentTxs(chunks, {gasBudget: args.gasBudget});
  const txHashes: Hex[] = [];

  if (plan.mode === 'single') {
    const {manifest, txHash} = await writeContent(send, {store: args.store, chunks, chainId: args.chainId});
    return {manifest, txHashes: [txHash], chunkCount: chunks.length};
  }

  const written: Array<{pointer: Address; compressed: boolean}> = [];
  for (const batch of plan.batches) {
    const res = await writeChunkBatch(send, {store: args.store, chunks: batch, chainId: args.chainId});
    written.push(...res.written);
    txHashes.push(res.txHash);
  }
  const {manifest, txHash} = await writeManifest(send, {store: args.store, chunks: written, chainId: args.chainId});
  txHashes.push(txHash);
  return {manifest, txHashes, chunkCount: chunks.length};
}

/** Write the manifest (ordered chunk list); returns its address (the `reader` pointer). */
export async function writeManifest(
  send: SendTx,
  args: {store: Address; chunks: ReadonlyArray<{pointer: Address; compressed: boolean}>; chainId: number},
): Promise<{manifest: Address; txHash: Hex}> {
  const receipt = await send({
    op: 'write-manifest',
    to: args.store,
    data: encodeFunctionData({
      abi: abxChunkStoreAbi,
      functionName: 'writeManifest',
      args: [args.chunks.map((c) => ({pointer: c.pointer, compressed: c.compressed}))],
    }),
    value: '0x0',
    chainId: args.chainId,
    summary: `Write the on-chain content manifest (${args.chunks.length} chunk${args.chunks.length === 1 ? '' : 's'})`,
    fields: {store: args.store, chunks: String(args.chunks.length)},
  });
  const ev = parseEventLogs({abi: abxChunkStoreAbi, eventName: 'ManifestWritten', logs: receipt.logs});
  const manifest = (ev[0] as {args: {manifest: Address}} | undefined)?.args.manifest;
  if (!manifest) throw new Error('writeManifest emitted no ManifestWritten event');
  return {manifest, txHash: receipt.transactionHash};
}

/** Progress from {@link ensureChunkStore}, so a caller can narrate without the SDK printing. */
export type ChunkStoreEvent =
  | {kind: 'stale'; address: Address} // listed store exists but predates `writeContent`
  | {kind: 'canonical'; address: Address} // found at the deterministic address, not yet in the manifest
  | {kind: 'deploying'}
  | {kind: 'deployed'; address: Address; inManifest: boolean};

/**
 * Resolve a usable multi-chunk content store for this chain, deploying one if needed.
 *
 * This is the bootstrap every on-chain-content path needs, and it existed only inside the CLI — so an
 * SDK integrator got `resolveChunkStore()` (which may return undefined) plus a separate
 * `storeSupportsWriteContent()` they had to remember to call. Forget the second and an incapable
 * store fails *deep inside a mint, after transactions have already landed*. One team hand-rolled this
 * guard for exactly that reason; exporting it is cheaper than every integrator rediscovering it.
 *
 * Three ways to succeed, in order: the listed store if it exists AND exposes the current ABI; the
 * CREATE2-deterministic address (the store is canonical, so a forge script or an earlier lazy deploy
 * may have put it there before the manifest caught up — self-healing, and never a duplicate at a
 * random CREATE address); otherwise deploy it. Ownerless, so any funded signer may stand it up.
 */
export async function ensureChunkStore(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; onEvent?: (e: ChunkStoreEvent) => void} = {chainId: 0},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const listed = resolveChunkStore(opts.chainId, opts.override);
  if (listed) {
    const code = await publicClient.getCode({address: listed});
    if (code && code !== '0x') {
      if (await storeSupportsWriteContent(publicClient, listed)) return listed;
      notify({kind: 'stale', address: listed});
    }
  }
  const predicted = predictChunkStore();
  if (!listed || listed.toLowerCase() !== predicted.toLowerCase()) {
    const code = await publicClient.getCode({address: predicted});
    if (code && code !== '0x' && (await storeSupportsWriteContent(publicClient, predicted))) {
      notify({kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  notify({kind: 'deploying'});
  const {chunkStore} = await deployChunkStore(send, {chainId: opts.chainId});
  notify({kind: 'deployed', address: chunkStore, inManifest: false});
  return chunkStore;
}

/**
 * What {@link probeChunkStore} found — mirrors `probeSeedSource`/`probeTransferValidator` (see
 * ops.ts / creator-token.ts): every failure is a verdict, never a thrown error, so a caller — a
 * server startup check, in particular — can branch on the reason instead of catching.
 *
 *  - `ok`           — a store is configured, has code, and answers the current `writeContent` ABI.
 *  - `unconfigured` — no override, no `ABX_CHUNK_STORE`, and no manifest entry for this chain.
 *                     There is nothing to probe. {@link ensureChunkStore} would deploy one here;
 *                     THIS function never does — see its doc for why.
 *  - `no-code`      — an address is configured (override, env, or manifest) but nothing is
 *                     deployed there on this chain: a chain-id mismatch, a wiped local devnet, or
 *                     a manifest entry for a chain the caller isn't actually talking to.
 *  - `incompatible` — code exists but reverts the empty `writeContent([],[])` probe: either a
 *                     store deployed before that ABI existed, or an address that was never a chunk
 *                     store at all.
 *  - `unreachable`  — the RPC didn't answer `getCode`. Says nothing about the address; retry,
 *                     don't refuse on the merits (mirrors the sibling probes' treatment of a
 *                     transport failure).
 */
export type ChunkStoreVerdict = 'ok' | 'unconfigured' | 'no-code' | 'incompatible' | 'unreachable';

/**
 * The result of {@link probeChunkStore} — verdict plus what was observed, for a message.
 * `address` is absent only for `unconfigured`, where there is nothing to name.
 */
export interface ChunkStoreProbe {
  verdict: ChunkStoreVerdict;
  address?: Address;
  /** First line of the transport error, for `unreachable`. */
  error?: string;
}

/**
 * Resolve a usable multi-chunk content store WITHOUT ever deploying one — the fail-closed sibling
 * to {@link ensureChunkStore}, for the caller that must never send a transaction to answer "is
 * there a usable store here" (a request-scoped service, a read-only server startup check).
 *
 * `ensureChunkStore`'s last resort is a deploy, which is the right call for a CLI staging path (a
 * human is present, a signer is funded, standing up shared infra on demand is the point) and the
 * wrong call for a service: it has no business sending a transaction just because it was asked
 * whether a store exists, and "silently deployed a new chunk store during a health check" would be
 * its own incident. So this composes the SAME two primitives `ensureChunkStore` uses — address
 * resolution ({@link resolveChunkStore}) and the ABI probe ({@link storeSupportsWriteContent}) —
 * into a read-only check that returns a verdict a caller can log, alert on, and refuse to start
 * on, instead of an address or a thrown error.
 *
 * Deliberately does NOT fall back to the CREATE2-deterministic address the way `ensureChunkStore`
 * does: that fallback exists to self-heal a manifest that hasn't caught up with an out-of-band
 * deploy, which is a staging-time convenience, not part of "does the address this caller is
 * actually configured with work" — the question a startup check asks. An explicit `override` (or
 * `ABX_CHUNK_STORE`) still takes precedence over the chain's manifest default, exactly as it does
 * for `ensureChunkStore` — {@link resolveChunkStore} is the single place that precedence lives.
 */
export async function probeChunkStore(
  publicClient: PublicClient,
  opts: {chainId: number; override?: string},
): Promise<ChunkStoreProbe> {
  const address = resolveChunkStore(opts.chainId, opts.override);
  if (!address) return {verdict: 'unconfigured'};
  let code: Hex | undefined;
  try {
    code = await publicClient.getCode({address});
  } catch (err) {
    return {verdict: 'unreachable', address, error: firstLine(err)};
  }
  if (!code || code === '0x') return {verdict: 'no-code', address};
  if (!(await storeSupportsWriteContent(publicClient, address))) return {verdict: 'incompatible', address};
  return {verdict: 'ok', address};
}

/** First line of an error message — a revert reason is readable; viem's full dump is not. */
function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0].trim();
}
