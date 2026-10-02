import {encodeFunctionData, parseEventLogs, toHex, zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import {
  oneOfOneImageAbi,
  oneOfOneImageFactoryAbi,
  seriesImageAbi,
  seriesImageFactoryAbi,
  abxMetadataRendererBytecode,
  abxFixedPriceMinterAbi,
  abxFixedPriceMinterBytecode,
  abxFixedPriceMinter1155Abi,
  abxFixedPriceMinter1155Bytecode,
  abxSeedSourceAbi,
  abxSeedSourceBytecode,
  seriesCodeAbi,
  seriesCodeFactoryAbi,
  oneOfOneEditionAbi,
  oneOfOneEditionFactoryAbi,
  editionImageFactoryAbi,
  editionCodeFactoryAbi,
} from './abi/index.js';
import {encodeTag} from './spine.js';
import {SeedSourceUnusableError} from './errors.js';
// The two edition-image factories are library-linked, so their initcode comes from the `link*`
// helpers, never from the raw `*Bytecode` exports (which still carry solc's `__$…$__` placeholder).
import {
  ABX_SALT,
  CREATE2_PROXY,
  create2Calldata,
  linkEditionFactory,
  linkFactory,
  linkOneOfOneEditionFactory,
  linkSeriesFactory,
} from './create2.js';
import type {
  EditionCodeInitParams,
  EditionImageInitParams,
  OneOfOneEditionInitParams,
  OneOfOneInitParams,
  SeriesCodeInitParams,
  SeriesInitParams,
} from './deploy.js';

/**
 * An unsigned, ready-to-sign transaction — the SDK's neutral output for every
 * write. It carries only the data needed to sign (`to`/`data`/`value`/`chainId`)
 * plus a human layer (`summary`/`fields`) so a UX can show the *intention*, not
 * hex. Signing is the caller's job: an env key, a browser wallet, a multisig —
 * the SDK takes no custody and broadcasts nothing.
 *
 * `to` is `null` for a contract-creation tx (the factory deploy).
 */
export interface PreparedTx {
  op: string;
  to: Address | null;
  data: Hex;
  value: Hex; // hex quantity, '0x0' unless the op is payable with a value
  chainId: number;
  summary: string; // one-line plain-language description
  fields: Record<string, string>; // decoded args, for a sign-page table
  /**
   * A **provable** lower bound on this tx's gas — a value the real cost cannot possibly be below.
   *
   * This is a DETECTOR, not a substitute gas limit. It exists because `eth_estimateGas` can return a
   * confidently wrong answer (an estimate taken against a target whose code isn't visible yet is
   * just the calldata cost), and the only safe response to a wrong estimate is to notice and refuse
   * — not to invent a replacement number. A sender treats `estimate < gasFloor` as "this estimate is
   * impossible", retries, and errors out; it does NOT send `gasFloor` instead, because a bound that
   * covers the provable part says nothing about the rest of the payload.
   *
   * Set it only from costs that are physics rather than guesswork. The one such cost here is EVM
   * code deposit: storing N bytes on-chain costs exactly 200·N gas, before any other work.
   */
  gasFloor?: Hex; // hex quantity
}

const ZERO_VALUE = '0x0' as const;

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** The `Multicallable.multicall` fragment — identical on every ABX contract (the token
 *  and the chunk store both inherit Solady's `Multicallable`), so one fragment batches
 *  for any target. */
const MULTICALL_ABI = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{name: 'data', type: 'bytes[]'}],
    outputs: [{name: 'results', type: 'bytes[]'}],
  },
] as const;

/**
 * Batch several ops into ONE atomic transaction via the target's
 * `Multicallable.multicall`. This is how a human applies many owner ops — set several
 * fields, point a renderer, lock — in a single signature instead of N transactions.
 *
 * Security: a multicall is *exactly* equivalent to sending each op individually from
 * the same signer — it grants no extra authority (each subcall re-runs its own
 * `onlyOwner`/lock checks under the preserved `msg.sender`) and it's all-or-nothing
 * (any revert bubbles, so nothing partially applies). Enforced here:
 *   - every op MUST target the same contract — `multicall` `delegatecall`s into the
 *     contract itself, so it can only batch that contract's own functions (it is NOT a
 *     cross-contract call primitive; spanning contracts is the *account's* job — an
 *     EIP-7702 EOA, ERC-4337 account, or Safe);
 *   - every op MUST be value-free — `multicall` reverts on non-zero `msg.value` (the
 *     classic multicall double-spend guard), and no ABX op carries value anyway.
 */
export function prepareMulticall(args: {
  ops: PreparedTx[];
  chainId?: number;
  summary?: string;
}): PreparedTx {
  const {ops} = args;
  if (ops.length === 0) throw new Error('prepareMulticall: no ops to batch');
  const to = ops[0].to;
  if (to === null) throw new Error('prepareMulticall: cannot batch a contract-creation tx');
  for (const o of ops) {
    if (o.to !== to) {
      throw new Error(
        'prepareMulticall: all ops must target the same contract (multicall is delegatecall-to-self, not a cross-contract call)',
      );
    }
    if (o.value !== ZERO_VALUE) {
      throw new Error(`prepareMulticall: op "${o.op}" carries value; multicall must be value-free`);
    }
  }
  return {
    op: 'multicall',
    to,
    data: encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: 'multicall',
      args: [ops.map((o) => o.data)],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId ?? ops[0].chainId,
    summary: args.summary ?? `Batch ${ops.length} ops in one tx (${ops.map((o) => o.op).join(', ')})`,
    fields: {contract: to, batched: String(ops.length), ops: ops.map((o) => o.op).join(',')},
  };
}

/**
 * Collapse a list of ops into the minimal transaction set: same-target runs of ≥2 ops
 * become one `multicall`, lone ops pass through untouched, and contract-creation txs
 * (`to === null`, e.g. a factory/renderer/store deploy) are never folded. Order is
 * preserved — important when a later op depends on an earlier one's effect — so a run is
 * only merged while the target stays the same. This is what turns "6 owner edits" into
 * "1 transaction" for the UX, while staying honest about what genuinely needs its own tx.
 *
 * A CREATE2-proxy deploy (`to === CREATE2_PROXY` — the renderer/minter/seed-source singletons)
 * is creation too, even though it carries a `to`: the proxy has no `multicall`, so folding two of
 * them together would silently produce a transaction that reverts on the target it's actually
 * sent to. Excluded from merging for the same reason `to === null` is.
 */
export function batchOps(ops: PreparedTx[]): PreparedTx[] {
  const out: PreparedTx[] = [];
  let run: PreparedTx[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push(prepareMulticall({ops: run}));
    run = [];
  };
  for (const op of ops) {
    const mergeable = op.to !== null && op.to !== CREATE2_PROXY && op.value === ZERO_VALUE;
    if (mergeable && run.length > 0 && run[0].to === op.to) {
      run.push(op);
    } else {
      flush();
      run = mergeable ? [op] : [];
      if (!mergeable) out.push(op); // standalone (creation or value-bearing)
    }
  }
  flush();
  return out;
}

/** Transfer a token to a new holder (a sale/gift settlement). Signer must be `from`. */
export function prepareTransfer(args: {
  contract: Address;
  from: Address;
  to: Address;
  tokenId: bigint | number;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  return {
    op: 'transfer',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'safeTransferFrom',
      args: [args.from, args.to, id],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Transfer token #${id} → ${short(args.to)}`,
    fields: {contract: args.contract, from: args.from, to: args.to, tokenId: id.toString()},
  };
}

/**
 * Mint the single token (id 0) to `to`. Owner-only and one-shot — for deferred
 * issuance: deploy first (warm the resolver at the known address), then mint, or
 * mint straight to a buyer on a primary sale. Signer must be the owner.
 */
export function prepareMint(args: {contract: Address; to: Address; chainId: number}): PreparedTx {
  return {
    op: 'mint',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'mint', args: [args.to]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    // `mint(address)` issues the NEXT sequential token — id #0 for a 1/1, but the next unminted id
    // for a Series (chain-determined at mint time). Don't hardcode "#0" (misleads on a Series where
    // #0 is already minted); say "next" — correct for both.
    summary: `Mint the next token → ${short(args.to)}`,
    fields: {contract: args.contract, to: args.to, token: 'next in order'},
  };
}

/**
 * The token ids a mint actually created, decoded from its receipt's mint logs — `Transfer` from
 * `0x0` on a 721 token, or `TransferSingle`/`TransferBatch` from `0x0` on an edition (each id
 * reported once, regardless of how many copies it minted — an edition amount has nowhere to ride
 * in a `string[]`, so it's a job for the sibling {@link mintedEditionAmounts}). Both event
 * families are probed unconditionally (harmless — a contract only ever emits the one that
 * matches its own standard, so exactly one probe ever finds anything) rather than branching on
 * contract type, so this stays a single call for either kind.
 *
 * Authoritative by construction: the ids come from the transaction that minted them, so a
 * `--count N` batch reports all N and a concurrent mint elsewhere cannot skew the answer. Returns
 * `[]` rather than throwing if the receipt can't be read — a mint that landed on-chain must not be
 * reported as failed because a follow-up read hiccuped.
 */
export async function mintedTokenIds(client: PublicClient, contract: Address, txHash: Hex): Promise<string[]> {
  try {
    const receipt = await client.getTransactionReceipt({hash: txHash});
    const logs = receipt.logs.filter((log) => log.address.toLowerCase() === contract.toLowerCase());
    const ids = new Set<string>();

    const transfers = parseEventLogs({abi: oneOfOneImageAbi, eventName: 'Transfer', logs});
    for (const ev of transfers) {
      const args = ev.args as unknown as {from?: Address; id?: bigint; tokenId?: bigint};
      if (args.from && args.from !== zeroAddress) continue; // a transfer, not a mint
      const id = args.id ?? args.tokenId;
      if (id !== undefined) ids.add(id.toString());
    }

    const singles = parseEventLogs({abi: oneOfOneEditionAbi, eventName: 'TransferSingle', logs});
    for (const ev of singles) {
      const args = ev.args as unknown as {from?: Address; id?: bigint};
      if (args.from && args.from !== zeroAddress) continue;
      if (args.id !== undefined) ids.add(args.id.toString());
    }
    const batches = parseEventLogs({abi: oneOfOneEditionAbi, eventName: 'TransferBatch', logs});
    for (const ev of batches) {
      const args = ev.args as unknown as {from?: Address; ids?: readonly bigint[]};
      if (args.from && args.from !== zeroAddress) continue;
      for (const id of args.ids ?? []) ids.add(id.toString());
    }

    return [...ids].sort((a, b) => Number(BigInt(a) - BigInt(b)));
  } catch {
    return [];
  }
}

/** One id's minted copy count from a single edition mint transaction — the amount half {@link
 *  mintedTokenIds} can't carry (its `string[]` shape is shared with the 721 side, where a token
 *  is always exactly 1 unit). */
export interface MintedEditionAmount {
  tokenId: string;
  amount: string;
}

/**
 * The `(id, amount)` pairs an edition mint actually created, decoded from its receipt's
 * `TransferSingle`/`TransferBatch` (`from == 0x0`) logs — the amount-carrying sibling of {@link
 * mintedTokenIds}, for callers that need "how many copies of #7 did this tx mint" rather than
 * just "which ids." Amounts are summed per id (a batch could in principle mint the same id
 * twice in one call), then sorted by id. Returns `[]` on a 721 receipt (no matching events) or
 * any read failure, same fail-open contract as {@link mintedTokenIds}.
 */
export async function mintedEditionAmounts(
  client: PublicClient,
  contract: Address,
  txHash: Hex,
): Promise<MintedEditionAmount[]> {
  try {
    const receipt = await client.getTransactionReceipt({hash: txHash});
    const logs = receipt.logs.filter((log) => log.address.toLowerCase() === contract.toLowerCase());
    const amounts = new Map<string, bigint>();
    const add = (id: string, amount: bigint) => amounts.set(id, (amounts.get(id) ?? 0n) + amount);

    const singles = parseEventLogs({abi: oneOfOneEditionAbi, eventName: 'TransferSingle', logs});
    for (const ev of singles) {
      const args = ev.args as unknown as {from?: Address; id?: bigint; amount?: bigint};
      if (args.from && args.from !== zeroAddress) continue;
      if (args.id !== undefined) add(args.id.toString(), args.amount ?? 0n);
    }
    const batches = parseEventLogs({abi: oneOfOneEditionAbi, eventName: 'TransferBatch', logs});
    for (const ev of batches) {
      const args = ev.args as unknown as {from?: Address; ids?: readonly bigint[]; amounts?: readonly bigint[]};
      if (args.from && args.from !== zeroAddress) continue;
      const batchIds = args.ids ?? [];
      const batchAmounts = args.amounts ?? [];
      for (let i = 0; i < batchIds.length; i++) add(batchIds[i].toString(), batchAmounts[i] ?? 0n);
    }

    return [...amounts.entries()]
      .map(([tokenId, amount]) => ({tokenId, amount: amount.toString()}))
      .sort((a, b) => Number(BigInt(a.tokenId) - BigInt(b.tokenId)));
  } catch {
    return [];
  }
}

/** Re-point a token's resolver BASE (move the resolver). The per-token pointer is derived
 *  on-chain as `{base}/{chainId}/{address}/{tokenId}`. Affects every token without an
 *  override. Signer must be the owner. */
export function prepareSetTokenURIBase(args: {contract: Address; base: string; chainId: number}): PreparedTx {
  return {
    op: 'set-token-uri-base',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'setTokenURIBase', args: [args.base]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set tokenURI base → ${args.base}`,
    fields: {contract: args.contract, tokenURIBase: args.base},
  };
}

/** Set (or clear, with "") a per-token full-URI override — a fixed locator (e.g. `ipfs://`)
 *  that wins over the derived base path for one token. Signer must be the owner. */
export function prepareSetTokenURIOverride(args: {
  contract: Address;
  tokenId: number | bigint;
  uri: string;
  chainId: number;
}): PreparedTx {
  return {
    op: 'set-token-uri-override',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setTokenURIOverride',
      args: [BigInt(args.tokenId), args.uri],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: args.uri
      ? `Set tokenURI override #${args.tokenId} → ${args.uri}`
      : `Clear tokenURI override #${args.tokenId}`,
    fields: {contract: args.contract, tokenId: String(args.tokenId), tokenURIOverride: args.uri},
  };
}

/** Re-point the collection (ERC-7572) resolver BASE; derived on-chain as
 *  `{base}/{chainId}/{address}`. Signer must be the owner. */
export function prepareSetContractURIBase(args: {contract: Address; base: string; chainId: number}): PreparedTx {
  return {
    op: 'set-contract-uri-base',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'setContractURIBase', args: [args.base]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set contractURI base → ${args.base}`,
    fields: {contract: args.contract, contractURIBase: args.base},
  };
}

/** Set (or clear, with "") the collection's full-URI override — a fixed locator that wins
 *  over the derived base. Signer must be the owner. */
export function prepareSetContractURIOverride(args: {contract: Address; uri: string; chainId: number}): PreparedTx {
  return {
    op: 'set-contract-uri-override',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'setContractURIOverride', args: [args.uri]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: args.uri ? `Set contractURI override → ${args.uri}` : 'Clear contractURI override',
    fields: {contract: args.contract, contractURIOverride: args.uri},
  };
}

/**
 * Set (or clear) the token's on-chain URI renderer — the toggle between off-chain
 * resolution (`renderer == 0x0`, use the stored `tokenURI`) and on-chain resolution
 * (a non-zero `IAbxMetadataRenderer` that assembles the JSON from on-chain fields).
 * Signer must be the owner; reverts if the URI config is locked.
 */
export function prepareSetTokenURIRenderer(args: {
  contract: Address;
  renderer: Address;
  chainId: number;
}): PreparedTx {
  const onChain = args.renderer !== zeroAddress;
  return {
    op: 'set-token-uri-renderer',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setTokenURIRenderer',
      args: [args.renderer],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: onChain ? `Resolve tokenURI on-chain via ${short(args.renderer)}` : 'Resolve tokenURI off-chain (clear renderer)',
    fields: {contract: args.contract, renderer: args.renderer},
  };
}

/** Set (or clear) the collection's on-chain URI renderer. Signer must be the owner. */
export function prepareSetContractURIRenderer(args: {
  contract: Address;
  renderer: Address;
  chainId: number;
}): PreparedTx {
  const onChain = args.renderer !== zeroAddress;
  return {
    op: 'set-contract-uri-renderer',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setContractURIRenderer',
      args: [args.renderer],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: onChain ? `Resolve contractURI on-chain via ${short(args.renderer)}` : 'Resolve contractURI off-chain (clear renderer)',
    fields: {contract: args.contract, renderer: args.renderer},
  };
}

/** Freeze the token-URI config (pointer + renderer) forever. Irreversible. Signer = owner. */
export function prepareLockTokenURI(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'lock-token-uri',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'lockTokenURI', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Freeze the tokenURI config (pointer + renderer) — permanent',
    fields: {contract: args.contract},
  };
}

/** Freeze the collection-URI config forever. Irreversible. Signer = owner. */
export function prepareLockContractURI(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'lock-contract-uri',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'lockContractURI', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Freeze the contractURI config (pointer + renderer) — permanent',
    fields: {contract: args.contract},
  };
}

/** Set the contract-wide default royalty. Signer must be the owner. */
/**
 * The on-chain royalty ceiling, mirrored from `RoyaltyExtension._maxRoyaltyBps()` (1000 bps = 10%).
 *
 * Client-side validation used to allow the full 0–10000 ERC-2981 range, and the CLI's own error text
 * offered `10000 = 100%` as an example — so a creator asking for an ordinary 15% got a fully built,
 * fully signed transaction that reverted `RoyaltyTooHigh()` on chain. On the wallet lane they approved
 * it in their own wallet first and paid the gas to find out. Validate against the real cap so the
 * refusal is instant, local and free.
 *
 * The royalty ceiling is now **per-collection**: owner-set at deploy (0–10000 bps) and reduce-only
 * after. So this constant is the ABSOLUTE protocol maximum (100%); a collection's own, possibly
 * lower, `maxRoyaltyBps()` is the binding cap and is enforced on chain. To refuse an over-cap
 * `set-royalty` instantly rather than after a revert, pass `maxBps` (the collection's live cap, read
 * from `maxRoyaltyBps()`); it defaults to the absolute max when omitted.
 */
export const MAX_ROYALTY_BPS = 10_000;

export function prepareSetRoyalty(args: {
  contract: Address;
  receiver: Address;
  bps: number;
  chainId: number;
  maxBps?: number;
}): PreparedTx {
  const cap = args.maxBps ?? MAX_ROYALTY_BPS;
  if (args.bps < 0 || args.bps > cap)
    throw new Error(
      `royalty bps out of range (0–${cap}): ${args.bps}. This collection's royalty cap is ` +
        `${cap / 100}% (RoyaltyExtension.maxRoyaltyBps, owner-set at deploy, reduce-only) — a higher ` +
        `value REVERTS with RoyaltyTooHigh().`,
    );
  return {
    op: 'set-royalty',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setDefaultRoyalty',
      args: [args.receiver, args.bps],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set royalty → ${(args.bps / 100).toFixed(2)}% to ${short(args.receiver)}`,
    fields: {contract: args.contract, receiver: args.receiver, bps: String(args.bps)},
  };
}

/**
 * Lower a collection's royalty ceiling (`RoyaltyExtension.reduceMaxRoyaltyBps`). Owner-only and
 * **reduce-only**: the chain reverts `RoyaltyCapNotReduced()` if `newMaxBps` is not strictly below
 * the current cap, and `RoyaltyCapBelowRoyalty()` if it would sit under the live royalty rate. This
 * builder is domain-only (0–100%); the CLI reads the live cap + rate to refuse both cases before
 * signing so the failure is local and free rather than a paid revert. Emits `MaxRoyaltyBpsUpdated`.
 */
export function prepareReduceMaxRoyaltyBps(args: {
  contract: Address;
  newMaxBps: number;
  chainId: number;
}): PreparedTx {
  if (args.newMaxBps < 0 || args.newMaxBps > MAX_ROYALTY_BPS)
    throw new Error(`royalty cap out of range (0\u2013${MAX_ROYALTY_BPS}): ${args.newMaxBps}`);
  return {
    op: 'set-royalty-cap',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'reduceMaxRoyaltyBps',
      args: [args.newMaxBps],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Reduce royalty cap \u2192 ${(args.newMaxBps / 100).toFixed(2)}% (reduce-only)`,
    fields: {contract: args.contract, maxBps: String(args.newMaxBps)},
  };
}

/**
 * Set/replace an on-chain metadata field for a token. `field` is what (e.g. "image",
 * "description"), `representation` is how it's carried (e.g. "inline", "keccak256",
 * "arweave"), `value` is the bytes. Reverts once the field is locked. Signer = owner.
 */
export function prepareSetTokenField(args: {
  contract: Address;
  tokenId: bigint | number;
  field: string;
  representation: string;
  value: Hex;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  return {
    op: 'set-field',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setTokenField',
      args: [id, encodeTag(args.field), encodeTag(args.representation), args.value],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set on-chain ${args.field} (${args.representation}) for token #${id}`,
    fields: {contract: args.contract, tokenId: id.toString(), field: args.field, representation: args.representation, value: args.value},
  };
}

/** Freeze a token field forever, across all its representations (irreversible). Signer = owner. */
export function prepareLockTokenField(args: {
  contract: Address;
  tokenId: bigint | number;
  field: string;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  return {
    op: 'lock-field',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'lockTokenField', args: [id, encodeTag(args.field)]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Lock token #${id} field "${args.field}" — permanent`,
    fields: {contract: args.contract, tokenId: id.toString(), field: args.field},
  };
}

/** Set/replace a collection (contract-wide) on-chain metadata field. Signer = owner. */
export function prepareSetContractField(args: {
  contract: Address;
  field: string;
  representation: string;
  value: Hex;
  chainId: number;
}): PreparedTx {
  return {
    op: 'set-collection-field',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneImageAbi,
      functionName: 'setContractField',
      args: [encodeTag(args.field), encodeTag(args.representation), args.value],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set on-chain collection ${args.field} (${args.representation})`,
    fields: {contract: args.contract, field: args.field, representation: args.representation, value: args.value},
  };
}

/** Freeze a collection field forever (irreversible). Signer = owner. */
export function prepareLockContractField(args: {contract: Address; field: string; chainId: number}): PreparedTx {
  return {
    op: 'lock-collection-field',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'lockContractField', args: [encodeTag(args.field)]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Lock collection field "${args.field}" — permanent`,
    fields: {contract: args.contract, field: args.field},
  };
}

/** Transfer contract ownership (admin). Signer must be the current owner. */
export function prepareTransferOwnership(args: {
  contract: Address;
  newOwner: Address;
  chainId: number;
}): PreparedTx {
  return {
    op: 'set-admin',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneImageAbi, functionName: 'transferOwnership', args: [args.newOwner]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Transfer contract ownership → ${short(args.newOwner)}`,
    fields: {contract: args.contract, newOwner: args.newOwner},
  };
}

/**
 * The unsigned form of the genesis deploy: a `deployDeterministic(params, salt)`
 * call on the factory. The clone address is deterministic in (factory, salt) — a
 * pure function of the salt, independent of the signer — so the URIs in `params`
 * can be baked to point at the predicted address before anyone connects (see
 * `predictClone`). `params.mintTo` decides whether the token mints in this tx or
 * is deferred to a later `mint`. Building the URIs is the caller's job.
 */
export function prepareDeployOneOfOne(args: {
  factory: Address;
  params: OneOfOneInitParams;
  salt: Hex;
  chainId: number;
  clone: Address;
}): PreparedTx {
  return {
    op: 'deploy',
    to: args.factory,
    data: encodeFunctionData({
      abi: oneOfOneImageFactoryAbi,
      functionName: 'deployDeterministic',
      args: [args.params as never, args.salt],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Deploy "${args.params.name}" → ${args.clone}`,
    fields: {
      factory: args.factory,
      clone: args.clone,
      name: args.params.name,
      symbol: args.params.symbol,
      owner: args.params.owner,
    },
  };
}

/** The unsigned form of the factory (trust-anchor) deploy — CREATE2 via the keyless proxy at the
 *  canonical salt, matching the forge `Deploy` script and `predictFactory()` (create2.ts). A trust
 *  anchor is the one address platforms allowlist, so it has to be the same on every chain and
 *  computable before the first tx; a plain creation (`to: null`) would make it depend on the
 *  deployer's nonce and could never match the recorded manifest. */
export function prepareDeployFactory(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-factory',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.oneOfOneFactory, linkFactory()),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical clone factory (trust anchor)',
    fields: {},
  };
}

/** The unsigned form of the canonical metadata-renderer deploy — CREATE2 via the keyless proxy +
 *  canonical salt, so it lands at the SAME (predictable) address on every chain, matching the forge
 *  `DeployRenderer` script and `predictRenderer()` (create2.ts). NOT a plain contract creation
 *  (`to: null`) — that would land at a nonce-dependent address, defeating the whole point of a
 *  canonical, cross-chain-identical singleton. */
export function prepareDeployRenderer(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-renderer',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.renderer, abxMetadataRendererBytecode),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical on-chain metadata renderer (CREATE2, deterministic address)',
    fields: {},
  };
}

// ── Series (multi-token) ops ──────────────────────────────────────────────────
// Token ids are sequential and a token's metadata is its token id (no decoupling). Signer
// must be the owner or an authorized minter for the mint ops; owner-only for the config ops.

/**
 * Mint the next sequential token on a Series (its metadata is its token id). Reverts when
 * sold out.
 */
export function prepareSeriesMint(args: {contract: Address; to: Address; chainId: number}): PreparedTx {
  return {
    op: 'mint',
    to: args.contract,
    data: encodeFunctionData({abi: seriesImageAbi, functionName: 'mint', args: [args.to]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Mint next token (in order) → ${short(args.to)}`,
    fields: {contract: args.contract, to: args.to},
  };
}

/** Mint `count` Series tokens in order in one tx — N individual `Transfer`s. */
export function prepareSeriesMintMany(args: {
  contract: Address;
  to: Address;
  count: bigint | number;
  chainId: number;
}): PreparedTx {
  const n = Number(args.count);
  return {
    op: 'mint-many',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesImageAbi,
      functionName: 'mintMany',
      args: [args.to, BigInt(args.count)],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Mint ${n} tokens (in order) → ${short(args.to)}`,
    fields: {contract: args.contract, to: args.to, count: String(n)},
  };
}

/**
 * Set (or clear, with `0x0`) the single authorized minter. Setting a new minter atomically
 * replaces any previous one; `0x0` clears it (back to owner-only). Signer must be the owner.
 */
export function prepareSetMinter(args: {contract: Address; minter: Address; chainId: number}): PreparedTx {
  const clearing = args.minter === zeroAddress;
  return {
    op: 'set-minter',
    to: args.contract,
    data: encodeFunctionData({abi: seriesImageAbi, functionName: 'setMinter', args: [args.minter]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: clearing ? 'Clear the authorized minter (owner-only)' : `Set authorized minter → ${short(args.minter)}`,
    fields: {contract: args.contract, minter: args.minter},
  };
}

/** Lower the supply cap (monotonic — never raises, never below the minted count). Signer = owner. */
export function prepareSetMaxInvocations(args: {
  contract: Address;
  maxInvocations: bigint | number;
  chainId: number;
}): PreparedTx {
  const max = BigInt(args.maxInvocations);
  return {
    op: 'set-max-invocations',
    to: args.contract,
    data: encodeFunctionData({abi: seriesImageAbi, functionName: 'setMaxInvocations', args: [max]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set max invocations → ${max}`,
    fields: {contract: args.contract, maxInvocations: max.toString()},
  };
}

/** Pause or unpause minting. While paused only the owner may mint (reserves/config); unpausing
 *  opens it to the authorized minter. Signer must be the owner. */
export function prepareSetPaused(args: {contract: Address; paused: boolean; chainId: number}): PreparedTx {
  return {
    op: 'set-paused',
    to: args.contract,
    data: encodeFunctionData({abi: seriesImageAbi, functionName: 'setPaused', args: [args.paused]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: args.paused ? 'Pause minting (owner-only until unpaused)' : 'Unpause minting (open to the minter)',
    fields: {contract: args.contract, paused: String(args.paused)},
  };
}

/** Set (or clear, with `0x0`) the primary-sale payout destination. Signer = owner. */
export function prepareSetPrimaryPayee(args: {contract: Address; payee: Address; chainId: number}): PreparedTx {
  return {
    op: 'set-primary-payee',
    to: args.contract,
    data: encodeFunctionData({abi: seriesImageAbi, functionName: 'setPrimaryPayee', args: [args.payee]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: args.payee !== zeroAddress ? `Set primary payee → ${short(args.payee)}` : 'Clear primary payee',
    fields: {contract: args.contract, primaryPayee: args.payee},
  };
}

/** The unsigned form of a Series genesis deploy — `deployDeterministic(params, salt)` on the Series factory. */
export function prepareDeploySeries(args: {
  factory: Address;
  params: SeriesInitParams;
  salt: Hex;
  chainId: number;
  clone: Address;
}): PreparedTx {
  return {
    op: 'deploy-series',
    to: args.factory,
    data: encodeFunctionData({
      abi: seriesImageFactoryAbi,
      functionName: 'deployDeterministic',
      args: [args.params as never, args.salt],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Deploy Series "${args.params.name}" (${String(args.params.maxInvocations)} max) → ${args.clone}`,
    fields: {
      factory: args.factory,
      clone: args.clone,
      name: args.params.name,
      symbol: args.params.symbol,
      owner: args.params.owner,
      maxInvocations: String(args.params.maxInvocations),
    },
  };
}

/** The unsigned form of the Series factory (trust-anchor) deploy — CREATE2 via the keyless proxy at
 *  the canonical salt, matching the forge `DeploySeries` script and `predictSeriesFactory()`. Same
 *  reasoning as `prepareDeployFactory` above. */
export function prepareDeploySeriesFactory(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-series-factory',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.seriesFactory, linkSeriesFactory()),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical Series clone factory (trust anchor)',
    fields: {},
  };
}

// ── ERC-1155 editions (IAbxEditionMint + Edition Supply) ──────────────────────
// Ids are caller-named, not a sequential cursor — a minter/owner targets any id, in any order,
// with a per-mint amount. `mint`'s signature is uniform across all three edition kinds
// (`OneOfOneEdition` reverts unless `id === 0`, its id space fixed to the single work), so
// every op below encodes against `oneOfOneEditionAbi` — the narrowest-common-superset ABI for
// the family, exactly like `oneOfOneImageAbi` plays that role on the 721 side.

/**
 * Mint `amount` copies of `id` to `to` (`IAbxEditionMint.mint`). Owner always; the authorized
 * minter only while unpaused — same auth shape as {@link prepareMint}/{@link prepareSeriesMint}.
 * The edition twin of both: there is no separate "next in order" primitive here, since an
 * edition mint always names its id.
 */
export function prepareEditionMint(args: {
  contract: Address;
  to: Address;
  tokenId: bigint | number;
  amount: bigint | number;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  const amount = BigInt(args.amount);
  return {
    op: 'mint',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneEditionAbi, functionName: 'mint', args: [args.to, id, amount]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Mint ${amount} cop${amount === 1n ? 'y' : 'ies'} of #${id} → ${short(args.to)}`,
    fields: {contract: args.contract, to: args.to, tokenId: id.toString(), amount: amount.toString()},
  };
}

/** Transfer `amount` copies of `id` to a new holder (`safeTransferFrom(from,to,id,amount,"")` on
 *  the ERC-1155 ABI) — the edition twin of {@link prepareTransfer}. Signer must be `from` (or an
 *  operator it approved via the standard `setApprovalForAll`). */
export function prepareEditionTransfer(args: {
  contract: Address;
  from: Address;
  to: Address;
  tokenId: bigint | number;
  amount: bigint | number;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  const amount = BigInt(args.amount);
  return {
    op: 'transfer',
    to: args.contract,
    data: encodeFunctionData({
      abi: oneOfOneEditionAbi,
      functionName: 'safeTransferFrom',
      args: [args.from, args.to, id, amount, '0x'],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Transfer ${amount} cop${amount === 1n ? 'y' : 'ies'} of #${id} → ${short(args.to)}`,
    fields: {contract: args.contract, from: args.from, to: args.to, tokenId: id.toString(), amount: amount.toString()},
  };
}

/**
 * Owner overrides `id`'s supply cap (Edition Supply extension) — the edition twin of {@link
 * prepareSetMaxInvocations}, one id finer. Monotonically non-increasing once used for this id,
 * never below its live `totalSupply(id)` (see `IAbxEditionSupply`'s "0 = open until overridden"
 * semantics — an explicit `0` permanently closes the id, it does not mean "reopen to uncapped").
 * Signer must be the owner.
 */
export function prepareSetMaxSupply(args: {
  contract: Address;
  tokenId: bigint | number;
  cap: bigint | number;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  const cap = BigInt(args.cap);
  return {
    op: 'set-max-supply',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneEditionAbi, functionName: 'setMaxSupply', args: [id, cap]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set #${id}'s supply cap → ${cap}`,
    fields: {contract: args.contract, tokenId: id.toString(), cap: cap.toString()},
  };
}

/**
 * Permissionless, caller-chunked re-emission of the native `URI` event for the given ids —
 * called after a contract-wide re-point (`setTokenURIBase`/`setTokenURIRenderer`, which emit
 * only their own Register-2 config event; see `Uri1155`'s class-level dev note on why there's no
 * automatic per-id loop for that case) to make marketplaces/indexers that only honor the native
 * event re-index. Anyone may call it — it only re-emits already-public, current truth, so there
 * is no state to protect; the caller picks the batch size.
 */
export function preparePingURI(args: {
  contract: Address;
  tokenIds: Array<bigint | number>;
  chainId: number;
}): PreparedTx {
  const ids = args.tokenIds.map((id) => BigInt(id));
  return {
    op: 'ping-uri',
    to: args.contract,
    data: encodeFunctionData({abi: oneOfOneEditionAbi, functionName: 'pingURI', args: [ids]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Re-emit URI for ${ids.length} id${ids.length === 1 ? '' : 's'}`,
    fields: {contract: args.contract, tokenIds: ids.join(',')},
  };
}

/** The unsigned form of a 1/1-edition genesis deploy — `deployDeterministic(params, salt)` on
 *  the {@link oneOfOneEditionFactoryAbi} factory. The edition twin of {@link
 *  prepareDeployOneOfOne}. */
export function prepareDeployOneOfOneEdition(args: {
  factory: Address;
  params: OneOfOneEditionInitParams;
  salt: Hex;
  chainId: number;
  clone: Address;
}): PreparedTx {
  return {
    op: 'deploy-one-of-one-edition',
    to: args.factory,
    data: encodeFunctionData({
      abi: oneOfOneEditionFactoryAbi,
      functionName: 'deployDeterministic',
      args: [args.params as never, args.salt],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Deploy edition "${args.params.name}" → ${args.clone}`,
    fields: {
      factory: args.factory,
      clone: args.clone,
      name: args.params.name,
      symbol: args.params.symbol,
      owner: args.params.owner,
    },
  };
}

/** The unsigned form of the 1/1-edition factory (trust-anchor) deploy — CREATE2 via the keyless
 *  proxy + canonical salt, so it lands at the SAME (predictable) address on every chain, matching
 *  `predictOneOfOneEditionFactory()` (create2.ts). See {@link prepareDeployRenderer} for why this
 *  is `to: CREATE2_PROXY`, not a plain creation.
 *
 *  The initcode goes out LINKED against `AbxEditionLib` (`linkOneOfOneEditionFactory()`): the
 *  embedded `OneOfOneEdition` implementation delegates its uri / creator-token / edition-supply
 *  bodies into that library, so the shipped bytecode carries a solc `__$…$__` placeholder. That
 *  library must already be on-chain at `predictEditionLib()` for the deployed factory to work —
 *  {@link deployOneOfOneEditionFactory} (deploy.ts) is the path that guarantees it. */
export function prepareDeployOneOfOneEditionFactory(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-one-of-one-edition-factory',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.oneOfOneEditionFactory, linkOneOfOneEditionFactory()),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical 1/1-edition clone factory (trust anchor), linked against AbxEditionLib — CREATE2, deterministic address',
    fields: {},
  };
}

/** The unsigned form of an edition-image genesis deploy — `deployDeterministic(params, salt)` on
 *  the {@link editionImageFactoryAbi} factory. The edition twin of {@link prepareDeploySeries}. */
export function prepareDeployEditionImage(args: {
  factory: Address;
  params: EditionImageInitParams;
  salt: Hex;
  chainId: number;
  clone: Address;
}): PreparedTx {
  return {
    op: 'deploy-edition-image',
    to: args.factory,
    data: encodeFunctionData({
      abi: editionImageFactoryAbi,
      functionName: 'deployDeterministic',
      args: [args.params as never, args.salt],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Deploy edition "${args.params.name}" (${String(args.params.maxInvocations)} max) → ${args.clone}`,
    fields: {
      factory: args.factory,
      clone: args.clone,
      name: args.params.name,
      symbol: args.params.symbol,
      owner: args.params.owner,
      maxInvocations: String(args.params.maxInvocations),
    },
  };
}

/** The unsigned form of the edition-image factory (trust-anchor) deploy — CREATE2 via the
 *  keyless proxy + canonical salt, matching `predictEditionFactory()` (create2.ts). See {@link
 *  prepareDeployRenderer} for why this is `to: CREATE2_PROXY`, not a plain creation, and {@link
 *  prepareDeployOneOfOneEditionFactory} for why the initcode is linked against `AbxEditionLib`
 *  (`EditionImage` delegates the same three mixins' bodies into it). */
export function prepareDeployEditionFactory(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-edition-factory',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.editionFactory, linkEditionFactory()),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary:
      'Deploy the canonical multi-work edition clone factory (trust anchor), linked against AbxEditionLib — CREATE2, deterministic address',
    fields: {},
  };
}

/** Deterministic deploy of an {EditionCode} clone — the code-project edition factory op. The
 *  edition twin of {@link prepareDeploySeriesCode}. */
export function prepareDeployEditionCode(args: {
  factory: Address;
  params: EditionCodeInitParams;
  salt: Hex;
  chainId: number;
  clone: Address;
}): PreparedTx {
  return {
    op: 'deploy-edition-code',
    to: args.factory,
    data: encodeFunctionData({
      abi: editionCodeFactoryAbi,
      functionName: 'deployDeterministic',
      args: [args.params as never, args.salt],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Deploy code-project edition "${args.params.name}" (${String(args.params.maxInvocations)} max) → ${args.clone}`,
    fields: {
      factory: args.factory,
      clone: args.clone,
      name: args.params.name,
      symbol: args.params.symbol,
      owner: args.params.owner,
      seedSource: args.params.seedSource,
      maxInvocations: String(args.params.maxInvocations),
    },
  };
}

// ── Fixed-price minter (the Minter spine) ─────────────────────────────────────
// The minter is a shared, ownerless, multi-tenant singleton. `configure` defers to the
// token owner; `purchase`/`purchaseTo` are public. See site/content/docs/protocol/minting.mdx.

/**
 * Set/update a project's fixed-price sale on the shared minter. Signer must be the ABX
 * token's owner. `paymentToken == 0x0` prices the sale in ETH; otherwise it's that ERC-20.
 * `price` is raw units per token; `allocation` is the max this minter may sell (its budget,
 * distinct from the token's own `maxInvocations` cap). Enabling the sale is separate from
 * granting mint rights — also `prepareSetMinter(token, minter)`.
 */
export function prepareConfigureSale(args: {
  minter: Address;
  token: Address;
  paymentToken?: Address;
  price: bigint | number;
  allocation: bigint | number;
  chainId: number;
}): PreparedTx {
  const paymentToken = args.paymentToken ?? zeroAddress;
  const price = BigInt(args.price);
  const allocation = BigInt(args.allocation);
  const isEth = paymentToken === zeroAddress;
  return {
    op: 'configure-sale',
    to: args.minter,
    data: encodeFunctionData({
      abi: abxFixedPriceMinterAbi,
      functionName: 'configure',
      args: [args.token, paymentToken, price, allocation],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Configure sale: ${price} ${isEth ? 'wei' : `of ${short(paymentToken)}`}/token, allocation ${allocation}`,
    fields: {
      minter: args.minter,
      token: args.token,
      paymentToken,
      price: price.toString(),
      allocation: allocation.toString(),
    },
  };
}

/** The sale terms a buyer is agreeing to — the input to the minter's on-chain terms guard.
 *  ("Terms guard", not "slippage guard": on the ETH lane it tolerates no movement at all — see
 *  {@link preparePurchase}.)
 *  A {@link SaleConfig} (or {@link SaleConfig1155}) read from the chain drops straight in, which is
 *  the point: the terms that go into the transaction are the terms the caller just read. */
export type PurchaseTerms = Pick<SaleConfig, 'paymentToken' | 'price'>;

/**
 * Buy one token from the shared minter. `to` omitted → minted to the signer (`purchase`);
 * `to` set → minted to that address (`purchaseTo`). Public — no owner rights needed.
 *
 * `sale` is the live terms ({@link readSaleConfig}), and they are **mandatory**: the minter takes
 * `(expectedPaymentToken, maxPrice)` and reverts `SaleTermsChanged` if the sale has moved, which is
 * what stops a project owner from front-running a pending purchase and spending the buyer's whole
 * ERC-20 allowance (`configure` has no timelock). The ETH to attach is derived from those terms —
 * `price` for an ETH sale, `0` for an ERC-20 one (where the buyer must have approved the minter to
 * pull `price` beforehand) — so a caller can't desync the payment from the guard.
 *
 * `maxPrice` defaults to `sale.price` (accept exactly what was read). Pass it to state a wider
 * ceiling. It bounds the guard only; the ETH attached still comes from `sale.price`, since the minter
 * wants exact payment. There is deliberately no "no maximum" sentinel.
 *
 * **A wide `maxPrice` is how a caller opts out of the protection.** The minter refuses a sentinel
 * precisely so that a bound has to be stated, but nothing stops a caller from stating an enormous
 * one — and on the ERC-20 lane that hands back exactly the vector the guard closes: the minter pulls
 * the live price from the buyer's standing allowance, so a ceiling of `2^256-1` lets a re-priced sale
 * take the whole allowance. Omitting the argument is the safe path and is what every caller in this
 * repo does. If you widen it, widen it by an amount you would be content to lose, and never derive it
 * from a price you read in the same breath as sending — that is the same thing as no bound at all.
 *
 * **On the ETH lane, `maxPrice` is a terms ASSERTION, not slippage tolerance — do not sell it as
 * one.** The minter requires `msg.value == price` (an equality) and V1 has no refund path, so an
 * in-flight ETH purchase reverts `WrongPayment` if the price moves in *either* direction, however
 * wide the ceiling. Raising `maxPrice` on an ETH sale buys the buyer nothing at all. Real tolerance
 * exists only on the **ERC-20** lane, where the minter pulls the live `price` from the buyer's
 * allowance and any price at or below the ceiling settles. Re-pricing a live ETH sale therefore fails
 * every buy already in flight, by design — pause first for a clean cutover.
 */
export function preparePurchase(args: {
  minter: Address;
  token: Address;
  sale: PurchaseTerms;
  to?: Address;
  maxPrice?: bigint | number;
  chainId: number;
}): PreparedTx {
  const paymentToken = args.sale.paymentToken;
  const price = BigInt(args.sale.price);
  const isEth = paymentToken === zeroAddress;
  const maxPrice = args.maxPrice === undefined ? price : BigInt(args.maxPrice);
  const value = isEth ? price : 0n; // exact payment; an ERC-20 sale attaches none
  const toRecipient = args.to && args.to !== zeroAddress;
  const cost = isEth ? `${price} wei` : `${price} units of ${short(paymentToken)}`;
  return {
    op: 'purchase',
    to: args.minter,
    data: toRecipient
      ? encodeFunctionData({
          abi: abxFixedPriceMinterAbi,
          functionName: 'purchaseTo',
          args: [args.token, args.to!, paymentToken, maxPrice],
        })
      : encodeFunctionData({
          abi: abxFixedPriceMinterAbi,
          functionName: 'purchase',
          args: [args.token, paymentToken, maxPrice],
        }),
    value: value > 0n ? toHex(value) : ZERO_VALUE,
    chainId: args.chainId,
    summary: toRecipient ? `Buy 1 token → ${short(args.to!)} for ${cost}` : `Buy 1 token for ${cost}`,
    fields: {
      minter: args.minter,
      token: args.token,
      to: args.to ?? '(sender)',
      value: value.toString(),
      expectedPaymentToken: paymentToken,
      maxPrice: maxPrice.toString(),
    },
  };
}

/** A project's fixed-price sale state on the shared minter (`sales(token)`): whether a sale is
 *  configured, the payment token (`zeroAddress` = ETH), the per-unit price, the minter's own
 *  sell-through budget (`allocation`, distinct from the token's `maxInvocations` cap), and units
 *  sold so far. The read half of {@link prepareConfigureSale}/{@link preparePurchase} — every
 *  caller that needs to know a sale's live terms (show it, gate a purchase) reads through here. */
export interface SaleConfig {
  configured: boolean;
  paymentToken: Address;
  price: bigint;
  allocation: bigint;
  sold: bigint;
}

export async function readSaleConfig(client: PublicClient, minter: Address, token: Address): Promise<SaleConfig> {
  const [configured, paymentToken, price, allocation, sold] = (await client.readContract({
    address: minter,
    abi: abxFixedPriceMinterAbi,
    functionName: 'sales',
    args: [token],
  })) as [boolean, Address, bigint, bigint, bigint];
  return {configured, paymentToken, price, allocation, sold};
}

/** The unsigned form of the shared fixed-price minter deploy — CREATE2 via the keyless proxy +
 *  canonical salt (same address on every chain), matching `predictFixedPriceMinter()`. See
 *  {@link prepareDeployRenderer} for why this is `to: CREATE2_PROXY`, not a plain creation. */
export function prepareDeployFixedPriceMinter(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-fixed-price-minter',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.fixedPriceMinter, abxFixedPriceMinterBytecode),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical fixed-price minter (shared, ownerless) — CREATE2, deterministic address',
    fields: {},
  };
}

// ── Fixed-price EDITION minter (the Minter spine's 1155 lane) ────────────────
// The structural sibling of the block above, keyed one step finer: `(token, id)` instead of just
// `token`, since an edition project prices each work on its own terms. See
// `AbxFixedPriceMinter1155`'s own doc comment for the two-grant model (mint rights via
// `setMinter`, sale terms via `configure` — unchanged from the 721 lane, one id finer).

/**
 * Set/update a project's fixed-price sale for one id on the shared edition minter. The id-keyed
 * twin of {@link prepareConfigureSale}. Signer must be the ABX token's owner.
 */
export function prepareConfigureSale1155(args: {
  minter: Address;
  token: Address;
  tokenId: bigint | number;
  paymentToken?: Address;
  price: bigint | number;
  allocation: bigint | number;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  const paymentToken = args.paymentToken ?? zeroAddress;
  const price = BigInt(args.price);
  const allocation = BigInt(args.allocation);
  const isEth = paymentToken === zeroAddress;
  return {
    op: 'configure-sale',
    to: args.minter,
    data: encodeFunctionData({
      abi: abxFixedPriceMinter1155Abi,
      functionName: 'configure',
      args: [args.token, id, paymentToken, price, allocation],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Configure sale for #${id}: ${price} ${isEth ? 'wei' : `of ${short(paymentToken)}`}/copy, allocation ${allocation}`,
    fields: {
      minter: args.minter,
      token: args.token,
      tokenId: id.toString(),
      paymentToken,
      price: price.toString(),
      allocation: allocation.toString(),
    },
  };
}

/**
 * Buy `quantity` copies of `id` from the shared edition minter. The id/quantity-keyed twin of
 * {@link preparePurchase}. `to` omitted → minted to the signer (`purchase`); `to` set → minted to
 * that address (`purchaseTo`). Public — no owner rights needed.
 *
 * `sale` is the live terms ({@link readSaleConfig1155}) and is mandatory, same terms guard as the 721
 * lane — except the minter bounds the **total** (`price × quantity`), which is what actually leaves
 * the buyer's balance. `price × quantity` is computed here (once), for both the attached ETH and the
 * bound; `maxTotalPrice` defaults to it, and passing it states a wider ceiling.
 *
 * The ETH-lane caveat on {@link preparePurchase} applies here identically: `msg.value` must equal the
 * total exactly, so `maxTotalPrice` is an assertion about the terms, **not** slippage tolerance. Only
 * an ERC-20 edition sale gets real tolerance.
 */
export function preparePurchase1155(args: {
  minter: Address;
  token: Address;
  tokenId: bigint | number;
  quantity: bigint | number;
  sale: PurchaseTerms;
  to?: Address;
  maxTotalPrice?: bigint | number;
  chainId: number;
}): PreparedTx {
  const id = BigInt(args.tokenId);
  const qty = BigInt(args.quantity);
  const paymentToken = args.sale.paymentToken;
  const total = BigInt(args.sale.price) * qty;
  const isEth = paymentToken === zeroAddress;
  const maxTotalPrice = args.maxTotalPrice === undefined ? total : BigInt(args.maxTotalPrice);
  const value = isEth ? total : 0n; // exact payment; an ERC-20 sale attaches none
  const toRecipient = args.to && args.to !== zeroAddress;
  const cost = isEth ? `${total} wei` : `${total} units of ${short(paymentToken)}`;
  const copies = `${qty} cop${qty === 1n ? 'y' : 'ies'} of #${id}`;
  return {
    op: 'purchase',
    to: args.minter,
    data: toRecipient
      ? encodeFunctionData({
          abi: abxFixedPriceMinter1155Abi,
          functionName: 'purchaseTo',
          args: [args.token, id, qty, args.to!, paymentToken, maxTotalPrice],
        })
      : encodeFunctionData({
          abi: abxFixedPriceMinter1155Abi,
          functionName: 'purchase',
          args: [args.token, id, qty, paymentToken, maxTotalPrice],
        }),
    value: value > 0n ? toHex(value) : ZERO_VALUE,
    chainId: args.chainId,
    summary: toRecipient ? `Buy ${copies} → ${short(args.to!)} for ${cost}` : `Buy ${copies} for ${cost}`,
    fields: {
      minter: args.minter,
      token: args.token,
      tokenId: id.toString(),
      quantity: qty.toString(),
      to: args.to ?? '(sender)',
      value: value.toString(),
      expectedPaymentToken: paymentToken,
      maxTotalPrice: maxTotalPrice.toString(),
    },
  };
}

/** A project's fixed-price sale state for one id on the shared edition minter (`sales(token,
 *  id)`) — the id-keyed twin of {@link SaleConfig}. */
export interface SaleConfig1155 {
  configured: boolean;
  paymentToken: Address;
  price: bigint;
  allocation: bigint;
  sold: bigint;
}

/** The id-keyed twin of {@link readSaleConfig}. */
export async function readSaleConfig1155(
  client: PublicClient,
  minter: Address,
  token: Address,
  tokenId: bigint | number,
): Promise<SaleConfig1155> {
  const [configured, paymentToken, price, allocation, sold] = (await client.readContract({
    address: minter,
    abi: abxFixedPriceMinter1155Abi,
    functionName: 'sales',
    args: [token, BigInt(tokenId)],
  })) as [boolean, Address, bigint, bigint, bigint];
  return {configured, paymentToken, price, allocation, sold};
}

/** The unsigned form of the shared edition minter deploy — CREATE2 via the keyless proxy +
 *  canonical salt (same address on every chain), matching `predictFixedPriceMinter1155()`. See
 *  {@link prepareDeployRenderer} for why this is `to: CREATE2_PROXY`, not a plain creation. */
export function prepareDeployFixedPriceMinter1155(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-fixed-price-minter-1155',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.fixedPriceMinter1155, abxFixedPriceMinter1155Bytecode),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical fixed-price edition minter (shared, ownerless) — CREATE2, deterministic address',
    fields: {},
  };
}

/** The unsigned form of the canonical seed source deploy — CREATE2 via the keyless proxy +
 *  canonical salt (same address on every chain), matching `predictSeedSource()`. See
 *  {@link prepareDeployRenderer} for why this is `to: CREATE2_PROXY`, not a plain creation. */
export function prepareDeploySeedSource(args: {chainId: number}): PreparedTx {
  return {
    op: 'deploy-seed-source',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.seedSource, abxSeedSourceBytecode),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Deploy the canonical pseudorandom seed source (CREATE2, deterministic address)',
    fields: {},
  };
}

// ── the seed source (Seed Source extension, Register 2) ───────────────────────
// Mint-time randomness is CONFIGURATION, not hard-coded token logic: the token holds one address
// and calls `IAbxSeedSource.seed(tokenId, to)` on it at mint. The canonical `AbxSeedSource` is
// deliberately pseudorandom (replayable after the fact, computable *during* the mint tx), so the
// documented escape for anything lottery-like is to point this at a commit-reveal / VRF-backed
// source of the project's own. That promise is only real if a creator can actually SET the address
// — which is what the two ops below, plus the probe, exist for.

/**
 * Set (or clear, with `0x0`) the seed source a code project draws mint seeds from. Signer must be
 * the owner. **Future mints only** — a seed is settled once assigned, so re-pointing never rewrites
 * a token that already has one.
 *
 * Pass an address that {@link probeSeedSource} says is usable. The chain does NOT validate the
 * source (`SeedSourceExtension.setSeedSource` stores whatever it's handed), and the failure mode of
 * a bad one is the worst kind: `seedSource()` reads back exactly what you set, the `SeedSourceSet`
 * event fires, everything looks configured — and then every mint reverts in the ABI decode of the
 * source's (empty or short) return. Callers should probe first and refuse before gas.
 */
export function prepareSetSeedSource(args: {contract: Address; seedSource: Address; chainId: number}): PreparedTx {
  const clearing = args.seedSource === zeroAddress;
  return {
    op: 'set-seed-source',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'setSeedSource', args: [args.seedSource]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: clearing
      ? 'Clear the seed source (future mints draw no seed; assigned seeds stay settled)'
      : `Set seed source → ${short(args.seedSource)} (future mints only)`,
    fields: {contract: args.contract, seedSource: args.seedSource},
  };
}

/**
 * The seed source a token currently draws from — `zeroAddress` for "no mint-time seed", and
 * `undefined` when the getter isn't there at all (a 1/1 or an image Series never composed the
 * extension). Those two are NOT the same fact and must not be collapsed: one is a code project
 * that opted out, the other is a token that has no such knob to set.
 */
export async function readSeedSource(client: PublicClient, contract: Address): Promise<Address | undefined> {
  return (await client
    .readContract({address: contract, abi: seriesCodeAbi, functionName: 'seedSource'})
    .catch(() => undefined)) as Address | undefined;
}

/**
 * Why a candidate seed source is unusable — or `ok`. Structured rather than a sentence: the SDK
 * doesn't know a UX's flag names (see `AnchorUnavailableError`'s note), so the caller composes the
 * guidance and this only says which shape it hit.
 *
 *   - `no-code`      — nothing deployed there. A Solidity call to a codeless address SUCCEEDS with
 *                      zero returndata, so the token's `abi.decode` to `bytes32` is what reverts.
 *   - `empty-return` — has code, answered, returned nothing. The permissive-fallback shape: a
 *                      **Safe** (`FallbackManager.fallback()` returns empty for an unset handler),
 *                      an uninitialised proxy, an EIP-7702-delegated EOA. Same mint revert.
 *   - `short-return` — answered with fewer than 32 bytes; not a `bytes32` no matter what it is.
 *   - `reverted`     — has code and refused the call. Either the wrong address entirely (a token,
 *                      a renderer — no such selector, no fallback) or a real source that is gating
 *                      callers / not yet armed. Both are refusals: `seed()` is called
 *                      **synchronously inside the mint** and its revert bubbles, so a source that
 *                      cannot answer now cannot answer at mint either.
 *   - `unreachable`  — the RPC didn't answer. Says nothing about the address; retry, don't refuse
 *                      on the merits (a preview may choose to defer the check and say so).
 */
export type SeedSourceVerdict = 'ok' | 'no-code' | 'empty-return' | 'short-return' | 'reverted' | 'unreachable';

/** The result of {@link probeSeedSource} — the verdict plus what was observed, for a message. */
export interface SeedSourceProbe {
  verdict: SeedSourceVerdict;
  /** The address probed. */
  address: Address;
  /** Bytes of returndata, when the call answered at all (`ok`/`empty-return`/`short-return`). */
  returnedBytes?: number;
  /** First line of the revert/transport error, for `reverted` / `unreachable`. */
  error?: string;
}

/**
 * Ask a candidate seed source the exact question the token will ask it, and report whether it
 * answers with 32 bytes.
 *
 * **`code.length > 0` is not enough**, which is the whole reason this exists. Three separate shapes
 * pass a has-code check, read back correctly from `seedSource()`, emit `SeedSourceSet`, and then
 * revert **every mint of the collection**: no code, a permissive fallback that returns empty (a
 * Safe, an uninitialised proxy, a 7702-delegated EOA — the same footgun the transfer-validator
 * probe in `CreatorToken.sol` was written for), and anything answering with fewer than 32 bytes.
 * A misconfigured seed source is silent until the first buyer, so the check belongs at configure
 * time, loudly.
 *
 * `IAbxSeedSource.seed` is **non-`view`** (sources may keep state — commit-reveal, oracle-fed), but
 * an `eth_call` simulates a state-changing function perfectly well and the canonical implementation
 * is itself `view`, so one `eth_call` probes both kinds without sending anything.
 *
 * The call is made **as the token** (`from` = `opts.as`, when given): `msg.sender` namespaces the
 * canonical seed and is exactly what a caller-gating custom source checks, so probing from a
 * random address would false-negative a legitimate source. Same reason the transfer-validator
 * research used `cast call --from <collection>`.
 *
 * Never throws for an on-chain reason — every failure is a verdict.
 */
export async function probeSeedSource(
  client: PublicClient,
  source: Address,
  opts: {as?: Address; tokenId?: bigint} = {},
): Promise<SeedSourceProbe> {
  let code: Hex | undefined;
  try {
    code = await client.getCode({address: source});
  } catch (err) {
    return {verdict: 'unreachable', address: source, error: firstLine(err)};
  }
  if (!code || code === '0x') return {verdict: 'no-code', address: source};
  const tokenId = opts.tokenId ?? 0n;
  // `to` mirrors the mint: the token asks for a seed for a recipient. The canonical source ignores
  // it; a custom one may not, so pass a plausible non-zero address rather than 0x0 (which a source
  // validating its recipient would rightly refuse, turning a good source into a false negative).
  const to = opts.as ?? source;
  try {
    const res = await client.call({
      to: source,
      data: encodeFunctionData({abi: abxSeedSourceAbi, functionName: 'seed', args: [tokenId, to]}),
      ...(opts.as ? {account: opts.as} : {}),
    });
    const bytes = res.data ? (res.data.length - 2) / 2 : 0;
    if (bytes === 0) return {verdict: 'empty-return', address: source, returnedBytes: 0};
    if (bytes < 32) return {verdict: 'short-return', address: source, returnedBytes: bytes};
    return {verdict: 'ok', address: source, returnedBytes: bytes};
  } catch (err) {
    return {verdict: 'reverted', address: source, error: firstLine(err)};
  }
}

/** First line of an error message — a revert reason is readable; viem's full dump is not. */
function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0].trim();
}

/**
 * {@link probeSeedSource}, as a guard: throws {@link SeedSourceUnusableError} unless the verdict is
 * `ok`. For an SDK caller that just wants "refuse a bad source" without composing prose; the CLI
 * uses the probe directly so it can name its own flags in the refusal.
 */
export async function assertSeedSourceUsable(
  client: PublicClient,
  source: Address,
  opts: {as?: Address; tokenId?: bigint} = {},
): Promise<void> {
  const probe = await probeSeedSource(client, source, opts);
  if (probe.verdict !== 'ok') throw new SeedSourceUnusableError(probe);
}

/** Deterministic deploy of a {SeriesCode} clone — the code-project factory op. */
export function prepareDeploySeriesCode(args: {
  factory: Address;
  params: SeriesCodeInitParams;
  salt: Hex;
  chainId: number;
  clone: Address;
}): PreparedTx {
  return {
    op: 'deploy-code',
    to: args.factory,
    data: encodeFunctionData({
      abi: seriesCodeFactoryAbi,
      functionName: 'deployDeterministic',
      args: [args.params as never, args.salt],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Deploy code project "${args.params.name}" (${String(args.params.maxInvocations)} max) → ${args.clone}`,
    fields: {
      factory: args.factory,
      clone: args.clone,
      name: args.params.name,
      symbol: args.params.symbol,
      owner: args.params.owner,
      seedSource: args.params.seedSource,
      maxInvocations: String(args.params.maxInvocations),
    },
  };
}

/** The code project's post-deploy setup: script chunks + PostParam schemas (+ dependency
 *  declarations, when the project has any; + the on-chain-URI legs under `--onchain-uri`),
 *  one atomic multicall. */
export function prepareCodeSetup(args: {
  contract: Address;
  calls: Hex[];
  chainId: number;
  chunkCount: number;
  schemaKeys: string[];
  /** Byte length of each script chunk this multicall stores. Used only to compute `gasFloor`. */
  chunkBytes?: number[];
  deps?: string[]; // human dependency refs, in index order (display only — the legs ride `calls`)
  onchainUri?: boolean; // the on-chain URI legs (animation field · the two URI renderers) ride `calls`
}): PreparedTx {
  const deps = args.deps ?? [];
  // EVM code deposit is exactly 200 gas per stored byte, so a multicall that stores these chunks
  // CANNOT cost less than this — before the CREATEs themselves, the schema/dependency/URI legs, or
  // any mints riding along. Deliberately the bare deposit and nothing else: this number's whole job
  // is to be un-arguable, so that an estimate below it is proof of a broken estimate rather than a
  // hint. (Do NOT pad it into a "probably enough" figure — a padded bound tempts a caller to send it
  // as the gas limit, and it would under-fund any setup carrying more than a couple of legs.)
  const chunkBytes = args.chunkBytes ?? [];
  const deposit = chunkBytes.reduce((g, n) => g + n * 200, 0);
  const gasFloor = deposit > 0 ? BigInt(deposit) : undefined;
  return {
    op: 'code-setup',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'multicall', args: [args.calls]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    ...(gasFloor === undefined ? {} : {gasFloor: `0x${gasFloor.toString(16)}` as Hex}),
    // Human, and ACCURATE to what THIS multicall actually contains — a creator signs it in their
    // wallet. (The old label was protocol jargon AND wrong for the renderer-only lane: it always
    // claimed a "generator animation field" even when no generator/animation was in the tx.)
    summary: (() => {
      const parts: string[] = [];
      if (args.chunkCount) parts.push(`store your program (${args.chunkCount} on-chain chunk${args.chunkCount === 1 ? '' : 's'})`);
      if (args.schemaKeys.length) parts.push(`enable collector-set parameter${args.schemaKeys.length === 1 ? '' : 's'}: ${args.schemaKeys.join(', ')}`);
      if (deps.length) parts.push(`declare ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'}: ${deps.join(', ')}`);
      if (args.onchainUri) parts.push('wire on-chain metadata resolution (the animation + URI renderers)');
      return parts.length ? `Finish setup — ${parts.join('; ')}` : 'Finish setup';
    })(),
    fields: {
      contract: args.contract,
      scriptChunks: String(args.chunkCount),
      schemas: args.schemaKeys.join(',') || '—',
      ...(deps.length ? {dependencies: deps.join(',')} : {}),
      ...(args.onchainUri ? {onchainUri: 'yes'} : {}),
    },
  };
}

// ── dependencies (Dependencies extension — code projects) ─────────────────────
// The ordered library declarations of a template-mode code project (index 0 = the runtime,
// by convention). Owner-only; the list stays dense (set at index ≤ count, remove only the
// last). See site/content/docs/protocol/code-projects.mdx + src/deps.ts for the ref encoding.

/** Set/replace the dependency at `index` — `resolution` 0 = Registry (`ref` = readable
 *  `name@version` bytes32), 1 = OnChain (`ref` = a data-contract address, left-aligned).
 *  Encode the pair with `parseDependencyRef`. Signer must be the owner. */
export function prepareSetDependency(args: {
  contract: Address;
  index: bigint | number;
  resolution: 0 | 1;
  ref: Hex;
  display?: string; // the human form, for the sign page
  chainId: number;
}): PreparedTx {
  const index = BigInt(args.index);
  const kind = args.resolution === 1 ? 'on-chain' : 'registry';
  const shown = args.display ?? args.ref;
  return {
    op: 'set-dependency',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'setDependency',
      args: [index, args.resolution, args.ref],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set dependency [${index}] → ${shown} (${kind})${index === 0n ? ' — index 0 = the runtime' : ''}`,
    fields: {contract: args.contract, index: index.toString(), resolution: kind, ref: shown},
  };
}

/** Remove the LAST dependency (the list stays dense — order is load-bearing). Signer = owner. */
export function prepareRemoveLastDependency(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'remove-last-dependency',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'removeLastDependency', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Remove the last dependency (the list stays dense)',
    fields: {contract: args.contract},
  };
}

/** Set (or clear, with `0x0`) the soft, non-validating dependency registry pointer —
 *  what `name@version` refs resolve through. Signer must be the owner. */
export function prepareSetDependencyRegistry(args: {
  contract: Address;
  registry: Address;
  chainId: number;
}): PreparedTx {
  const clearing = args.registry === zeroAddress;
  return {
    op: 'set-dependency-registry',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'setDependencyRegistry', args: [args.registry]}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: clearing
      ? 'Clear the dependency registry pointer (soft — refs stay declared)'
      : `Set dependency registry → ${short(args.registry)} (soft, non-validating)`,
    fields: {contract: args.contract, registry: args.registry},
  };
}

/** Freeze the dependency set (list + registry pointer) forever. Irreversible. Signer = owner. */
export function prepareLockDependencies(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'lock-dependencies',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'lockDependencies', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Freeze the dependency set (list + registry pointer) — permanent',
    fields: {contract: args.contract},
  };
}

/** Freeze the on-chain program (script chunks) forever — `setScriptChunk`/`removeLastScriptChunk`
 *  revert after this. Irreversible, owner-only. This is the lock that actually freezes the WORK
 *  of a code project; `lock-field`/`lock-uri` only freeze the metadata, and `lock-dependencies` only
 *  the library set. All of them together freeze everything the CONTRACT stores — which is not the
 *  same as a frozen output: params have no lock and the renderer serves them, and a `Registry`
 *  dependency resolves from the registry at read time. */
export function prepareLockScript(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'lock-script',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'lockScript', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Freeze the on-chain program (script chunks) — permanent',
    fields: {contract: args.contract},
  };
}

/** Set a CONTRACT-scope param to a literal `bytes32` (the raw owner setter — Params base).
 *  Only for schema-less keys (a schema'd key closes the raw path: `SchemaGoverned`). This is
 *  the write behind well-known contract params like `display.animation`. The key joins the
 *  contract's on-chain key list automatically (`contractParamKeys`), so it is enumerated by
 *  the generator and the renderer with no separate declaration. Signer must be the owner. */
export function prepareSetContractParam(args: {
  contract: Address;
  key: string;
  value: Hex; // bytes32 — a readable-ASCII literal (encodeTag) or a canonical scalar
  display?: string; // the human form, for the sign page
  chainId: number;
}): PreparedTx {
  return {
    op: 'set-contract-param',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'setContractParam',
      args: [encodeTag(args.key), args.value],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set contract param ${args.key} = ${args.display ?? args.value}`,
    fields: {contract: args.contract, key: args.key, value: args.display ?? args.value},
  };
}

/** Set a CONTRACT-scope param via the data path (one blob; the evented value is its keccak256).
 *  The raw owner setter for schema-less keys — the long-form twin of {@link prepareSetContractParam}. */
export function prepareSetContractParamData(args: {
  contract: Address;
  key: string;
  data: Hex;
  chainId: number;
}): PreparedTx {
  return {
    op: 'set-contract-param-data',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'setContractParamData',
      args: [encodeTag(args.key), args.data],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set contract param ${args.key} (data, ${(args.data.length - 2) / 2} bytes)`,
    fields: {contract: args.contract, key: args.key},
  };
}

/** Wire the three param-lifecycle hook addresses (configure/augment/transfer) in ONE owner call.
 *  The contract has no per-hook setter — `setParamHooks` writes all three at once — so a caller
 *  changing one hook must pass the CURRENT values for the other two (read them via `paramHooks()`),
 *  else it silently clears them. `zeroAddress` for any role means "no hook". SeriesCode/EditionCode
 *  only.
 *
 *  Note what the `transferHook` slot is: a **veto**. Its revert bubbles and fails the transfer, and
 *  a mint is a transfer from `0x0`, so a reverting hook stops minting for the project too. Setting
 *  one is therefore a standing power over a collector's ability to sell — disclose it, and offer
 *  {@link prepareLockParamHooks} to a project that wants to prove it will never arm one.
 *
 *  Reverts `ParamHooksLocked()` once {@link prepareLockParamHooks} has been sent. */
export function prepareSetParamHooks(args: {
  contract: Address;
  configureHook: Address;
  augmentHook: Address;
  transferHook: Address;
  chainId: number;
}): PreparedTx {
  return {
    op: 'set-param-hooks',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'setParamHooks',
      args: [args.configureHook, args.augmentHook, args.transferHook],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set param hooks — configure ${args.configureHook}, augment ${args.augmentHook}, transfer ${args.transferHook}`,
    fields: {
      contract: args.contract,
      configureHook: args.configureHook,
      augmentHook: args.augmentHook,
      transferHook: args.transferHook,
    },
  };
}

/**
 * Is the param hook set frozen (`lockParamHooks()` already sent)?
 *
 * One `eth_call` to `paramHooksLocked()`. This used to simulate `setParamHooks` as the owner and
 * watch for a `ParamHooksLocked()` revert, on the stated grounds that no getter existed — it does
 * now (`IAbxConfigurableParams`), and the simulation cost two extra reads (`paramHooks` + `owner`)
 * to infer what one read states.
 *
 * The other honest read is the `ParamHooksFrozen` event, which is what `reconstructProject` folds
 * (`ProjectState.paramHooks.locked`). Prefer the fold when you already have the logs; use this when
 * you have an address and one RPC round trip, which is `abx state`'s situation.
 *
 * Returns `undefined` — never throws for an on-chain reason — when the answer can't be established:
 * not a ConfigurableParams project, or the node refused the call. A caller must render that as
 * "unknown", never as "unlocked".
 */
export async function readParamHooksLocked(
  client: PublicClient,
  contract: Address,
): Promise<boolean | undefined> {
  try {
    return (await client.readContract({
      address: contract,
      abi: seriesCodeAbi,
      functionName: 'paramHooksLocked',
    })) as boolean;
  } catch {
    return undefined;
  }
}

/**
 * Freeze the param-lifecycle hook set forever — `setParamHooks` reverts `ParamHooksLocked()` after
 * this. Irreversible, owner-only. The sibling of `lock-script`/`lock-dependencies`/`lock-uri`, and
 * the one aimed at a **buyer** rather than at the metadata: the `transferHook` is a veto (its revert
 * fails a transfer, and a mint is a transfer from `0x0`), so while the hooks are unwritten-in-stone a
 * project retains a standing power over whether a collector can ever sell. Sending this gives up
 * three abilities permanently — arming a transfer veto, arming a write-time configure veto, and
 * re-pointing or clearing the read-time augment hook — and it cannot be undone, re-opened, or
 * time-limited. A project that never wants the power sends it before the sale; a buyer reads
 * `paramHooks()` plus the `ParamHooksFrozen` event (`abx state`) to check.
 *
 * It does NOT freeze anything else: schemas, values, script, dependencies, and URIs all keep their
 * own locks, and a hook already set keeps running exactly as before — freezing the SET is not
 * disarming the hooks in it.
 */
export function prepareLockParamHooks(args: {contract: Address; chainId: number}): PreparedTx {
  return {
    op: 'lock-param-hooks',
    to: args.contract,
    data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'lockParamHooks', args: []}),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: 'Freeze the param hooks (configure/augment/transfer) — permanent',
    fields: {contract: args.contract},
  };
}

/** Set a schema-governed PostParam (literal scalar) — signer must satisfy the schema's auth. */
export function prepareConfigureTokenParam(args: {
  contract: Address;
  tokenId: bigint;
  key: string;
  value: Hex; // bytes32, canonically encoded per the schema's type
  display: string; // the human form, for the sign page
  chainId: number;
}): PreparedTx {
  return {
    op: 'configure-param',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'configureTokenParam',
      args: [args.tokenId, encodeTag(args.key), args.value],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Configure ${args.key} = ${args.display} on token ${args.tokenId}`,
    fields: {contract: args.contract, tokenId: String(args.tokenId), key: args.key, value: args.display},
  };
}

/** Set a schema-governed `String`/`Bytes` PostParam (the data path — one blob, hash evented). */
export function prepareConfigureTokenParamData(args: {
  contract: Address;
  tokenId: bigint;
  key: string;
  data: Hex;
  chainId: number;
}): PreparedTx {
  return {
    op: 'configure-param-data',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'configureTokenParamData',
      args: [args.tokenId, encodeTag(args.key), args.data],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Configure ${args.key} (data, ${(args.data.length - 2) / 2} bytes) on token ${args.tokenId}`,
    fields: {contract: args.contract, tokenId: String(args.tokenId), key: args.key},
  };
}

// ── PostParam schemas, post-deploy (ConfigurableParams) ──────────────────────
// `setParamSchema` is owner-gated and has NO deploy-time restriction and no `exists` check, so it is
// an upsert usable for the whole life of a project: attach a schema to a new key, or replace one.
// There is no delete anywhere in the contract — `exists` is only ever set true — so a governed key
// stays governed. What IS available is retirement: a `lockAfter` in the past makes every subsequent
// write revert `ParamLockExpired`, permanently. See `prepareRetireParam`.

/** Attach or replace one key's schema. Owner-only.
 *
 *  A replacement does NOT re-validate values already stored under the key — narrow a bound, drop a
 *  `Select` option or change the type and existing tokens keep values that now violate their own
 *  schema. Callers that are editing (rather than creating) should read the current schema first and
 *  carry forward every field they don't mean to change; this is a full-row write, not a patch. */
export function prepareSetParamSchema(args: {
  contract: Address;
  key: string;
  paramType: number;
  auth: number;
  authAddress?: Address;
  lockAfter?: number;
  min: Hex;
  max: Hex;
  selectOptions?: string[];
  chainId: number;
  /** Human rendering for the sign page (the CLI's `describeSchema`). */
  display?: string;
}): PreparedTx {
  const lockAfter = args.lockAfter ?? 0;
  const authAddress = args.authAddress ?? ('0x0000000000000000000000000000000000000000' as Address);
  return {
    op: 'set-param-schema',
    to: args.contract,
    data: encodeFunctionData({
      abi: seriesCodeAbi,
      functionName: 'setParamSchema',
      args: [encodeTag(args.key), args.paramType, args.auth, authAddress, lockAfter, args.min, args.max, args.selectOptions ?? []],
    }),
    value: ZERO_VALUE,
    chainId: args.chainId,
    summary: `Set the on-chain schema for "${args.key}"${lockAfter ? ` (value locks after ${new Date(lockAfter * 1000).toISOString().slice(0, 19)}Z)` : ''}`,
    fields: {
      contract: args.contract,
      key: args.key,
      schema: args.display ?? args.key,
      ...(lockAfter ? {lockAfter: String(lockAfter)} : {}),
    },
  };
}

/** The decoded on-chain schema for one key (`paramSchema(bytes32)`). `exists: false` ⇒ ungoverned. */
export interface OnChainParamSchema {
  exists: boolean;
  paramType: number;
  auth: number;
  authAddress: Address;
  lockAfter: number;
  min: Hex;
  max: Hex;
  selectOptions: string[];
}

/** Read one key's schema from chain. The read half of the upsert — anything editing a live schema
 *  MUST start here, or it silently rewrites the fields it didn't mention. */
export async function readParamSchema(
  client: PublicClient,
  contract: Address,
  key: string,
): Promise<OnChainParamSchema> {
  const r = (await client.readContract({
    address: contract,
    abi: seriesCodeAbi,
    functionName: 'paramSchema',
    args: [encodeTag(key)],
  })) as readonly [boolean, number, number, Address, number, Hex, Hex, readonly string[]];
  return {
    exists: r[0],
    paramType: Number(r[1]),
    auth: Number(r[2]),
    authAddress: r[3],
    lockAfter: Number(r[4]),
    min: r[5],
    max: r[6],
    selectOptions: [...r[7]],
  };
}

/**
 * Retire a parameter: keep every field of its existing schema and set only `lockAfter` to a past
 * timestamp, so all further writes revert `ParamLockExpired`. This is the closest thing the protocol
 * has to deleting a parameter, and it is the read-modify-write case the upsert makes dangerous —
 * hence the caller passes the schema it just READ, rather than a schema it composed.
 *
 * What retiring does NOT do: erase a value already stored. That value keeps being served in token
 * data. It cannot be removed, deliberately — a value written under a `TokenOwner` or `Address` leg
 * came from a collector, and the creator should not be able to delete someone else's contribution.
 */
export function prepareRetireParam(args: {
  contract: Address;
  key: string;
  current: OnChainParamSchema;
  chainId: number;
  /** Unix seconds; defaults to "one second ago" (already expired ⇒ permanent). */
  at?: number;
}): PreparedTx {
  const lockAfter = args.at ?? Math.floor(Date.now() / 1000) - 1;
  const tx = prepareSetParamSchema({
    contract: args.contract,
    key: args.key,
    paramType: args.current.paramType,
    auth: args.current.auth,
    authAddress: args.current.authAddress,
    lockAfter,
    min: args.current.min,
    max: args.current.max,
    selectOptions: args.current.selectOptions,
    chainId: args.chainId,
  });
  return {
    ...tx,
    op: 'retire-param',
    summary: `Retire "${args.key}" — no further writes, permanently (the schema and any stored value remain)`,
    fields: {contract: args.contract, key: args.key, lockAfter: String(lockAfter), effect: 'all future writes revert'},
  };
}
