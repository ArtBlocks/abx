/**
 * ERC-721C creator-token support — the opt-in transfer-validation surface.
 *
 * An ABX token enrolls at deploy, permanently, by passing a non-zero `transferValidator` in
 * its InitParams (see `deploy.ts`); zero leaves a plain ERC-721 forever, indistinguishable
 * from a pre-721C token (ERC-165 and the extension beacon both branch on enrollment). Within
 * an enrolled token the owner re-points the validator freely or suspends enforcement with
 * zero — never un-enrolls. Every transfer that isn't a mint/burn (or the validator's own)
 * staticcalls `validateTransfer(caller, from, to, tokenId)` on the validator; a policy
 * violation reverts and bubbles.
 *
 * **`setTransferValidator` is owner-only only while the collection has an owner.** Once
 * `owner() == address(0)` the contract opens one asymmetric door: **anyone** may suspend
 * enforcement by passing `zeroAddress`, and nobody — including that caller — may ever arm a
 * validator again. That is the dead-man release for the worst reachable state (a validator that
 * reverts every transfer on a collection with nobody left to re-point it, which would otherwise
 * strand every collector's token forever). An integrator building for collectors should expose
 * that suspension path on a renounced collection rather than gating it behind an owner check that
 * can no longer be satisfied — see {@link prepareSetTransferValidator}.
 */
import {encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import {oneOfOneImageAbi} from './abi/index.js';
import type {PreparedTx} from './ops.js';

/** ERC-165 id of `ICreatorToken` — advertised (with the legacy id) only when enrolled. */
export const CREATOR_TOKEN_INTERFACE_ID = '0xad0d7f6c' as const;
/** ERC-165 id of `ICreatorTokenLegacy` — the subset older marketplaces probe for. */
export const CREATOR_TOKEN_LEGACY_INTERFACE_ID = '0xa07d229a' as const;
/** keccak256("abx.extension.creator-token") — `extensionVersion(id)` is 1 only when enrolled. */
export const CREATOR_TOKEN_EXTENSION_ID =
  '0x0839e7ed7fc1f5db3f253851d61b10f852045c5520c2936138b121b73e7e27c0' as const;

/**
 * The recommended transfer validator per chain — OpenSea's
 * **StrictAuthorizedTransferSecurityRegistry**, the validator their creator-fee-enforcement
 * doc recommends for enforcement eligibility (docs.opensea.io "Creator Fee Enforcement"; the named
 * alternative is Limit Break's CreatorTokenTransferValidator
 * 0x721C0078c2328597Ca70F5451ffF5A7B38D4E947). Verified empirically against the live contracts with
 * `cast call --from <collection>` on the 4-arg
 * `validateTransfer(address,address,address,uint256)` overload, both chains):
 * an owner-initiated (OTC) transfer succeeds; an unauthorized operator reverts
 * `StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()`.
 *
 * CREATE2-style vanity address, identical on both shipped chains — kept per-chain anyway
 * (keyed like `deployments.ts`) because presence-on-chain is the fact that matters, and a
 * future chain may recommend a different validator.
 */
export const RECOMMENDED_TRANSFER_VALIDATOR: Record<number, Address> = {
  // Sepolia (testnet)
  11155111: '0xA000027A9B2802E1ddf7000061001e5c005A0000',
  // Base Sepolia (testnet)
  84532: '0xA000027A9B2802E1ddf7000061001e5c005A0000',
};

/** The recommended validator for a chain (undefined if none is known — never guess one). */
export function resolveRecommendedTransferValidator(chainId: number): Address | undefined {
  return RECOMMENDED_TRANSFER_VALIDATOR[chainId];
}

/** A token's creator-token (ERC-721C) status, read from chain. */
export interface CreatorTokenStatus {
  /** True iff the token enrolled at deploy (permanent). False = plain ERC-721, forever. */
  enrolled: boolean;
  /** The active validator (`zeroAddress` when unenrolled, or enrolled-but-suspended). */
  validator: Address;
}

/**
 * Read whether `contract` is an enrolled ERC-721C creator token, and its active validator.
 * Enrollment comes from ERC-165 (`ICreatorToken`, which the token advertises only when
 * enrolled); the validator from `getTransferValidator()`. Both reads are defensive — a
 * pre-721C ABX token has neither branch (no `getTransferValidator` selector at all), and
 * must read as `{enrolled: false, validator: zeroAddress}`, not as an error.
 */
export async function readCreatorTokenStatus(
  client: PublicClient,
  contract: Address,
): Promise<CreatorTokenStatus> {
  const [enrolled, validator] = await Promise.all([
    client
      .readContract({
        address: contract,
        abi: oneOfOneImageAbi,
        functionName: 'supportsInterface',
        args: [CREATOR_TOKEN_INTERFACE_ID],
      })
      .catch(() => false) as Promise<boolean>,
    client
      .readContract({address: contract, abi: oneOfOneImageAbi, functionName: 'getTransferValidator'})
      .catch(() => zeroAddress) as Promise<Address>,
  ]);
  return {enrolled, validator};
}

/** What {@link probeTransferValidator} found. Only `ok` may be written to a live collection.
 *
 *  - `ok`                  — the address has code and refuses a selector no validator implements,
 *                            which is what every live validator does (see the probe's doc).
 *  - `no-code`             — nothing deployed at this address on this chain. Enforcement would read
 *                            as ON everywhere and check nothing.
 *  - `permissive-fallback` — it has code, but it answers an unknown selector *successfully*. A
 *                            Safe, an uninitialised proxy, or a 7702-delegated EOA does this, and
 *                            because `validateTransfer` returns nothing there is no ABI decode to
 *                            fail — so every transfer would silently pass validation.
 *  - `unreachable`         — the RPC didn't answer. Says nothing about the address; retry.
 */
export type TransferValidatorVerdict = 'ok' | 'no-code' | 'permissive-fallback' | 'unreachable';

/** The result of {@link probeTransferValidator} — verdict plus what was observed, for a message. */
export interface TransferValidatorProbe {
  verdict: TransferValidatorVerdict;
  address: Address;
  /** First line of the revert/transport error, when there was one. */
  error?: string;
}

/**
 * A selector no transfer validator implements — the probe question. Same constant the contract's
 * own `_requireHasCode` uses, so the SDK and the chain agree about which addresses are refused.
 */
const NOT_A_VALIDATOR_SELECTOR = '0xa9b1c2d3' as Hex;

/**
 * Ask a candidate transfer validator a question no validator can answer, and require it to FAIL.
 *
 * **`code.length > 0` is not enough**, which is why this exists and why the on-chain guard was
 * rewritten to match. Two shapes enforce nothing while every read surface — ERC-165,
 * `getTransferValidator()`, the extension beacon — reports enforcement as on: no code at all, and a
 * *permissive fallback* that succeeds for any selector. `validateTransfer` returns nothing, so
 * there is no ABI decode to fail; a Safe (its `FallbackManager.fallback()` returns empty when no
 * handler is set), an uninitialised proxy, and an EIP-7702-delegated EOA all pass a has-code check
 * and then wave every transfer through. A creator pasting their own Safe is the likely real case.
 *
 * So the probe inverts the question: a real validator **reverts** here (verified against OpenSea's
 * SATSR and three Limit Break deployments on mainnet and Sepolia), and a permissive one returns
 * empty success. This mirrors the contract exactly — the same selector, the same "must fail" rule —
 * so an address that passes here is an address the token will accept, and the CLI stops reporting
 * "no code on this chain" for an address that plainly has code.
 *
 * An ERC-165 gate was measured and rejected: none of those four live validators advertises
 * `ITransferValidator`/`ITransferValidator1155`, so requiring an id would refuse the entire
 * ecosystem, including the validator ABX itself recommends.
 *
 * **A misconfiguration guard, not a security boundary** — a contract can always be written to pass
 * this and enforce nothing. It catches the honest mistake. Never throws for an on-chain reason:
 * every failure is a verdict (mirrors `probeSeedSource`).
 */
export async function probeTransferValidator(
  client: PublicClient,
  validator: Address,
  /** The enrolling/enrolled token, when known — the probe is made as the token, because that is
   *  the `msg.sender` the contract's own staticcall presents. */
  opts: {as?: Address} = {},
): Promise<TransferValidatorProbe> {
  let code: Hex | undefined;
  try {
    code = await client.getCode({address: validator});
  } catch (err) {
    return {verdict: 'unreachable', address: validator, error: firstLine(err)};
  }
  if (!code || code === '0x') return {verdict: 'no-code', address: validator};
  try {
    await client.call({
      to: validator,
      data: NOT_A_VALIDATOR_SELECTOR,
      ...(opts.as ? {account: opts.as} : {}),
    });
  } catch (err) {
    // A revert is the PASS: this is what a real validator does with an unknown selector. A
    // transport failure lands here too, so classify it rather than calling a broken RPC "ok".
    return isTransportFailure(err)
      ? {verdict: 'unreachable', address: validator, error: firstLine(err)}
      : {verdict: 'ok', address: validator};
  }
  return {verdict: 'permissive-fallback', address: validator};
}

/** First line of an error message — a revert reason is readable; viem's full dump is not. */
function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0].trim();
}

/** Distinguish "the node said this call reverted" (a verdict) from "the node didn't answer" (retry).
 *  viem reports a revert as an execution error carrying revert data or the word itself; anything
 *  that never reached execution (timeout, socket, HTTP status, rate limit) must not read as a pass. */
function isTransportFailure(err: unknown): boolean {
  const name = (err as {name?: string})?.name ?? '';
  const msg = String((err as Error)?.message ?? err);
  if (/execution reverted|reverted with|revert reason|InvalidTransferValidator/i.test(msg)) return false;
  return (
    /Timeout|Socket|Network|HttpRequest|Connection|RateLimit|InternalRpc|LimitExceeded/i.test(name) ||
    /timed? out|timeout|socket hang up|ECONN|fetch failed|status code|too many requests|rate limit/i.test(msg)
  );
}

/**
 * Re-point an enrolled token's transfer validator, or suspend enforcement with
 * `zeroAddress` (the token stays enrolled). Reverts `NotCreatorToken()` on a token that didn't
 * enroll at deploy — enrollment can never be added later — and `InvalidTransferValidator()` on a
 * validator the chain's own probe refuses (no code on this chain, **or** a permissive fallback that
 * would enforce nothing); call {@link probeTransferValidator} first and refuse those before gas.
 *
 * **Who may sign:** the owner, while there is one. On a collection whose `owner()` is
 * `address(0)`, **any** signer may send this with `validator = zeroAddress` to suspend enforcement
 * permanently — the dead-man release described in this module's header. Arming a validator is still
 * owner-only, so an ownerless collection can only move toward transferability, never back. A UX for
 * collectors should offer that suspension when it sees a renounced, enforcing collection; gating it
 * on `owner()` would hide the one recovery a stranded holder has.
 */
export function prepareSetTransferValidator(args: {
  contract: Address;
  validator: Address;
  chainId: number;
}): PreparedTx {
  const suspending = args.validator === zeroAddress;
  return {
    op: 'set-transfer-validator',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setTransferValidator',
      args: [args.validator],
    }),
    value: '0x0',
    chainId: args.chainId,
    summary: suspending
      ? 'Suspend ERC-721C transfer enforcement (validator → 0x0; the token stays enrolled)'
      : `Set ERC-721C transfer validator → ${args.validator}`,
    fields: {contract: args.contract, validator: args.validator},
  };
}
