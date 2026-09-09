/**
 * On-chain program chunks — the writer-side twin of {@link AbxGenerator}'s `_escapedScript`.
 *
 * The generator (and the resolver) join `scriptChunk(i)` with a single `'\n'` between chunks. A
 * fixed-size byte slice that ignores that join inserts a newline in the middle of a token — `mass`
 * becomes `ma\nss`, which is invalid JavaScript — and `abx verify` still goes green because it
 * never parses the reassembled program. Splitting AT an existing newline (and dropping it, because
 * the join puts it back) makes `chunks.join('\n') === source`. A 22 kB+ span with no newline is
 * refused: there is no honest split that matches the on-chain join.
 *
 * This module also carries the write-side counterpart to that split (`prepareSetScriptChunk` /
 * `prepareRemoveLastScriptChunk`, wrapping `OnChainScript.sol`'s `setScriptChunk`/
 * `removeLastScriptChunk` — contracts/src/extensions/onchain-script/OnChainScript.sol) and the
 * SAFE-REPLACEMENT planning + verification pair (`planScriptReplace` / `verifyScriptReplace`) that
 * `abx replace-script` is built on (packages/cli/src/ownerops.ts). Both take a small reader
 * interface rather than a viem client — the same shape `resume.ts` uses — so the diff and the
 * post-write verification are testable with a fake chain, no RPC, no signer.
 */
import {encodeFunctionData, hexToBytes, type Address, type Hex} from 'viem';
import {seriesCodeAbi} from './abi/index.js';
import type {PreparedTx} from './ops.js';

const ZERO_VALUE = '0x0' as const;

/** SSTORE2 data-contract code limit is 24576 bytes (EIP-170) minus STOP; stay conservative. */
export const DEFAULT_SCRIPT_CHUNK_SIZE = 22_000;

/** The byte the on-chain generator inserts between script chunks. Must stay in lockstep with
 *  `AbxGenerator._escapedScript` and the resolver's `.join('\n')`. */
export const SCRIPT_CHUNK_JOIN = '\n';

const NL = 0x0a;

/**
 * Split a program so the generator's newline-join reconstitutes it byte-for-byte.
 * Empty source → no chunks (nothing to store). A single chunk that already fits is stored as-is
 * (the generator inserts no join when `n === 1`).
 */
export function splitScriptChunks(
  source: string,
  chunkSize: number = DEFAULT_SCRIPT_CHUNK_SIZE,
): Uint8Array[] {
  if (chunkSize < 1) throw new Error('chunkSize must be ≥ 1');
  const bytes = new TextEncoder().encode(source);
  if (bytes.length === 0) return [];
  if (bytes.length <= chunkSize) return [bytes];

  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const remaining = bytes.length - i;
    if (remaining <= chunkSize) {
      chunks.push(bytes.subarray(i));
      break;
    }
    // Last newline in the window. The generator will put it back between this chunk and the next,
    // so the chunk itself excludes it.
    let split = -1;
    for (let j = i + chunkSize - 1; j >= i; j--) {
      if (bytes[j] === NL) {
        split = j;
        break;
      }
    }
    if (split < i) {
      throw new Error(
        `script has a ${chunkSize}+ byte span with no newline — the on-chain generator joins ` +
          `chunks with a newline, so a split here would insert a byte and can break the program ` +
          `(a 22 kB minified line has been observed to turn \`mass\` into \`ma\\nss\`). ` +
          `Insert a line break, or shrink the file.`,
      );
    }
    chunks.push(bytes.subarray(i, split));
    i = split + 1;
  }
  return chunks;
}

/** Inverse of {@link splitScriptChunks}: the join the generator performs on chain. */
export function joinScriptChunks(chunks: readonly Uint8Array[]): string {
  const dec = new TextDecoder();
  return chunks.map((c) => dec.decode(c)).join(SCRIPT_CHUNK_JOIN);
}

// ── writes: OnChainScript.sol's setScriptChunk / removeLastScriptChunk ────────
// No `prepare*` wrapper existed for either before this — every caller (deploy-code's setup
// multicall, its --resume leg) hand-encoded `encodeFunctionData` inline. These mirror
// `prepareSetDependency`/`prepareRemoveLastDependency` (ops.ts) exactly: same `PreparedTx` shape,
// same "one index-addressed setter + one pop-the-tail remover" split.

/** Owner writes/replaces the on-chain program chunk at `index` (`index === count` appends) —
 *  `OnChainScript.setScriptChunk`. Content should come from {@link splitScriptChunks} so the
 *  generator's newline-join reassembles the exact source. Signer must be the owner. */
export function prepareSetScriptChunk(args: {
  contract: Address;
  index: bigint | number;
  chunk: Hex;
  chainId: number;
}): PreparedTx {
  const index = BigInt(args.index);
  const bytes = (args.chunk.length - 2) / 2;
  // EVM code deposit is 200 gas/byte — the same physics-backed floor the code-setup multicall
  // computes for its script-chunk legs (ops.ts). Restated per-chunk here so a caller that assembles
  // its own multicall (`replace-script`) can sum an honest `gasFloor` instead of trusting
  // `eth_estimateGas` against a target too fresh for the estimator to see (see PreparedTx.gasFloor's
  // own doc for why a wrong estimate must be DETECTED, not silently replaced).
  const gasFloor = bytes > 0 ? (`0x${(bytes * 200).toString(16)}` as Hex) : undefined;
  return {
    op: 'set-script-chunk',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'setScriptChunk', args: [index, args.chunk]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set script chunk [${index}] (${bytes} byte${bytes === 1 ? '' : 's'})`,
    fields: {contract: args.contract, index: index.toString(), bytes: String(bytes)},
    ...(gasFloor === undefined ? {} : {gasFloor}),
  };
}

/** Remove the LAST on-chain program chunk (the list stays dense; order is load-bearing) —
 *  `OnChainScript.removeLastScriptChunk`. There is no "remove N": shrinking by more than one chunk
 *  is this call, repeated. Signer must be the owner. */
export function prepareRemoveLastScriptChunk(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'remove-last-script-chunk',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'removeLastScriptChunk', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Remove the last script chunk (the list stays dense)',
    fields: {contract: args.contract},
  };
}

// ── safe replacement: diff + post-write verification ──────────────────────────
// `abx replace-script` (packages/cli/src/ownerops.ts) is built on these two functions. Both take a
// `ScriptChunkReader` — not a viem client — so they're testable against a fake chain, the same
// seam `resume.ts` uses for its own script-chunk leg (`ResumeReaderCore.scriptChunk`).

/** The two on-chain reads a replace-script diff/verify needs. An interface, not a client, so both
 *  are testable without a chain — see the module doc. */
export interface ScriptChunkReader {
  scriptChunkCount(): Promise<number>;
  /** Stored bytes at `index`, or `null` when unset/unreadable (index ≥ count, or a transient miss). */
  scriptChunk(index: number): Promise<Hex | null>;
}

export interface ScriptReplacePlan {
  /** `{index, hex}` for every index whose ON-CHAIN content differs from the target (or is missing
   *  entirely) — these need `setScriptChunk`. Compared by CONTENT, not by count, for the identical
   *  reason `resume.ts`'s chunk leg is: a hand-repaired index that already matches the target must
   *  not be re-sent (SSTORE2 deposit is 200 gas/byte — the most expensive way to be "safe"). */
  toWrite: Array<{index: number; hex: Hex}>;
  /** How many trailing chunks to pop via `removeLastScriptChunk` — non-zero only when the
   *  replacement uses FEWER chunks than what's on-chain now. There is no "remove N" call, so this
   *  many single `removeLastScriptChunk` calls are queued (see {@link prepareRemoveLastScriptChunk}). */
  toRemove: number;
  /** `scriptChunkCount()` before this plan runs. */
  currentCount: number;
  /** `next.length` — the chunk count this plan drives the contract toward. */
  targetCount: number;
  /** Nothing differs at all — the replacement already matches on-chain byte for byte. The command
   *  must send NOTHING in this case, not an empty-but-"successful" transaction. */
  noop: boolean;
}

/**
 * Diff a replacement program's chunks against what a contract holds NOW, so `replace-script` sends
 * only what actually changed. Mirrors `resume.ts`'s script-chunk leg (`planCoreLegs`) exactly —
 * content, not count, decides "present" — the difference being that a resume leg is checked
 * present/absent as a GROUP (the setup multicall is atomic, so partial-content-mismatch never
 * legitimately happens), while a replacement is expected to change SOME indices and not others, so
 * each index is diffed and reported independently.
 */
export async function planScriptReplace(read: ScriptChunkReader, next: readonly Hex[]): Promise<ScriptReplacePlan> {
  const currentCount = await read.scriptChunkCount();
  const toWrite: Array<{index: number; hex: Hex}> = [];
  for (let i = 0; i < next.length; i++) {
    const stored = i < currentCount ? await read.scriptChunk(i) : null;
    if (stored !== null && stored.toLowerCase() === next[i].toLowerCase()) continue;
    toWrite.push({index: i, hex: next[i]});
  }
  const toRemove = Math.max(0, currentCount - next.length);
  return {toWrite, toRemove, currentCount, targetCount: next.length, noop: toWrite.length === 0 && toRemove === 0};
}

export interface ScriptVerifyResult {
  /** Whether the on-chain script, read back and reassembled, is byte-identical to what was asked for. */
  ok: boolean;
  /** The reassembled program, for a diagnostic when `ok` is false. */
  reassembled: string;
  /** `scriptChunkCount()` at verification time. */
  chunkCount: number;
}

/**
 * Read the completed script back from chain and confirm it reassembles EXACTLY to `expectedSource`
 * — the safety property that justifies `replace-script` existing at all. A transaction not
 * reverting is proof the EVM accepted each call; it is NOT proof the final program is what was
 * intended (a stale RPC view, a concurrent write racing the same contract, or a bug in the ordering
 * of writes-vs-removes could all leave a script that "sent fine" and reassembles to garbage). This
 * is the check that turns "the multicall didn't revert" into "the program is provably correct" —
 * run it BEFORE reporting success, never after.
 */
export async function verifyScriptReplace(read: ScriptChunkReader, expectedSource: string): Promise<ScriptVerifyResult> {
  const chunkCount = await read.scriptChunkCount();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const hex = await read.scriptChunk(i);
    // `scriptChunkCount()` and `scriptChunk(i)` are two separate reads against (hopefully) the same
    // block; a `null` here means they disagree, which is itself the failure this function exists to
    // catch — report it as a verification miss rather than silently reassembling a gap.
    chunks.push(hex === null ? new Uint8Array(0) : hexToBytes(hex));
  }
  const reassembled = joinScriptChunks(chunks);
  return {ok: reassembled === expectedSource, reassembled, chunkCount};
}
