import {parseEventLogs, type Log} from 'viem';
import {classifyIndexError, exponentialBackoffDelay, getLogsAdaptive, linearBackoffDelay, spineEventAbi, type Address} from '@artblocks/abx-sdk';
import type {SelfHostIndexer} from '@artblocks/abx-indexer';

/**
 * The chain watcher — the resolver's one live subscription to the chain, and the trigger
 * source for the whole effects layer (`site/content/docs/protocol/effects.mdx`).
 *
 * Architecture (deliberate):
 *  - **The resolver is the ONLY chain consumer.** One incremental `eth_getLogs` poll covers
 *    every registered project (a single multi-address call per tick); effects never watch the
 *    chain themselves — they are notified. No websockets: polling reuses the deterministic
 *    reconstruction machinery, works on any RPC, and a marketplace thumbnail doesn't need
 *    sub-second latency. (A WSS tip-watcher would be a future latency opt-in that calls the
 *    same incremental reindex — never a second code path.)
 *  - **Notifications are coarse and effect-agnostic**: "project X changed (these tokens, or
 *    all)" — never "re-render". Each registered effect reacts asynchronously and dedups by its
 *    content address (settled inputsHash), so over-notification is harmless by construction;
 *    the token-id hint is an optimization, not a contract.
 *  - **The watermark is notification bookkeeping, not indexing truth.** Indexing truth stays
 *    per-project (`toBlock` + the deterministic replay). Losing the watermark merely re-notifies
 *    once; idempotency absorbs it. It advances only when a tick fully succeeds, so a failed
 *    reindex retries the same window next tick instead of silently skipping a delta.
 *  - **No reorg machinery** (owner call): post-PoS reorgs are rare; the repair is the existing
 *    deterministic full replay (`abx index <addr> --full`).
 */

export interface WatcherStatus {
  running: boolean;
  intervalMs: number;
  /** Per chainKey: the last head seen and the notified-through watermark. */
  chains: Record<string, {head: string | null; watermark: string | null}>;
  lastDeltaAt: string | null;
  lastError: string | null;
}

export interface WatcherOptions {
  indexer: SelfHostIndexer;
  /** Poll cadence. Default ABX_WATCH_INTERVAL_MS → 12s. `0` disables (caller should not start). */
  intervalMs?: number;
  /** Notification sink — defaults to {@link notifyEffects} (the runner's `POST /notify`). */
  notify?: (address: string, tokenIds?: string[]) => void;
  log?: (line: string) => void;
}

/** Largest block window one tick will scan; a longer gap (resolver was down) continues next tick. */
const MAX_BLOCKS_PER_TICK = 5_000n;
/** Consecutive-failure backoff cap (multiplier on the base interval). */
const MAX_BACKOFF = 8;
/**
 * How far behind head the watcher may fall before the projects it tracks are reported `stale`
 * (still serving, but honestly not tracking head — see the lifecycle in
 * site/content/docs/using-abx/remote-services.mdx).
 *
 * Measured against the WATCHER'S WATERMARK, never a project's own `toBlock`: the watermark advances
 * every tick, while a quiet project's `toBlock` only moves when it has events — so lag-by-`toBlock`
 * would slowly mark every idle project stale, which is exactly wrong.
 */
const DEFAULT_STALE_LAG_BLOCKS = 5_000n;
/** How many queued/retryable projects one tick will pick up (bounded so a burst of registrations
 *  can't monopolize a tick — the rest come next tick). */
const DRAIN_PER_TICK = 2;
/** Consecutive tick failures before the tracked projects are reported `stale`. One failed tick is
 *  weather; two in a row is a condition worth surfacing. */
const FAILURES_BEFORE_STALE = 2;

function staleLagBlocks(): bigint {
  const raw = process.env.ABX_STALE_LAG_BLOCKS;
  if (raw === undefined || raw === '') return DEFAULT_STALE_LAG_BLOCKS;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : DEFAULT_STALE_LAG_BLOCKS;
  } catch {
    return DEFAULT_STALE_LAG_BLOCKS;
  }
}

/**
 * A `failed` project is retried with exponential backoff off its attempt count — the point of
 * recording `attempts` at all. Without this a rate-limited RPC gets hammered every tick, which is how
 * a transient throttle becomes a permanent one.
 *
 * Delegates to the sdk's {@link exponentialBackoffDelay} (hoisted from this exact shape). That
 * helper is 1-indexed (`delay(attempt) = min(baseMs * 2^(attempt-1), capMs)`), while `attempts`
 * here is 0-indexed and separately capped at 8 BEFORE the exponent — so `attempt` is passed as
 * `min(attempts, 8) + 1` to land on the identical exponent (and therefore the identical delay,
 * cap included) the old inline formula produced. See `test/watcher-backoff.test.ts` for the
 * old-vs-new equality table this mapping is proven against.
 */
function dueForRetry(row: {attempts: number; lastAttemptAt?: string | null}, baseMs: number, now: number): boolean {
  if (!row.lastAttemptAt) return true;
  const wait = exponentialBackoffDelay(Math.min(row.attempts, 8) + 1, baseMs, 15 * 60_000);
  return now - new Date(row.lastAttemptAt).getTime() >= wait;
}

/** Steady-state proof-of-life cadence: on a quiet stretch (nothing else logged) the watcher emits
 *  ONE "alive" line at most this often, so `tail`ing a resolver shows it's watching, not hung —
 *  without per-tick spam. Deltas and first-run lines reset the clock (they're proof enough). */
const HEARTBEAT_MS = 120_000;

export const DEFAULT_WATCH_INTERVAL_MS = 12_000;

export function watchIntervalMs(): number {
  const raw = process.env.ABX_WATCH_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_WATCH_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WATCH_INTERVAL_MS;
}

/**
 * Fire-and-forget generalized effects notification — `POST /notify {address, tokenIds?}` on the
 * runner at ABX_EFFECTS_URL (bearer ABX_EFFECTS_TOKEN when the runner is public). Deliberately
 * dumb: it says "something changed here", never what to do about it. A missing/down runner costs
 * nothing — its own periodic sweep is the eventual floor.
 */
export function notifyEffects(address: string, tokenIds?: string[]): void {
  const base = process.env.ABX_EFFECTS_URL;
  if (!base) return;
  const headers: Record<string, string> = {'content-type': 'application/json'};
  const token = process.env.ABX_EFFECTS_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  fetch(`${base.replace(/\/$/, '')}/notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify(tokenIds?.length ? {address, tokenIds} : {address}),
  }).catch(() => undefined);
}

export function startChainWatcher(opts: WatcherOptions): {stop(): void; status(): WatcherStatus} {
  const {indexer} = opts;
  const intervalMs = opts.intervalMs ?? watchIntervalMs();
  const notify = opts.notify ?? notifyEffects;
  const rawLog = opts.log ?? ((line: string) => console.log(`[watch] ${line}`));
  // Any real log line (first-run, delta, failure, heartbeat) stamps this — the heartbeat only fires
  // after HEARTBEAT_MS of silence, so an active watcher never double-logs.
  let lastLogAt = 0;
  const log = (line: string) => {
    lastLogAt = Date.now();
    rawLog(line);
  };

  const status: WatcherStatus = {running: true, intervalMs, chains: {}, lastDeltaAt: null, lastError: null};
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;

  /**
   * Flip the tracked projects between `live` and `stale` — and ONLY those two. A project that is
   * `queued`/`backfilling`/`failed` is mid-lifecycle and owns its own status; overwriting it here
   * would erase a recorded failure class or claim a backfill finished.
   */
  function markLag(addresses: string[], lag: 'behind' | 'caught-up', error?: unknown): void {
    for (const addr of addresses) {
      const row = indexer.store.getIndexStatus(addr);
      if (!row) continue;
      if (lag === 'behind' && row.status === 'live') {
        indexer.store.setIndexStatus(addr, {
          status: 'stale',
          ...(error ? {error: classifyIndexError(error)} : {}),
        });
      } else if (lag === 'caught-up' && row.status === 'stale') {
        indexer.store.setIndexStatus(addr, {status: 'live', error: null});
      }
    }
  }

  /**
   * Pick up projects whose catch-up hasn't happened or didn't finish: a `queued` registration (a
   * register that answered 202 and handed the work here, or one interrupted by a restart) and a
   * `failed` one whose backoff has elapsed. This is what makes a deferred registration eventually
   * become `live` with nobody watching — and what repairs the old silent failure mode where an
   * interrupted `add` left a registered project that only a manual `abx index` would fix.
   */
  async function drainPending(): Promise<void> {
    const now = Date.now();
    const pending = indexer.store
      .listIndexStatuses()
      .filter((row) => {
        if (indexer.isCatchingUp(row.address as Address)) return false;
        if (row.status === 'queued') return true;
        return row.status === 'failed' && dueForRetry(row, intervalMs, now);
      })
      .slice(0, DRAIN_PER_TICK);
    for (const row of pending) {
      if (!indexer.store.getRegistration(row.address)) continue; // deregistered under us
      try {
        const {state, mode} = await indexer.reindexShared(row.address as Address);
        notify(row.address);
        log(`${row.address}: catch-up complete (${mode}, ${state.eventCount} event(s)) → live`);
      } catch (err) {
        // reindex() already recorded status + the credential-free class; one project's failure must
        // not abort the tick (or hold the whole chain's watermark).
        log(`${row.address}: catch-up failed (${classifyIndexError(err).class}) — will retry with backoff`);
      }
    }
  }

  async function tick(): Promise<void> {
    const regs = indexer.store.listRegistrations();
    if (regs.length === 0) return; // nothing registered — idle (re-checked every tick)

    // Group by chain — one poll per chain covers all its projects in a single getLogs.
    const byChain = new Map<string, string[]>();
    for (const r of regs) {
      const list = byChain.get(r.chainKey) ?? [];
      list.push(r.address);
      byChain.set(r.chainKey, list);
    }

    for (const [chainKey, addresses] of byChain) {
      const client = indexer.publicClient(chainKey);
      const head = await client.getBlockNumber();
      const metaKey = `watch:${chainKey}`;
      const stored = indexer.store.getMeta(metaKey);
      status.chains[chainKey] = {head: head.toString(), watermark: stored};
      // Persist the head so the resolver's `GET /api/watch` (and `abx verify --remote`) can show
      // liveness for a HOSTED node where you can't tail the log. Cheap k/v, same table as the watermark.
      indexer.store.putMeta(`watch:${chainKey}:head`, head.toString());

      // First run: start at head. Projects were fully indexed when added — the watcher only
      // tracks NEW deltas; backfill is `add`/`index`'s job, never a genesis surprise here.
      if (stored === null) {
        indexer.store.putMeta(metaKey, head.toString());
        status.chains[chainKey].watermark = head.toString();
        log(`${chainKey}: watching ${addresses.length} project(s) from block ${head}`);
        continue;
      }

      const watermark = BigInt(stored);
      // Honest lag: the watcher itself is behind head (a restart after downtime, a slow/failing RPC).
      // Projects still serve their last-known state — that's what `stale` means, as opposed to
      // `failed`. Cleared as soon as the watermark catches back up.
      markLag(addresses, head - watermark > staleLagBlocks() ? 'behind' : 'caught-up');
      if (head <= watermark) continue; // no new blocks

      const from = watermark + 1n;
      const to = head - from + 1n > MAX_BLOCKS_PER_TICK ? from + MAX_BLOCKS_PER_TICK - 1n : head;

      const logs = await getLogsAdaptive(client, addresses as Address[], from, to);

      if (logs.length > 0) {
        // Group the delta by project, reindex each touched projection (the same deterministic
        // incremental fold every other trigger uses), and coalesce to ONE notification per
        // project on its FINAL state — a backfill of N events never fans out N notifications.
        const touched = new Map<string, Log[]>();
        for (const l of logs) {
          const key = (l.address as string).toLowerCase();
          const list = touched.get(key) ?? [];
          list.push(l);
          touched.set(key, list);
        }
        for (const [addr, projectLogs] of touched) {
          // Shared: if a register's backfill for this project is still running, join it rather than
          // starting a rival reconstruct. Throws ⇒ watermark holds; same window retries next tick.
          await indexer.reindexShared(addr as Address, {logs: projectLogs, toBlock: to});
          const hint = tokenHint(projectLogs);
          notify(addr, hint);
          log(`${chainKey}: ${addr} changed (${projectLogs.length} log(s), blocks ${from}–${to}) → notified effects${hint ? ` [tokens ${hint.join(',')}]` : ' [all]'}`);
        }
        status.lastDeltaAt = new Date().toISOString();
        indexer.store.putMeta('watch:lastDeltaAt', status.lastDeltaAt);
      }

      indexer.store.putMeta(metaKey, to.toString());
      status.chains[chainKey].watermark = to.toString();
    }

    // AFTER the delta lane, deliberately: a project the delta scan just reindexed needs nothing more,
    // and draining first would duplicate that work (and its notification) in the same tick. What's
    // left here is what the delta lane can't fix — a deferred registration, an interrupted backfill,
    // a catch-up that failed with no pending window to retry it.
    await drainPending();

    // Tick completed. Record it (proof-of-life for the API) and, if we've been quiet a while, emit
    // one heartbeat so a human tailing the resolver sees the watcher is alive between changes.
    indexer.store.putMeta('watch:pollAt', new Date().toISOString());
    if (Date.now() - lastLogAt >= HEARTBEAT_MS) {
      const summary = Object.entries(status.chains)
        .map(([ck, s]) => `${ck} @ block ${s.head}`)
        .join(', ');
      log(`alive — watching ${summary || 'no registered projects'}${status.lastDeltaAt ? ` · last change ${status.lastDeltaAt}` : ' · no changes seen yet'}`);
    }
  }

  /**
   * The changed-token hint for one project's delta: token ids when EVERY decoded event is
   * token-scoped, else undefined (= "all minted"). A hint, not a contract — the settled-hash
   * probe downstream makes over-notification free, so unknown/contract-scope events simply
   * widen the sweep rather than risk missing a token.
   */
  function tokenHint(projectLogs: Log[]): string[] | undefined {
    try {
      const parsed = parseEventLogs({abi: spineEventAbi, logs: projectLogs});
      if (parsed.length === 0) return undefined; // nothing decodable — sweep wide
      const ids = new Set<string>();
      for (const ev of parsed) {
        const args = ev.args as Record<string, unknown> | undefined;
        const id = args?.tokenId ?? args?._tokenId ?? args?.id;
        if (id === undefined || id === null) return undefined; // a contract-scope event ⇒ all
        ids.add(String(id));
      }
      return [...ids];
    } catch {
      return undefined;
    }
  }

  function loop(): void {
    if (stopped) return;
    // linear backoff up to MAX_BACKOFF× on repeated failure — the sdk's linearBackoffDelay(attempt,
    // baseMs) = attempt * baseMs is this exact shape; Math.max(1, failures) is the "attempt" (never
    // below 1, so a single failure still waits one full interval, not zero).
    timer = setTimeout(async () => {
      try {
        await tick();
        failures = 0;
        status.lastError = null;
      } catch (err) {
        failures = Math.min(failures + 1, MAX_BACKOFF);
        status.lastError = (err as Error).message;
        // Repeated tick failures mean this node is no longer tracking head for anything — say so on
        // the projects themselves, so `abx status` / a provider's status route shows it. Until this,
        // a watcher that had been failing for an hour was visible only in the node's own log.
        if (failures >= FAILURES_BEFORE_STALE) {
          markLag(
            indexer.store.listRegistrations().map((r) => r.address),
            'behind',
            err,
          );
        }
        log(`tick failed (retry with backoff): ${(err as Error).message}`);
      }
      loop();
    }, linearBackoffDelay(Math.max(1, failures), intervalMs));
  }

  // A `backfilling` row at startup belonged to a process that is gone (the catch-up ran in-process
  // and died with it), so nothing would ever finish it. Reset to `queued` and let drainPending pick
  // it up — the repair for an `add` interrupted by a restart or a deploy.
  for (const row of indexer.store.listIndexStatuses()) {
    // …unless a catch-up for it is running in THIS process: `abx serve` starts the watcher after the
    // server is already accepting registers, so a backfill that began moments ago is still alive and
    // owns its own status.
    if (row.status === 'backfilling' && !indexer.isCatchingUp(row.address as Address)) {
      indexer.store.setIndexStatus(row.address, {status: 'queued'});
      log(`${row.address}: backfill was interrupted — re-queued`);
    }
  }

  loop();
  return {
    stop() {
      stopped = true;
      status.running = false;
      if (timer) clearTimeout(timer);
    },
    status: () => status,
  };
}
