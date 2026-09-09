/**
 * Gas limits for a sequenced transaction — decided HERE, once, rather than re-read at signing time.
 *
 * The failure this exists to prevent, in full, because it is not obvious and it cost a reporter every
 * `deploy-code` attempt of a session: a project deploys in two transactions, and the second targets
 * the contract the first just created. If the node answering `eth_estimateGas` has not yet seen the
 * deploy block, the target looks like an account with no code — and an estimate for a call to a
 * codeless account is just the calldata cost, around 200k. That number is then sent as the gas limit.
 * Once the contract does exist the same call needs ~941k, because storing a program on-chain is
 * dominated by CREATE code deposit at ~200 gas per byte. The CREATE receives 63/64 of a budget that
 * cannot cover the deposit, returns 0, and Solady's `SSTORE2.write` reverts `DeploymentFailed()` — a
 * revert that reads like a contract bug and is really an out-of-gas.
 *
 * (Measured, from the real transactions: `gasLimit 201,616 / gasUsed 198,870` and
 * `gasLimit 169,301 / gasUsed 166,810` — 98.6% and 98.5% of their limits. Replaying those payloads
 * against a codeless address reproduces both limits to the gas; against the real contract the same
 * calls estimate at 941,331.)
 *
 * The deploy loop already pinned the *nonce* against exactly this read-after-write lag on a
 * distributed RPC. The rule generalizes, and it is the reason this module exists: **anything read at
 * send time on a distributed RPC needs pinning, not just the nonce.**
 */
import type {Account, Address, Hex, PublicClient, TransactionReceipt, WalletClient} from 'viem';
import type {PreparedTx} from './ops.js';
import {GasEstimateBelowFloorError, TxRevertedError} from './errors.js';

/**
 * Wait until `address` has code from THIS client's point of view. A deploy receipt proves the
 * contract exists on chain; it does not prove the node answering the next request has caught up.
 * Bounded — on timeout we proceed and let the gas floor carry it, since a slow RPC is not a reason
 * to refuse to continue a deploy that already spent money.
 */
export async function waitForCodeAt(client: PublicClient, address: Address, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = await client.getCode({address}).catch(() => undefined);
    if (code && code !== '0x') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 750));
  }
}

/**
 * Decide a transaction's gas limit once, here.
 *
 * The important design point, because the obvious approach is wrong: when an estimate looks too low
 * we do **not** substitute a computed number. A caller can only compute the *provable* part of a
 * payload's cost (see `PreparedTx.gasFloor` — code deposit is 200 gas/byte and nothing else is
 * physics); the same setup multicall also carries schema writes, dependency legs, URI legs and
 * mints, whose cost we cannot derive without simulating them. A "probably enough" constant is a
 * number tuned to whatever case was in front of its author: it papers over the symptom, then
 * under-funds the next payload that carries a few more legs, producing the identical
 * `DeploymentFailed()` with a fresh mystery attached.
 *
 * So the floor is used as a **detector**. An estimate below a provable minimum is not "low", it is
 * *impossible* — proof that the node answering us is looking at the wrong state (typically it has
 * not seen the deploy block yet, so the target reads as an account with no code and the estimate
 * comes back as the calldata cost alone). The right response to a broken measurement is to take it
 * again, and if it stays broken, to refuse — sending a transaction we can prove is under-funded
 * would burn the gas AND orphan the contract.
 *
 * When the estimate IS plausible it is trusted, plus headroom for state drift between estimate and
 * inclusion.
 */
export async function pinGas(
  client: PublicClient,
  tx: {from: Address; to: Address | null; data: Hex; value?: Hex; gasFloor?: Hex},
  opts: {attempts?: number; delayMs?: number} = {},
): Promise<bigint> {
  const floor = tx.gasFloor ? BigInt(tx.gasFloor) : 0n;
  const attempts = opts.attempts ?? 3;
  let lastEstimate: bigint | null = null;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      const estimate = await client.estimateGas({
        account: tx.from,
        to: tx.to ?? undefined,
        data: tx.data,
        ...(tx.value && tx.value !== '0x0' ? {value: BigInt(tx.value)} : {}),
      });
      // Plausible (or nothing provable to check it against) → trust it.
      if (estimate >= floor) return (estimate * 125n) / 100n;
      lastEstimate = estimate;
    } catch (err) {
      lastError = err;
      // A revert during estimation is a real answer about the transaction, not a lagging node —
      // surface it immediately, since its message ("caller is not the owner") is the useful part.
      if (floor === 0n) throw err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 1_500));
  }

  if (lastEstimate !== null) {
    throw new GasEstimateBelowFloorError(lastEstimate, floor);
  }
  throw lastError instanceof Error ? lastError : new Error('gas estimation failed');
}

/** Sign + broadcast one {@link PreparedTx} and return its mined receipt (for event parsing). The
 *  SDK's one send-injection point: a hot key ({@link makeHotSender}), a browser wallet (a
 *  `WalletSession`), or anything else a caller wires up — the SDK never picks or performs the
 *  signing itself. */
export type SendTx = (tx: PreparedTx) => Promise<TransactionReceipt>;

/** Progress from a {@link SendTx} built by {@link makeHotSender}, so a caller can narrate without
 *  the SDK printing anything itself (the SDK never prints — see clients.ts / chunks.ts for the same
 *  `onEvent` pattern). */
export type SendEvent =
  | {kind: 'sending'; tx: PreparedTx}
  | {kind: 'mined'; receipt: TransactionReceipt; tx: PreparedTx};

/**
 * Build a {@link SendTx} that signs with an env-style hot key and broadcasts — the generalization of
 * what used to be hand-rolled per call site (a deploy-then-setup loop in the CLI, the hot lane in
 * `signer.ts`, the chunk-staging sender in `ownerops.ts`): one function that gets the read-after-
 * write-lag handling right ONCE.
 *
 * Two lags, pinned once at construction / tracked locally per send, rather than re-read at send time:
 *   - the NONCE — read once here as `max(pending, latest)`, then incremented locally per tx. Right
 *     after a tx is mined a distributed RPC (e.g. Alchemy, `sepolia.base.org`) can briefly serve a
 *     stale `pending` transaction count (read-after-write lag), so re-fetching it for the NEXT send
 *     in the same sequence risks reusing the just-spent nonce — the tx it already has in the mempool
 *     rejects the duplicate as "replacement transaction underpriced", and that send is silently
 *     lost. The `max` covers the cross-INVOCATION case the local increment cannot see: a node whose
 *     pending view has fallen behind its own head answers the first send of the next `abx` command
 *     with a nonce it has already spent.
 *   - GAS, one field over: a tx after the first in a sequence may target a contract an EARLIER tx in
 *     this same sequence just created. If the node answering `eth_estimateGas` hasn't seen that
 *     block yet, the target looks codeless and the estimate comes back as the calldata cost alone —
 *     see `pinGas` above for the full story (and the measured numbers). So every send after the
 *     first waits for its target's code to be visible before estimating.
 *
 * Every send: wait for code at the target when it's not the first send in this sender's sequence
 * (mirrors the exact rule the deploy-code hot lane hand-rolled: every tx after the first, since the
 * first is what creates what the rest target), pin the gas (a provable floor detector, never a
 * substitute limit), broadcast, wait for the receipt, and throw a typed {@link TxRevertedError} —
 * carrying the tx hash — on a `reverted` status rather than reporting a burned transaction as
 * "confirmed".
 */
export function makeHotSender(args: {
  wallet: WalletClient;
  account: Account;
  publicClient: PublicClient;
  onEvent?: (e: SendEvent) => void;
}): SendTx {
  const {wallet, account, publicClient} = args;
  const notify = args.onEvent ?? (() => {});
  let nonce: number | undefined;
  let sent = 0;

  return async (tx: PreparedTx): Promise<TransactionReceipt> => {
    if (nonce === undefined) {
      // Fetch once, then increment locally per send — see the read-after-write-lag reasoning above.
      //
      // Read BOTH views and take the higher. `pending` is by definition >= `latest` on a coherent
      // node, but a distributed endpoint that has not caught up with its own head serves a *lower*
      // pending count than its own latest-block count — measured on `sepolia.base.org` right after
      // a confirmed write, and never on the publicnode fallback. That is the cross-invocation half
      // of the same lag this sender already handles within one sequence: each `abx` command is a
      // fresh process, so the first send of the NEXT command re-reads a nonce the node has already
      // spent, and the broadcast is rejected as a duplicate — silently, because a viem simulation
      // failure means nothing is ever sent. `max` is correct-or-better in every case: with real
      // pending txs `pending` wins, and against a stale view `latest` floors it.
      const [pending, latest] = await Promise.all([
        publicClient.getTransactionCount({address: account.address, blockTag: 'pending'}),
        publicClient.getTransactionCount({address: account.address, blockTag: 'latest'}),
      ]);
      nonce = Math.max(pending, latest);
    }
    // The SAME lag, one field over: every send after the first in this sender's sequence may target
    // what an earlier send just created.
    if (sent > 0 && tx.to) await waitForCodeAt(publicClient, tx.to);
    const gas = await pinGas(publicClient, {from: account.address, to: tx.to, data: tx.data, value: tx.value, gasFloor: tx.gasFloor});

    notify({kind: 'sending', tx});
    const hash = await wallet.sendTransaction({
      to: tx.to ?? undefined,
      data: tx.data,
      value: tx.value && tx.value !== '0x0' ? BigInt(tx.value) : undefined,
      account,
      chain: wallet.chain,
      nonce,
      gas,
    });
    nonce += 1;
    sent += 1;

    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== 'success') throw new TxRevertedError(tx.op, hash);
    notify({kind: 'mined', receipt, tx});
    return receipt;
  };
}

/** Send a list of prepared txs, in order, via `send`; returns their receipts in the same order.
 *  A small convenience for the common "just run this sequence" case — narration (if any) rides
 *  `send`'s own `onEvent`, not a callback here. */
export async function runPrepared(txs: PreparedTx[], send: SendTx): Promise<TransactionReceipt[]> {
  const receipts: TransactionReceipt[] = [];
  for (const tx of txs) receipts.push(await send(tx));
  return receipts;
}
