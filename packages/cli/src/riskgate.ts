/**
 * The CLI's one risk gate for a write — the choke point every signing path (owner-op or deploy)
 * routes an already-prepared tx through, so `--dry-run` and `--confirm` behave IDENTICALLY no
 * matter which command reached them.
 *
 * Before this module existed, the same three-part shape (preview-and-stop under `--dry-run` →
 * optional interactive `--confirm` → pick a lane → sign) was hand-written THREE times: ownerops.ts's
 * `runWrite` (every owner-op), a near-identical `runMinterWrite` ("the minter path does not go
 * through runWrite, so it needs its OWN dry-run guard" — its own comment conceding the duplication),
 * and a third copy inline in main.ts's `deploy-code --resume` send path. Each could drift from the
 * others without anyone deciding it should — and the two owner-op copies HAD already drifted: only
 * one of them printed the `owner` line on a dry-run preview when the caller supplied one.
 *
 * `gatedSend` is the merge. Callers that had NO `--confirm` support (every owner-op) gain it for
 * free just by routing through here — there is no owner-op-specific reason they lacked it; it was
 * simply never wired.
 */
import {decodeErrorResult, formatEther, zeroAddress, type PublicClient} from 'viem';
import {createInterface} from 'node:readline';
import {
  assertChainId,
  envSigningKey,
  makePublicClient,
  pinGas,
  seriesCodeAbi,
  GasEstimateBelowFloorError,
  type Address,
  type PreparedTx,
} from '@artblocks/abx-sdk';
import {signTx, type Lane, type SignResult, type TxProvider} from './signer.js';
import {isDryRun, type Flags} from './flags.js';

// ── tiny ANSI (kept local — every module here stands alone; see signer.ts/ownerops.ts) ───────
const C = {reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[38;5;115m', orange: '\x1b[38;5;215m'};
const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const bold = (s: string) => `${C.bold}${s}${C.reset}`;

/** Resolve the signing lane from flags: `--unsigned` (cold) · `--sign` (wallet) · default hot. The
 *  one place this decision is made — every write reads the same three flags the same way. */
export function laneFromFlags(flags: Flags): Lane {
  // Two lane flags at once is always a mistake, and silently picking one is how a caller ends up in a
  // lane they did not choose — an agent writing `--send --sign` from two different help lines gets a
  // browser wallet page when it meant the env key, and reads the wait as a hang. Refuse instead: the
  // precedence order below is an implementation detail, not an interface.
  const named = (['send', 'sign', 'unsigned'] as const).filter((k) => flags[k] !== undefined);
  if (named.length > 1) {
    throw new Error(
      `pick ONE signing lane, not ${named.length}: ${named.map((n) => `--${n}`).join(' and ')}. ` +
        `--send signs with the hot/env key (the default, so it can also be omitted) · --sign opens a ` +
        `wallet page · --unsigned prints the transaction for you to sign elsewhere.`,
    );
  }
  // PRESENCE, not truthiness. A bare `--sign` parses to `'true'`, but `--sign=` parses to `''`, which
  // is falsy — so a truthiness test sent that caller down the hot-key lane after they explicitly named
  // the wallet one. That is the one direction that matters: asking for a browser approval and getting
  // an unattended key signature instead. Naming a lane selects it, full stop.
  if (named.includes('unsigned')) return 'unsigned';
  if (named.includes('sign')) return 'sign';
  return 'send';
}

/**
 * Refuse a real deploy on the HOT lane when there is no key to sign with — before the command has
 * spent anything.
 *
 * The signing lanes are checked at *signing* time, which is the end of a deploy. Everything that
 * makes a deploy possible happens first, and some of it is neither free nor reversible: `--backend
 * arweave|ipfs|cloud` UPLOADS the creator's art before any transaction is prepared. So a deploy run
 * with no key, and no `--dry-run` to say "preview only", would mint an Arweave identity, publish the
 * art, and only THEN discover it could never have deployed. Under Turbo's free tier the upload
 * *succeeds*, so the art is published permanently — an irreversible side effect from a run that was
 * always going to fail.
 *
 * `--dry-run` guards every signing choke point (`isDryRun`, `gatedSend`); this is the same idea one
 * step earlier, and the rule it enforces is the sibling of that one: **a spend or a publish never
 * precedes the check that this run can be signed at all.** Only the hot lane is checked — `--sign`
 * (browser wallet) and `--unsigned` (offline signer) deliberately have no local key, and a preview
 * spends nothing.
 */
export function assertLaneCanSign(flags: Flags): void {
  if (isDryRun(flags)) return; // a preview neither signs nor spends
  if (laneFromFlags(flags) !== 'send') return; // wallet/cold lanes have no local key BY DESIGN
  if (envSigningKey()) return;
  throw new Error(
    'no signing key, so this run could not be sent — stopping before it uploads or spends anything. ' +
      'Pick a lane: --sign --for 0x.. (you approve in your own wallet, no key here) · --unsigned (print the tx ' +
      'for an offline signer) · or set ABX_DEPLOYER_PK in .env for the unattended hot lane. ' +
      'To preview without any of them, add --dry-run --for 0x...',
  );
}

/**
 * Opt-in pre-send confirmation gate (`--confirm`). OFF by default → scripted use is untouched. Even
 * when opted in, it never blocks automation: `--yes` or a non-TTY stdin proceeds silently. Only an
 * interactive `--confirm` prints the summary and waits for a y/N. Aborts on anything but yes.
 */
export async function confirmSend(summary: string, flags: Flags): Promise<void> {
  if (flags.confirm === undefined) return; // not opted in
  if (flags.yes !== undefined || !process.stdin.isTTY) return; // don't stall scripts/CI
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const answer = await new Promise<string>((resolve) => rl.question(`\n  ${summary}\n  Proceed? [y/N] `, resolve));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('aborted at --confirm (nothing sent).');
}

async function resolveProvider(provider: TxProvider, signer: Address): Promise<PreparedTx> {
  return typeof provider === 'function' ? await provider(signer) : provider;
}

function printDryRunPreview(prepared: PreparedTx, expectedSigner?: Address): void {
  console.log(`\n  ${bold('◆ ' + prepared.summary)}  ${dim('(dry run — nothing sent)')}`);
  for (const [k, v] of Object.entries(prepared.fields)) console.log(`    ${dim(k.padEnd(12))} ${v}`);
  console.log(`    ${dim('to'.padEnd(12))} ${prepared.to ?? dim('(contract deploy)')}`);
  if (expectedSigner) console.log(`    ${dim('owner'.padEnd(12))} ${expectedSigner}`);
}

export interface DryRunSimulation {
  /** Three honest states, never collapsed into one another: `would-succeed` is earned (state check
   *  passed AND the signer can afford it), `would-revert` is a proven failure (a state revert OR an
   *  insufficient-funds shortfall — see `reason`), and `unknown` means neither could be established —
   *  it is NOT a synonym for "probably fine" and must never be reported as `would-succeed`. */
  status: 'would-succeed' | 'would-revert' | 'unknown';
  reason?: string;
  /** The gas the REAL send would use, from the same {@link pinGas} `makeHotSender` calls at send
   *  time — never `transaction.gasFloor` (a proven MINIMUM used to detect an implausible estimate,
   *  not a prediction of what the send needs; see `pinGas`'s own doc in execute.ts). Present only
   *  when a real estimate was obtained. Decimal string — a `bigint` doesn't survive `JSON.stringify`. */
  estimatedGas?: string;
  /** `estimatedGas × current gas price`, plus the tx's own value if any — in wei, decimal string. */
  estimatedCostWei?: string;
  /** The signer's current balance, in wei, decimal string — present whenever a balance read was
   *  attempted, so the numbers behind an insufficient-funds verdict are visible even to a caller
   *  that only reads the JSON. */
  balanceWei?: string;
}

/**
 * A revert's own name, when the payload carries one — `RoyaltyTooHigh()` instead of a raw hex dump
 * or "reverted for an unknown reason".
 *
 * Whether we get one is the NODE's choice, not ours: many public endpoints (measured:
 * `base-sepolia-rpc.publicnode.com` and `sepolia.base.org`) answer a failed `eth_call` with a bare
 * `execution reverted` and no data at all. So the no-data case says *that*, rather than implying we
 * looked at a reason and couldn't read it.
 */
export function revertReason(err: unknown): string {
  const data = (err as {data?: unknown; cause?: {data?: unknown}})?.data ?? (err as {cause?: {data?: unknown}})?.cause?.data;
  const hex = typeof data === 'string' ? data : (data as {data?: string} | undefined)?.data;
  if (typeof hex === 'string' && hex.length >= 10) {
    try {
      const decoded = decodeErrorResult({abi: seriesCodeAbi, data: hex as `0x${string}`});
      return `${decoded.errorName}(${(decoded.args ?? []).join(', ')})`;
    } catch {
      /* not one of ours — fall through to the message */
    }
  }
  const short = (err as {shortMessage?: string})?.shortMessage ?? (err as Error)?.message ?? 'reverted';
  // viem's phrasing for "the node sent no revert data" reads like OUR failure to decode. Say what
  // actually happened, and what it almost always means.
  if (/unknown reason/i.test(short)) {
    return 'reverted (this RPC returns no revert data) — usually a precondition the contract enforces: a lock, a cap, or the wrong signer';
  }
  return short;
}

/**
 * Simulate the prepared transaction against current state, and say what would happen — honestly.
 *
 * This is what makes `--dry-run` an *answer* rather than an echo of its own input. It matters most
 * for a **multicall** — `attach`'s batched pairs, `deploy-code`'s setup — because a multicall is one
 * transaction, so simulating it exercises the whole sequence atomically against real state, with no
 * fork and no new surface.
 *
 * A dry run that reports `would-succeed` for a send whose real gas turned out to need 49% more than
 * this function used to check, then failed for real, is a preview asserting an outcome it never
 * established — the same class of bug fixed for `verify --remote --json` (see `cmdVerifyRemote`'s
 * fail-closed comment in commands/project.ts): a payload must not claim success it hasn't earned.
 * Two things had to be true before this could say "would succeed", and neither was checked:
 *   1. The call executes without reverting — the ORIGINAL check (an `eth_call`, now folded into
 *      {@link pinGas} below instead of a separate unconstrained call, so the preview shares the
 *      real send's own gas math, not a second copy of it that could quietly disagree).
 *   2. The signer can actually PAY for it. `estimateGas` succeeding proves the call is valid; it says
 *      nothing about whether the account sending it has the ETH to cover `gas × gasPrice (+ value)`.
 *      A preview that skips this is not "optimistic", it is wrong — the failure this fixes.
 *
 * Reports **unknown**, never a false green, whenever it cannot actually prove EITHER of those: no
 * signer to simulate as, a contract deploy, a target that does not exist yet, an unreachable node, or
 * a gas estimate that comes back below the transaction's provable floor even after retrying (the
 * exact same refusal a real send makes — see {@link GasEstimateBelowFloorError}). `unknown` is never
 * collapsed into `would-succeed` (an optimistic guess) or `would-revert` (a false alarm) — it says
 * plainly that the question could not be answered, and why.
 *
 * `clientOverride` exists for tests: production callers always omit it and get a real client built
 * from `chainKey`, exactly as before.
 */
async function simulateDryRun(
  prepared: PreparedTx,
  chainKey: string,
  expectedSigner?: Address,
  narrate = true,
  clientOverride?: PublicClient,
): Promise<DryRunSimulation> {
  const label = 'simulation'.padEnd(12);
  const unknown = (why: string): DryRunSimulation => {
    if (narrate) console.log(`    ${dim(label)} ${dim(`unknown — ${why}`)}`);
    return {status: 'unknown', reason: why};
  };
  if (!prepared.to) return unknown('this creates a contract; there is nothing to call yet');
  if (!expectedSigner || expectedSigner === zeroAddress) {
    return unknown(
      'no signer known to simulate as the caller — set a signing key, or use --sign; some commands ' +
        '(e.g. deploy, predict) also accept --for 0x..'
    );
  }
  // Everything below is best-effort: a dry run must work OFFLINE and against an unknown chain (the
  // preview is the product; the simulation is a bonus). So even constructing the client is guarded —
  // `resolveChain` throws on a chain key it doesn't know, and that must degrade to `unknown`, never
  // turn a preview into a failure.
  let client: PublicClient;
  try {
    client = clientOverride ?? makePublicClient({chainKey});
  } catch (err) {
    return unknown(`could not run the simulation (${revertReason(err)})`);
  }
  try {
    const code = await client.getCode({address: prepared.to});
    if (!code || code === '0x') return unknown(`${prepared.to} has no code yet on this chain`);
  } catch (err) {
    return unknown(`could not run the simulation (${revertReason(err)})`);
  }

  // Reuse the REAL send's own gas selection (`pinGas`, execute.ts — the exact function
  // `makeHotSender` calls at send time) instead of a second, separately-written `eth_call`. Two
  // benefits: (a) the preview can never independently drift from what the send would actually do,
  // and (b) a transaction whose real send would REFUSE (every estimate attempt below the provable
  // floor) is reported as such here too, rather than "succeeding" against an unconstrained call.
  let gas: bigint;
  try {
    gas = await pinGas(client, {
      from: expectedSigner,
      to: prepared.to,
      data: prepared.data,
      value: prepared.value,
      gasFloor: prepared.gasFloor,
    });
  } catch (err) {
    if (err instanceof GasEstimateBelowFloorError) {
      // Not a contract-logic revert and not a network hiccup — this is "cannot be determined safe",
      // the same refusal a real send makes. Reported as `unknown`, never folded into `would-revert`
      // (nothing was proven to revert) or `would-succeed` (nothing was proven safe either).
      return unknown(
        `the gas estimate (${err.estimate}) came back below the ${err.floor} this transaction provably needs, ` +
          `even after retrying — the same reason a real send would refuse rather than risk an under-funded ` +
          `transaction. Retry in a few seconds, or against a different RPC.`,
      );
    }
    const reason = revertReason(err);
    // A node that cannot answer is not a failing transaction — do not report one as the other.
    if (/fetch|network|timeout|ECONN|unknown chain/i.test(reason)) return unknown(`could not run the simulation (${reason})`);
    if (narrate) {
      console.log(`    ${dim(label)} ${C.orange}✗ would REVERT${C.reset} — ${reason}`);
      console.log(`    ${dim(''.padEnd(12))} ${dim('sending this now would burn gas and change nothing.')}`);
    }
    return {status: 'would-revert', reason};
  }

  // The call is provably executable at `gas` — what's left is whether the signer can actually PAY
  // for it. This is the check that was missing entirely: a preview that never compares cost against
  // balance is asserting an outcome it has not earned.
  let gasPrice: bigint;
  let balance: bigint;
  try {
    [gasPrice, balance] = await Promise.all([client.getGasPrice(), client.getBalance({address: expectedSigner})]);
  } catch (err) {
    // We proved the call itself would succeed; we just can't price it. Say so — do NOT fall back to
    // a bare "would succeed" that quietly drops the affordability question it was just asked.
    return unknown(`the call would succeed, but the cost to send it could not be priced (${revertReason(err)})`);
  }
  const value = prepared.value && prepared.value !== '0x0' ? BigInt(prepared.value) : 0n;
  const cost = gas * gasPrice + value;
  const priced = {estimatedGas: gas.toString(), estimatedCostWei: cost.toString(), balanceWei: balance.toString()};

  if (balance < cost) {
    const reason =
      `insufficient funds — this send needs ≈${formatEther(cost)} ETH (${gas} gas × ${formatEther(gasPrice)} ` +
      `ETH/gas${value > 0n ? ` + ${formatEther(value)} ETH value` : ''}) but ${expectedSigner} has only ` +
      `${formatEther(balance)} ETH — short by ${formatEther(cost - balance)} ETH.`;
    if (narrate) {
      console.log(`    ${dim(label)} ${C.orange}✗ would FAIL${C.reset} — ${reason}`);
      console.log(`    ${dim(''.padEnd(12))} ${dim('sending this now would run out of funds before it lands.')}`);
    }
    return {status: 'would-revert', reason, ...priced};
  }
  if (narrate) {
    console.log(
      `    ${dim(label)} ${C.green}✓${C.reset} would succeed ${dim(`(≈${gas} gas, ≈${formatEther(cost)} ETH — signer holds ${formatEther(balance)} ETH)`)}`,
    );
  }
  return {status: 'would-succeed', ...priced};
}

export interface GatedSendOptions {
  chainKey: string;
  /** The address that must sign (onlyOwner / token holder) — shown to the human, guards the hot
   *  lane, and (when set) printed on the dry-run preview. */
  expectedSigner?: Address;
  /** Test-only seam: a pre-built client for the dry-run simulation, instead of one `simulateDryRun`
   *  would otherwise construct from `chainKey`. Every production caller omits this. */
  client?: PublicClient;
}

/**
 * The one send choke point for a SINGLE already-prepared write: `--dry-run` preview (nothing sent,
 * returns `null`) → optional `--confirm` prompt → lane selection → `signTx`. Every caller — an
 * owner-op's `runWrite`/`runMinterWrite`, or the deploy family's resumed-setup send — resolves to
 * this, so the two families can never again each carry their own (possibly diverging) idea of what
 * `--dry-run` or `--confirm` means. The historical bug class this forecloses structurally: a write
 * reaching the send lane under `--dry-run` because some caller re-derived the check by hand and
 * missed a branch.
 */
export async function gatedSend(provider: TxProvider, flags: Flags, opts: GatedSendOptions): Promise<SignResult | null> {
  if (isDryRun(flags)) {
    const prepared = await resolveProvider(provider, opts.expectedSigner ?? zeroAddress);
    if (flags.json !== undefined) {
      const simulation = await simulateDryRun(prepared, opts.chainKey, opts.expectedSigner, false, opts.client);
      console.log(JSON.stringify({
        dryRun: true,
        sent: false,
        lane: laneFromFlags(flags),
        expectedSigner: opts.expectedSigner ?? null,
        transaction: prepared,
        // `transaction.gasFloor` (when present) is a PROVEN MINIMUM used to detect an implausible
        // gas estimate — not a prediction of total cost. `simulation.estimatedGas`/`estimatedCostWei`
        // are the real numbers, from the same gas selection the send itself uses; trust those.
        simulation,
      }, null, 2));
    } else {
      printDryRunPreview(prepared, opts.expectedSigner);
      await simulateDryRun(prepared, opts.chainKey, opts.expectedSigner, true, opts.client);
      console.log(dim(`\n  Re-run without --dry-run to send (lane: ${laneFromFlags(flags)}).\n`));
    }
    return null;
  }
  await assertChainId(opts.chainKey); // verify the RPC really is the target chain before any irreversible write
  const preview = await resolveProvider(provider, opts.expectedSigner ?? zeroAddress);
  await confirmSend(preview.summary, flags);
  return signTx(provider, {
    lane: laneFromFlags(flags),
    chainKey: opts.chainKey,
    expectedSigner: opts.expectedSigner,
    yes: !!flags.yes,
    port: flags.port ? Number(flags.port) : undefined,
    signUrlFile: flags['sign-url-file'],
  });
}
