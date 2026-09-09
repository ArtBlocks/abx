import type {Address, Hex} from 'viem';

/** One extension a contract has enabled, as learned from `AbxExtensionVersionSet`. */
export interface ExtensionInfo {
  id: Hex;
  name: string; // friendly name where known, else the raw id
  version: number;
}

/**
 * One on-chain metadata value, decoded from the spine: a `field` (the *what*, e.g.
 * "image") carried in a `representation` (the *how*, e.g. "inline" / "keccak256" /
 * "arweave"). See the protocol registry (site/content/docs/protocol/metadata.mdx).
 */
export interface MetadataField {
  field: string; // decoded field tag, e.g. "image", "description"
  representation: string; // decoded representation tag, e.g. "inline", "keccak256"
  value: Hex; // raw bytes — the content, a locator, or a hash, per representation
}

/** One param (Params extension): `key → bytes32` with the hash flag + write provenance. */
export interface ParamValue {
  key: string; // decoded readable-ASCII key, e.g. "seed", "palette"
  value: Hex; // the literal (valueIsHash=false) or keccak256 of the data blob (true)
  valueIsHash: boolean; // true ⇒ full content reads back via tokenParamData/contractParamData
  updatedBy: Address; // who wrote it — owner, the seed source, a hook, a schema-authorized configurer
}

/** One key's governance (Configurable Params): what it means, who may set it, until when. */
export interface ParamSchema {
  key: string;
  paramType: string; // canonical name, e.g. "HexColor" (see PARAM_TYPES)
  auth: string; // canonical name, e.g. "TokenOwner" (see AUTH_OPTIONS)
  authAddress: Address | null; // the Address auth leg (null unless used)
  lockAfter: string; // unix seconds as decimal string; "0" = never locks
  min: Hex;
  max: Hex;
  selectOptions: string[];
}

/** The three param lifecycle hooks (any may be null = none), plus whether the set is frozen. */
export interface ParamHooks {
  configureHook: Address | null; // write-time veto/validator
  augmentHook: Address | null; // read-time derivation (tokenData assembly)
  /** Ownership-change lifecycle — a **VETO**: its revert fails the transfer, and a mint is a
   *  transfer from `0x0`, so a reverting hook also stops minting. Read `locked` next to it. */
  transferHook: Address | null;
  /** `lockParamHooks()` was sent: the three addresses above can never change again. The read that
   *  turns "the hooks are whatever the owner currently says" into something a buyer can verify —
   *  it matters most for `transferHook`, an unlocked one being a standing power over a collector's
   *  ability to sell. Folded from `ParamHooksFrozen`. */
  locked: boolean;
}

/** One declared code dependency (Dependencies extension); index 0 = the runtime. */
export interface DependencyInfo {
  resolution: 'registry' | 'onchain';
  ref: Hex; // the raw bytes32 as evented
  refDecoded: string; // registry ⇒ the name-and-version tag; onchain ⇒ the address
}

/** On-chain script custody state. Chunk content is a head read (too large to log). */
export interface ScriptState {
  chunkCount: number | null; // head read; null when unread
  locked: boolean;
  /** keccak256 over the concatenated chunk contents (head read) — the content digest
   *  effect `inputsHash` values commit to. Null when unread or no chunks. */
  digest?: Hex | null;
}

/** The declared dependency set (fully log-foldable — events carry full values). */
export interface DependenciesState {
  list: DependencyInfo[];
  registry: Address | null; // soft, non-validating pointer
  locked: boolean;
}

/** A decoded spine log, kept verbatim as reconstruction provenance. */
export interface SpineEvent {
  name: string;
  register: 1 | 2;
  what: string;
  blockNumber: string;
  logIndex: number;
  txHash: Hex;
  args: Record<string, string>;
}

export interface TokenState {
  tokenId: string;
  /**
   * Does a token exist at this id **right now** — the one question a consumer is actually asking.
   *
   * - `'unminted'` — ERC-721: a valid id never issued (the deployed-but-unminted state a resolver
   *   serves warming metadata for). Valid state, not a gap.
   * - `'live'` — a token exists: a 721 with a holder, or an edition id with `supply > 0`.
   * - `'burned'` — **terminal, and ERC-721 only.** The id was issued and destroyed, the contract
   *   disowns it (`tokenURI` reverts `NonexistentToken`), and it can never come back: ABX mints from
   *   a monotonic `nextTokenId`, so no mint path can reissue that id. This is the word a consumer
   *   may act on irreversibly — drop it from a gallery, answer `410 Gone`.
   * - `'no-live-copies'` — **ERC-1155 editions only, and never terminal.** Zero live copies of this
   *   id right now: never minted, or every copy burned, or minted and fully burned twice over. It
   *   makes no claim about history *because the two have no different consequence* — the id can mint
   *   again either way, so anything that treats it as gone forever is wrong. `supply`/`holders`
   *   carry the numbers; the event log carries the history.
   *
   * **Why `'burned'` is not shared across the standards**, though the first draft of this enum shared
   * it: the correct response to destruction differs by standard, so one word covering both put every
   * consumer one forgotten branch away from serving `410 Gone` for an edition id that can mint again.
   * Splitting the word moves the rule out of prose that must be
   * remembered and into the type: **`lifecycle === 'burned'` is safe to treat as permanent on either
   * standard, with no carve-out**, which is the only version of this rule that survives a refactor.
   *
   * It replaced a `minted: boolean` that latched `true` at mint and was never recomputed on the 721
   * lane, so a burned token reconstructed as live, held by `0x0`. "Was it ever issued" is
   * `lifecycle !== 'unminted'` on a 721; on an edition, ask the log.
   */
  lifecycle: 'unminted' | 'live' | 'burned' | 'no-live-copies';
  /** 721 only — the current holder; `null` when `'unminted'` or `'burned'` (a destroyed token has
   *  no holder — the zero address is never written here, so this field never has to be read as a
   *  sentinel). Always `null` for an edition (an id can have many concurrent holders; see
   *  {@link holders}). */
  owner: Address | null;
  tokenURI: string | null; // read at head (events are pings, carry no value); null until minted
  fields: MetadataField[]; // on-chain metadata fields for this token (field × representation)
  lockedFields: string[]; // field names frozen forever (per-field lock)
  /** Token-scope params (Params extension) — `seed`, PostParam values, … Absent/empty ⇒ none. */
  params?: ParamValue[];
  /** ERC-1155 editions only — total live copies of this id (minted − burned), folded from
   *  `TransferSingle`/`TransferBatch`. Absent for a 721 token. */
  supply?: string;
  /**
   * ERC-1155 editions only — this id's **effective** supply cap: its own override when one exists,
   * otherwise the collection default ({@link ProjectState.defaultMaxSupply}). Absent for a 721
   * token. Equals the on-chain `maxSupply(id)` view, and therefore its head-read twin
   * (`TokenRow.maxSupply` in `tokens.ts`) — one field name, one meaning, whichever lane produced it.
   *
   * It used to fold `MaxSupplyUpdated` alone, which made the two lanes disagree on the DEFAULT
   * shape: `--copies 10` sets the cap at `initialize` and never calls `setMaxSupply`, so no id had
   * an event of its own and this read *absent* — "open, uncapped" — for every capped edition ever
   * deployed. The head read said `10`. That is the sibling-drift class, on the field that decides
   * whether a buy button renders.
   *
   * `'0'` carries the on-chain overload deliberately: **open** when {@link maxSupplyOverridden} is
   * false, **closed forever** when it is true.
   */
  maxSupply?: string;
  /** ERC-1155 editions only — has this id ever been explicitly overridden (`setMaxSupply`)? The
   *  distinction the on-chain getter cannot make and the log can, now that `DefaultMaxSupplySet`
   *  completes the log: it disambiguates a `'0'` cap (open vs deliberately closed) and tells you
   *  whether the monotonic never-increase rule is already in force for this id. Absent ⇒ false. */
  maxSupplyOverridden?: boolean;
  /** ERC-1155 editions only — current balances by holder address, folded from
   *  `TransferSingle`/`TransferBatch`. Zero balances are deleted, so a key's presence IS "holds
   *  at least one copy." Omitted/empty when unknown (a 721 token, or an edition with no folded
   *  history). Not chain-enumerable outside the event log — this is why {@link owner} can't
   *  simply generalize to "the current holders": a chain-only head read (no event scan) has no
   *  way to list them (see `tokens.ts`'s `listTokens`, which is exactly that head-read-only path
   *  and therefore never populates this field). */
  holders?: Record<Address, string>;
}

/**
 * The full reconstructed state of an ABX project — rebuilt from the event log
 * (structure) plus targeted head reads (string values the events only ping).
 * This is the object the reconstructability property produces: derivable from
 * the chain alone, with no provider's cooperation.
 */
export interface ProjectState {
  address: Address;
  chainId: number;

  // identity / trust (Register 2 + factory)
  abxVersion: number | null;
  deployBlock: string | null;
  deployTx: Hex | null;
  factory: Address | null;
  implementation: Address | null;
  isCanonical: boolean | null; // factory.isAbxClone(address) — trust, not just discovery

  // collection identity
  name: string | null; // head read
  symbol: string | null; // head read
  owner: Address | null;
  contractURI: string | null; // head read (data: URI when resolving on-chain)
  royalty: {receiver: Address; bps: number} | null;
  /**
   * The royalty **ceiling** — owner-set at deploy, reduce-only forever after, folded from
   * `MaxRoyaltyBpsUpdated` (last-writer-wins, so a later `reduceMaxRoyaltyBps` beats the deploy-time
   * value). Tri-state, and the third state carries weight: `null` means **the spine never stated
   * one** — an implementation with no `maxRoyaltyBps()` at all — which is a different fact from a
   * collection that published a ceiling of 1000. Never report a default for a ceiling the contract
   * never published.
   *
   * Deliberately NOT nested inside {@link royalty}: clearing the royalty to `(0x0, 0)` sets that
   * field to `null`, and the ceiling survives that on chain — nesting would drop a still-binding
   * fact. Present them together in any readout, though: a rate without its ceiling is half the fact
   * (a ceiling above the live rate means the owner can raise the rate unilaterally, and a buyer
   * cannot see that from a listing — so reducing the cap to the current rate is what turns "5%
   * today" into a promise).
   */
  maxRoyaltyBps?: number | null;
  /**
   * Did this collection opt into burning (`BurnConfigured`, emitted once at deploy and fixed
   * thereafter)? Tri-state on the same rule as {@link maxRoyaltyBps}: `null` = the spine never
   * stated it, which is not `false`. An implementation predating the opt-in has no `burn`
   * entrypoint at all; a collection with `burnable: false` has one that refuses.
   */
  burnable?: boolean | null;

  // URI resolution config — the off-chain↔on-chain toggle + freeze (head reads).
  // A non-null renderer ⇒ the URI resolves on-chain (the JSON is assembled from fields);
  // null ⇒ off-chain pointer. `*Locked` true ⇒ the config (pointer + renderer) is frozen.
  tokenURIRenderer: Address | null;
  tokenURILocked: boolean | null;
  contractURIRenderer: Address | null;
  contractURILocked: boolean | null;

  // on-chain collection (contract-wide) metadata fields — ERC-7572 scope
  collectionFields: MetadataField[];
  lockedCollectionFields: string[];

  // multi-token (Series) state — absent/identity for a 1/1.
  /** Which concrete token type this is, inferred from the enabled extensions. The `-edition`
   *  suffix is the ERC-1155 family (detected via the Edition Supply extension), a parallel
   *  ladder to the ERC-721 one: `1of1-edition` ↔ `1of1`, `edition` ↔ `series`,
   *  `edition-code` ↔ `code`. */
  contractType?: '1of1' | 'series' | 'code' | '1of1-edition' | 'edition' | 'edition-code';
  /** Supply cap "X of Y" (Max Invocations extension); null/absent ⇒ uncapped 1/1. */
  maxInvocations?: string | null;
  /** ERC-1155 editions only — the collection-wide DEFAULT per-id cap (`editionSize` at
   *  `initialize`), folded from `DefaultMaxSupplySet`. `'0'` ⇒ open by default; null ⇒ not an
   *  edition. The 1155 analogue of {@link maxInvocations}: it is the project-level ceiling, while
   *  {@link TokenState.maxSupply} is a single id's. Every id that has never been overridden carries
   *  this, which is why the event exists — see `IAbxEditionSupply`. */
  defaultMaxSupply?: string | null;
  /** The single authorized minter (External Minter extension); null ⇒ owner-only. */
  minter?: Address | null;
  /** Whether minting is paused (Paused extension) — true ⇒ owner-only. Absent/false ⇒ open. */
  paused?: boolean;
  /** Primary-sale payout destination (Primary Payee extension); null ⇒ none. */
  primaryPayee?: Address | null;

  // code-project state — absent for static tokens; folded from the spine.
  /** Contract-scope params (Params extension). */
  contractParams?: ParamValue[];
  /** Per-key PostParam schemas (Configurable Params) — emitted in full, log-foldable. */
  paramSchemas?: ParamSchema[];
  /** The param lifecycle hooks; null ⇒ extension absent, all-null ⇒ none wired. */
  paramHooks?: ParamHooks | null;
  /** TokenOwner-auth delegation resolver: address, or null = disabled. Absence of the
   *  event resolves to the canonical delegate.xyz default when the extension is present. */
  delegateRegistry?: Address | null;
  /** Mint-time seed source (Seed Source extension); null ⇒ no mint-time seed. */
  seedSource?: Address | null;
  /** On-chain script custody (On-Chain Script extension); null ⇒ extension absent. */
  script?: ScriptState | null;
  /** Declared code dependencies (Dependencies extension); null ⇒ extension absent. */
  dependencies?: DependenciesState | null;

  extensions: ExtensionInfo[];
  tokens: TokenState[];

  // provenance / re-index accounting
  events: SpineEvent[];
  fromBlock: string;
  toBlock: string;
  eventCount: number;
  reconstructedAt: string; // ISO timestamp, stamped by the caller
  rpcUrl?: string;
}
