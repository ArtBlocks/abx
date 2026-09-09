import {createPublicClient, http, zeroAddress, type Address, type Chain, type Hash, type PublicClient} from 'viem';
import {resolveChain, resolveRpcUrls, redactRpcUrl} from './chains.js';
import {isGetLogsRangeError} from './reconstruct.js';

/**
 * Capability probe for RPC endpoints. Reconstruction is `eth_getLogs`-heavy and
 * needs *archive* depth (to read a project's deploy block) plus a usable block
 * *range* (for speed). Providers differ wildly and change, so rather than trust a
 * table we measure each endpoint and classify it for the job:
 *
 *   • best     — serves a wide recent range AND archive-depth logs (fast + complete)
 *   • capped   — archive works but the getLogs range is small (works via chunking, slower)
 *   • unusable — unreachable, or can't serve archive-depth logs (can't reconstruct old projects)
 *
 * The toolkit's client already fails over across endpoints at request time; this is
 * the deliberate, explainable view `doctor` shows so a human/agent can pick or fix.
 */
export type RpcVerdict = 'best' | 'capped' | 'unusable';

export interface RpcProbe {
  url: string; // full URL (may embed a key — redact before display)
  label: string; // display-safe
  reachable: boolean;
  headBlock?: string;
  chainId?: number; // the network the endpoint actually reports (eth_chainId)
  wideRange: boolean; // getLogs over a wide recent range succeeded
  archive: boolean; // getLogs at archive depth succeeded
  verdict: RpcVerdict;
  reason?: string; // why capped / unusable
}

const RANGE_PROBE = 2000n; // "wide" recent range to test the getLogs window
/**
 * How far back "archive depth" means. Deliberately deep: reconstruction starts at a project's
 * DEPLOY block, so the bar is "can this endpoint still serve a project that is not new?". At 500k
 * blocks that is ~11 days on Base Sepolia (2s blocks) and ~10 weeks on Ethereum Sepolia (12s) —
 * comfortably past the retention window of the pruning public endpoints, and far short of any
 * genuinely archival node. It was 100_000, which sat *inside* the retained window of at least one
 * default endpoint, so the probe passed on a node that could not reconstruct anything older.
 */
const ARCHIVE_DEPTH = 500_000n;
/** How many of a probe block's transactions to try a receipt for before giving up. */
const RECEIPT_TRIES = 3;

export async function probeRpcEndpoints(
  opts: {chainKey?: string; urls?: string[]} = {},
): Promise<RpcProbe[]> {
  const chain = resolveChain(opts.chainKey);
  const urls = opts.urls ?? resolveRpcUrls(opts.chainKey);
  return Promise.all(urls.map((url) => probeOne(chain, url)));
}

async function probeOne(chain: Chain, url: string): Promise<RpcProbe> {
  const probe: RpcProbe = {url, label: redactRpcUrl(url), reachable: false, wideRange: false, archive: false, verdict: 'unusable'};
  const client = createPublicClient({chain, transport: http(url, {retryCount: 0})});

  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch (err) {
    probe.reason = `unreachable: ${firstLine(err)}`;
    return probe;
  }
  probe.reachable = true;
  probe.headBlock = head.toString();

  // network identity — the var names a chain, but the URL behind it could point anywhere.
  // A wrong-network endpoint is unusable regardless of range/archive (and would send writes
  // to the wrong chain), so flag it first and stop.
  try {
    probe.chainId = await client.getChainId();
    if (probe.chainId !== chain.id) {
      probe.verdict = 'unusable';
      probe.reason = `wrong network: reports chain ${probe.chainId}, expected ${chain.id} (${chain.name})`;
      return probe;
    }
  } catch {
    /* some endpoints flake on eth_chainId; fall through to the capability probes */
  }

  // wide recent range — tests the getLogs window (a range cap fails here)
  try {
    await client.getLogs({address: zeroAddress, fromBlock: head > RANGE_PROBE ? head - RANGE_PROBE : 0n, toBlock: head});
    probe.wideRange = true;
  } catch (err) {
    if (!isGetLogsRangeError(err)) probe.reason = firstLine(err); // non-range failure is the telling one
  }

  // archive depth — one block, deep in the past, to isolate archive from range
  const old = head > ARCHIVE_DEPTH ? head - ARCHIVE_DEPTH : 0n;
  const retention = await probeHistoryAt(client, old);
  probe.archive = retention.retained;
  if (!probe.archive && !probe.reason) probe.reason = retention.reason;

  if (!probe.archive) {
    probe.verdict = 'unusable';
    probe.reason = probe.reason ?? 'no archive access — can’t read a project’s deploy block';
  } else if (probe.wideRange) {
    probe.verdict = 'best';
    probe.reason = undefined;
  } else {
    probe.verdict = 'capped';
    probe.reason = probe.reason ?? 'small eth_getLogs range — works via chunking, slower on wide ranges';
  }
  return probe;
}

/**
 * Can this endpoint still serve LOG HISTORY at `blockNumber`?
 *
 * The check this replaced was `getLogs({address: zeroAddress, fromBlock: old, toBlock: old})` and
 * "any non-throw counts as archive access" — which cannot fail on a pruning node. `zeroAddress`
 * never emits logs, so an empty result is what a *perfect* archive node returns too: the assertion
 * had no discriminating power and only caught endpoints that *error* on old blocks. A node that
 * silently answers `[]` for pruned history was graded `best`, and `abx add` then ground through
 * half a million blocks and reconstructed nothing, because a successful empty response is not an
 * error and never fails over to the next endpoint.
 *
 * So assert on something that MUST come back. Blocks are retained by everyone; receipts and the log
 * index are what get pruned. We read the probe block, ask for one of its transactions' receipts, and
 * — when that receipt carries a log — require `getLogs` to return that same log. Measured on two
 * Base Sepolia endpoints at 500k blocks back, same transaction: one returns a receipt with 1 log,
 * the other returns null. That is the discriminator, and it needs no hardcoded address or block.
 *
 * Fails SAFE, in the direction of the old behaviour: when the probe block has no transactions, or
 * the receipt has no logs, there is nothing to assert on, so we fall back to the lenient
 * "getLogs didn't throw" signal rather than manufacturing a failure.
 *
 * Exported for tests — `probeOne` builds its own transport per URL, so the discriminating logic is
 * what gets asserted directly.
 */
export async function probeHistoryAt(
  client: PublicClient,
  blockNumber: bigint,
): Promise<{retained: boolean; reason?: string}> {
  const depth = `~${ARCHIVE_DEPTH} blocks back`; // the FAULT only — each caller words its own remedy
  let txHashes: readonly Hash[] = [];
  try {
    const block = await client.getBlock({blockNumber, includeTransactions: false});
    txHashes = block.transactions.slice(0, RECEIPT_TRIES);
  } catch (err) {
    return {retained: false, reason: `can't read a block ${depth} — ${firstLine(err)}`};
  }

  for (const hash of txHashes) {
    let logAddress: Address | undefined;
    try {
      const receipt = await client.getTransactionReceipt({hash});
      logAddress = receipt.logs[0]?.address;
    } catch (err) {
      // Only a genuine "no such receipt" proves pruning. A rate-limit or a transport blip must NOT
      // become a "history pruned" claim about an endpoint that is actually fine — so anything else
      // falls through to the lenient check below, which is what this function did before.
      if (!looksLikeReceiptMissing(err)) break;
      // The node served the block but not the receipt of a transaction inside it: its history is
      // pruned at this depth. This is exactly what a "recent logs only" endpoint looks like.
      return {
        retained: false,
        reason: `history pruned ${depth} — it serves the block but not the receipts of transactions inside it`,
      };
    }
    if (!logAddress) continue; // nothing to assert on in this tx — try the next
    try {
      const logs = await client.getLogs({address: logAddress, fromBlock: blockNumber, toBlock: blockNumber});
      if (logs.length > 0) return {retained: true};
      return {
        retained: false,
        reason: `log index pruned ${depth} — eth_getLogs returns EMPTY for a block whose receipts still hold logs`,
      };
    } catch (err) {
      return {retained: false, reason: `eth_getLogs failed ${depth} — ${firstLine(err)}`};
    }
  }

  // Inconclusive (no transactions at the probe block, or none of them logged anything): keep the
  // old lenient signal rather than inventing a verdict.
  try {
    await client.getLogs({address: zeroAddress, fromBlock: blockNumber, toBlock: blockNumber});
    return {retained: true};
  } catch (err) {
    return {retained: false, reason: firstLine(err)};
  }
}

/**
 * Does this error mean "that receipt does not exist here" (viem's `TransactionReceiptNotFoundError`,
 * i.e. the node answered `null`) as opposed to "I could not ask" (rate limit, timeout, 5xx)? Only the
 * first is evidence about retention; treating the second as evidence would libel a healthy endpoint.
 */
function looksLikeReceiptMissing(err: unknown): boolean {
  const e = err as {name?: string; message?: string};
  if (e?.name === 'TransactionReceiptNotFoundError') return true;
  return /receipt.*(not be found|not found)|could not be found/i.test(e?.message ?? '');
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split('\n')[0].slice(0, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// eth_call gas cap — the number that decides whether a big on-chain token can be READ
//
// A fixed byte threshold cannot express RPC readability, so this module measures the endpoint.
// `eth_call`, `eth_estimateGas`, and the block gas limit are independent: this function measures the
// first, which bounds off-chain reads such as `tokenURI`.
//
// Note the row for ethereum-sepolia publicnode: it measured 50M one hour and 2000M the next. Pooled
// endpoints rotate between backends with different configs, so a measurement is a point-in-time
// observation of somebody else's infrastructure, never a guarantee. Report it as what it is.
// ─────────────────────────────────────────────────────────────────────────────

/** A contract whose entire body is `GAS; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN` — it returns
 *  the gas the node actually provisioned for the call. Injected via an `eth_call` state override,
 *  so the probe deploys nothing, sends nothing, and needs no key. */
const GAS_REPORTER_CODE = '0x5a60005260206000f3';
/** An address nothing else will occupy, for the state override to write the reporter into. */
const GAS_REPORTER_ADDR = '0x00000000000000000000000000000000000c0de0';
/** Ask for more than any node grants, so the answer is the node's cap rather than our request.
 *  geth clamps silently (it logs "Caller gas above allowance, capping"), which is exactly the
 *  behavior that makes this readable as a measurement. */
const GAS_PROBE_ASK = 2_000_000_000;

/**
 * Measure an endpoint's real `eth_call` gas allowance, or `null` if it can't be determined.
 *
 * Returns `Infinity` when the node applied no cap at all (it handed back everything asked for).
 *
 * `null` is a normal outcome, not an error: an endpoint may reject state overrides, be behind a
 * proxy that strips them, or be unreachable. Callers MUST treat `null` as "unknown" and fall back
 * to {@link ETH_CALL_GAS_FLOOR} for guidance — never as a reason to block anything.
 *
 * Two limits on what this result means, and both belong in anything shown to a creator:
 *   1. It measures what YOUR endpoint serves. It says nothing about the endpoint a marketplace or
 *      an indexer uses, and those are the ones that decide whether the token displays.
 *   2. It is point-in-time. Pooled endpoints rotate between backends with different configs —
 *      ethereum-sepolia publicnode measured 50M and 2000M an hour apart — so this is an
 *      observation of third-party infrastructure, not a property you can rely on tomorrow.
 */
export async function probeEthCallGasCap(url: string, timeoutMs = 6_000): Promise<number | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {to: GAS_REPORTER_ADDR, gas: `0x${GAS_PROBE_ASK.toString(16)}`},
          'latest',
          {[GAS_REPORTER_ADDR]: {code: GAS_REPORTER_CODE}},
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {result?: string; error?: unknown};
    if (typeof body.result !== 'string' || !/^0x[0-9a-f]+$/i.test(body.result)) return null;
    const gas = Number(BigInt(body.result));
    // A node that ignored the override returns 0x (empty) or a nonsense value; a node that honored
    // it reports something in the tens-of-millions. Anything below the floor means the override did
    // not take, not that the node is unusually stingy.
    if (!Number.isFinite(gas) || gas <= 1_000_000) return null;
    // If the node handed back (nearly) everything asked for, it did not clamp — so it is uncapped,
    // or capped somewhere above the ask. Either way GAS_PROBE_ASK is OUR number, not a measurement,
    // and reporting it as the node's cap would be inventing a limit that does not exist.
    return gas >= GAS_PROBE_ASK * 0.99 ? Number.POSITIVE_INFINITY : gas;
  } catch {
    return null;
  }
}

/**
 * The best `eth_call` gas cap available across the configured endpoints — the toolkit fails over
 * between them, so the one that can serve the read is the one that matters. `null` when none could
 * be measured.
 */
export async function probeBestEthCallGasCap(opts: {chainKey?: string; urls?: string[]} = {}): Promise<{
  gasCap: number | null;
  label: string | null;
}> {
  const urls = opts.urls ?? resolveRpcUrls(opts.chainKey);
  const results = await Promise.all(
    urls.map(async (url) => ({label: redactRpcUrl(url), gasCap: await probeEthCallGasCap(url)})),
  );
  const best = results.filter((r) => r.gasCap != null).sort((a, b) => b.gasCap! - a.gasCap!)[0];
  return best ? {gasCap: best.gasCap!, label: best.label} : {gasCap: null, label: null};
}
