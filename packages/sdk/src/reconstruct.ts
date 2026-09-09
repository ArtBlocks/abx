import {
  concat as concatHex,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type Log,
} from 'viem';
import {oneOfOneEditionAbi, oneOfOneImageAbi, oneOfOneImageFactoryAbi, seriesCodeAbi, spineEventAbi} from './abi/index.js';
import {
  AUTH_OPTIONS,
  decodeTag,
  DELEGATE_REGISTRY_DEFAULT,
  extensionName,
  EXTENSION_ID,
  PARAM_TYPES,
  SPINE_EVENT_DOC,
} from './spine.js';
import {AbxSdkError, BlockTagUnavailableError} from './errors.js';
import {readEnv} from './util.js';
import type {
  DependenciesState,
  DependencyInfo,
  ExtensionInfo,
  MetadataField,
  ParamHooks,
  ParamSchema,
  ParamValue,
  ProjectState,
  ScriptState,
  SpineEvent,
  TokenState,
} from './types.js';

/**
 * Block tags a caller may pick as a reconstruction boundary, beyond a literal number or `'latest'`.
 * Only the two the issue asked for: `'safe'` (the client's reorg-unlikely tip) and `'finalized'`
 * (post-merge finality — won't be reorged short of a >1/3-stake slashing event). Hosted operators
 * want this so a resolver can serve state it's confident will never need to be walked back, without
 * inventing an ad hoc lookback-window policy on top of `latest`.
 */
export type ReconstructBlockTag = 'safe' | 'finalized';

/**
 * Resolve `'safe'`/`'finalized'` to a CONCRETE inclusive block number — BEFORE any `eth_getLogs`
 * scan starts, and before it's persisted anywhere. A stored watermark (`ProjectState.toBlock`) must
 * always be a literal number, never the tag itself: `"finalized"` is a moving target, so persisting
 * the string would silently redefine an already-written checkpoint's meaning on every later read,
 * and two reconstructions minutes apart would disagree about what block a stored `toBlock:
 * "finalized"` even meant. Resolving once, here, up front, is what makes the persisted value durable.
 *
 * Throws {@link BlockTagUnavailableError} — never falls back to `latest` — when the RPC can't answer
 * the tag. See that error for why silent fallback is the wrong move.
 */
export async function resolveBlockTag(client: PublicClient, tag: ReconstructBlockTag): Promise<bigint> {
  let block: {number: bigint | null} | undefined;
  try {
    block = await client.getBlock({blockTag: tag});
  } catch (err) {
    throw new BlockTagUnavailableError(tag, err);
  }
  if (block?.number == null) throw new BlockTagUnavailableError(tag);
  return block.number;
}

/** Resolve a scan boundary — a literal block, `'latest'`/undefined (chain head), or a supported
 *  {@link ReconstructBlockTag} — to a concrete inclusive block number before any scan starts. Shared
 *  by {@link reconstructProject} (which also accepts a literal number) and
 *  {@link reconstructIncremental} (which only ever resolves relative to head). */
async function resolveScanBoundary(
  client: PublicClient,
  toBlock: bigint | 'latest' | ReconstructBlockTag | undefined,
): Promise<bigint> {
  if (toBlock === undefined || toBlock === 'latest') return client.getBlockNumber();
  if (toBlock === 'safe' || toBlock === 'finalized') return resolveBlockTag(client, toBlock);
  return toBlock;
}

export interface ReconstructOptions {
  address: Address;
  fromBlock: bigint;
  /** Default `'latest'` (chain head) — unchanged. `'safe'`/`'finalized'` stop the scan at that tag's
   *  block instead, resolved to a concrete number via {@link resolveBlockTag} before any log fetch
   *  and persisted as that number, never the tag (see {@link ProjectState.toBlock}). */
  toBlock?: bigint | 'latest' | ReconstructBlockTag;
  /** Canonical factory — lets reconstruction verify trust (isAbxClone), not just discovery. */
  factory?: Address;
  /** Override the `eth_getLogs` scan safety cap (env fallback: `ABX_GETLOGS_MAX_CHUNKS`; the
   *  CLI's `--yes` sets that). */
  maxChunks?: number;
  /** Override the starting `eth_getLogs` window, in blocks (env fallback: `ABX_GETLOGS_RANGE`). */
  getLogsRange?: bigint;
  /**
   * Also head-read the composed `contractURI`/`tokenURI` documents (default **false**). These are
   * diagnostic, not structural — see {@link applyHeadReads} for why they're opt-in: on the on-chain
   * lane each one assembles a whole metadata document per call, and neither has a settled value a
   * projection could cache correctly. Leave this off unless something is actually going to display
   * the composed document (e.g. `abx demo`'s read-back step).
   */
  readUriDocuments?: boolean;
  /** See {@link GetLogsAdaptiveOptions.onChunk} — the only progress signal during a large scan. */
  onChunk?: GetLogsAdaptiveOptions['onChunk'];
}

/**
 * Rebuild a project's full state from the chain alone — the canonical replay.
 *
 * Structure comes from folding the event spine (idempotent, last-writer-wins);
 * string *values* the events only ping (tokenURI, contractURI, name/symbol) are
 * read at head — exactly the spine's design. No provider is involved, and the
 * result is byte-for-byte reproducible from the same chain range. This is the
 * durability proof: delete the projection, run this, get identical state.
 */
export async function reconstructProject(
  client: PublicClient,
  opts: ReconstructOptions,
): Promise<ProjectState> {
  const {address, fromBlock, factory} = opts;
  const toBlockNum = await resolveScanBoundary(client, opts.toBlock);

  const rawLogs = await getLogsAdaptive(client, address, fromBlock, toBlockNum, {
    maxChunks: opts.maxChunks,
    range: opts.getLogsRange,
    onChunk: opts.onChunk,
  });
  const events = decodedToSpineEvents(parseEventLogs({abi: spineEventAbi, logs: rawLogs as Log[]})).sort(byOrder);
  return assembleState(client, address, events, foldSpine(events), fromBlock, toBlockNum, factory, !!opts.readUriDocuments);
}

/**
 * The same state, but resumed from a prior reconstruction's checkpoint — so a
 * re-index only fetches the blocks added since (a wide head gap costs nothing),
 * yet the result is identical to a full replay. We fetch strictly `prior.toBlock + 1`
 * onward (no reorg lookback — post-PoS reorgs are rare enough that the repair is the
 * deterministic full replay: `abx index <addr> --full`), merge + de-dup with the prior
 * event log, re-fold the complete sorted spine in-memory, and re-read head values fresh.
 * Folding the whole history each time is microseconds; not re-fetching it is the win.
 */
export async function reconstructIncremental(
  client: PublicClient,
  prior: ProjectState,
  opts: {
    factory?: Address;
    maxChunks?: number;
    getLogsRange?: bigint;
    readUriDocuments?: boolean;
    onChunk?: GetLogsAdaptiveOptions['onChunk'];
    /** Default `'latest'` (chain head) — unchanged. `'safe'`/`'finalized'` stop the catch-up at that
     *  tag's block instead; see {@link ReconstructOptions.toBlock}. */
    toBlock?: 'latest' | ReconstructBlockTag;
  } = {},
): Promise<ProjectState> {
  const address = prior.address;
  const factory = opts.factory ?? prior.factory ?? undefined;
  const head = await resolveScanBoundary(client, opts.toBlock);

  const priorTo = BigInt(prior.toBlock);
  const origin = BigInt(prior.deployBlock ?? prior.fromBlock);
  const resumeFrom = priorTo + 1n > origin ? priorTo + 1n : origin;

  let rawLogs: Log[] = [];
  if (head >= resumeFrom) {
    rawLogs = await getLogsAdaptive(client, address, resumeFrom, head, {
      maxChunks: opts.maxChunks,
      range: opts.getLogsRange,
      onChunk: opts.onChunk,
    });
  }

  const toBlock = head >= priorTo ? head : priorTo;
  return reconstructFromLogs(client, prior, rawLogs, {factory, readUriDocuments: opts.readUriDocuments, toBlock});
}

/**
 * The fold / head-read half of {@link reconstructIncremental}, given logs the caller already
 * fetched. A multi-address watch loop (`getLogs({address: Address[]})`) holds each touched
 * project's delta; this consumes it so that loop is the only `eth_getLogs`. Folding stays here.
 *
 * `toBlock` is the inclusive scan head those logs cover — required even when `logs` is empty,
 * so a quiet window still advances the checkpoint to the range the caller scanned, and so a
 * caller that scanned a capped window (not chain head) cannot stamp `toBlock` past the last
 * log they actually held.
 */
export async function reconstructFromLogs(
  client: PublicClient,
  prior: ProjectState,
  logs: readonly Log[],
  opts: {factory?: Address; readUriDocuments?: boolean; toBlock: bigint},
): Promise<ProjectState> {
  const factory = opts.factory ?? prior.factory ?? undefined;
  const fresh = decodedToSpineEvents(parseEventLogs({abi: spineEventAbi, logs: logs as Log[]}));

  // Merge the prior log with the freshly-fetched tail, de-duping by position so an
  // overlapping/duplicate re-run can't double-count, then fold the complete spine.
  const seen = new Set<string>();
  const all: SpineEvent[] = [];
  for (const ev of [...prior.events, ...fresh]) {
    const key = `${ev.blockNumber}:${ev.logIndex}:${ev.txHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(ev);
  }
  all.sort(byOrder);

  // Chunk content has no log (too large); `ScriptUpdated` is the ping. A Transfer currently
  // used to re-download every chunk. Keep the prior digest unless that ping is in `fresh`.
  const scriptTouched = fresh.some((e) => e.name === 'ScriptUpdated');
  const reuseScript = !scriptTouched && prior.script?.digest != null ? prior.script : undefined;

  const priorTo = BigInt(prior.toBlock);
  const toBlock = opts.toBlock >= priorTo ? opts.toBlock : priorTo;
  return assembleState(
    client,
    prior.address,
    all,
    foldSpine(all),
    BigInt(prior.fromBlock),
    toBlock,
    factory,
    !!opts.readUriDocuments,
    reuseScript,
  );
}

// ── the shared fold ───────────────────────────────────────────────────────────

/** The structural projection folded from the spine (everything that isn't a head read).
 *  Exported for tests and advanced consumers; the shape may evolve with the spine. */
export interface Fold {
  abxVersion: number | null;
  deployBlock: string | null;
  deployTx: Hex | null;
  owner: Address | null; // from OwnershipTransferred; the head read overrides with current
  royalty: {receiver: Address; bps: number} | null;
  maxRoyaltyBps: number | null; // MaxRoyaltyBpsUpdated; last-writer-wins (reduce-only on chain)
  burnable: boolean | null; // BurnConfigured; emitted once at deploy. null ⇒ never stated
  extById: Map<string, ExtensionInfo>;
  tokens: Map<string, TokenState>;
  tokenFields: Map<string, Map<string, MetadataField>>; // tokenId -> "field\0repr" -> field (last-writer-wins)
  tokenLocked: Map<string, Set<string>>; // tokenId -> locked field names
  collectionFields: Map<string, MetadataField>; // "field\0repr" -> field
  collectionLocked: Set<string>; // locked collection field names
  // multi-token (Series) state
  maxInvocations: string | null; // Max Invocations extension; last-writer-wins (monotonic on-chain)
  defaultMaxSupply: string | null; // Edition Supply extension; the collection-wide per-id default ('0' = open)
  minter: Address | null; // External Minter (single address); last-writer-wins, zero ⇒ none
  paused: boolean; // Paused extension; last-writer-wins, default false (absent event ⇒ unpaused)
  primaryPayee: Address | null; // Primary Payee extension (zero ⇒ none)
  // code-project state
  tokenParams: Map<string, Map<string, ParamValue>>; // tokenId -> key -> value (last-writer-wins; cleared = deleted)
  contractParams: Map<string, ParamValue>;
  paramSchemas: Map<string, ParamSchema>; // key -> schema (emitted in full; last-writer-wins)
  paramHooks: ParamHooks | null;
  paramHooksFrozen: boolean; // one-way; `ParamHooksFrozen` ⇒ the three addresses can never change
  delegateRegistry: Address | null | undefined; // undefined = no event ⇒ canonical default (when the extension is present)
  seedSource: Address | null;
  scriptLocked: boolean;
  dependencies: DependencyInfo[]; // ordered; DependencyUpdated writes by index, Removed pops
  dependencyRegistry: Address | null;
  dependenciesLocked: boolean;
}


/** Turn decoded viem logs into the canonical, serializable {@link SpineEvent} list. */
function decodedToSpineEvents(decoded: ReturnType<typeof parseEventLogs>): SpineEvent[] {
  return decoded.map((log) => {
    const name = (log as {eventName?: string}).eventName ?? 'Unknown';
    const args = ((log as {args?: Record<string, unknown>}).args ?? {}) as Record<string, unknown>;
    const doc = SPINE_EVENT_DOC[name] ?? {register: 2 as const, what: ''};
    return {
      name,
      register: doc.register,
      what: doc.what,
      blockNumber: (log.blockNumber ?? 0n).toString(),
      logIndex: log.logIndex ?? 0,
      txHash: (log.transactionHash ?? '0x') as Hex,
      args: stringifyArgs(args),
    };
  });
}

function tokenIn(tokens: Map<string, TokenState>, id: string): TokenState {
  let t = tokens.get(id);
  if (!t) {
    t = {tokenId: id, lifecycle: 'unminted', owner: null, tokenURI: null, fields: [], lockedFields: []};
    tokens.set(id, t);
  }
  return t;
}

/**
 * Fold one ERC-1155 transfer leg (a `TransferSingle`, or one element of a `TransferBatch`) into
 * an id's per-id supply counter + holder balances. Mint = `from` the zero address (supply +=
 * amount); burn = `to` the zero address (supply -= amount); a transfer between two live holders
 * touches no supply, only balances — mirrors `AbxErc1155Base._afterTokenTransfer`'s own
 * if/else-if exactly.
 *
 * {@link TokenState.lifecycle} is recomputed from the counter on every leg, never latched: an
 * edition id can return to zero supply (a full burn) and mint again. `supply > 0` ⇒ `'live'`;
 * back to zero having once been issued ⇒ `'burned'`; never issued ⇒ `'unminted'`. Same three words
 * the 721 lane uses, which is the point — one vocabulary, whichever standard produced it.
 */
function applyEditionTransfer(
  tokens: Map<string, TokenState>,
  id: string,
  from: Address,
  to: Address,
  amount: bigint,
): void {
  const t = tokenIn(tokens, id);
  if (isZeroAddr(from)) t.supply = (BigInt(t.supply ?? '0') + amount).toString();
  else if (isZeroAddr(to)) t.supply = (BigInt(t.supply ?? '0') - amount).toString();
  // Zero live copies — and on this standard that is NOT `'burned'`, which is reserved for the
  // terminal 721 case. An edition id at zero can mint again, whether it was never minted or fully
  // burned, so the two have no different consequence for anything downstream and share one word.
  // The alternative shipped for about an hour: `'burned'` on both standards, which put every
  // consumer one forgotten `contractType` branch away from answering `410 Gone` for an id the
  // contract still resolves and can reissue. See {@link TokenState.lifecycle}.
  //
  // Note this deliberately does NOT use the fold's extra knowledge (it could distinguish
  // never-minted from fully-burned; the head-read lane cannot). Spending it here would make the two
  // lanes disagree on the same id under one field name — the sibling-drift class — to express a
  // distinction with no consumer. The history stays in `supply`, `holders`, and the log.
  t.lifecycle = BigInt(t.supply ?? '0') > 0n ? 'live' : 'no-live-copies';
  adjustHolderBalance(t, from, -amount);
  adjustHolderBalance(t, to, amount);
}

/**
 * Adjust one token's per-holder balance by `delta`. The zero address is never a real holder
 * (a mint's `from` / a burn's `to`) and is skipped. A balance that reaches zero is deleted
 * rather than kept at `"0"` — {@link TokenState.holders} lists only CURRENT holders.
 */
function adjustHolderBalance(t: TokenState, addr: Address, delta: bigint): void {
  if (isZeroAddr(addr) || delta === 0n) return;
  if (!t.holders) t.holders = {};
  const bal = BigInt(t.holders[addr] ?? '0') + delta;
  if (bal <= 0n) delete t.holders[addr];
  else t.holders[addr] = bal.toString();
}

const isZeroAddr = (v: string | undefined): boolean => {
  try {
    return BigInt(v ?? '0') === 0n;
  } catch {
    return false;
  }
};

/**
 * Fold an *ordered* spine into structure. Operates on {@link SpineEvent} (string
 * args) so full and incremental use one implementation, and a stored event log
 * re-folds identically. Idempotent + last-writer-wins, so re-folding the same
 * events (e.g. the reorg overlap) yields the same result.
 */
export function foldSpine(events: SpineEvent[]): Fold {
  const fold: Fold = {
    abxVersion: null,
    deployBlock: null,
    deployTx: null,
    owner: null,
    royalty: null,
    maxRoyaltyBps: null,
    burnable: null,
    extById: new Map(),
    tokens: new Map(),
    tokenFields: new Map(),
    tokenLocked: new Map(),
    collectionFields: new Map(),
    collectionLocked: new Set(),
    maxInvocations: null,
    defaultMaxSupply: null,
    minter: null,
    paused: false,
    primaryPayee: null,
    tokenParams: new Map(),
    contractParams: new Map(),
    paramSchemas: new Map(),
    paramHooks: null,
    paramHooksFrozen: false,
    delegateRegistry: undefined,
    seedSource: null,
    scriptLocked: false,
    dependencies: [],
    dependencyRegistry: null,
    dependenciesLocked: false,
  };

  for (const ev of events) {
    const a = ev.args;
    switch (ev.name) {
      case 'AbxDeployed': {
        if (fold.deployBlock === null) {
          fold.abxVersion = Number(a.abxVersion ?? 0);
          fold.deployBlock = ev.blockNumber;
          fold.deployTx = ev.txHash;
        }
        break;
      }
      case 'AbxExtensionVersionSet': {
        const id = (a.extensionId ?? '0x') as Hex;
        fold.extById.set(id.toLowerCase(), {id, name: extensionName(id), version: Number(a.version ?? 0)});
        break;
      }
      case 'RoyaltyChangedForAll': {
        const receiver = a.account as Address;
        const bps = Number(a.basisPoints ?? 0);
        fold.royalty = isZeroAddr(receiver) && bps === 0 ? null : {receiver, bps};
        break;
      }
      // The two collection-policy events. Both are Register 2 facts a buyer prices in, and both
      // fold — being in `SPINE_EVENT_DOC` only supplies the `register`/`what` strings on the event
      // record; it has never made anything land in state. The guard in `spine-fold-coverage.test.ts`
      // fails if a `folds: 'state'` event has no
      // case here.)
      case 'MaxRoyaltyBpsUpdated':
        // Last-writer-wins: the deploy-time ceiling, then any `reduceMaxRoyaltyBps`.
        fold.maxRoyaltyBps = Number(a.maxBps ?? 0);
        break;
      case 'BurnConfigured':
        // Emitted once at initialize and fixed thereafter; still last-writer-wins for the same
        // reason every other fold is — a re-fold of an overlapping range must be idempotent.
        fold.burnable = String(a.burnable) === 'true';
        break;
      case 'OwnershipTransferred':
        fold.owner = a.newOwner as Address;
        break;
      case 'Transfer': {
        const t = tokenIn(fold.tokens, String(a.tokenId ?? a.id ?? '0'));
        // `to == 0x0` is a BURN and nothing else: Solady's `transferFrom` reverts on a zero
        // recipient, so the only path that emits it is `_burn` (the token's own `burn(id)`, gated
        // on the collection having opted in). So the leg is unambiguous, and it is the whole
        // reason this case cannot just write `a.to` into `owner` — that put the zero address in a
        // field every consumer reads as a holder, and left `minted` latched `true` forever.
        // `'burned'` is TERMINAL on this standard, and that is a fact about ABX's mint paths rather
        // than about ERC-721: ids come from a monotonic `nextTokenId`, so no entrypoint can reissue
        // a destroyed id. The branch below would still return such an id to `'live'` if a log ever
        // showed a re-mint — the fold owes the log's meaning, not our mint policy's — but no ABX
        // deployment can produce that log, which is what makes the word safe to act on irreversibly.
        if (isZeroAddr(a.to)) {
          t.lifecycle = 'burned';
          t.owner = null;
        } else {
          t.lifecycle = 'live';
          t.owner = a.to as Address;
        }
        break;
      }
      case 'TransferSingle': {
        applyEditionTransfer(fold.tokens, String(a.id ?? '0'), a.from as Address, a.to as Address, BigInt(a.amount ?? '0'));
        break;
      }
      case 'TransferBatch': {
        const ids = parseStringArray(a.ids);
        const amounts = parseStringArray(a.amounts);
        const from = a.from as Address;
        const to = a.to as Address;
        for (let i = 0; i < ids.length; i++) {
          applyEditionTransfer(fold.tokens, ids[i], from, to, BigInt(amounts[i] ?? '0'));
        }
        break;
      }
      case 'MaxSupplyUpdated': {
        const t = tokenIn(fold.tokens, String(a.id ?? '0'));
        t.maxSupply = String(a.cap ?? '0');
        // An override latches: it is what makes a `'0'` cap "closed forever" rather than "open",
        // and what puts the monotonic never-increase rule in force for this id.
        t.maxSupplyOverridden = true;
        break;
      }
      // The collection-wide default, announced once at `initialize`. Last-writer-wins for the same
      // reason as every other Register 2 setter, even though only one is emitted today. Without
      // this case the event reached the ABI and stopped there: an id inheriting a non-zero default
      // has no `MaxSupplyUpdated` of its own, so the fold reported it uncapped.
      case 'DefaultMaxSupplySet':
        fold.defaultMaxSupply = String(a.cap ?? '0');
        break;
      case 'TokenFieldSet': {
        const id = String(a.tokenId ?? '0');
        const field = decodeTag((a.field ?? '0x') as Hex);
        const representation = decodeTag((a.representation ?? '0x') as Hex);
        let m = fold.tokenFields.get(id);
        if (!m) fold.tokenFields.set(id, (m = new Map()));
        m.set(field, {field, representation, value: (a.value ?? '0x') as Hex}); // one active rep per field — last wins
        break;
      }
      case 'TokenFieldLocked': {
        const id = String(a.tokenId ?? '0');
        let s = fold.tokenLocked.get(id);
        if (!s) fold.tokenLocked.set(id, (s = new Set()));
        s.add(decodeTag((a.field ?? '0x') as Hex));
        break;
      }
      case 'ContractFieldSet': {
        const field = decodeTag((a.field ?? '0x') as Hex);
        const representation = decodeTag((a.representation ?? '0x') as Hex);
        fold.collectionFields.set(field, {field, representation, value: (a.value ?? '0x') as Hex}); // last wins
        break;
      }
      case 'ContractFieldLocked':
        fold.collectionLocked.add(decodeTag((a.field ?? '0x') as Hex));
        break;
      case 'MaxInvocationsUpdated':
        fold.maxInvocations = String(a.maxInvocations ?? '0'); // last-writer-wins (monotonic on-chain)
        break;
      case 'MinterSet':
        fold.minter = isZeroAddr(a.minter) ? null : (a.minter as Address); // last-writer-wins
        break;
      case 'PausedStatusChanged':
        fold.paused = String(a.paused) === 'true'; // last-writer-wins (absent ⇒ false)
        break;
      case 'PrimaryPayeeChanged':
        fold.primaryPayee = isZeroAddr(a.account) ? null : (a.account as Address);
        break;
      case 'TokenParamConfigured': {
        const id = String(a.tokenId ?? '0');
        const key = decodeTag((a.key ?? '0x') as Hex);
        let m = fold.tokenParams.get(id);
        if (!m) fold.tokenParams.set(id, (m = new Map()));
        m.set(key, {
          key,
          value: (a.value ?? '0x') as Hex,
          valueIsHash: String(a.valueIsHash) === 'true',
          updatedBy: a.updatedBy as Address,
        });
        break;
      }
      case 'TokenParamCleared': {
        fold.tokenParams.get(String(a.tokenId ?? '0'))?.delete(decodeTag((a.key ?? '0x') as Hex));
        break;
      }
      case 'ContractParamConfigured': {
        const key = decodeTag((a.key ?? '0x') as Hex);
        fold.contractParams.set(key, {
          key,
          value: (a.value ?? '0x') as Hex,
          valueIsHash: String(a.valueIsHash) === 'true',
          updatedBy: a.updatedBy as Address,
        });
        break;
      }
      case 'ContractParamCleared':
        fold.contractParams.delete(decodeTag((a.key ?? '0x') as Hex));
        break;
      case 'ParamSchemaConfigured': {
        const key = decodeTag((a.key ?? '0x') as Hex);
        fold.paramSchemas.set(key, {
          key,
          paramType: PARAM_TYPES[Number(a.paramType ?? 0)] ?? String(a.paramType),
          auth: AUTH_OPTIONS[Number(a.auth ?? 0)] ?? String(a.auth),
          authAddress: isZeroAddr(a.authAddress) ? null : (a.authAddress as Address),
          lockAfter: String(a.lockAfter ?? '0'),
          min: (a.min ?? '0x') as Hex,
          max: (a.max ?? '0x') as Hex,
          selectOptions: parseStringArray(a.selectOptions),
        });
        break;
      }
      case 'HooksConfigured': {
        const z = (v: string | undefined) => (isZeroAddr(v) ? null : (v as Address));
        fold.paramHooks = {
          configureHook: z(a.configureHook),
          augmentHook: z(a.augmentHook),
          transferHook: z(a.transferHook),
          locked: false, // resolved from `paramHooksFrozen` at assembly — order-independent
        };
        break;
      }
      case 'DelegateRegistrySet':
        fold.delegateRegistry = isZeroAddr(a.registry) ? null : (a.registry as Address);
        break;
      case 'SeedSourceSet':
        fold.seedSource = isZeroAddr(a.seedSource) ? null : (a.seedSource as Address);
        break;
      case 'ScriptLocked':
        fold.scriptLocked = true;
        break;
      // A one-way lock like ScriptLocked/DependenciesLocked, and the one a BUYER cares about: after
      // this the transfer hook (which can veto a transfer or a mint) can never be re-pointed.
      case 'ParamHooksFrozen':
        fold.paramHooksFrozen = true;
        break;
      case 'DependencyUpdated': {
        const idx = Number(a.index ?? 0);
        const raw = (a.ref ?? '0x') as Hex;
        const onchain = String(a.resolution) === '1';
        const dep: DependencyInfo = {
          resolution: onchain ? 'onchain' : 'registry',
          ref: raw,
          refDecoded: onchain ? '0x' + raw.slice(2, 42) : decodeTag(raw),
        };
        if (idx === fold.dependencies.length) fold.dependencies.push(dep);
        else if (idx < fold.dependencies.length) fold.dependencies[idx] = dep;
        break;
      }
      case 'DependencyRemoved':
        fold.dependencies.pop(); // the list stays dense — only the last is removable
        break;
      case 'DependencyRegistrySet':
        fold.dependencyRegistry = isZeroAddr(a.registry) ? null : (a.registry as Address);
        break;
      case 'DependenciesLocked':
        fold.dependenciesLocked = true;
        break;
      default:
        break;
    }
  }
  return fold;
}

/** Build the full {@link ProjectState} from a fold + provenance, then overlay head reads. */
async function assembleState(
  client: PublicClient,
  address: Address,
  events: SpineEvent[],
  fold: Fold,
  fromBlock: bigint,
  toBlock: bigint,
  factory?: Address,
  readUriDocuments = false,
  reuseScript?: ScriptState,
): Promise<ProjectState> {
  // ensure a TokenState exists for every token referenced by on-chain fields/locks/params
  // (a deployed-but-unminted token can carry fields before any Transfer)
  for (const id of fold.tokenFields.keys()) tokenIn(fold.tokens, id);
  for (const id of fold.tokenLocked.keys()) tokenIn(fold.tokens, id);
  for (const id of fold.tokenParams.keys()) tokenIn(fold.tokens, id);
  // A 1/1 has token id 0 from deploy, even before mint — seed it so the resolver can
  // serve metadata (warming marketplaces) the instant the contract exists.
  if (fold.tokens.size === 0 && fold.deployBlock !== null) tokenIn(fold.tokens, '0');
  // attach on-chain fields + per-field locks + params onto tokens
  for (const t of fold.tokens.values()) {
    t.fields = [...(fold.tokenFields.get(t.tokenId)?.values() ?? [])];
    t.lockedFields = [...(fold.tokenLocked.get(t.tokenId) ?? [])];
    const params = fold.tokenParams.get(t.tokenId);
    if (params?.size) t.params = [...params.values()];
  }

  // A contract is a Series if it enabled the supply-cap extension; a Series that also
  // speaks Params is a code project (SeriesCode's composition). `maxInvocations` is shared,
  // unchanged, with the ERC-1155 editions family (EditionImage/EditionCode compose it too), so
  // `isSeries` alone doesn't distinguish 721 from 1155 — `hasEditionSupply` does that.
  const isSeries = fold.extById.has(EXTENSION_ID.maxInvocations.toLowerCase());
  const has = (id: Hex) => fold.extById.has(id.toLowerCase());
  const hasParams = has(EXTENSION_ID.params);
  const hasConfigurableParams = has(EXTENSION_ID.configurableParams);
  const hasScript = has(EXTENSION_ID.onChainScript);
  const hasDependencies = has(EXTENSION_ID.dependencies);
  const hasSeedSource = has(EXTENSION_ID.seedSource);
  // Edition Supply is the ONLY extension id new to the 1155 family — its presence is the
  // discriminator between the 721 ladder (1of1/series/code) and the 1155 one
  // (1of1-edition/edition/edition-code); every other extension id is shared, unchanged.
  const hasEditionSupply = has(EXTENSION_ID.editionSupply);

  // The collection-wide per-id default, behind the same gate as every other extension-scoped field
  // (one gate, read twice: here and on `state.defaultMaxSupply` below).
  const defaultCap = hasEditionSupply ? fold.defaultMaxSupply : null;
  // An id with no `MaxSupplyUpdated` of its own inherits that default, exactly as `maxSupply(id)`
  // does on chain. The fold used to stop at the per-id event, so every `--copies N` edition — which
  // sets the cap at `initialize` and never calls `setMaxSupply` — reported *uncapped* here while the
  // head read said N. See {@link TokenState.maxSupply}.
  if (defaultCap !== null) {
    for (const t of fold.tokens.values()) if (t.maxSupply === undefined) t.maxSupply = defaultCap;
  }

  const state: ProjectState = {
    address,
    chainId: client.chain?.id ?? 0,
    abxVersion: fold.abxVersion,
    deployBlock: fold.deployBlock,
    deployTx: fold.deployTx,
    factory: factory ?? null,
    implementation: null,
    isCanonical: null,
    name: null,
    symbol: null,
    owner: fold.owner,
    contractURI: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: fold.royalty,
    // Both tri-state and both folded, never defaulted: `null` says the spine did not state it (an
    // implementation from before the opt-in), which is not the same fact as `false` / a 10% ceiling.
    maxRoyaltyBps: fold.maxRoyaltyBps,
    burnable: fold.burnable,
    collectionFields: [...fold.collectionFields.values()],
    lockedCollectionFields: [...fold.collectionLocked],
    contractType:
      fold.deployBlock === null
        ? undefined
        : hasEditionSupply
          ? hasParams ? 'edition-code' : isSeries ? 'edition' : '1of1-edition'
          : isSeries ? (hasParams ? 'code' : 'series') : '1of1',
    maxInvocations: fold.maxInvocations,
    defaultMaxSupply: defaultCap,
    minter: fold.minter,
    paused: fold.paused,
    primaryPayee: fold.primaryPayee,
    contractParams: hasParams ? [...fold.contractParams.values()] : undefined,
    paramSchemas: hasConfigurableParams ? [...fold.paramSchemas.values()] : undefined,
    paramHooks: hasConfigurableParams
      ? {
          ...(fold.paramHooks ?? {configureHook: null, augmentHook: null, transferHook: null}),
          // Read off the separate fold flag rather than the HooksConfigured branch, so a freeze
          // survives regardless of event order (a project may freeze hooks it never set).
          locked: fold.paramHooksFrozen,
        }
      : null,
    // absence of the event ⇒ the canonical delegate.xyz default (the emit-non-default rule)
    delegateRegistry: hasConfigurableParams
      ? fold.delegateRegistry !== undefined
        ? fold.delegateRegistry
        : DELEGATE_REGISTRY_DEFAULT
      : null,
    seedSource: hasSeedSource ? fold.seedSource : null,
    script: hasScript ? {chunkCount: null, locked: fold.scriptLocked} : null,
    dependencies: hasDependencies
      ? {
          list: [...fold.dependencies],
          registry: fold.dependencyRegistry,
          locked: fold.dependenciesLocked,
        }
      : null,
    extensions: [...fold.extById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    tokens: [...fold.tokens.values()].sort((a, b) => Number(a.tokenId) - Number(b.tokenId)),
    events: [...events].sort(byOrder),
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    eventCount: events.length,
    reconstructedAt: new Date().toISOString(),
    rpcUrl: client.transport?.url as string | undefined,
  };

  await applyHeadReads(client, state, factory, readUriDocuments, reuseScript);
  return state;
}

/** Default safety cap on chunk count; raise via the `maxChunks` opt (or ABX_GETLOGS_MAX_CHUNKS —
 *  the CLI's --yes sets that). */
const DEFAULT_MAX_CHUNKS = 3000;
function resolveMaxChunks(override?: number): number {
  if (override !== undefined && override > 0) return override;
  const v = Number(readEnv('ABX_GETLOGS_MAX_CHUNKS'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_CHUNKS;
}

/** Does this error look like an RPC rejecting the block range (vs a real failure)? */
export function isGetLogsRangeError(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /block range|range should work|too large|out of bounds|response size|query returned more|results|limited|\d+\s*block|exceeds|max(imum)?\b/.test(m);
}

/** Thrown when a reconstruction would need more getLogs requests than the cap allows. */
export class GetLogsScanTooLargeError extends AbxSdkError {
  constructor(
    readonly spanBlocks: bigint,
    readonly window: bigint,
    readonly estimatedRequests: number,
    readonly cap: number,
  ) {
    super(
      `Reconstructing ${spanBlocks} blocks needs ~${estimatedRequests} eth_getLogs requests at this RPC's range limit ` +
        `(~${window} blocks/call) — over the ${cap}-request safety cap. A higher-range RPC is the real fix ` +
        `(set ABX_RPC_URLS, then re-check with \`abx doctor\`). To chunk through it anyway, raise ABX_GETLOGS_MAX_CHUNKS (the CLI's --yes does this).`,
    );
    this.name = 'GetLogsScanTooLargeError';
  }
}

/**
 * Discover the block a contract's code first appears — its deployment block — by binary
 * searching `eth_getCode` between genesis and head. ~log2(head) calls (~24 on Sepolia),
 * NONE of them `eth_getLogs`, so it's independent of an RPC's log-range cap. This is the
 * scan floor for a fresh reconstruction: without it an `add` defaults to genesis and
 * sweeps the whole chain (millions of blocks) — the difference between an instant index
 * and a rate-limited grind (and the root cause of a hosted resolver "not indexing").
 *
 * **Fail-safe by design.** It reads archive-depth `getCode`, and a pruned/non-archive node
 * can make old blocks read empty (breaking the search's monotonicity) and return a too-HIGH
 * floor — which is worse than genesis, because you'd silently miss the deploy event and
 * index an incomplete project. So any `getCode` error, or no code at head, returns `null`,
 * and the caller must require an explicit `--from-block` rather than guess. Assumes the
 * contract has no code at block 0 (true for every ABX clone — deployed long after genesis).
 */
export async function discoverDeployBlock(
  client: PublicClient,
  address: Address,
  toBlock?: bigint,
): Promise<bigint | null> {
  try {
    const head = toBlock ?? (await client.getBlockNumber());
    const codeAtHead = await client.getCode({address, blockNumber: head});
    if (!codeAtHead || codeAtHead === '0x') return null; // no contract at head — nothing to find
    // Invariant across the search: code absent at `lo`, present at `hi`; narrow to adjacent.
    let lo = 0n;
    let hi = head;
    while (lo + 1n < hi) {
      const mid = (lo + hi) / 2n;
      const code = await client.getCode({address, blockNumber: mid});
      if (code && code !== '0x') hi = mid;
      else lo = mid;
    }
    return hi;
  } catch {
    return null; // archive/getCode unsupported — caller falls back to an explicit --from-block
  }
}

/**
 * Ordinary RPC tiers cap how many addresses one `eth_getLogs` filter may carry.
 * This is an RPC-tier opinion, not a protocol constant — callers with a dedicated
 * node can raise it; `0` disables splitting (one filter for the whole list).
 */
export const DEFAULT_GETLOGS_ADDRESS_BATCH = 1000;

export interface GetLogsAdaptiveOptions {
  maxChunks?: number;
  range?: bigint;
  /** Split `address[]` filters into this many addresses per request. Default
   *  {@link DEFAULT_GETLOGS_ADDRESS_BATCH}. `0` = no split. */
  addressBatch?: number;
  /**
   * Fired after each `eth_getLogs` chunk with how far the scan has gotten — the signal a caller has
   * that a large scan is alive, not hung. Pure notification,
   * no return value; a CLI caller throttles this itself before printing (every chunk would be noise).
   */
  onChunk?: (progress: {
    /** Completed block-filter work across every address batch. */
    scanned: bigint;
    /** Total block-filter work (`blockSpan * addressBatches`). */
    span: bigint;
    /** Blocks completed in the current address batch. */
    scannedBlocks: bigint;
    blockSpan: bigint;
    /** Zero-based batch index and total batch count. */
    addressBatch: number;
    addressBatches: number;
  }) => void;
}

/**
 * Pull logs over a block range, adapting to RPC range caps — and, when `address` is
 * a list, splitting that list so a registered-set watch scan stays one code path for
 * self-host and hosted. Providers cap `eth_getLogs` very differently and the numbers
 * change, so we don't hard-code a window: try the whole range, and when the RPC
 * rejects it, halve the window and sweep. `ABX_GETLOGS_RANGE` overrides the starting
 * window. Address-list chunking is a separate cap (`addressBatch`); 5000-block
 * per-tick windows belong to the caller (the watcher), not here.
 *
 * Once the working window is known we estimate the whole job *before* grinding it: if
 * it would exceed the cap, we stop early (only the probe calls spent) and throw
 * {@link GetLogsScanTooLargeError} so the caller can offer the real fix (a higher-range
 * RPC) or an explicit opt-in to chunk through it.
 */
export async function getLogsAdaptive(
  client: PublicClient,
  address: Address | readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
  opts: GetLogsAdaptiveOptions = {},
): Promise<Log[]> {
  const addrs = (Array.isArray(address) ? address : [address]) as Address[];
  if (addrs.length === 0) return [];
  const batchSize =
    opts.addressBatch === 0 ? addrs.length : Math.max(1, opts.addressBatch ?? DEFAULT_GETLOGS_ADDRESS_BATCH);
  const batches: Address[][] = [];
  for (let i = 0; i < addrs.length; i += batchSize) batches.push(addrs.slice(i, i + batchSize));

  const span = toBlock - fromBlock + 1n;
  const envRange = readEnv('ABX_GETLOGS_RANGE');
  const startWindow = opts.range && opts.range > 0n ? opts.range : envRange && BigInt(envRange) > 0n ? BigInt(envRange) : span;

  const out: Log[] = [];
  let estimated = false;
  for (const [batchIndex, batch] of batches.entries()) {
    const filter: Address | Address[] = batch.length === 1 ? batch[0]! : batch;
    let window = startWindow;
    let start = fromBlock;
    while (start <= toBlock) {
      const end = start + window - 1n < toBlock ? start + window - 1n : toBlock;
      let logs: Log[];
      try {
        logs = (await client.getLogs({address: filter, fromBlock: start, toBlock: end})) as Log[];
      } catch (err) {
        if (isGetLogsRangeError(err) && window > 1n) {
          window = window > 2n ? window / 2n : 1n; // RPC rejected this window — shrink and retry
          continue;
        }
        throw err; // genuine failure, or already at one block per call
      }
      out.push(...logs);
      start = end + 1n;
      const scannedBlocks = start - fromBlock;
      opts.onChunk?.({
        scanned: BigInt(batchIndex) * span + scannedBlocks,
        span: span * BigInt(batches.length),
        scannedBlocks,
        blockSpan: span,
        addressBatch: batchIndex,
        addressBatches: batches.length,
      });

      // Window now proven. Estimate the whole job once (range chunks × address batches)
      // and bail *before* grinding if absurd.
      if (!estimated) {
        estimated = true;
        const remaining = toBlock - start + 1n;
        const perBatch = (remaining > 0n ? Number(remaining / window) + 1 : 0) + 1; // +1 for the chunk just done
        const need = perBatch * batches.length;
        const cap = resolveMaxChunks(opts.maxChunks);
        if (need > cap) throw new GetLogsScanTooLargeError(span, window, need, cap);
      }
    }
  }
  return out;
}

/**
 * How many unbounded reads (`tokenURI`, `contractURI`, a script chunk) ride one aggregate. Small on
 * purpose: on the on-chain lane each of these can return tens of KB *assembled at read*, and the
 * cap that matters is the node's per-`eth_call` budget for the aggregate, not the leg count. A
 * whole-chunk failure still recovers via the per-leg retry below, so this only sets how often that
 * costs an extra round trip.
 */
const HEAVY_READ_CHUNK = 2;

/**
 * Multicall in chunks, tolerating per-leg failure — and, when a whole chunk comes back failed,
 * retrying its legs individually before believing it.
 *
 * The retry is the point, and it exists to tell apart two failure modes that an aggregate throwing
 * cannot distinguish on its own:
 *
 * 1. **Over budget.** `allowFailure: true` reports per-leg failures, but a multicall is ONE
 *    `eth_call`: if the aggregate exceeds the node's gas or response cap, the *whole* batch fails
 *    and every leg in it reports failure — including legs that answer fine on their own. Batching a
 *    cheap read beside an expensive one therefore turns the expensive one's cost into the cheap
 *    one's failure. Re-asking each leg alone, with no aggregate overhead, recovers this: the calls
 *    were always fine, only their batching was too big.
 * 2. **No multicall3 on this chain.** If the aggregate fails because there's no multicall3
 *    deployment to call at all, *every* multicall — including a single-leg one — fails the identical
 *    way. Re-asking through `client.multicall` again, at any width, reproduces the same failure, so
 *    the retry must go through a call shape that has no multicall3 dependency: `client.readContract`.
 *    Skipping this means a chain lacking multicall3 reads back as "the contract answered nothing" —
 *    indistinguishable from a real revert — which is exactly the silent-blank-identity bug this
 *    retry was reported to have.
 *
 * So the fallback always resolves each leg with `readContract`, never with a smaller `multicall`.
 * `readContract` throws on revert where multicall's `allowFailure` returns a `status: 'failure'`
 * result instead, so a per-leg throw here is caught and mapped back to `null` — a genuine revert on
 * one leg must still read as "that leg has no answer," matching the aggregate's own contract,
 * whichever call shape actually answered it.
 */
export async function multicallChunked(
  client: PublicClient,
  contracts: Array<Record<string, unknown>>,
  chunkSize: number,
): Promise<Array<unknown>> {
  const out: unknown[] = new Array(contracts.length).fill(null);
  const runAggregate = async (legs: Array<Record<string, unknown>>): Promise<Array<unknown>> => {
    try {
      const res = (await client.multicall({contracts: legs as never, allowFailure: true})) as Array<
        {status: 'success'; result: unknown} | {status: 'failure'; error: unknown}
      >;
      return res.map((r) => (r.status === 'success' ? r.result : null));
    } catch {
      return legs.map(() => null); // the aggregate itself failed
    }
  };
  const readOne = async (leg: Record<string, unknown>): Promise<unknown> => {
    try {
      return await client.readContract(leg as never);
    } catch {
      return null; // a genuine revert — or the fallback itself failing — reads the same as unreadable
    }
  };
  for (let i = 0; i < contracts.length; i += chunkSize) {
    const legs = contracts.slice(i, i + chunkSize);
    let vals = await runAggregate(legs);
    // Every leg failed: the aggregate itself is the likely cause (too costly, or no multicall3 to
    // call at all), not the individual reads. Re-ask one at a time via `readContract` — never via
    // `multicall` again, even for a lone leg — so the batch degrades to what genuinely can't be
    // read, whether the original cause was cost or an absent multicall3. (A chunk can land at width
    // 1 too, e.g. the last chunk of an odd-length list — that leg is exactly as exposed to "no
    // multicall3 here" as any other, so it gets the same fallback, not a pass.)
    if (vals.every((v) => v === null)) {
      vals = await Promise.all(legs.map(readOne));
    }
    for (let k = 0; k < vals.length; k++) out[i + k] = vals[k];
  }
  return out;
}

/**
 * Head-read the values the spine only pings (name/symbol/contractURI/tokenURI) plus the trust and
 * URI-lane facts, and fold them into state.
 *
 * **Reads are split by cost class, and that split is load-bearing.** These used to be one multicall,
 * which was correct for an off-chain project (every return is a short string) and quietly wrong for
 * the flagship on-chain lane: there, `tokenURI(id)` *assembles the whole metadata document
 * on-chain*, tens of KB per token. Four such legs in one aggregate already exceed a public node's
 * `eth_call` budget, so the batch failed whole — and took `name`, `symbol`, `contractURI`,
 * `isAbxClone`, and, worst, `tokenURIRenderer` down with it. A resolver then believed a
 * fully-on-chain 32-token collection had no name, no canonical proof, and **was not in the
 * on-chain-URI lane at all.** Reproduced on Base Sepolia at `0xB844…5E56`: 4 legs → 0/8 succeeded,
 * while `name()` answered `"ABXdoku"` on its own.
 *
 * So: the cheap fixed reads — the ones that decide the project's identity and lane — go in one
 * batch of their own and can never be collateral damage.
 *
 * **The unbounded pair (`contractURI` + one `tokenURI` per token) is diagnostic and opt-in
 * (`readUriDocuments`, default `false`) — skipped ENTIRELY unless requested, not just best-effort.**
 * Two independent reasons, not one:
 *
 * 1. **Size.** A real 32-token fully-on-chain project measured at 13.4 MB of serialized
 *    `ProjectState`, of which 99.8% was `tokens[].tokenURI` — ~313 KB/token, re-fetched on *every*
 *    reconstruct, full or incremental, to fold a single new mint. `contractURI` is the same shape at
 *    collection scope (~1 KB there, but proportionally as dominant once `tokenURI` is out of the
 *    picture).
 * 2. **No settled value.** A renderer that composes these on demand can change them with **no log at
 *    all** — the refresh trigger here is `getLogs`, and there is no event for "the composed document
 *    changed." A value with no settled state and no change signal cannot be cached correctly at any
 *    refresh cadence: too eager and every tick looks different (a real incident); too lazy and the
 *    cached copy silently rots. The only correct move is not to cache it — read it live when someone
 *    actually wants to display it (`nothing served depends on it`, the one exception being a fresh
 *    `abx demo` read-back, which asks for it explicitly).
 */
async function applyHeadReads(
  client: PublicClient,
  state: ProjectState,
  factory?: Address,
  readUriDocuments = false,
  reuseScript?: ScriptState,
): Promise<void> {
  const token = {address: state.address, abi: oneOfOneImageAbi} as const;
  const tokenIds = state.tokens.map((t) => t.tokenId);
  // The edition family (ERC-1155) shares every cheap fixed-return name with the 721 superset ABI
  // used below (name/symbol/owner/tokenURIRenderer/tokenURILocked/contractURIRenderer/
  // contractURILocked/contractURI — same signatures on both standards), EXCEPT the per-token URI
  // getter: editions expose `uri(id)`, not `tokenURI(id)` (ERC-1155 has no `tokenURI`). Encode
  // that one leg against an edition ABI instead; the field name on `TokenState` stays `tokenURI`
  // either way (it's the resolved metadata pointer regardless of which standard produced it).
  const isEdition =
    state.contractType === '1of1-edition' || state.contractType === 'edition' || state.contractType === 'edition-code';
  const uriAbi = isEdition ? oneOfOneEditionAbi : oneOfOneImageAbi;
  const uriFn = isEdition ? 'uri' : 'tokenURI';

  // ── cheap, fixed-size returns: identity, trust, the URI lane, the script count ──
  // Mixed-ABI multicall — type it loosely; results are validated per-call below.
  const cheap: Array<Record<string, unknown>> = [
    {...token, functionName: 'name'},
    {...token, functionName: 'symbol'},
    {...token, functionName: 'owner'},
    {...token, functionName: 'tokenURIRenderer'},
    {...token, functionName: 'tokenURILocked'},
    {...token, functionName: 'contractURIRenderer'},
    {...token, functionName: 'contractURILocked'},
  ];
  const factoryIdx = cheap.length;
  if (factory) {
    cheap.push(
      {address: factory, abi: oneOfOneImageFactoryAbi, functionName: 'isAbxClone', args: [state.address]},
      {address: factory, abi: oneOfOneImageFactoryAbi, functionName: 'implementation'},
    );
  }
  // On-chain script: chunk content is too large to log, so the count is a head read.
  // Skip when the caller already holds a digest and `fresh` had no `ScriptUpdated` —
  // a Transfer must not re-download every chunk.
  const keepPriorScript = !!(state.script && reuseScript?.digest != null);
  const scriptIdx = cheap.length;
  if (state.script && !keepPriorScript) {
    cheap.push({address: state.address, abi: seriesCodeAbi, functionName: 'scriptChunkCount'});
  }

  // ── unbounded returns: each one may assemble a whole document on-chain ──
  // `contractURI` first so a huge per-token tokenURI can never cost us the collection's own URI.
  // `contractURI` itself is standard-neutral (ContractURI is reused as-is on the edition family),
  // so only the per-token leg switches ABI/function name (see `uriAbi`/`uriFn` above).
  //
  // Skipped ENTIRELY when `readUriDocuments` is false (the default) — not requested at reduced
  // width, not requested-then-discarded: no `eth_call` for either leg. `state.contractURI` and
  // every `tok.tokenURI` stay `null`, same as an off-chain project with nothing to read.
  const heavy: Array<Record<string, unknown>> = readUriDocuments
    ? [
        {...token, functionName: 'contractURI'},
        ...tokenIds.map((id) => ({address: state.address, abi: uriAbi, functionName: uriFn, args: [BigInt(id)]})),
      ]
    : [];

  const [cheapVals, heavyVals] = await Promise.all([
    multicallChunked(client, cheap, cheap.length), // one batch: all short returns
    readUriDocuments ? multicallChunked(client, heavy, HEAVY_READ_CHUNK) : Promise.resolve([]),
  ]);
  const val = (i: number) => cheapVals[i] ?? null;

  state.name = (val(0) as string) ?? null;
  state.symbol = (val(1) as string) ?? null;
  state.owner = (val(2) as Address) ?? state.owner;
  const nonZero = (a: unknown): Address | null =>
    a && a !== '0x0000000000000000000000000000000000000000' ? (a as Address) : null;
  state.tokenURIRenderer = nonZero(val(3));
  state.tokenURILocked = (val(4) as boolean) ?? null;
  state.contractURIRenderer = nonZero(val(5));
  state.contractURILocked = (val(6) as boolean) ?? null;
  if (factory) {
    state.isCanonical = (cheapVals[factoryIdx] as boolean) ?? null;
    state.implementation = (cheapVals[factoryIdx + 1] as Address) ?? null;
  }
  // `tok.tokenURI` is already `null` from `tokenIn` — only overwrite it when we actually asked.
  if (readUriDocuments) {
    state.contractURI = (heavyVals[0] as string) ?? null;
    tokenIds.forEach((id, k) => {
      const tok = state.tokens.find((t) => t.tokenId === id);
      if (tok) tok.tokenURI = (heavyVals[1 + k] as string) ?? null;
    });
  }
  if (state.script && keepPriorScript) {
    state.script.chunkCount = reuseScript!.chunkCount;
    state.script.digest = reuseScript!.digest;
  } else if (state.script) {
    const count = cheapVals[scriptIdx] ?? null;
    state.script.chunkCount = count === null ? null : Number(count);
    // digest = keccak over the concatenated chunks — the content half of effect inputsHash
    // values. Chunks are bounded (~24 KB each) but there can be many, and the same aggregate cap
    // applies, so they read through the chunked path too.
    const n = state.script.chunkCount ?? 0;
    if (n > 0) {
      const chunkReads = await multicallChunked(
        client,
        Array.from({length: n}, (_, i) => ({
          address: state.address,
          abi: seriesCodeAbi,
          functionName: 'scriptChunk',
          args: [BigInt(i)],
        })),
        HEAVY_READ_CHUNK,
      );
      const parts: Hex[] = [];
      for (const r of chunkReads) {
        if (r === null) return; // partial read — leave digest unset rather than wrong
        parts.push(r as Hex);
      }
      state.script.digest = keccak256(concatHex(parts));
    } else {
      state.script.digest = null;
    }
  }
}

function stringifyArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof k === 'string' && /^\d+$/.test(k)) continue; // skip positional dupes
    // arrays (e.g. a schema's selectOptions) keep fidelity as JSON — String() would
    // comma-join and lose options containing commas.
    if (Array.isArray(v)) out[k] = JSON.stringify(v.map(String));
    else out[k] = typeof v === 'bigint' ? v.toString() : String(v);
  }
  return out;
}

/** Parse an array arg back out of a {@link SpineEvent} (JSON per {@link stringifyArgs}). */
function parseStringArray(v: string | undefined): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function byOrder(a: SpineEvent, b: SpineEvent): number {
  const bn = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (bn !== 0n) return bn < 0n ? -1 : 1;
  return a.logIndex - b.logIndex;
}
