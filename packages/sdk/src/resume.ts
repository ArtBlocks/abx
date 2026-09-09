import type {Address, Hex} from 'viem';

/**
 * Finish a `deploy-code` whose **setup** never fully landed.
 *
 * A code project deploys in two or more transactions: create the clone, then one or more gas-bounded
 * setup transactions carrying the script chunks, the PostParam schemas, the dependency declarations,
 * the on-chain-URI legs, and any reserve mints — split (`commands/deploy.ts`'s
 * `planCodeSetupBatches`) whenever the whole setup can't fit the `eth_estimateGas` ceiling in one
 * multicall (a single small project still gets exactly one setup tx, as before). There is no
 * rollback for any of these. When one fails — or a wallet session / hot-key run is interrupted
 * between them — you own a live-but-unusable contract, and the CREATE2 salt reserved for that
 * address is spent — so the dry run's pinned-salt reproduce command can never be run again. One
 * reporter session produced three orphaned contracts from three attempts; another produced five;
 * a later funded sweep produced one by hitting the gas ceiling on a single oversized setup multicall.
 *
 * The useful half of that report is that those contracts were **recoverable, not lost**: resending the
 * setup with an adequate gas limit completed one, after which `abx verify` reported chain-complete.
 * The tester did it by hand with `cast`. We deliberately do not document that as a recipe — telling a
 * creator to hand-assemble a multicall is worse than telling them nothing — so this is the verb.
 *
 * **Why it diffs instead of just re-sending everything.** Each setup transaction is atomic, so in the
 * common case (a fresh deploy that never sent one) every leg is absent and the diff finds nothing to
 * skip. But several cases make the diff earn its keep: a creator who already repaired part of it by
 * hand, an interruption between two of several gas-bounded setup transactions (some landed, some
 * didn't — this is exactly why chunk writes and config setters must be idempotent, so any such split
 * point is safely resumable), and the gas cost of re-storing script chunks that already landed — EVM
 * code deposit is 200 gas per byte, so blindly re-sending a large program is the most expensive way to
 * be safe. Every leg is also idempotent by construction (index-addressed chunks and dependencies, an
 * upsert for schemas), so the diff is an optimisation on top of a safe operation rather than the thing
 * that makes it safe.
 *
 * The one leg that is NOT idempotent is `mint`, which is why it is computed as a **shortfall** against
 * current supply rather than re-sent: minting again would mint more tokens, and a token cannot be
 * un-minted.
 *
 * **721 vs EditionCode.** The four non-mint leg groups (chunks/schemas/deps/URI) are id-agnostic —
 * they read/write collection-scope or index-addressed state, so the SAME diff serves both standards
 * ({@link planCoreLegs}). Only the mint leg differs in shape: a 721 mints ONE token per call against a
 * single whole-contract `totalSupply()`; an EditionCode mints `amount` COPIES of a specific `id` per
 * call against that id's own `totalSupply(id)` (there is no whole-contract total on an edition — see
 * the SDK's `tokens.ts` `TokenListing.totalSupply` doc). {@link planResume} keeps the 721 shape,
 * byte-identical to before this split; {@link planEditionResume} is the per-id sibling.
 */

/** The reads every leg group but `mints` needs — shared by both standards. An interface, not a
 *  client, so the diff is testable without a chain. */
export interface ResumeReaderCore {
  scriptChunkCount(): Promise<number>;
  /** The stored bytes at `index`, or `null` when unset/unreadable. */
  scriptChunk(index: number): Promise<Hex | null>;
  schemaExists(key: string): Promise<boolean>;
  dependencyCount(): Promise<number>;
  dependencyRegistry(): Promise<Address | null>;
  tokenURIRenderer(): Promise<Address | null>;
  contractURIRenderer(): Promise<Address | null>;
  /** Whether a collection-scope field has any active representation. */
  contractFieldSet(field: string): Promise<boolean>;
}

/** The 721 reader: `ResumeReaderCore` plus the one whole-contract mint read. */
export interface ResumeReader extends ResumeReaderCore {
  totalSupply(): Promise<number>;
}

/** The EditionCode reader: `ResumeReaderCore` plus the per-id mint read. There is no whole-contract
 *  `totalSupply()` to fall back to — an edition's supply is always per id. */
export interface EditionResumeReader extends ResumeReaderCore {
  /** Copies of `id` minted so far — EditionCode's `totalSupply(id)`, not a whole-contract total. */
  totalSupplyForId(id: bigint): Promise<number>;
}

/** The intended setup for every leg but mints, grouped so each group can be skipped independently.
 *  Shared by both standards — see the class doc for why these four are id-agnostic. */
export interface SetupLegsCore {
  /** One entry per script chunk, in index order. `hex` is the intended content, for comparison. */
  chunks: Array<{index: number; hex: Hex; data: Hex}>;
  schemas: Array<{key: string; data: Hex}>;
  /** Dependency legs ride as one group — `count` is how many `setDependency` calls it carries. */
  deps: {count: number; registry: Address | null; calls: Hex[]};
  /** The on-chain-URI legs. `animationField` names the collection field they set, when they set one. */
  uri: {calls: Hex[]; animationField: string | null};
}

/** The intended setup for a 721 code contract. */
export interface SetupLegs extends SetupLegsCore {
  /** Reserve mints as an INTENDED TOTAL SUPPLY, not a count to add — see the shortfall note above. */
  mints: {intendedTotal: number; data: Hex};
}

/** The intended setup for an EditionCode contract. One entry per premint id — `intendedAmount` is
 *  that id's INTENDED TOTAL copies (the shortfall model, same principle as the 721 leg, one id
 *  finer). `dataForAmount` builds the `mint(to, id, amount)` call for whatever amount is actually
 *  missing — unlike the 721 leg (whose `mint(owner)` call carries no count and is simply repeated),
 *  an edition mint takes the amount as an argument, so the shortfall rides in ONE call, not N. */
export interface EditionSetupLegs extends SetupLegsCore {
  mints: Array<{id: bigint; intendedAmount: bigint; dataForAmount: (amount: bigint) => Hex}>;
}

export interface ResumePlan {
  /** The calls to send, in the original setup's order. Empty ⇒ nothing is missing. */
  calls: Hex[];
  /** Human lines for what is already on-chain — the reassurance half of the readout. */
  done: string[];
  /** Human lines for what this will send. */
  todo: string[];
  /**
   * What the selected calls actually consist of, so the caller can label the transaction and compute
   * its gas floor without re-deriving the selection (matching call bytes back to legs would be both
   * fragile and quadratic).
   */
  sending: {
    chunkIndices: number[];
    /** Byte length of each chunk being stored — the 200-gas-per-byte deposit floor. */
    chunkBytes: number[];
    schemaKeys: string[];
    deps: boolean;
    uri: boolean;
    /** Count of mint CALLS sent — on the 721 lane this is also the token count (one each); on the
     *  edition lane one call can carry many copies, so this is calls, not copies. */
    mints: number;
  };
}

/** Diff the four id-agnostic leg groups against what the contract already holds. Shared by
 *  {@link planResume} and {@link planEditionResume} — the mint leg is appended by each caller,
 *  since its shape differs (see the class doc). */
async function planCoreLegs(read: ResumeReaderCore, legs: SetupLegsCore): Promise<Omit<ResumePlan, 'sending'> & {sending: Omit<ResumePlan['sending'], 'mints'>}> {
  const calls: Hex[] = [];
  const done: string[] = [];
  const todo: string[] = [];
  const sending: Omit<ResumePlan['sending'], 'mints'> = {chunkIndices: [], chunkBytes: [], schemaKeys: [], deps: false, uri: false};

  // ── script chunks ───────────────────────────────────────────────────────────
  // Compared by CONTENT, not by count. A count check would call a chunk "present" when a hand-repair
  // wrote different bytes at that index, and re-sending is the cheap, correct answer to any doubt.
  if (legs.chunks.length) {
    const count = await read.scriptChunkCount();
    const missing: number[] = [];
    for (const chunk of legs.chunks) {
      const stored = chunk.index < count ? await read.scriptChunk(chunk.index) : null;
      if (stored !== null && stored.toLowerCase() === chunk.hex.toLowerCase()) continue;
      missing.push(chunk.index);
      calls.push(chunk.data);
      sending.chunkIndices.push(chunk.index);
      sending.chunkBytes.push((chunk.hex.length - 2) / 2);
    }
    if (missing.length === 0) done.push(`script: all ${legs.chunks.length} chunk(s) already stored on-chain`);
    else if (missing.length === legs.chunks.length) todo.push(`script: store ${missing.length} chunk(s)`);
    else todo.push(`script: store ${missing.length} of ${legs.chunks.length} chunk(s) (indices ${missing.join(', ')} — the rest already match)`);
  }

  // ── PostParam schemas ───────────────────────────────────────────────────────
  // `exists` is the whole test. A schema cannot have landed with different content than the leg that
  // wrote it (the multicall is atomic), so present ⇒ correct — and re-writing one is an upsert with
  // real value-stranding risk, which belongs to `set-schema` and its guard, never to a resume.
  if (legs.schemas.length) {
    const absent: string[] = [];
    for (const s of legs.schemas) {
      if (await read.schemaExists(s.key)) continue;
      absent.push(s.key);
      calls.push(s.data);
      sending.schemaKeys.push(s.key);
    }
    if (absent.length === 0) done.push(`params: all ${legs.schemas.length} schema(s) already declared`);
    else todo.push(`params: declare ${absent.join(', ')}`);
  }

  // ── dependencies ────────────────────────────────────────────────────────────
  // One group: the legs are index-addressed and the registry pointer rides with them, so "as many as
  // intended, pointing at the intended registry" is the honest test.
  if (legs.deps.calls.length) {
    const count = await read.dependencyCount();
    const registry = await read.dependencyRegistry();
    const registryOk =
      legs.deps.registry === null || (registry ?? '').toLowerCase() === legs.deps.registry.toLowerCase();
    if (count >= legs.deps.count && registryOk) {
      done.push(`dependencies: ${count} already declared${legs.deps.registry ? ' (registry matches)' : ''}`);
    } else {
      calls.push(...legs.deps.calls);
      sending.deps = true;
      todo.push(`dependencies: declare ${legs.deps.count}${registryOk ? '' : ' + re-point the registry'}`);
    }
  }

  // ── the on-chain URI legs ───────────────────────────────────────────────────
  // All-or-nothing as a group: a token whose renderers are set but whose animation field is not is
  // the half-wired state this verb exists to finish, and the legs are all idempotent setters.
  if (legs.uri.calls.length) {
    const [tokenR, contractR] = await Promise.all([read.tokenURIRenderer(), read.contractURIRenderer()]);
    const animationOk = legs.uri.animationField === null || (await read.contractFieldSet(legs.uri.animationField));
    if (tokenR && contractR && animationOk) {
      done.push('on-chain URI: renderers wired and the animation field is set');
    } else {
      calls.push(...legs.uri.calls);
      sending.uri = true;
      todo.push('on-chain URI: wire the metadata renderers + the animation field');
    }
  }

  return {calls, done, todo, sending};
}

/** Diff the intended 721 setup against what the contract already holds. */
export async function planResume(read: ResumeReader, legs: SetupLegs): Promise<ResumePlan> {
  const core = await planCoreLegs(read, legs);
  const calls = core.calls;
  const done = core.done;
  const todo = core.todo;
  const sending: ResumePlan['sending'] = {...core.sending, mints: 0};

  // ── reserve mints ───────────────────────────────────────────────────────────
  // A SHORTFALL, never a re-send: mint is the one non-idempotent leg, and a token cannot be un-minted.
  if (legs.mints.intendedTotal > 0) {
    const supply = await read.totalSupply();
    const shortfall = Math.max(0, legs.mints.intendedTotal - supply);
    if (shortfall === 0) {
      done.push(`mints: ${supply} token(s) already minted (intended ${legs.mints.intendedTotal})`);
    } else {
      for (let i = 0; i < shortfall; i++) calls.push(legs.mints.data);
      sending.mints = shortfall;
      todo.push(`mints: mint ${shortfall} more token(s) — ${supply} of ${legs.mints.intendedTotal} exist`);
    }
  }

  return {calls, done, todo, sending};
}

/**
 * Diff the intended EditionCode setup against what the contract already holds. The non-mint legs are
 * IDENTICAL diffing to {@link planResume} ({@link planCoreLegs}); the mint leg is a per-id shortfall
 * against `totalSupply(id)` instead of a single shortfall against a whole-contract total, and each
 * shortfall rides as ONE `mint(to, id, amount)` call (the amount argument does the work a 721 resume
 * needs N repeated calls for).
 */
export async function planEditionResume(read: EditionResumeReader, legs: EditionSetupLegs): Promise<ResumePlan> {
  const core = await planCoreLegs(read, legs);
  const calls = core.calls;
  const done = core.done;
  const todo = core.todo;
  const sending: ResumePlan['sending'] = {...core.sending, mints: 0};

  // ── reserve mints, per id ────────────────────────────────────────────────────
  // Same shortfall principle as the 721 leg, one id finer: minting again would mint MORE copies of
  // that id, and a copy cannot be un-minted. Every id is read and reported independently so a
  // creator sees exactly which ids are short, not just an aggregate count.
  if (legs.mints.length) {
    const perIdTodo: string[] = [];
    let short = 0;
    let complete = 0;
    for (const m of legs.mints) {
      const supply = BigInt(await read.totalSupplyForId(m.id));
      const shortfall = m.intendedAmount > supply ? m.intendedAmount - supply : 0n;
      if (shortfall === 0n) {
        complete++;
        continue;
      }
      calls.push(m.dataForAmount(shortfall));
      short++;
      perIdTodo.push(`id ${m.id}: mint ${shortfall} more (${supply} of ${m.intendedAmount} exist)`);
    }
    sending.mints = short;
    if (short === 0) done.push(`mints: all ${legs.mints.length} premint id(s) already fully minted`);
    else todo.push(`mints: ${perIdTodo.join('; ')}`);
  }

  return {calls, done, todo, sending};
}
