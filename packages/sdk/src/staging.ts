import type {Address, Hex, PublicClient} from 'viem';
import {ensureChunkStore, planChunks, planContentTxs, stageContent, type ChunkStoreEvent, type ContentTxPlan} from './chunks.js';
import {encodeReader} from './token.js';
import {METADATA_REPRESENTATION as R} from './spine.js';
import type {SendTx} from './execute.js';

/**
 * Content staging — putting a field's bytes on-chain behind the shared multi-chunk store/reader
 * (`AbxChunkStore`), the SDK-native counterpart of {@link ChunkStoreEvent}'s bootstrap: this module
 * layers the *content* side (plan → resolve a store → write chunks → encode the `reader` value) on
 * top of `chunks.ts`'s primitives (`planChunks`/`planContentTxs`/`stageContent`/`ensureChunkStore`)
 * and `token.ts`'s `encodeReader`, so an integrator gets ONE call instead of hand-wiring all four —
 * the same reasoning `ensureChunkStore`'s own doc comment gives for the store half.
 *
 * `gzip` is deliberately NOT performed here: it's a Node-only transform (`node:zlib`), and this
 * module is reachable from the browser bundle (browser-bundle.test.ts) like the rest of the SDK
 * core. Callers that support `compress: 'gzip'` (the CLI) gzip the bytes themselves and hand the
 * already-compressed result in as `content` — see {@link planStagedContent}.
 */

/** How staged content is compressed before chunking. `fastlz` is per-chunk and pure-JS
 *  ({@link planChunks} does it right here); `gzip` compresses the WHOLE content off-chain (the
 *  caller's job — see the module doc) and decodes off-chain too, hence the `reader-gzip`
 *  representation rather than `reader`. */
export type Compress = 'none' | 'fastlz' | 'gzip';

// ── Two independent costs, and the one that binds is the READ ────────────────
//
// WRITE cost is ~200 gas/byte (SSTORE2 code deposit) + per-chunk tx overhead, paid once by the
// creator. Past these soft limits, off-chain (Arweave pay-once, or a hosted resolver + IPFS) is FAR
// cheaper — on-chain's remaining edge is self-resolution, not cost. Per-file limit ≈ one 22 KB
// storage chunk; project limit caps the whole collection's write gas. Neither says anything about
// whether the result can be READ.
export const ONCHAIN_IMAGE_SOFT_LIMIT = 24 * 1024; // per file
export const ONCHAIN_PROJECT_SOFT_LIMIT = 256 * 1024; // whole collection, WRITE cost only

/** Whether `bytesLen` is past the point where on-chain storage stops being the cost-sane choice to
 *  WRITE. Says nothing about readability — that's {@link classifyOnchainReadSize}. */
export function exceedsOnchainSoftLimit(bytesLen: number): boolean {
  return bytesLen > ONCHAIN_IMAGE_SOFT_LIMIT;
}

// READ cost is the constraint nobody sees coming, and it is the one that decides whether a
// marketplace, an indexer, or another contract can see the token at all. The renderer assembles the
// whole document on every `tokenURI` call, and that cost is **superlinear**: EVM memory expansion
// carries a quadratic term, and the chunk store's `read()` concatenates chunk by chunk. So there is
// no honest flat "gas per KB" — the rate itself climbs with size.
//
// Measured (`forge`, `OneOfOneImage` + `AbxMetadataRenderer`, callee execution gas for one
// `tokenURI` call — no caller-side returndata copy, which a node serving `eth_call` doesn't pay
// either; `reader` = the representation `--onchain-image` produces, 22,000-byte chunks):
//
//     content   tokenURI gas    per KB     content    tokenURI gas    per KB
//       3 KB       1,123,327    374,000     100 KB      40,254,159    403,000
//      10 KB       3,588,993    359,000     128 KB      53,559,735    418,000
//      23 KB       8,346,220    363,000     187 KB      86,021,071    460,000
//      40 KB      14,740,366    369,000     256 KB     131,269,134    513,000
//      50 KB      18,759,333    375,000
//      75 KB      29,137,215    388,000
//      90 KB      35,868,124    399,000
//
// So: **~360,000–405,000 gas per KB across the 10–100 KB range that matters, climbing past that**
// (~460,000/KB at 187 KB, ~510,000/KB at 256 KB). The 3 KB row is higher per KB because the JSON
// wrapper is a fixed cost the content hasn't yet dwarfed.
//
// `inline` and `reader` agree within ~1% up to 75 KB — the cost is the renderer's own string
// building, not the storage mechanism, which is why `--compress fastlz` makes a field cheaper to
// WRITE and not one gas cheaper to read. They diverge above that (reader 1.8% dearer at 90 KB, 2.4%
// at 128 KB, 5.5% at 187 KB, 9.6% at 256 KB) because the store's read loop is quadratic in chunk
// count.
//
// Readability is a property of the endpoint, not the chain, so `probeEthCallGasCap` measures it.
// Do not conflate the `eth_call` cap with either the block gas limit or `eth_estimateGas` allowance.
// There is no fixed-size refusal: the toolkit reports the estimated cost and measured endpoint cap.
/** Measured `tokenURI` gas per KB at the BOTTOM of the readable range (10 KB). The rate is not
 *  flat — see the note above, and use {@link tokenUriGasEstimate} for a figure at a given size. */
export const TOKEN_URI_GAS_PER_KB_LOW = 360_000;
/** Measured `tokenURI` gas per KB at the TOP of the readable range (100 KB). Past that the rate
 *  keeps climbing (~460,000/KB at 187 KB), so this is a range endpoint, not a ceiling. */
export const TOKEN_URI_GAS_PER_KB_HIGH = 405_000;
/** From here up, the read is worth NAMING a number for (~15M gas at 40 KB) — a note about cost, not
 *  a statement about whether the token can be read. Every endpoint measured serves well past this. */
export const ONCHAIN_READ_WARN_BYTES = 40 * 1024;

/**
 * Conservative `eth_call` reference based on geth's default `--rpc.gascap`. It is a floor, not a
 * ceiling. Use {@link probeEthCallGasCap} to learn what the configured endpoint actually serves.
 */
export const ETH_CALL_GAS_FLOOR = 50_000_000;

/**
 * Rough `tokenURI` gas for `bytesLen` of on-chain content — orientation, not a quote.
 *
 * Fitted to the measurements above as `350,000·KB + 650·KB²`: within ~3% of measured from 10 KB to
 * 256 KB, and slightly high rather than low, which is the right direction for a number a creator
 * plans against. A flat per-KB rate was wrong at both ends — it overstated a 10 KB read by ~30% and
 * understated a 256 KB one by ~10%.
 */
export function tokenUriGasEstimate(bytesLen: number): number {
  const kb = bytesLen / 1024;
  return Math.round(kb * 350_000 + kb * kb * 650);
}

/** How much on-chain content a node with `gasCap` can serve in one `tokenURI` — the inverse of
 *  {@link tokenUriGasEstimate}, solved for bytes. Orientation, same ~3% fit. */
export function readableBytesAtGas(gasCap: number): number {
  // 650·KB² + 350,000·KB − gasCap = 0
  const kb = (-350_000 + Math.sqrt(350_000 ** 2 + 4 * 650 * gasCap)) / (2 * 650);
  return Math.max(0, Math.round(kb * 1024));
}

/**
 * `ok` = every endpoint measured serves this read · `endpoint-dependent` = your RPC serves it but a
 * 50M-capped one does not, so some marketplaces and indexers will see a revert · `beyond-local-rpc`
 * = past what even your own measured endpoint allows.
 *
 * None of these is a refusal. Reads happen off-chain and a read that is too large for one node is an
 * RPC-capability problem, not a reason to stop a creator writing bytes they want permanent — and any
 * fixed byte threshold is a guess about third-party infrastructure that will be wrong in both
 * directions (ours was: it blocked 100 KB while the default chain's own endpoint served 729 KB).
 */
export type OnchainReadVerdict = 'ok' | 'endpoint-dependent' | 'beyond-local-rpc';

/**
 * Classify `bytesLen` of on-chain content by who can READ the token carrying it.
 *
 * `capGas` is the caller's measured `eth_call` allowance ({@link probeEthCallGasCap}); pass `null`
 * or omit it when it could not be measured, and the verdict degrades to the two bands that do not
 * need it. Kept in the SDK so the SDK and the CLI cannot disagree about the boundary.
 */
export function classifyOnchainReadSize(bytesLen: number, capGas?: number | null): OnchainReadVerdict {
  const gas = tokenUriGasEstimate(bytesLen);
  if (gas <= ETH_CALL_GAS_FLOOR) return 'ok';
  if (capGas != null && gas > capGas) return 'beyond-local-rpc';
  return 'endpoint-dependent';
}

/** The plan for staging one piece of content: how it chunks, how it compresses, and the
 *  transaction shape ({@link planContentTxs}) that staging it will take. */
export interface ContentPlan {
  content: Uint8Array;
  fastlz: boolean;
  chunks: number;
  stagedBytes: number;
  plan: ContentTxPlan;
  representation: string;
}

/**
 * Pure staging plan for a piece of content — chunk count + transaction shape — with NO chain
 * writes, no signer, no `ensureChunkStore`. Shared by {@link stageFieldContent} (which then
 * actually stages) and a dry-run preview, so the count a human is told up front is the same one
 * real staging produces. `content` must already be in its final pre-chunking form — gzipped when
 * `compress === 'gzip'` (see the module doc for why that step isn't here). `chunkSize` defaults to
 * {@link planChunks}'s default (currently 22 KB), so e.g. a 2.8 KB SVG is 1 chunk.
 */
export function planStagedContent(content: Uint8Array, compress: Compress): ContentPlan {
  const fastlz = compress === 'fastlz';
  const planned = planChunks(content, {fastlz});
  const plan = planContentTxs(planned);
  const representation = compress === 'gzip' ? R.readerGzip : R.reader;
  const stagedBytes = planned.reduce((n, c) => n + c.data.length, 0);
  return {content, fastlz, chunks: planned.length, stagedBytes, plan, representation};
}

/** Progress from {@link stageFieldContent}, so a caller can narrate without the SDK printing
 *  anything itself (mirrors {@link ChunkStoreEvent} / `AnchorEvent`'s vocabulary). `chunk-store`
 *  simply forwards `ensureChunkStore`'s own event — staging always resolves one. */
export type StagingEvent =
  | {kind: 'chunk-store'; event: ChunkStoreEvent}
  | {kind: 'planned'; field: string; store: Address; contentPlan: ContentPlan}
  | {kind: 'staged'; field: string; manifest: Address; txHashes: Hex[]};

export interface StageFieldContentArgs {
  /** Content bytes, already in their final pre-chunking form (gzipped by the caller when
   *  `compress === 'gzip'` — see the module doc). */
  content: Uint8Array;
  compress: Compress;
  /** The metadata field this content is destined for — narration only (e.g. `'image'`). */
  field: string;
  send: SendTx;
  publicClient: PublicClient;
  chainId: number;
  /** Pre-resolved store (batch staging reuses one across files); else resolve/deploy via
   *  {@link ensureChunkStore}. */
  store?: Address;
  onEvent?: (e: StagingEvent) => void;
}

/**
 * Put `content` on-chain as SSTORE2 chunks behind the shared reader, and return the field's
 * `(representation, value)`. `fastlz` compresses per chunk (reader decodes on read → stays
 * on-chain renderable); `gzip` compresses the whole content (off-chain decode → the
 * `reader-gzip` representation, not on-chain renderable).
 *
 * Staging is one atomic `writeContent` (content fits a single tx's gas) or gas-bounded chunk-write
 * `multicall`s plus a final manifest write — {@link stageContent} picks. These store writes use
 * `send` (typically the env key on the hot lane, or the connected wallet on the wallet lane) — the
 * data contracts are ownerless, so any funded signer may write them; the caller signs the field-set
 * that references the manifest separately.
 */
export async function stageFieldContent(args: StageFieldContentArgs): Promise<{value: Hex; representation: string}> {
  const notify = args.onEvent ?? (() => {});
  const p = planStagedContent(args.content, args.compress);
  const resolvedStore =
    args.store ??
    (await ensureChunkStore(args.publicClient, args.send, {
      chainId: args.chainId,
      onEvent: (e) => notify({kind: 'chunk-store', event: e}),
    }));
  notify({kind: 'planned', field: args.field, store: resolvedStore, contentPlan: p});
  const {manifest, txHashes} = await stageContent(args.send, {store: resolvedStore, content: p.content, fastlz: p.fastlz, chainId: args.chainId});
  notify({kind: 'staged', field: args.field, manifest, txHashes});
  return {value: encodeReader(resolvedStore, manifest), representation: p.representation};
}
