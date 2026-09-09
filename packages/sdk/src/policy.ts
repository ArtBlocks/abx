/**
 * The **collection policy** plane: the two permanent-ish promises a collection makes about itself
 * that a buyer prices in and neither standard carries — whether tokens can be destroyed
 * (`burnable()`, opt-in at deploy and fixed thereafter) and how high the resale royalty can ever go
 * (`maxRoyaltyBps()`, owner-set at deploy and reduce-only forever after).
 *
 * Both facts have two lanes, and they are meant to be read as a pair:
 *
 * - **folded** — `ProjectState.burnable` / `.maxRoyaltyBps`, replayed from the log
 *   (`BurnConfigured` / `MaxRoyaltyBpsUpdated`). Works with no RPC beyond the scan, and is the
 *   authoritative tri-state: `null` there means *the spine never stated it*.
 * - **live** — {@link readCollectionPolicy}, two staticcalls, answering for any address whether or
 *   not anything has indexed it.
 *
 * They are allowed to disagree, and a consumer serving both should say so out loud rather than
 * silently picking: a live ceiling BELOW the folded one is almost certainly a reduction that hasn't
 * been indexed yet (the cap is reduce-only, so that direction is expected), while a `burnable` that
 * differs at all is a contradiction — it is emitted once, at deploy, and cannot legitimately move.
 *
 * This module exists because the CLI was declaring its own ABI fragments for both getters and
 * reading them itself, in two places, so no other integrator could reach the facts at all. The SDK
 * owns protocol knowledge; the CLI is a shell over it.
 */
import type {Address, PublicClient} from 'viem';
import {oneOfOneImageAbi} from './abi/index.js';

/**
 * A collection's live policy, read from chain. Both members are tri-state, and `null` is a real
 * answer, not a failure: **the contract did not publish this**. An implementation predating the
 * opt-in has no `burn` entrypoint at all and a hard-coded ceiling — which is a different fact from
 * `burnable: false` (an entrypoint that refuses) or a published ceiling of 1000, and must never be
 * reported as either. `null` also covers "the read did not come back"; a caller that needs to tell
 * those apart has the folded value to compare against (see the module note).
 */
export interface CollectionPolicy {
  /** Can holders destroy their tokens? Fixed at deploy. `null` ⇒ the contract has no such getter. */
  burnable: boolean | null;
  /** The reduce-only royalty ceiling in basis points. `null` ⇒ the contract publishes no ceiling. */
  maxRoyaltyBps: number | null;
}

/**
 * Read {@link CollectionPolicy} live from chain — two cheap staticcalls, no event scan, no indexer.
 * Both getters have the same signature on all six token types (the 721 family and its ERC-1155
 * twins), so one ABI covers every lane.
 */
export async function readCollectionPolicy(client: PublicClient, contract: Address): Promise<CollectionPolicy> {
  const [burnable, maxRoyaltyBps] = await Promise.all([
    client
      .readContract({address: contract, abi: oneOfOneImageAbi, functionName: 'burnable'})
      .then((v) => v as boolean)
      .catch(() => null),
    client
      .readContract({address: contract, abi: oneOfOneImageAbi, functionName: 'maxRoyaltyBps'})
      .then((v) => Number(v as bigint | number))
      .catch(() => null),
  ]);
  return {burnable, maxRoyaltyBps};
}

/**
 * The gap between what a collection charges today and the most it could ever charge without asking
 * anyone — `ceiling − rate`, in basis points. `null` when either number is unknown.
 *
 * Worth surfacing to both sides of a sale, because it is invisible on a listing page: an owner can
 * raise the royalty to the ceiling unilaterally, so headroom is the part of "5% royalty" that isn't
 * a promise yet. The corollary is the useful one for a creator — reducing the cap **to** the current
 * rate (`abx set-royalty-cap`) is what converts "5% today" into "5%, provably, forever."
 */
export function royaltyHeadroomBps(policy: {maxRoyaltyBps?: number | null}, currentBps?: number | null): number | null {
  const cap = policy.maxRoyaltyBps;
  if (cap == null || currentBps == null) return null;
  return Math.max(0, cap - currentBps);
}
