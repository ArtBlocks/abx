import {zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import {editionCodeAbi, seriesCodeAbi} from './abi/index.js';
import {readParamSchema} from './ops.js';
import {AUTH_OPTIONS, decodeTag, encodeTag, PARAM_TYPES} from './spine.js';
import {decodeParam} from './tokendata.js';
import type {ParamSchema, ParamValue} from './types.js';

/**
 * The whole collection's tokens — seeds, owners, and params — read **from chain alone**.
 *
 * No indexer projection, no event scan, no running resolver: every input is a plain `eth_call`
 * against the token contract, because the params store maintains its own key lists inside its
 * write paths (`tokenParamKeys` / `contractParamKeys`) and the seed is just a reserved param.
 * That matters for the question this answers — *for a generative collection the seed list IS the
 * collection* — since it means the answer is available to anyone with an RPC URL, including
 * before any indexing has happened, and it can never disagree with the chain.
 *
 * Deliberately not built on {@link reconstructProject}: that folds the event spine (a `getLogs`
 * range scan, which a range-capped RPC can refuse) to recover *structure*. Here every value
 * wanted is a head read, so a scan would be strictly more fragile for strictly less.
 */

/** The reserved param the seed source writes at mint. Never in the enumerable key lists (every
 *  consumer reads it as a tokenData coordinate), so it is read by name. */
const SEED_KEY = 'seed';

/** How many tokens to read concurrently. Each token costs ~2 + (params) `eth_call`s, so a
 *  1000-token collection is a few thousand reads — wide enough to be quick, narrow enough that a
 *  free-tier RPC doesn't rate-limit. */
const DEFAULT_CONCURRENCY = 8;

export interface TokenRow {
  tokenId: string;
  /** `null` when `ownerOf` reverts — see {@link lifecycle}, which says WHY it reverted whenever the
   *  chain gives enough evidence to tell. Always `null` on an ERC-1155 edition: an id can have many
   *  concurrent holders, and *which* holders is not chain-enumerable outside the event log (that's
   *  the indexer's job, not a head read). */
  owner: Address | null;
   /**
   * Does a token exist at this id right now — from head reads alone, no event log. The same words the
   * fold uses ({@link TokenState.lifecycle}), plus `'unknown'` for the one case where a head read
   * genuinely cannot say and the log can:
   *
   * - `'live'` — `ownerOf` answered (721), or `totalSupply(id) > 0` (edition).
   * - `'burned'` — 721 only, terminal, and *decidable at head*: `nextTokenId` is a mint frontier that
   *   only ever rises, so an id BELOW it whose `ownerOf` reverts was minted and destroyed. A listing
   *   enumerates `0 … nextTokenId - 1`, so inside that range a revert IS a burn.
   * - `'unminted'` — 721: at or past the frontier, never issued.
   * - `'no-live-copies'` — editions: `totalSupply(id) == 0`. **The same word the fold uses for the
   *   same id**, deliberately: the fold could distinguish never-minted from fully-burned and does not,
   *   because the distinction has no consumer (the id can mint again either way). One field name, one
   *   value per id, whichever lane produced it.
   * - `'unknown'` — a 1/1 exposes no `nextTokenId`, so a reverting `ownerOf` there is evidence of
   *   nothing: it is equally consistent with never-minted and with burned. The log settles it; a head
   *   read must not guess. This is the *only* remaining case, and it is why the word exists.
   *
   * The first draft had this lane answer `'unknown'` for an edition at zero while the fold answered
   * `'burned'` for the same id — two values under one field name, which is the sibling-drift class
   * this repo treats as a bug (see {@link TokenState.maxSupply}'s note). Splitting `'burned'` from
   * `'no-live-copies'` is what makes the claim true instead of aspirational.
   */
  lifecycle: 'live' | 'burned' | 'unminted' | 'no-live-copies' | 'unknown';
  /**
   * The mint-time seed as the raw `bytes32` — exactly what `tokenData` carries. A schema is what
   * buys a human decode and `seed` deliberately has none, so raw hex IS its canonical form.
   * `null` ⇒ no seed set for this token (no seed source, or not minted).
   */
  seed: Hex | null;
  /**
   * Token-scope params, decoded to their canonical strings. Contract-scope params are listed once
   * on {@link TokenListing.contractParams} rather than repeated per row; the work sees
   * contract ∪ token with **token winning** (see `buildTokenData`, the canonical assembly).
   */
  params: Record<string, string>;
  /** ERC-1155 editions only — this id's live supply (`totalSupply(id)`), as a decimal string.
   *  Absent on a 721 token. */
  supply?: string;
  /** ERC-1155 editions only — this id's current supply cap (`maxSupply(id)`; `"0"` reads as
   *  open/uncapped exactly like the contract's own convention). Absent on a 721 token. */
  maxSupply?: string;
}

/** What an edition id's cap actually means. `closed` is the state the on-chain getter cannot express
 *  (`maxSupply(id)` returns `0` for both "never capped" and "deliberately closed") — see
 *  {@link editionCapOf}. */
export type EditionCap = {kind: 'open'} | {kind: 'capped'; cap: string} | {kind: 'closed'};

/**
 * Read an edition id's cap without re-deriving the rule at each call site — the derivation this
 * protocol got wrong twice, in opposite directions: the on-chain getter overloads `0`, and the
 * event fold used to miss the collection default entirely.
 *
 * Pass a folded {@link TokenState} (from `reconstructProject`) to get all three states. Pass a
 * head-read {@link TokenRow}, which has no `maxSupplyOverridden` because a state read cannot know
 * it, and a `'0'` cap reads `open` — the documented on-chain convention, and the reason
 * `IAbxEditionSupply` tells an integrator rendering a buy button to consult the log.
 *
 * `null` ⇒ no cap information at all (a 721 token, or a row from a projection written before
 * `DefaultMaxSupplySet` was folded).
 */
export function editionCapOf(token: {maxSupply?: string; maxSupplyOverridden?: boolean}): EditionCap | null {
  if (token.maxSupply === undefined) return null;
  if (token.maxSupply !== '0') return {kind: 'capped', cap: token.maxSupply};
  return token.maxSupplyOverridden ? {kind: 'closed'} : {kind: 'open'};
}

export interface TokenListing {
  chainId: number;
  address: Address;
  /** Ids `0 … nextTokenId - 1` have been minted at some point. `null` on a token type with no
   *  sequential mint frontier — a 1/1 (always just token 0), or an ERC-1155 edition (ids are
   *  caller-named, not a cursor; see each row's own `supply`/`maxSupply` instead). */
  nextTokenId: number | null;
  /** Live supply (mints − burns) — differs from `nextTokenId` only if tokens were burned. `null`
   *  on an edition: there's no unconditional whole-contract total, only a per-id one (each row's
   *  `supply`). */
  totalSupply: number | null;
  /** How many tokens have been destroyed: `nextTokenId − totalSupply`, both of which the contract
   *  keeps (the frontier counts mints and never falls; the total counts live tokens). `null` when
   *  either is absent — a 1/1, or an edition, where burns are per id (each row's `supply`). */
  burnedCount: number | null;
  maxInvocations: number | null;
  /**
   * Whether the contract exposes the params surface at all. `false` for the image token types
   * (they have no Params extension), in which case every row's `seed` is `null` and `params` is
   * empty — correct, not a failed read.
   */
  hasParams: boolean;
  /** Whether the contract exposes on-chain param *enumeration*. `false` on a project deployed
   *  before enumeration shipped: seeds still read (by name), but params can't be listed. */
  hasParamEnumeration: boolean;
  contractParams: Record<string, string>;
  tokens: TokenRow[];
}

export interface ListTokensOptions {
  /** Read only this many ids from `from` (default: all). */
  limit?: number;
  /** First token id to read (default 0). */
  from?: number;
  concurrency?: number;
  /** Called after each token resolves — for a progress line on a large collection. */
  onProgress?: (done: number, total: number) => void;
}

/** Minimal ERC-165 fragment — shared by any capability check that only needs `supportsInterface`
 *  (no need to pull in a whole token ABI just for this one function). */
const ERC165_PROBE_ABI = [
  {
    type: 'function',
    name: 'supportsInterface',
    stateMutability: 'view',
    inputs: [{name: 'interfaceId', type: 'bytes4'}],
    outputs: [{name: '', type: 'bool'}],
  },
] as const;

/** The standard's own ERC-165 id — the cheapest capability check that can never collide with a
 *  721 token (which doesn't implement ERC-1155 at all, so this reverts/returns false there). */
const ERC1155_INTERFACE_ID = '0xd9b67a26' as const;

/** Whether `address` is an ERC-1155 edition (vs. the 721 family) — the probe {@link listTokens}
 *  branches on before choosing its read path. */
async function probeIsEdition(client: PublicClient, address: Address): Promise<boolean> {
  try {
    return (await client.readContract({
      address,
      abi: ERC165_PROBE_ABI,
      functionName: 'supportsInterface',
      args: [ERC1155_INTERFACE_ID],
    })) as boolean;
  } catch {
    return false;
  }
}

/** Every token's owner, seed, and params, straight from the contract. */
export async function listTokens(
  client: PublicClient,
  address: Address,
  opts: ListTokensOptions = {},
): Promise<TokenListing> {
  if (await probeIsEdition(client, address)) return listEditionTokens(client, address, opts);

  const read = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T | null> => {
    try {
      // dynamic dispatch over the superset ABI — cast past viem's literal-name inference. Every
      // getter here is absent on at least one token type, so the try/catch IS the capability probe.
      return (await client.readContract({address, abi: seriesCodeAbi, functionName, args} as never)) as T;
    } catch {
      return null; // absent on this token type, or an unminted id — the caller decides what that means
    }
  };

  const [chainId, nextTokenId, totalSupply, maxInvocations, contractKeys] = await Promise.all([
    client.getChainId(),
    read<bigint>('nextTokenId'),
    read<bigint>('totalSupply'),
    read<bigint>('maxInvocations'),
    read<readonly Hex[]>('contractParamKeys'),
  ]);

  // The params surface is probed by a read that only a params-bearing token answers. `seed` is the
  // cheapest such probe that works on a LEGACY project too (deployed before enumeration shipped),
  // so the two capabilities are detected separately rather than collapsed.
  const seedProbe = await read<readonly [Hex, boolean, boolean]>('tokenParam', [0n, encodeTag(SEED_KEY)]);
  const hasParams = seedProbe !== null || contractKeys !== null;
  const hasParamEnumeration = contractKeys !== null;

  // Schemas are read once per key and shared across every token — on a 1000-token collection this
  // is the difference between one read per key and one per key PER TOKEN.
  const schemaCache = new Map<string, Promise<ParamSchema | undefined>>();
  const schemaOf = (key: string): Promise<ParamSchema | undefined> => {
    let hit = schemaCache.get(key);
    if (!hit) {
      hit = schemaFor(client, address, key);
      schemaCache.set(key, hit);
    }
    return hit;
  };

  const contractParams: Record<string, string> = {};
  for (const raw of contractKeys ?? []) {
    const key = decodeTag(raw);
    const slot = await read<readonly [Hex, boolean, boolean]>('contractParam', [raw]);
    if (!slot?.[2]) continue; // not set
    const p: ParamValue = {key, value: slot[0], valueIsHash: slot[1], updatedBy: address};
    contractParams[key] = (await decodeParam(client, address, '0', p, false, await schemaOf(key))).value;
  }

  // The id range — an ID SPACE, never a live count. `nextTokenId` is the mint frontier; a token type
  // without one is a 1/1, whose id space is token 0 alone and stays that way forever.
  //
  // This used to fall back to `totalSupply`, which is live (mints − burns): burn a 1/1's only token
  // and the listing enumerated ZERO ids, so `abx tokens` on a burned 1/1 printed nothing at all —
  // indistinguishable from a collection with no tokens, when the honest answer is one id whose state
  // the chain cannot pin down (see {@link TokenRow.lifecycle}'s `'unknown'`). Found by burning a real
  // token on Sepolia rather than by a fixture, which is the only way this one shows up.
  const count = nextTokenId !== null ? Number(nextTokenId) : 1;
  const from = Math.max(0, opts.from ?? 0);
  const end = opts.limit === undefined ? count : Math.min(count, from + Math.max(0, opts.limit));
  const ids = Array.from({length: Math.max(0, end - from)}, (_, i) => from + i);

  let done = 0;
  const tokens = await pool(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    const tokenId = String(id);
    const [owner, seedSlot, keys] = await Promise.all([
      read<Address>('ownerOf', [BigInt(id)]),
      hasParams ? read<readonly [Hex, boolean, boolean]>('tokenParam', [BigInt(id), encodeTag(SEED_KEY)]) : null,
      hasParamEnumeration ? read<readonly Hex[]>('tokenParamKeys', [BigInt(id)]) : null,
    ]);

    const params: Record<string, string> = {};
    for (const raw of keys ?? []) {
      const key = decodeTag(raw);
      const slot = await read<readonly [Hex, boolean, boolean]>('tokenParam', [BigInt(id), raw]);
      if (!slot?.[2]) continue;
      const p: ParamValue = {key, value: slot[0], valueIsHash: slot[1], updatedBy: address};
      params[key] = (await decodeParam(client, address, tokenId, p, true, await schemaOf(key))).value;
    }

    opts.onProgress?.(++done, ids.length);
    // With a frontier, a missing owner below it is a burn — without one (a 1/1), it is not evidence.
    const lifecycle: TokenRow['lifecycle'] = owner
      ? 'live'
      : nextTokenId === null
        ? 'unknown'
        : BigInt(id) < nextTokenId
          ? 'burned'
          : 'unminted';
    return {tokenId, owner, lifecycle, seed: seedSlot?.[2] ? seedSlot[0] : null, params} satisfies TokenRow;
  });

  return {
    chainId,
    address,
    nextTokenId: nextTokenId === null ? null : Number(nextTokenId),
    totalSupply: totalSupply === null ? null : Number(totalSupply),
    burnedCount: nextTokenId === null || totalSupply === null ? null : Number(nextTokenId - totalSupply),
    maxInvocations: maxInvocations === null ? null : Number(maxInvocations),
    hasParams,
    hasParamEnumeration,
    contractParams,
    tokens,
  };
}

/**
 * The edition (ERC-1155) path {@link listTokens} delegates to once {@link probeIsEdition} says
 * yes — a parallel implementation, not a set of `if (isEdition)` branches threaded through the
 * 721 path above, so that path stays byte-identical. Reads against `editionCodeAbi` (the
 * narrowest-common-superset ABI for the family, same role `seriesCodeAbi` plays on the 721
 * side): per id, `totalSupply(id)`/`maxSupply(id)` instead of `ownerOf` — `owner` is always
 * `null` here (a multi-holder id has no single owner, and *which* holders isn't chain-enumerable
 * outside the event log). `params`/`seed` still apply — EditionCode composes the same Params/
 * ConfigurableParams extensions as SeriesCode, unchanged — but are absent (every read reverts,
 * same honest "absent" answer as a 1/1 image) on `OneOfOneEdition`/`EditionImage`.
 */
async function listEditionTokens(
  client: PublicClient,
  address: Address,
  opts: ListTokensOptions,
): Promise<TokenListing> {
  const read = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T | null> => {
    try {
      return (await client.readContract({address, abi: editionCodeAbi, functionName, args} as never)) as T;
    } catch {
      return null;
    }
  };

  const [chainId, maxInvocations, contractKeys] = await Promise.all([
    client.getChainId(),
    read<bigint>('maxInvocations'), // absent on OneOfOneEdition — its id space is fixed to {0}
    read<readonly Hex[]>('contractParamKeys'),
  ]);

  const seedProbe = await read<readonly [Hex, boolean, boolean]>('tokenParam', [0n, encodeTag(SEED_KEY)]);
  const hasParams = seedProbe !== null || contractKeys !== null;
  const hasParamEnumeration = contractKeys !== null;

  const schemaCache = new Map<string, Promise<ParamSchema | undefined>>();
  const schemaOf = (key: string): Promise<ParamSchema | undefined> => {
    let hit = schemaCache.get(key);
    if (!hit) {
      hit = schemaFor(client, address, key);
      schemaCache.set(key, hit);
    }
    return hit;
  };

  const contractParams: Record<string, string> = {};
  for (const raw of contractKeys ?? []) {
    const key = decodeTag(raw);
    const slot = await read<readonly [Hex, boolean, boolean]>('contractParam', [raw]);
    if (!slot?.[2]) continue;
    const p: ParamValue = {key, value: slot[0], valueIsHash: slot[1], updatedBy: address};
    contractParams[key] = (await decodeParam(client, address, '0', p, false, await schemaOf(key))).value;
  }

  // The id space: the id-space cap (`maxInvocations`) when the token has one (EditionImage/
  // EditionCode); `OneOfOneEdition` has no id-space extension at all — its id space is the
  // single work, id 0 alone (mirrors the 1/1 count fallback on the 721 path above).
  const count = maxInvocations !== null ? Number(maxInvocations) : 1;
  const from = Math.max(0, opts.from ?? 0);
  const end = opts.limit === undefined ? count : Math.min(count, from + Math.max(0, opts.limit));
  const ids = Array.from({length: Math.max(0, end - from)}, (_, i) => from + i);

  let done = 0;
  const tokens = await pool(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    const tokenId = String(id);
    const [supply, maxSupply, seedSlot, keys] = await Promise.all([
      read<bigint>('totalSupply', [BigInt(id)]),
      read<bigint>('maxSupply', [BigInt(id)]),
      hasParams ? read<readonly [Hex, boolean, boolean]>('tokenParam', [BigInt(id), encodeTag(SEED_KEY)]) : null,
      hasParamEnumeration ? read<readonly Hex[]>('tokenParamKeys', [BigInt(id)]) : null,
    ]);

    const params: Record<string, string> = {};
    for (const raw of keys ?? []) {
      const key = decodeTag(raw);
      const slot = await read<readonly [Hex, boolean, boolean]>('tokenParam', [BigInt(id), raw]);
      if (!slot?.[2]) continue;
      const p: ParamValue = {key, value: slot[0], valueIsHash: slot[1], updatedBy: address};
      params[key] = (await decodeParam(client, address, tokenId, p, true, await schemaOf(key))).value;
    }

    opts.onProgress?.(++done, ids.length);
    return {
      tokenId,
      owner: null, // not chain-enumerable for a multi-holder id — indexer territory
      // Zero live copies. The fold says exactly this for the same id (it declines to spend its extra
      // history knowledge on a distinction with no consumer), so the two lanes agree by construction
      // rather than by a docstring promising they do.
      lifecycle: (supply ?? 0n) > 0n ? 'live' : 'no-live-copies',
      seed: seedSlot?.[2] ? seedSlot[0] : null,
      params,
      supply: supply === null ? undefined : supply.toString(),
      maxSupply: maxSupply === null ? undefined : maxSupply.toString(),
    } satisfies TokenRow;
  });

  return {
    chainId,
    address,
    nextTokenId: null, // editions have no sequential mint cursor — ids are caller-named
    totalSupply: null, // no unconditional whole-contract total; supply is per id (see each row)
    burnedCount: null, // per id, not per contract — and undecidable at head anyway (see each row)
    maxInvocations: maxInvocations === null ? null : Number(maxInvocations),
    hasParams,
    hasParamEnumeration,
    contractParams,
    tokens,
  };
}

/**
 * One key's declared schema in the shape {@link decodeParam} wants, or `undefined` when the key is
 * un-governed or the contract has no schema surface. A schema-less param is a normal, supported
 * state — its value simply stays raw, which is exactly what `seed` relies on.
 *
 * Delegates the read to {@link readParamSchema} (the one implementation, which also backs the
 * read-modify-write in `set-schema`) and only maps its numeric enums onto their canonical names.
 */
async function schemaFor(
  client: PublicClient,
  address: Address,
  key: string,
): Promise<ParamSchema | undefined> {
  try {
    const s = await readParamSchema(client, address, key);
    if (!s.exists) return undefined;
    return {
      key,
      paramType: PARAM_TYPES[s.paramType] ?? String(s.paramType),
      auth: AUTH_OPTIONS[s.auth] ?? String(s.auth),
      authAddress: s.authAddress === zeroAddress ? null : s.authAddress,
      lockAfter: String(s.lockAfter),
      min: s.min,
      max: s.max,
      selectOptions: s.selectOptions,
    };
  } catch {
    return undefined; // no schema surface on this token type
  }
}

/** Bounded-concurrency map, order-preserving. */
async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({length: Math.max(1, Math.min(width, items.length))}, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
