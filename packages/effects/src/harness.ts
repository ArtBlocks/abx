import {createServer, type Server} from 'node:http';
import {hexToString} from 'viem';
import {
  AbxServiceClient,
  BOUND_ARTIFACT_MAX_BYTES,
  CONTROL_PLANE_INTERFACE,
  buildTokenData,
  contentDigestOf,
  inputsHash,
  isCodeProject,
  linearBackoffDelay,
  locatorRejectionReason,
  renderArtifactKey,
  sleep,
  type Hex,
  type ProjectState,
  type PublicClient,
  type TokenState,
  type TokenDataResult,
} from '@artblocks/abx-sdk';
import type {StorageBackend} from '@artblocks/abx-storage';

/**
 * The reference effect runner (`site/content/docs/protocol/effects.mdx → The reference runner`).
 *
 * An effect is a spine subscriber, so its natural form is a deployed, long-running
 * service. This harness is effect-agnostic: an effect registers `{key, outputs, run}`;
 * the harness supplies triggers, the queue, idempotency, and storage. It is
 * **stateless by construction** — "is there work?" reduces to "does custody lack the
 * artifact at the CURRENT inputsHash address?" — so there is no job database, a
 * crash-restart re-derives everything, and duplicate runners are harmless (same
 * inputs → same address → idempotent writes).
 *
 * Trigger lanes (both converge on the same sweep): a periodic sweep (the floor), and
 * an HTTP ping (`POST /run {address, tokenIds?}`) the co-deployed indexer/resolver —
 * or the `abx render` repair command — hits for immediacy.
 */

export interface EffectOutput {
  bytes: Uint8Array;
  contentType: string;
}

export interface EffectContext {
  client: PublicClient | null;
  state: ProjectState;
  token: TokenState;
  tokenData: TokenDataResult;
  /** The live-view URL — the same document a collector sees; the render input. */
  liveViewUrl: string;
}

/** One declared output: the key naming the artifact + its MIME type, declared where the effect is
 *  declared (`site/content/docs/protocol/data-plane.mdx → Declared type, never sniffed`). The declared type is
 *  what the manifest and the serving surface speak; the per-run `EffectOutput.contentType` still
 *  travels with the bytes (a mismatch is logged, the declaration wins). */
export interface EffectOutputDecl {
  key: string;
  mimeType: string;
  /**
   * This output's content stitches into the metadata JSON (`site/content/docs/protocol/effects.mdx → Bound vs
   * referenced`) — `traits` today. Bound output is published as capped inline **bytes**, because a
   * locator can't work: the resolver assembles the content into `tokenURI`, so a pointer there would
   * put a third-party fetch on its hottest read.
   *
   * Everything else is **referenced**: the PRODUCER holds the bytes and publishes a reachable
   * locator. The resolver serves referenced output by redirect either way, so handing it the bytes
   * buys no capability and costs it an object store — it refuses them with a `400`.
   *
   * Declared here, next to the mimeType, for the same reason the type is: the serving side must not
   * have to guess. A declaration the resolver doesn't share (an effect whose bindings it doesn't
   * implement) is refused loudly rather than stored unservable.
   */
  bound?: boolean;
}

export interface EffectModule {
  /** Lowercase dot-namespaced effect key (`render`, `inference.caption`, …). */
  key: string;
  /** Typed output declarations; `outputs[0].key` is the presence probe (idempotency). */
  outputs: EffectOutputDecl[];
  run(ctx: EffectContext): Promise<Record<string, EffectOutput | null>>;
}

/** One artifact registration — the row a runner records (co-located, via `recordArtifact`) or
 *  registers (`/v1/effect-artifacts`) per declared output, so the resolver can enumerate the
 *  token's data plane without learning any effect's internals. `locator === null` means the content
 *  isn't reached by pointer: a BOUND output (held with the row / stitched into the JSON), or a
 *  co-located producer's bytes in the shared backend at `key`. */
export interface EffectArtifactRecord {
  key: Hex;
  address: string;
  tokenId: string;
  effectKey: string;
  outputKey: string;
  inputsHash: Hex;
  /** The DECLARED mimeType (`EffectOutputDecl.mimeType`) — what the manifest serves. */
  contentType: string;
  locator: string | null;
}

export interface RunnerOptions {
  resolverUrl: string;
  client: PublicClient | null;
  storage: StorageBackend;
  effects: EffectModule[];
  environmentId?: string;
  /** When set, register each artifact with the resolver's control plane
   *  (POST /v1/effect-artifacts) so a resolver that does NOT share this backend's disk can serve it
   *  — a locator for referenced output, capped content for bound output
   *  (`site/content/docs/protocol/effects.mdx → Bound vs referenced`). Requires a backend that exposes a locator;
   *  the constructor refuses otherwise. Bearer only; never signs on-chain. Omit for the co-located
   *  topology (runner + resolver share one backend). */
  adminToken?: string;
  /** Re-register artifacts that already exist in storage (not just freshly-rendered ones) — the
   *  idempotent repair that restores a resolver which lost its rows, and that lands a publish which
   *  failed transiently after the bytes were stored. **Default on** with `adminToken` (it costs a
   *  presence probe and a locator string); pass `false` to opt out. */
  republish?: boolean;
  /** Co-located topology: record each declared output into the resolver's artifact registry
   *  directly (the shared SQLite store) — the enumeration surface the manifest lists. Recorded on
   *  every run AND on every skip (cheap local upsert), so a wiped registry self-heals on the next
   *  sweep without re-rendering. The hosted twin is `adminToken` (publish over HTTP). */
  recordArtifact?: (row: EffectArtifactRecord) => void | Promise<void>;
  /** Test seam: state source override (defaults to the resolver's public state API). */
  fetchState?: (address: string) => Promise<ProjectState | null>;
  log?: (line: string) => void;
  /** Parallel renders while draining the queue. Default 1 — deterministic order, and Chromium is
   *  heavy on small VMs; raise deliberately (ABX_EFFECTS_CONCURRENCY). */
  concurrency?: number;
  /** When set, `/run` and `/notify` require `Authorization: Bearer <token>` — REQUIRED for a
   *  publicly-reachable runner (an open /run with force would let anyone burn Chromium/storage).
   *  `/health` stays open. (ABX_EFFECTS_TOKEN; the resolver's watcher/ping sends it.) */
  authToken?: string;
}

/** Give up on an artifact key after this many failed runs (a deterministically-crashing script
 *  must not hot-loop). In-memory: a runner restart, a NEW inputsHash (the state changed), or an
 *  explicit `force` all reset it. The failure itself is reported to the resolver with the error. */
const MAX_ATTEMPTS = 3;

/** A publish that failed for a reason retrying can't fix (400/403/404 — the wrong shape, a token
 *  that isn't allowed to write, a route the service doesn't serve). Distinct from a transient one
 *  because the response is opposite: stop, don't back off. See {@link EffectRunner.publishLatch}. */
class PublishConfigError extends Error {}

export interface SweepStats {
  ran: number;
  skipped: number;
  failed: number;
  /** Human-readable failure lines (effect + token + message) — surfaced by `abx render`. */
  errors: string[];
}

export class EffectRunner {
  private readonly opts: RunnerOptions;
  private readonly log: (line: string) => void;
  /** The resolver control-plane client (the locator-bridge publish lane) — null when co-located. */
  private readonly service: AbxServiceClient | null;
  /** Per-artifact-key failed-run counter (see MAX_ATTEMPTS). */
  private readonly attempts = new Map<string, number>();
  /** The notification queue: per-project pending work, merged on enqueue (tokenIds union;
   *  `null` = all minted). The REAL work ledger stays "artifacts missing at the current settled
   *  inputsHash" — this map only holds what we've been told about and not yet probed, so losing
   *  it (restart) costs nothing: the floor sweep re-derives everything. */
  private readonly pending = new Map<string, {tokenIds: Set<string> | null; force: boolean}>();
  private draining = false;
  private idleWaiters: Array<() => void> = [];
  /**
   * Set once a publish fails for a reason retrying can't fix (a 4xx, an unusable locator). While
   * latched, the runner renders NOTHING: a render whose publish can't land is a render that this
   * runner's own idempotency probe will ask for again on the next sweep, and every sweep after —
   * so continuing would burn Chromium and storage indefinitely to produce an artifact nobody can
   * serve. One actionable error beats an infinite quiet loop. Cleared by fixing the config and
   * restarting, or by an explicit `force` (the operator asserting they've fixed it).
   */
  private publishLatch: string | null = null;
  /** The startup handshake, run once and reused (see {@link preflight}). */
  private preflightOnce: Promise<void> | null = null;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => console.log(`[effects] ${line}`));
    this.service = opts.adminToken ? new AbxServiceClient({baseUrl: opts.resolverUrl, token: opts.adminToken}) : null;
    // Boot guard: in the publish topology (we don't share the resolver's disk), referenced output
    // can ONLY reach it as a locator — so a backend that can't produce one has no lane, and every
    // render would be wasted work ending in a 400. Refuse at construction, where the fix is cheap,
    // rather than after the first expensive capture. (Enforcing beats warning: the prose version of
    // this was the trap agents kept walking into.)
    if (opts.adminToken && !opts.storage.locator) {
      throw new Error(
        `this storage backend exposes no locator, so a remote resolver could never serve the renders it holds. ` +
          `Either point the runner at a backend that does — cloud/S3 or R2 with a public base, ipfs, or arweave (peers; pick on operational grounds, not durability dogma) — ` +
          `or run co-located with the resolver, sharing one backend and no admin token.`,
      );
    }
  }

  /** Merge a notification into the queue and kick the drain. Returns the queue depth. */
  enqueue(address: string, tokenIds?: string[], force = false): number {
    const key = address.toLowerCase();
    const cur = this.pending.get(key) ?? {tokenIds: new Set<string>(), force: false};
    if (!tokenIds?.length || cur.tokenIds === null) cur.tokenIds = null; // no hint ⇒ all minted
    else for (const t of tokenIds) cur.tokenIds.add(t);
    cur.force = cur.force || force;
    this.pending.set(key, cur);
    void this.drain();
    return this.pending.size;
  }

  /** Resolves when the queue is fully drained (test/ops seam). */
  idle(): Promise<void> {
    if (!this.draining && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Single drain loop: one project at a time (notifications for other projects merge while a
   *  drain runs), tokens in ascending order (token 0 — the collection page — first), renders
   *  fanned across `concurrency` workers. Over-notification lands on the settled-hash probe and
   *  costs a skip, never a re-render. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.pending.entries().next();
        if (next.done) break;
        const [address, req] = next.value;
        this.pending.delete(address);
        try {
          const stats = await this.sweepProject(address, req.tokenIds ? [...req.tokenIds] : undefined, {
            force: req.force,
          });
          if (stats.ran || stats.failed) {
            this.log(`queue: ${address} ran=${stats.ran} skipped=${stats.skipped} failed=${stats.failed}`);
          }
        } catch (err) {
          this.log(`queue: ${address} drain failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** All projects the resolver serves → sweep each code project. */
  async sweepAll(): Promise<SweepStats> {
    const total: SweepStats = {ran: 0, skipped: 0, failed: 0, errors: []};
    const projects = (await this.fetchJson(`${this.opts.resolverUrl}/api/projects`)) as
      | Array<{address: string}>
      | null;
    for (const p of projects ?? []) {
      const s = await this.sweepProject(p.address);
      total.ran += s.ran;
      total.skipped += s.skipped;
      total.failed += s.failed;
      total.errors.push(...s.errors);
    }
    return total;
  }

  /**
   * The startup handshake for the publish topology — run once, before any render, so a
   * misconfiguration costs a round trip instead of a Chromium launch. Checks the two things a
   * producer can know up front:
   *
   *  - the descriptor declares `abx-control-plane/v1` (which now carries the artifact-registry
   *    routes — there is no separate publish capability to negotiate) and serves our chain;
   *  - our credential actually works, via one authenticated control-plane read.
   *
   * A service's capabilities and a caller's permissions should never be discoverable only by
   * crashing after the expensive part. Descriptor trouble is a WARNING (a node may be older than
   * this field, and the publish still works); a definitive credential rejection latches.
   */
  private async preflight(): Promise<void> {
    if (!this.service) return;
    if (!this.preflightOnce) {
      this.preflightOnce = (async () => {
        try {
          const d = await this.service!.descriptor();
          if (!d.interfaces?.includes(CONTROL_PLANE_INTERFACE)) {
            this.log(
              `warning: ${this.opts.resolverUrl} declares no ${CONTROL_PLANE_INTERFACE} — publishes may be refused ` +
                `(interfaces: ${d.interfaces?.join(', ') || 'none'})`,
            );
          }
        } catch (err) {
          this.log(`warning: could not read the service descriptor (${(err as Error).message}) — continuing`);
        }
        try {
          await this.service!.listProjects();
        } catch (err) {
          const status = (err as {status?: number}).status;
          if (status === 401 || status === 403 || status === 404) {
            this.publishLatch =
              `the resolver at ${this.opts.resolverUrl} rejected our control-plane credential (${status}) — ` +
              `renders would be published nowhere. Check the admin/remote token; nothing has been rendered.`;
            this.log(`publish lane unavailable: ${this.publishLatch}`);
          } else {
            this.log(`warning: control-plane preflight failed (${(err as Error).message}) — treating as transient`);
          }
        }
      })();
    }
    return this.preflightOnce;
  }

  /** Sweep one project: run every effect for every token whose current output is missing.
   *  `opts.force` re-renders even when the current output already exists (the repair lane for a
   *  bad/blank/timed-out capture — the render is otherwise deterministic, so a normal sweep skips it). */
  async sweepProject(address: string, tokenIds?: string[], opts?: {force?: boolean}): Promise<SweepStats> {
    const stats: SweepStats = {ran: 0, skipped: 0, failed: 0, errors: []};
    if (opts?.force) this.publishLatch = null; // the operator asserting the config is fixed
    await this.preflight();
    // Latched: render nothing and say why once. Reporting it as a failure (rather than a silent
    // skip) is the point — `abx render` surfaces it, and a hosted runner's logs carry one
    // actionable line instead of a re-render loop nobody notices until the bill arrives.
    if (this.publishLatch) {
      stats.failed += 1;
      stats.errors.push(this.publishLatch);
      this.log(`skipping ${address}: ${this.publishLatch}`);
      return stats;
    }
    const state = await this.getState(address);
    if (!state || !isCodeProject(state)) return stats;
    const tokens = (
      tokenIds
        // `'no-live-copies'` (an EditionCode id with zero minted copies — see tokens.ts's TokenRow
        // doc) is excluded alongside `'burned'`, deliberately: an id with no live copies has never
        // had a mint-time seed drawn (there is nothing to derive an image/traits FROM yet), the exact
        // same reason a burned 721 token is excluded. Both are "no current holder, don't render" —
        // one because the token stopped existing, the other because it never started. A watcher
        // notification can still name a not-yet-minted id (a param-write attempt, a stray event), so
        // this guard has to hold even on the explicit-ids path, not just the default `'live'`-only sweep.
        ? state.tokens.filter((t) => tokenIds.includes(t.tokenId) && t.lifecycle !== 'burned' && t.lifecycle !== 'no-live-copies')
        : state.tokens.filter((t) => t.lifecycle === 'live')
    )
      // ascending — token 0 (the collection page / oldest listings) lands first on a big fan-out
      .sort((a, b) => (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
    // An explicit token id that matched nothing minted is a no-op that must SAY so — not a silent
    // `ran=0` that reads as "already done". (Over-notification from the watcher passes ids too, but
    // it never names a specific unminted id, so this only fires on a deliberate `abx render <addr> <id>`.)
    if (tokenIds?.length && tokens.length === 0) {
      const line = `${address}: token(s) ${tokenIds.join(',')} not minted / out of range — nothing to render`;
      stats.errors.push(line);
      this.log(line);
    }
    const work = tokens.flatMap((token) => this.opts.effects.map((effect) => ({token, effect})));
    // Bounded worker pool (default 1): a contract-scope param change fans out to EVERY minted
    // token — drain at a deliberate width instead of serially-forever or 1000 Chromiums at once.
    const width = Math.max(1, Math.min(this.opts.concurrency ?? 1, work.length || 1));
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const item = work[cursor++];
        if (!item) return;
        try {
          const outcome = await this.runToken(item.effect, state, item.token, opts?.force ?? false);
          stats[outcome] += 1;
        } catch (err) {
          stats.failed += 1;
          const line = `${item.effect.key} ${address}/${item.token.tokenId}: ${(err as Error).message}`;
          stats.errors.push(line);
          this.log(`${line} (failed)`);
          // A publish that can't succeed by retrying stops the whole pool: every remaining token
          // would render, fail the same way, and be re-rendered next sweep. Fix the config, restart.
          if (err instanceof PublishConfigError) {
            this.publishLatch = `${(err as Error).message} — rendering stopped; fix this and restart (or re-run with force)`;
            this.log(`publish lane unavailable: ${this.publishLatch}`);
            return;
          }
        }
      }
    };
    await Promise.all(Array.from({length: width}, worker));
    return stats;
  }

  /** One (effect, token): compute the current address; run only when the output is missing —
   *  unless `force` re-renders and overwrites the artifact at the current inputsHash. */
  async runToken(
    effect: EffectModule,
    state: ProjectState,
    token: TokenState,
    force = false,
  ): Promise<'ran' | 'skipped'> {
    // SETTLED tokenData (augment: false): effect outputs are addressed by event-derived state
    // only. A volatile augment hook (block timestamp, oracle) feeds the LIVE VIEW — the capture
    // snapshots whatever it shows — but must never re-address the artifact every block. An effect
    // that reads live data itself owns its own addressing (fold it into the output key, or accept
    // re-runs per trigger).
    const tokenData = await buildTokenData(this.opts.client, state, token, {augment: false});
    const hash = inputsHash(contentDigestOf(state), tokenData.json, this.opts.environmentId);
    const probeKey = this.artifactKey(state, token, hash, effect, effect.outputs[0].key);
    // Deterministic-image lane: if this project's on-chain `image` is a url-template pointing at
    // THIS backend's public base, the still lands at a STABLE per-token key the chain already names
    // (`<publicBase>/<key>`), overwritten in place — no resolver in the marketplace path. Idempotency
    // rides a sidecar `.abxhash` marker instead of the hash-embedded object key.
    const detImg = this.deterministicImageTarget(state, token);
    const currentAtHash = detImg
      ? new TextDecoder().decode((await this.opts.storage.getObject?.(`${detImg.objectKey}.abxhash`))?.bytes ?? new Uint8Array()) === hash
      : await this.opts.storage.has(probeKey);
    if (!force && currentAtHash) {
      // current output exists — idempotent (no re-render). Republish from storage on request so a
      // resolver that lost its volume can be restored without re-rendering (RunnerOptions.republish).
      // (No republish in the deterministic lane: the bytes already live at the public S3 key.)
      if (!detImg && this.opts.adminToken && this.opts.republish !== false) await this.republishFromStorage(effect, state, token, hash);
      // Registry repair lane: re-record rows for whatever is stored at the current hash — a cheap
      // local upsert per output, so a wiped artifact registry self-heals on the next sweep.
      if (this.opts.recordArtifact) await this.recordFromStorage(effect, state, token, hash, detImg);
      return 'skipped';
    }
    // Attempt cap: a run that keeps failing at THIS key stops retrying (a new inputsHash or an
    // explicit force resets it; the resolver holds the reported failure + error meanwhile).
    if (!force && (this.attempts.get(probeKey) ?? 0) >= MAX_ATTEMPTS) {
      return 'skipped';
    }
    if (force) this.attempts.delete(probeKey);

    const ctx: EffectContext = {
      client: this.opts.client,
      state,
      token,
      tokenData,
      liveViewUrl: `${this.opts.resolverUrl}/a/${state.chainId}/${state.address}/${token.tokenId}`,
    };
    await this.reportStatus(probeKey, state, token, effect, 'rendering');
    let outputs: Record<string, EffectOutput | null>;
    try {
      outputs = await effect.run(ctx);
    } catch (err) {
      const n = (this.attempts.get(probeKey) ?? 0) + 1;
      this.attempts.set(probeKey, n);
      await this.reportStatus(probeKey, state, token, effect, 'failed', (err as Error).message, n);
      throw err;
    }
    for (const [outputKey, output] of Object.entries(outputs)) {
      if (!output) continue; // optional output (e.g. a script that reported no traits)
      // Declared-type enforcement (`data-plane.md → Declared type, never sniffed`): an undeclared
      // output has no type to serve — refuse it loudly rather than sniff or guess.
      const decl = effect.outputs.find((o) => o.key === outputKey);
      if (!decl) {
        this.log(`${effect.key} ${state.address}/${token.tokenId}: undeclared output '${outputKey}' NOT stored — declare it in EffectModule.outputs with its mimeType`);
        continue;
      }
      if (output.contentType !== decl.mimeType) {
        this.log(`${effect.key}/${outputKey}: runtime contentType '${output.contentType}' ≠ declared '${decl.mimeType}' — the declaration wins`);
      }
      const key = this.artifactKey(state, token, hash, effect, outputKey);
      if (outputKey === 'image' && detImg) {
        // Overwrite the stable per-token object + its inputsHash marker. The on-chain url-template
        // is the authoritative image URL, so there is NO resolver locator publish for the image —
        // but the registry row still lands (locator = the public URL) so the manifest lists it.
        await this.opts.storage.putObject!(detImg.objectKey, {bytes: output.bytes, contentType: decl.mimeType});
        await this.opts.storage.putObject!(`${detImg.objectKey}.abxhash`, {bytes: new TextEncoder().encode(hash), contentType: 'text/plain'});
        if (this.opts.recordArtifact) await this.record(state, token, hash, effect, decl, key, detImg.url);
        this.log(`image ${state.address}/${token.tokenId} → ${detImg.url} (deterministic; ${output.bytes.length}B)`);
        continue;
      }
      await this.opts.storage.put(key, {bytes: output.bytes, contentType: decl.mimeType});
      if (this.opts.recordArtifact) await this.record(state, token, hash, effect, decl, key);
      if (this.opts.adminToken) await this.publishArtifact(state, token, hash, effect, decl, {bytes: output.bytes, contentType: decl.mimeType}, key);
    }
    this.attempts.delete(probeKey);
    await this.reportStatus(probeKey, state, token, effect, 'done');
    this.log(`${effect.key} ${state.address}/${token.tokenId} → ${hash.slice(0, 10)}…`);
    return 'ran';
  }

  /** Best-effort run-state report to the resolver's observability plane (`/v1/effect-status`).
   *  No admin token (co-located) ⇒ no-op: status degrades to derived up-to-date|stale; correctness
   *  is never here — it stays artifact-presence at the settled inputsHash. */
  private async reportStatus(
    key: Hex,
    state: ProjectState,
    token: TokenState,
    effect: EffectModule,
    status: 'rendering' | 'failed' | 'done',
    error?: string,
    attempts?: number,
  ): Promise<void> {
    if (!this.service) return;
    try {
      await this.service.reportEffectStatus({
        chainId: state.chainId,
        key,
        address: state.address,
        tokenId: token.tokenId,
        effectKey: effect.key,
        status,
        error,
        attempts,
      });
    } catch {
      // observability only — a failed report never fails the run
    }
  }

  /**
   * Register one stored output with the resolver's control plane so a node that doesn't share this
   * backend's disk can serve it. The form follows the output's DECLARED class
   * (`site/content/docs/protocol/effects.mdx → Bound vs referenced`), and the resolver enforces the same rule
   * from its side — this is one contract, not a preference on either end:
   *
   *  - **bound** (`traits`) → the content, capped. The resolver stitches it into the token JSON.
   *  - **referenced** (`image`, `print`, …) → a reachable locator from THIS backend. We hold the
   *    bytes; the resolver holds a pointer and redirects. If the backend can't produce a locator
   *    there is no legal publish, and that is a configuration error we refuse to paper over —
   *    the constructor's boot guard normally catches it before a single render is spent.
   *
   * `contentType` is the DECLARED mimeType.
   */
  private async publishArtifact(
    state: ProjectState,
    token: TokenState,
    hash: Hex,
    effect: EffectModule,
    decl: EffectOutputDecl,
    output: EffectOutput,
    key: Hex,
  ): Promise<void> {
    let body: {locator: string} | {bytes_base64: string};
    if (decl.bound) {
      if (output.bytes.length > BOUND_ARTIFACT_MAX_BYTES) {
        throw new PublishConfigError(
          `bound output '${effect.key}/${decl.key}' is ${output.bytes.length}B — over the ${BOUND_ARTIFACT_MAX_BYTES}B cap a resolver accepts. ` +
            `An output this size is referenced, not bound: drop \`bound\` from its declaration so it publishes as a locator.`,
        );
      }
      body = {bytes_base64: Buffer.from(output.bytes).toString('base64')};
    } else {
      const locator = (await this.opts.storage.locator?.(key)) ?? null;
      if (!locator) {
        throw new PublishConfigError(
          `no locator for '${effect.key}/${decl.key}' from this storage backend — a resolver that doesn't share this disk can only serve referenced output by redirect, so it needs a URL. ` +
            `Use a backend that exposes one (cloud/S3 or R2 with a public base, ipfs, arweave), or run this runner co-located with the resolver (drop the admin token and share the backend).`,
        );
      }
      const bad = locatorRejectionReason(locator);
      if (bad) {
        throw new PublishConfigError(
          `this backend's locator for '${effect.key}/${decl.key}' (${locator}) won't be accepted: ${bad}. ` +
            `A locator must resolve for anyone — check the public base / gateway this backend is configured with.`,
        );
      }
      body = {locator};
    }
    try {
      await this.service!.publishEffectArtifact({
        chainId: state.chainId,
        address: state.address,
        tokenId: token.tokenId,
        inputsHash: hash,
        output: decl.key,
        effectKey: effect.key,
        contentType: decl.mimeType,
        ...body,
      });
    } catch (err) {
      // Classify, because the two cases want opposite behavior. A 4xx will never succeed by
      // retrying, and swallowing it is expensive in a way a log line hides: the work ledger is
      // "custody lacks the artifact at the current hash", so an unpublished render re-renders on
      // EVERY sweep, forever. A 5xx/network failure is transient — leave the artifact missing and
      // let the next sweep retry it.
      const status = (err as {status?: number}).status;
      const detail = `publish ${decl.key} ${state.address}/${token.tokenId} → ${(err as Error).message}`;
      if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new PublishConfigError(detail);
      }
      throw new Error(detail);
    }
    this.log(
      `registered ${decl.key} ${state.address}/${token.tokenId} ` +
        `(${'locator' in body ? `locator ${body.locator}` : `${output.bytes.length}B bound`})`,
    );
  }

  /** Record one artifact row into the co-located registry (`RunnerOptions.recordArtifact`). */
  private async record(
    state: ProjectState,
    token: TokenState,
    hash: Hex,
    effect: EffectModule,
    decl: EffectOutputDecl,
    key: Hex,
    locatorOverride?: string,
  ): Promise<void> {
    // A bound output's content is served from the registry row / shared custody, never a pointer.
    const locator = locatorOverride ?? (decl.bound ? null : ((await this.opts.storage.locator?.(key)) ?? null));
    await this.opts.recordArtifact!({
      key,
      address: state.address.toLowerCase(),
      tokenId: token.tokenId,
      effectKey: effect.key,
      outputKey: decl.key,
      inputsHash: hash,
      contentType: decl.mimeType,
      locator,
    });
  }

  /**
   * Re-register already-stored outputs for (effect, token) at the current inputsHash — no re-render.
   * Cheap now that referenced output travels as a pointer: a presence probe plus a locator string,
   * no byte read (only a bound output's small content is read). That is why it runs on every skip in
   * the publish topology rather than being opt-in: it self-heals a resolver that lost its rows AND —
   * the case that matters more — a publish that failed transiently after the bytes had already
   * landed here, which the "is the artifact stored?" ledger would otherwise mark done forever.
   */
  private async republishFromStorage(effect: EffectModule, state: ProjectState, token: TokenState, hash: Hex): Promise<void> {
    for (const decl of effect.outputs) {
      const key = this.artifactKey(state, token, hash, effect, decl.key);
      if (decl.bound) {
        const stored = await this.opts.storage.get(key);
        if (stored) await this.publishArtifact(state, token, hash, effect, decl, stored, key);
        continue;
      }
      if (await this.opts.storage.has(key)) {
        // The bytes never leave this backend, so an empty placeholder is all publishArtifact needs
        // for a referenced output — it publishes the locator, not the content.
        await this.publishArtifact(state, token, hash, effect, decl, {bytes: new Uint8Array(), contentType: decl.mimeType}, key);
      }
    }
  }

  /** Re-record registry rows for outputs already stored at the current inputsHash — presence probes
   *  only, no byte reads, no re-render. The deterministic-image lane records its stable public URL
   *  (its sidecar marker already matched, or we wouldn't be in the skip path). */
  private async recordFromStorage(
    effect: EffectModule,
    state: ProjectState,
    token: TokenState,
    hash: Hex,
    detImg: {objectKey: string; url: string} | null,
  ): Promise<void> {
    for (const decl of effect.outputs) {
      const key = this.artifactKey(state, token, hash, effect, decl.key);
      if (decl.key === 'image' && detImg) {
        await this.record(state, token, hash, effect, decl, key, detImg.url);
        continue;
      }
      if (await this.opts.storage.has(key)) await this.record(state, token, hash, effect, decl, key);
    }
  }

  /** The trigger surface + health. Two write lanes, distinct on purpose:
   *   - `POST /notify {address, tokenIds?}` — the NOTIFICATION lane (the resolver's watcher):
   *     "something changed here". Enqueues + 202 immediately; the queue drains async. Coarse and
   *     effect-agnostic — never says what to do.
   *   - `POST /run {address, tokenIds?, force?}` — the COMMAND lane (`abx render --effects-url`):
   *     synchronous sweep, returns the stats.
   *  Both require `Authorization: Bearer <authToken>` when one is configured (a public runner
   *  with an open force-render endpoint is a resource-burn hole); `/health` stays open. */
  startHttp(port: number): Server {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/health') {
          res.writeHead(200, {'content-type': 'application/json'});
          return res.end(
            JSON.stringify({
              ok: true,
              effects: this.opts.effects.map((e) => ({key: e.key, outputs: e.outputs})),
              queued: this.pending.size,
            }),
          );
        }
        if (this.opts.authToken && req.headers.authorization !== `Bearer ${this.opts.authToken}`) {
          res.writeHead(401, {'content-type': 'application/json'});
          return res.end(JSON.stringify({error: 'unauthorized — send Authorization: Bearer <ABX_EFFECTS_TOKEN>'}));
        }
        if (req.method === 'POST' && url.pathname === '/notify') {
          const body = JSON.parse(await readBody(req)) as {address?: string; tokenIds?: string[]; force?: boolean};
          if (!body.address) {
            res.writeHead(400, {'content-type': 'application/json'});
            return res.end(JSON.stringify({error: 'address required'}));
          }
          const depth = this.enqueue(body.address, body.tokenIds, body.force ?? false);
          res.writeHead(202, {'content-type': 'application/json'});
          return res.end(JSON.stringify({queued: true, depth}));
        }
        if (req.method === 'POST' && url.pathname === '/run') {
          const body = JSON.parse(await readBody(req)) as {address?: string; tokenIds?: string[]; force?: boolean};
          if (!body.address) {
            res.writeHead(400, {'content-type': 'application/json'});
            return res.end(JSON.stringify({error: 'address required'}));
          }
          const stats = await this.sweepProject(body.address, body.tokenIds, {force: body.force});
          res.writeHead(200, {'content-type': 'application/json'});
          return res.end(JSON.stringify(stats));
        }
        res.writeHead(404, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'unknown route'}));
      } catch (err) {
        res.writeHead(500, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: (err as Error).message}));
      }
    });
    server.listen(port);
    return server;
  }

  /** The sweep loop — the trigger floor. Pings make it immediate; this makes it eventual. */
  startLoop(intervalMs: number): NodeJS.Timeout {
    let running = false;
    return setInterval(async () => {
      if (running) return; // one sweep at a time; overlap is wasted work, never corruption
      running = true;
      try {
        const s = await this.sweepAll();
        if (s.ran || s.failed) this.log(`sweep: ran=${s.ran} skipped=${s.skipped} failed=${s.failed}`);
      } catch (err) {
        this.log(`sweep failed: ${(err as Error).message}`);
      } finally {
        running = false;
      }
    }, intervalMs);
  }

  private artifactKey(
    state: ProjectState,
    token: TokenState,
    hash: Hex,
    effect: EffectModule,
    outputKey: string,
  ): Hex {
    return renderArtifactKey(state.chainId, state.address, token.tokenId, hash, outputKey, effect.key);
  }

  /**
   * The deterministic-thumbnail target for (project, token), or null if this project/backend isn't
   * on that lane. Active only when the backend both serves a public base and can write an arbitrary
   * key (cloud/S3), AND the project's on-chain collection `image` is a `url-template` whose
   * substituted URL lives under that public base. Then the still is written to the exact object the
   * on-chain pointer names (`<publicBase>/<objectKey>`) — marketplaces read the on-chain tokenURI →
   * this URL, never a resolver, and the URL is stable across re-renders (the pixels change, the
   * pointer doesn't → no chain write to update content). Any other host → null (the normal locator lane).
   */
  private deterministicImageTarget(state: ProjectState, token: TokenState): {objectKey: string; url: string} | null {
    const publicBase = this.opts.storage.publicBase;
    if (!publicBase || !this.opts.storage.putObject || !this.opts.storage.getObject) return null;
    const img = state.collectionFields.find((f) => f.field === 'image' && f.representation === 'url-template');
    if (!img) return null;
    let template: string;
    try {
      template = hexToString(img.value);
    } catch {
      return null;
    }
    const url = template.split('{id}').join(token.tokenId);
    const prefix = `${publicBase}/`;
    if (!url.startsWith(prefix)) return null; // template points at a different host — leave it to the normal path
    return {objectKey: url.slice(prefix.length), url};
  }

  private async getState(address: string): Promise<ProjectState | null> {
    if (this.opts.fetchState) return this.opts.fetchState(address);
    return (await this.fetchJson(`${this.opts.resolverUrl}/api/project/${address}`)) as ProjectState | null;
  }

  private async fetchJson(url: string): Promise<unknown> {
    // Retry transient failures — a hosted resolver can cold-start / briefly 502 on fly, and a
    // one-shot `abx render --remote` must not silently no-op against one that's just waking up.
    // Two OUTCOMES, deliberately distinct: a genuine 4xx (e.g. 404 unknown project) → `null`, so
    // the caller SKIPS cleanly (there is nothing to do). A network failure or a 5xx/429 that
    // survives every retry means the resolver is UNREACHABLE → we THROW, so the caller reports a
    // real failure instead of a clean `ran=0 failed=0`. (The old code returned null for both, so a
    // killed/unreachable resolver read as benign "nothing to do" — a failure disguised as success.)
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) return await res.json();
        if (res.status < 500 && res.status !== 429) return null;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < 3) await sleep(linearBackoffDelay(attempt + 1, 750));
    }
    throw new Error(
      `resolver unreachable at ${url} — ${(lastErr as Error)?.message ?? String(lastErr)} ` +
        `(is \`abx serve\` running there?)`,
    );
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
