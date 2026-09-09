import {
  classifyIndexError,
  makePublicClient,
  reconstructFromLogs,
  reconstructIncremental,
  reconstructProject,
  type Address,
  type GetLogsAdaptiveOptions,
  type ProjectState,
  type PublicClient,
  type ReconstructBlockTag,
} from '@artblocks/abx-sdk';
import type {Log} from 'viem';
import {SqliteStore, type IndexStatusRow, type Store, type ProjectRegistration} from './store.js';

export interface ReindexOptions {
  full?: boolean;
  readUriDocuments?: boolean;
  rpcUrl?: string;
  /** Already-fetched logs for this project covering {@link toBlock}. Skips the
   *  per-project `eth_getLogs` — the watch loop that scanned the registered set
   *  holds the delta and should be the only getLogs. */
  logs?: readonly Log[];
  /** Inclusive scan head `logs` cover. Required with `logs`. */
  toBlock?: bigint;
  /**
   * Stop the scan boundary at this block tag instead of chain head (the default, unchanged
   * behavior). Resolved to a concrete block number BEFORE scanning (`resolveBlockTag` in the SDK),
   * so the stored watermark (`ProjectState.toBlock`) is always a literal number, never the tag —
   * see {@link ReconstructBlockTag}. Ignored when `logs` is supplied: that path's own `toBlock` is
   * the caller's already-resolved scan head, from a watch loop that has nothing to do with a
   * per-project tag choice.
   */
  blockTag?: ReconstructBlockTag;
  /** See {@link GetLogsAdaptiveOptions.onChunk} — the only progress signal during a large scan. */
  onChunk?: GetLogsAdaptiveOptions['onChunk'];
}

export interface IndexResult {
  state: ProjectState;
  elapsedMs: number;
  mode: 'full' | 'incremental';
}

/** Bounded per-pass reclaim for {@link SelfHostIndexer.runIncrementalVacuum} — ~100 pages is ~400KB
 *  at SQLite's default 4096-byte page size, cheap enough to run synchronously without a request or a
 *  watch tick noticing, while a long-running node with a large freelist still drains it over several
 *  passes instead of never. */
export const DEFAULT_INCREMENTAL_VACUUM_PAGES = 100;

/** Default cadence for automatic SQLite maintenance (see
 *  {@link SelfHostIndexer.startVacuumMaintenance}). Deliberately far coarser than the chain watcher's
 *  poll (`ABX_WATCH_INTERVAL_MS`, 12s by default): freed pages accumulate slowly (a reclaim, a
 *  dropped projection, a pruned bound artifact), so there is nothing to gain from touching the file
 *  every tick — and this is process-internal scheduling, not an operator-facing knob, so it isn't
 *  read from the environment the way the watcher's interval is. */
export const DEFAULT_VACUUM_INTERVAL_MS = 5 * 60_000;

/**
 * The reference indexer (Layer 3). It does one thing well: replay the event
 * spine from chain into the store. Because every state change rides a standard,
 * versioned event, re-indexing is a *compute* cost, not an engineering one — and
 * it needs no cooperation from whatever provider held the data before. This is
 * the implementation everyone re-indexes with when they onboard or leave a
 * service; running a different one changes nothing the protocol guarantees.
 */
export class SelfHostIndexer {
  readonly store: Store;
  private clients = new Map<string, PublicClient>();
  /** Catch-up runs in flight, per lowercased address — see {@link reindexShared}. */
  private inFlight = new Map<string, {promise: Promise<IndexResult>; full: boolean}>();

  constructor(store?: Store) {
    this.store = store ?? new SqliteStore();
  }

  /**
   * The pooled read client for a chain, or — with `rpcUrl` — one pinned to a SINGLE endpoint.
   *
   * The default (no `rpcUrl`) is a viem `fallback` across every configured endpoint, which fails
   * over on an *error*. It does not fail over on a successful empty answer, which is exactly what an
   * endpoint that has pruned its log history returns for an old block: `[]`, HTTP 200. Pinning one
   * endpoint is how a caller can re-run the same scan against each in turn and find one that holds
   * the history (see the CLI's empty-scan recovery). Pooled per (chain, endpoint) so the pinned
   * clients don't evict the shared one.
   */
  private client(chainKey: string, rpcUrl?: string): PublicClient {
    const key = rpcUrl ? `${chainKey}|${rpcUrl}` : chainKey;
    let c = this.clients.get(key);
    if (!c) this.clients.set(key, (c = makePublicClient({chainKey, rpcUrl})));
    return c;
  }

  /** The RPC client for a chain — exposed for reads that aren't a reindex (e.g. deploy-block
   *  discovery in the admin control plane). Reuses the same pooled client as `reindex`. */
  publicClient(chainKey: string): PublicClient {
    return this.client(chainKey);
  }

  /** Register a project to index (the minimum needed to replay it). A FIRST registration enters the
   *  lifecycle at `queued`; a re-add leaves the existing lifecycle row alone (it's operational
   *  history, not operator input — see IndexStatusRow). */
  register(reg: Omit<ProjectRegistration, 'registeredAt'>): ProjectRegistration {
    const full: ProjectRegistration = {...reg, registeredAt: new Date().toISOString()};
    this.store.register(full);
    if (!this.store.getIndexStatus(full.address)) this.store.setIndexStatus(full.address, {status: 'queued'});
    return full;
  }

  /**
   * Re-index a single project. By default this is **incremental**: it resumes from
   * the stored checkpoint and only fetches blocks added since — so re-indexing is
   * fast no matter how far head has moved — yet yields state identical to a full
   * replay. `{full: true}` forces a replay from the deploy block (the durability
   * proof, and what runs automatically when there's no prior state). Idempotent.
   */
  async reindex(address: Address, opts: ReindexOptions = {}): Promise<IndexResult> {
    const reg = this.store.getRegistration(address);
    // User-facing: this surfaces through `abx index`/`abx verify`. Name the real command a creator
    // runs (`abx add`), never the internal `register()` (there is no `abx register` — a dead end).
    if (!reg) throw new Error(`${address} isn't registered on this node yet — add it first:  abx add ${address}`);

    const started = Date.now();
    const factory = reg.factory ? (reg.factory as Address) : undefined;
    const prior = opts.full ? null : this.store.getProject(address);
    const incremental = !!(prior && prior.deployBlock && prior.events.length > 0);
    const attempts = (this.store.getIndexStatus(address)?.attempts ?? 0) + 1;
    // `backfilling` is for an initial sync or a forced replay — the long ones a client polls. A
    // routine incremental catch-up keeps its current status until it lands, so a live project's
    // status doesn't flicker on every watcher tick.
    if (!incremental) {
      this.store.setIndexStatus(address, {status: 'backfilling', attempts, lastAttemptAt: new Date().toISOString()});
    }

    let state: ProjectState;
    let mode: 'full' | 'incremental';
    try {
      if (incremental && opts.logs !== undefined) {
        if (opts.toBlock === undefined) {
          throw new Error('reindex({logs}) requires toBlock — the inclusive scan head those logs cover');
        }
        state = await reconstructFromLogs(this.client(reg.chainKey, opts.rpcUrl), prior!, opts.logs, {
          factory,
          readUriDocuments: opts.readUriDocuments,
          toBlock: opts.toBlock,
        });
        mode = 'incremental';
      } else if (incremental) {
        state = await reconstructIncremental(this.client(reg.chainKey, opts.rpcUrl), prior!, {
          factory,
          readUriDocuments: opts.readUriDocuments,
          onChunk: opts.onChunk,
          toBlock: opts.blockTag,
        });
        mode = 'incremental';
      } else {
        state = await reconstructProject(this.client(reg.chainKey, opts.rpcUrl), {
          address,
          fromBlock: BigInt(reg.fromBlock),
          factory,
          readUriDocuments: opts.readUriDocuments,
          onChunk: opts.onChunk,
          toBlock: opts.blockTag,
        });
        mode = 'full';
      }
      // Self-heal, never loop: an incremental fold that yields FEWER events than what's already
      // stored signals a damaged projection. `eventCount` can only grow with append-only chain
      // history, so a decrease is
      // never legitimate — discard the bad fold before it's written, and repair with exactly ONE
      // full replay from the deploy block. That result is written unconditionally, even in the
      // (pathological) case where it too looks smaller: a full reconstruct from chain is
      // definitionally correct, so there is nothing left to fall back to and no second attempt.
      if (mode === 'incremental' && prior && state.eventCount < prior.eventCount) {
        console.error(
          `[indexer] ${address}: an incremental fold produced ${state.eventCount} events, fewer than the ` +
            `${prior.eventCount} already stored — discarding it and falling back to one full reconstruct.`,
        );
        state = await reconstructProject(this.client(reg.chainKey, opts.rpcUrl), {
          address,
          fromBlock: BigInt(reg.fromBlock),
          factory,
          readUriDocuments: opts.readUriDocuments,
          onChunk: opts.onChunk,
          toBlock: opts.blockTag,
        });
        mode = 'full';
      }
    } catch (err) {
      // Record WHY, as a closed credential-free class — a rate-limited RPC and a broken service are
      // the same 500 to a caller otherwise, and only one of them means "wait".
      this.store.setIndexStatus(address, {
        status: 'failed',
        error: classifyIndexError(err),
        attempts,
        lastAttemptAt: new Date().toISOString(),
      });
      throw err;
    }
    // A full replay is the repair path — it purges + rebuilds the append-only event log so a
    // reorg-replaced event can't survive as a stale row (incremental writes never delete).
    this.store.putProject(state, {fullReplay: mode === 'full'});
    const now = new Date().toISOString();
    this.store.setIndexStatus(address, {status: 'live', error: null, attempts: 0, lastAttemptAt: now, lastIndexedAt: now});
    return {state, elapsedMs: Date.now() - started, mode};
  }

  /**
   * {@link reindex}, but concurrent calls for the same project COALESCE into one run.
   *
   * Catch-up is the expensive, RPC-bound operation, and several triggers can point at one project at
   * once: a re-POST arriving while a first backfill is still running, a watcher tick landing
   * mid-catch-up. Starting a second reconstruct there doubles the load on the RPC that was already
   * the bottleneck — so the second caller joins the first run instead. A caller that needs a *full*
   * replay while an incremental is in flight gets its replay queued after it, never dropped.
   */
  reindexShared(address: Address, opts: ReindexOptions = {}): Promise<IndexResult> {
    const key = address.toLowerCase();
    const running = this.inFlight.get(key);
    if (running) {
      if (!opts.full || running.full) return running.promise;
      // A forced replay can't be satisfied by an in-flight incremental — chain it on.
      const chained = running.promise.catch(() => undefined).then(() => this.reindex(address, opts));
      return this.track(key, chained, true);
    }
    return this.track(key, this.reindex(address, opts), !!opts.full);
  }

  /** Is a catch-up for this project running right now? (Lets a caller answer "still backfilling"
   *  without starting more work.) */
  isCatchingUp(address: Address): boolean {
    return this.inFlight.has(address.toLowerCase());
  }

  /**
   * A project's lifecycle row, with the default for a store that predates the lifecycle: an existing
   * projection is already being served, so it reads `live` (freshness is what `toBlock` vs head is
   * for) — reporting `queued` there would tell every client on an upgraded node that its serving
   * projects are pending. A registration with no projection is genuinely `queued`.
   */
  indexStatus(address: Address): IndexStatusRow {
    const row = this.store.getIndexStatus(address);
    if (row) return row;
    return {
      address: address.toLowerCase(),
      status: this.store.getProject(address) ? 'live' : 'queued',
      attempts: 0,
    };
  }

  private track(key: string, promise: Promise<IndexResult>, full: boolean): Promise<IndexResult> {
    // settle() must run whether the run resolves or rejects, and must NOT swallow the rejection —
    // every caller of the shared promise still sees the error.
    const settle = () => {
      if (this.inFlight.get(key)?.promise === tracked) this.inFlight.delete(key);
    };
    const tracked = promise.then(
      (r) => {
        settle();
        return r;
      },
      (e) => {
        settle();
        throw e;
      },
    );
    this.inFlight.set(key, {promise: tracked, full});
    return tracked;
  }

  /** Re-index every registered project. */
  async reindexAll(opts: ReindexOptions = {}): Promise<IndexResult[]> {
    const out: IndexResult[] = [];
    for (const reg of this.store.listRegistrations()) {
      out.push(await this.reindex(reg.address as Address, opts));
    }
    return out;
  }

  getProject(address: Address): ProjectState | null {
    return this.store.getProject(address);
  }

  /** Throw away a project's reconstructed projection, keeping its registration — the next
   *  {@link reindex} then rebuilds it from the deploy block. The projection is a disposable cache of
   *  chain state; this is how you prove it (`abx demo` deletes and replays to show identical state). */
  dropProjection(address: Address): void {
    this.store.dropProjection(address);
  }

  listProjects(): ProjectState[] {
    return this.store.listProjects();
  }

  // ── SQLite maintenance — the bounded-automatic half; the explicit one-time
  // conversion for a pre-existing store lives on `SqliteStore.vacuumConvert` / `abx vacuum convert`.

  /**
   * Run one bounded `PRAGMA incremental_vacuum` pass, delegating to {@link SqliteStore.runIncrementalVacuum}.
   * A no-op (returns 0) for any `Store` implementation that isn't a `SqliteStore` — vacuuming is a
   * SQLite-specific concern, so a Postgres-backed deploy (which owns its own manual VACUUM story)
   * simply has nothing to do here. Exposed on its own (not just via {@link startVacuumMaintenance})
   * so a caller can also run one pass on demand — e.g. right after `abx vacuum convert`, to reclaim
   * whatever the full VACUUM already didn't (it shouldn't leave anything, but this makes "did it
   * work" independently checkable).
   */
  runIncrementalVacuum(maxPages: number = DEFAULT_INCREMENTAL_VACUUM_PAGES): number {
    return this.store instanceof SqliteStore ? this.store.runIncrementalVacuum(maxPages) : 0;
  }

  /**
   * Start automatic SQLite maintenance: {@link runIncrementalVacuum} on its own
   * timer, decoupled from the chain watcher's poll loop (`packages/token-api/src/watcher.ts`) so a
   * reclaim pass can never sit inline with a request or a watch tick — it runs BETWEEN them, on
   * whatever cadence the caller (or the default) picks, and a slow pass only ever delays the next
   * pass, never a request being served concurrently (`node:sqlite`'s `DatabaseSync` is synchronous,
   * but each pass is bounded — see `SqliteStore.runIncrementalVacuum` — precisely so that's cheap).
   *
   * `abx serve` is the intended caller, started once alongside `startChainWatcher`. Safe to call
   * unconditionally: for a non-`SqliteStore` backend this still returns a working `stop()`, it just
   * schedules calls that are themselves no-ops (see {@link runIncrementalVacuum}).
   *
   * A failed pass is logged and swallowed — maintenance must never be the thing that takes a node
   * down; the freelist simply waits for the next pass.
   */
  startVacuumMaintenance(opts: {intervalMs?: number; maxPages?: number; log?: (line: string) => void} = {}): {stop(): void} {
    const intervalMs = opts.intervalMs ?? DEFAULT_VACUUM_INTERVAL_MS;
    const maxPages = opts.maxPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES;
    const log = opts.log ?? ((line: string) => console.error(`[maintenance] ${line}`));
    const timer = setInterval(() => {
      try {
        const reclaimed = this.runIncrementalVacuum(maxPages);
        if (reclaimed > 0) log(`incremental_vacuum reclaimed ${reclaimed} page(s)`);
      } catch (err) {
        log(`incremental_vacuum failed (will retry next pass): ${(err as Error).message}`);
      }
    }, intervalMs);
    // Never keeps the process alive on its own — a plain background convenience, not a reason `abx
    // serve` (or a test) would hang waiting for it.
    timer.unref?.();
    return {stop: () => clearInterval(timer)};
  }
}
