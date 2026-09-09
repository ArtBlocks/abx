import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveDataDir} from '@artblocks/abx-sdk/node';
import type {
  Address,
  ExtensionInfo,
  Hex,
  IndexError,
  IndexErrorClass,
  IndexStatus,
  MetadataField,
  ProjectState,
  SpineEvent,
  TokenState,
} from '@artblocks/abx-sdk';

/** How a project was registered for indexing — the minimum to replay it. */
export interface ProjectRegistration {
  address: string;
  chainKey: string;
  fromBlock: string;
  factory: string | null;
  label?: string;
  /** Operator display metadata served in the token's ERC-721 JSON (the creator's words). */
  description?: string;
  externalUrl?: string;
  /** Operator's off-chain OpenSea attributes (JSON array), stitched UNDER any on-chain `attributes`.
   *  Collection-scope: a 1/1's traits, or a Series' shared/fallback traits. */
  attributes?: string;
  /** Operator's off-chain PER-TOKEN attributes (JSON `{ "<tokenId>": OpenSeaAttribute[] }`) — a Series'
   *  editable, resolver-served traits (the per-token twin of `attributes`; a token's entry wins over
   *  the collection-scope `attributes`, and any on-chain `attributes` still wins over both). */
  tokenAttributes?: string;
  /** Durable content locators keyed by on-chain hash (JSON `{ "0x<keccak>": "ipfs://<cid>" }`) —
   *  bridged from the deployer so this store can point `image` at IPFS/Arweave without the bytes. */
  contentLocators?: string;
  registeredAt: string;
}

/** One producer-published effect artifact — a row in the data plane's enumeration registry
 *  (`site/content/docs/protocol/data-plane.mdx`). The resolver lists a token's rows and keeps only those whose
 *  `key` matches the recomputed address at the CURRENT settled inputsHash, so stale rows go
 *  silently unlisted (self-invalidation). `locator === null` means the bytes live in custody
 *  (a co-located producer's bytes in the shared backend at `key`, or a bound output's `bytes` below).
 *  Producer-registered, NOT chain-derived: rows survive a projection wipe and self-heal from a
 *  runner's next sweep. */
export interface EffectArtifactRow {
  /** renderArtifactKey (keccak hex; encodes effectKey + settled inputsHash). */
  key: string;
  address: string;
  tokenId: string;
  effectKey: string;
  outputKey: string;
  inputsHash: string;
  /** The effect's DECLARED output mimeType — what the manifest and byte route serve. */
  contentType: string | null;
  locator: string | null;
  /**
   * A **bound** output's content (`site/content/docs/protocol/effects.mdx → Bound vs referenced`): the bytes that
   * stitch into the metadata JSON — `render/traits` today. Capped at
   * {@link BOUND_ARTIFACT_MAX_BYTES}; `null` for every **referenced** output, whose bytes stay with
   * the producer and reach us only as `locator`.
   *
   * These live HERE, next to the row, and deliberately not in a `StorageBackend`: byte custody holds
   * *source* bytes an on-chain keccak commits to (switchable, never lapsable), while these are
   * re-creatable projection state whose loss is a re-render. One write instead of two also removes a
   * way for the row and its content to disagree.
   */
  bytes?: Uint8Array | null;
  updatedAt?: string;
}

/** The cap a serving node MUST accept per bound output, and MUST refuse above
 *  (`site/content/docs/using-abx/remote-services.mdx → The mode is decided by the binding`). ~100× a real
 *  traits payload: generous for what it is for, far too small to become blob storage. */
export const BOUND_ARTIFACT_MAX_BYTES = 64 * 1024;

/**
 * Where one project sits in the indexing lifecycle (`site/content/docs/using-abx/remote-services.mdx` →
 * The indexing lifecycle) — what the control plane's `status`/list routes report and what
 * `abx status` prints, for a managed provider and for your own node in the same words.
 *
 * Deliberately its OWN table, not columns on `registrations`: `register()` is a full-column upsert,
 * so a re-add would silently reset the lifecycle (the clobber class). Registrations are operator
 * *input*; this is operational history — it survives a projection wipe (a replay's whole point is
 * that it doesn't lose where you were) and dies with `deregister()`.
 */
export interface IndexStatusRow {
  address: string;
  status: IndexStatus;
  /** Set on `stale`/`failed`, cleared on success. Credential-free by contract. */
  errorClass?: IndexErrorClass | null;
  errorMessage?: string | null;
  /** Catch-up attempts since the last success. */
  attempts: number;
  lastAttemptAt?: string | null;
  /** When catch-up last COMPLETED (distinct from the projection's `reconstructedAt`, which a
   *  failed attempt leaves untouched). */
  lastIndexedAt?: string | null;
  updatedAt?: string;
}

/** A patch to {@link IndexStatusRow}: omitted fields are preserved, an explicit `null` clears —
 *  the same preserve-on-omit / clear-on-null rule the off-chain registration fields follow. */
export interface IndexStatusPatch {
  status?: IndexStatus;
  error?: IndexError | null;
  attempts?: number;
  lastAttemptAt?: string | null;
  lastIndexedAt?: string | null;
}

/** Transient per-(artifact key) effect observability — `rendering`/`failed` between triggers.
 *  Rebuildable state ONLY: "up to date" is always artifact-presence at the current settled
 *  inputsHash, never a row here; a lost table costs history, not correctness. */
export interface EffectStatusRow {
  /** The artifact key (renderArtifactKey at the settled inputsHash) this run is producing. */
  key: string;
  address: string;
  tokenId: string;
  effectKey: string;
  status: 'rendering' | 'failed';
  error?: string | null;
  attempts?: number;
  updatedAt?: string;
}

/**
 * The projection store contract. Two responsibilities, kept distinct:
 *
 *  - **registrations** — the minimum needed to replay a project (operator input).
 *  - **projects** — the reconstructed state, the *disposable, replay-rebuildable
 *    projection*. `wipeProjections()` clears only this; registrations survive.
 *
 * The reference implementation is {@link SqliteStore}. A platform-scale deploy
 * swaps in a Postgres-backed implementation behind this same interface — nothing
 * upstream (indexer, token API) changes.
 */
export interface Store {
  /** Where the projection lives on disk (for display / ops). */
  readonly path: string;

  register(reg: ProjectRegistration): void;
  listRegistrations(): ProjectRegistration[];
  getRegistration(address: string): ProjectRegistration | null;
  /** Forget a project entirely — drop its registration and its projection (on-chain data is untouched). */
  deregister(address: string): void;
  /** Throw away the reconstructed projection but KEEP the registration, so the next index rebuilds
   *  it from the deploy block. The projection is a cache of chain state, never a source of truth —
   *  this is the operation that makes that claim checkable (and what `abx demo` demonstrates). */
  dropProjection(address: string): void;

  /** Register one effect artifact (the data plane's enumeration registry). Effect-agnostic —
   *  producers declare the (effectKey, outputKey, mimeType); the store never interprets them.
   *  Idempotent — last write wins per key. */
  putEffectArtifact(row: EffectArtifactRow): void;
  /** The registered artifact row for an effect artifact key, or null. */
  getEffectArtifact(key: string): EffectArtifactRow | null;
  /** Every registered artifact row for (project, token) — the manifest's effect-source listing.
   *  Callers filter by recomputing the current-inputsHash key per row (stale rows unlisted). */
  listEffectArtifacts(address: string, tokenId: string): EffectArtifactRow[];
  /**
   * Drop the **bound** content of every superseded row for (project, token, effectKey, outputKey) —
   * everything whose `inputs_hash` isn't `currentHash`.
   *
   * The spec makes this a **MAY**, not a MUST (`site/content/docs/protocol/effects.mdx → Bound vs referenced`):
   * what's normative is that superseded content is never *served* or stitched, which leaves it with
   * no legal reader. Dropping it is therefore free of consequence, and this node drops eagerly — on
   * each bound registration — because that is what turns "held bytes" into
   * `cap × minted × bound outputs` rather than a number that grows with every param change. A node
   * that chose to keep history would be equally conforming and simply carry the cost.
   *
   * The rows themselves survive as provenance; only the unreadable content goes.
   */
  pruneBoundArtifactBytes(address: string, tokenId: string, effectKey: string, outputKey: string, currentHash: string): void;

  /** Merge a lifecycle patch for one project (preserve-on-omit, clear-on-`null`) and return the
   *  stored row. Creates the row on first write. */
  setIndexStatus(address: string, patch: IndexStatusPatch): IndexStatusRow;
  /** One project's lifecycle row, or null when nothing has stamped it yet. */
  getIndexStatus(address: string): IndexStatusRow | null;
  /** Every lifecycle row (the list route's status column, in one read). */
  listIndexStatuses(): IndexStatusRow[];

  /** Node-level key/value metadata (e.g. the chain watcher's persisted watermark). */
  putMeta(key: string, value: string): void;
  getMeta(key: string): string | null;

  /** Upsert transient effect observability (`rendering` / `failed`) for an artifact key. */
  putEffectStatus(row: EffectStatusRow): void;
  /** Clear one artifact key's status — the run finished; artifact presence takes over as truth. */
  clearEffectStatus(key: string): void;
  listEffectStatuses(address: string): EffectStatusRow[];

  /** Persist a folded projection. `fullReplay: true` (the repair path — `abx index --full`) purges
   *  the project's append-only event log first, so a reorg-replaced event can't survive as a stale
   *  row; routine incremental writes leave the log append-only. */
  putProject(state: ProjectState, opts?: {fullReplay?: boolean}): void;
  getProject(address: string): ProjectState | null;
  listProjects(): ProjectState[];

  /** Drop the rebuildable projection (keeps registrations). Proves replay. */
  wipeProjections(): void;
  /** Close and remove the underlying store entirely. */
  destroy(): void;
}

// The data plane's effect-artifact registry (`site/content/docs/protocol/data-plane.mdx`): one row per declared
// output a runner produced, keyed by renderArtifactKey at the CURRENT settled inputsHash (a param
// change re-addresses → old rows go silently unlisted). Effect-agnostic — producers declare the
// (effect_key, output_key, content_type); the store never interprets them. locator NULL = nothing to
// redirect to: a BOUND output (content in `bytes`) or a co-located producer's bytes at `key` in the
// shared backend. Producer-registered, NOT chain-
// derived, so like registrations rows survive a projection wipe/replay — and a lost table self-heals
// from a runner's next sweep (record-on-skip / re-register).
const EFFECT_ARTIFACTS_DDL = `
CREATE TABLE IF NOT EXISTS effect_artifacts (
  key           TEXT PRIMARY KEY,   -- renderArtifactKey (keccak hex; encodes effectKey + settled inputsHash)
  address       TEXT NOT NULL,      -- lowercased project address
  token_id      TEXT NOT NULL,
  effect_key    TEXT NOT NULL,      -- 'render' | any registered effect
  output_key    TEXT NOT NULL,      -- 'image' | 'traits' | any declared output
  inputs_hash   TEXT NOT NULL,      -- the settled inputsHash this row was produced at
  locator       TEXT,               -- ipfs://<cid> | ar://<txid> | https://… | NULL (referenced bytes stay with the producer; or co-located custody at \`key\`)
  content_type  TEXT,               -- the effect's DECLARED output mimeType
  bytes         BLOB,               -- BOUND output content only (≤64KB, stitches into the JSON); NULL for referenced
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_artifacts_token ON effect_artifacts(address, token_id);
`;

const SCHEMA = `
-- Cross-process co-located writes (a local effect runner records artifact rows into this same
-- file while the resolver serves): wait out a writer instead of failing fast. WAL keeps readers
-- unblocked; artifact writes are rare (one per rendered output) and touch a table the indexer
-- never writes.
--
-- FIRST, before anything else: a timeout only protects the statements that come AFTER it. With this
-- third in the list (as it was), the WAL switch and the DDL below it had no timeout at all — so two
-- processes opening the same store at once (parallel CLI invocations, or a co-located runner starting
-- alongside the resolver) could fail outright with "database is locked" instead of waiting the moment
-- out. Setting the journal mode itself takes a write lock, which is exactly the collision.
PRAGMA busy_timeout = 5000;
-- Lets SQLite reclaim freed pages incrementally (via \`PRAGMA incremental_vacuum\`, see
-- SqliteStore.runIncrementalVacuum / \`abx vacuum\`) instead of only on a full VACUUM. Must precede
-- the first CREATE TABLE — auto_vacuum only takes effect on a database with no schema objects yet,
-- so this is a no-op for a store opened from an existing file (deliberately: a one-time \`VACUUM\` to
-- converting an existing store requires the explicit \`abx vacuum convert\`).
--
-- It must ALSO precede \`PRAGMA journal_mode = WAL\` below, not just the CREATE TABLEs — verified
-- empirically (\`packages/indexer/test/vacuum.test.ts\`): switching an empty database to WAL first and
-- only then requesting INCREMENTAL leaves \`PRAGMA auto_vacuum\` silently reporting 'none' forever
-- after, on this connection AND on every later reopen of the same file, even though no table has
-- been created yet and the pragma's own precondition ("database is empty") still holds. Whatever
-- SQLite's internal reason, the fix is this order; getting it backwards is indistinguishable from
-- the bug this whole file exists to fix — a store that LOOKS like it enabled incremental vacuum but
-- never actually did, and only \`SqliteStore.autoVacuumMode()\` would catch it.
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS registrations (
  address       TEXT PRIMARY KEY,   -- lowercased
  chain_key     TEXT NOT NULL,
  from_block    TEXT NOT NULL,
  factory       TEXT,
  label         TEXT,
  description   TEXT,
  external_url  TEXT,
  attributes    TEXT,               -- JSON OpenSeaAttribute[] (off-chain operator traits, collection-scope)
  token_attributes TEXT,            -- JSON { "<tokenId>": OpenSeaAttribute[] } (off-chain per-token traits)
  content_locators TEXT,            -- JSON { "0x<keccak>": "ipfs://<cid>" }
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  address           TEXT PRIMARY KEY,  -- lowercased
  address_original  TEXT NOT NULL,     -- checksummed, as reconstructed
  chain_id          INTEGER NOT NULL,
  abx_version       INTEGER,
  deploy_block      TEXT,
  deploy_tx         TEXT,
  factory           TEXT,
  implementation    TEXT,
  is_canonical      INTEGER,           -- 0 | 1 | NULL
  name              TEXT,
  symbol            TEXT,
  owner             TEXT,
  contract_uri      TEXT,              -- ALWAYS NULL:
                                        -- the composed ERC-7572 document is a live read, never
                                        -- projected (no settled value — a renderer can change it with
                                        -- no log at all). Column kept for schema stability; nothing
                                        -- writes it non-null. See token_uri_renderer/_locked below for
                                        -- the settled scalars that DO stay projected.
  token_uri_renderer    TEXT,          -- non-null => tokenURI resolves on-chain
  token_uri_locked      INTEGER,       -- 0 | 1 | NULL
  contract_uri_renderer TEXT,
  contract_uri_locked   INTEGER,
  royalty_receiver  TEXT,              -- NULL => no royalty
  royalty_bps       INTEGER,
  collection_fields TEXT,              -- JSON MetadataField[] (collection scope)
  locked_collection_fields TEXT,       -- JSON string[]
  contract_type     TEXT,              -- '1of1' | 'series' | 'code' | '1of1-edition' | 'edition' | 'edition-code'
  max_invocations   TEXT,              -- Series supply cap (decimal string) or NULL
  minter            TEXT,              -- the single authorized minter or NULL
  paused            INTEGER,           -- Paused extension: 1 | 0 | NULL (NULL/0 ⇒ unpaused)
  primary_payee     TEXT,              -- Primary Payee destination or NULL
  from_block        TEXT NOT NULL,
  to_block          TEXT NOT NULL,
  event_count       INTEGER NOT NULL,
  reconstructed_at  TEXT NOT NULL,
  rpc_url           TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  project_address    TEXT NOT NULL,
  token_id           TEXT NOT NULL,
  lifecycle          TEXT NOT NULL DEFAULT 'unminted', -- 'unminted' | 'live' | 'burned'; see TokenState
  owner              TEXT,
  token_uri          TEXT,             -- ALWAYS NULL:
                                        -- the composed tokenURI/uri(id) document is a live read,
                                        -- never projected — same reasoning as contract_uri above.
                                        -- Column kept for schema stability; nothing writes it non-null.
  fields             TEXT,             -- JSON MetadataField[] (on-chain token fields)
  locked_fields      TEXT,             -- JSON string[] (locked field names)
  PRIMARY KEY (project_address, token_id)
);

CREATE TABLE IF NOT EXISTS extensions (
  project_address TEXT NOT NULL,
  id              TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  PRIMARY KEY (project_address, id)
);

CREATE TABLE IF NOT EXISTS events (
  project_address TEXT NOT NULL,
  seq             INTEGER NOT NULL,  -- chain order (block, logIndex)
  name            TEXT NOT NULL,
  register        INTEGER NOT NULL,
  what            TEXT NOT NULL,
  block_number    TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  tx_hash         TEXT NOT NULL,
  args            TEXT NOT NULL,     -- JSON
  PRIMARY KEY (project_address, seq)
);

CREATE INDEX IF NOT EXISTS idx_tokens_project ON tokens(project_address);
CREATE INDEX IF NOT EXISTS idx_extensions_project ON extensions(project_address);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_address);

${EFFECT_ARTIFACTS_DDL}

-- Node-level key/value metadata: the chain watcher's persisted watermark, etc. NOT chain-derived
-- (survives a projection wipe; losing it merely re-notifies once, which idempotency absorbs).
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Transient effect observability: 'rendering' / 'failed' between triggers, reported by a runner.
-- REBUILDABLE ONLY — "up to date" is artifact-presence at the current settled inputsHash, never a
-- row here. A wiped table loses history (attempt counts, error text), not correctness.
CREATE TABLE IF NOT EXISTS effect_status (
  key         TEXT PRIMARY KEY,     -- the artifact key this run produces
  address     TEXT NOT NULL,        -- lowercased project address
  token_id    TEXT NOT NULL,
  effect_key  TEXT NOT NULL,        -- 'render' | any registered effect
  status      TEXT NOT NULL,        -- 'rendering' | 'failed'
  error       TEXT,
  attempts    INTEGER,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_status_address ON effect_status(address);

-- Where each project sits in the indexing lifecycle (queued | backfilling | live | stale | failed).
-- Operational history, NOT chain-derived and NOT operator input: it survives a projection wipe (the
-- replay must not lose where you were) and dies with deregister(). Kept OFF the registrations table
-- on purpose: register() is a full-column upsert, so a re-add would silently reset it.
CREATE TABLE IF NOT EXISTS index_status (
  address         TEXT PRIMARY KEY,   -- lowercased
  status          TEXT NOT NULL,      -- IndexStatus
  error_class     TEXT,               -- IndexErrorClass, on stale/failed
  error_message   TEXT,               -- credential-free hint (closed set — never an upstream message)
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_indexed_at TEXT,               -- when catch-up last COMPLETED
  updated_at      TEXT NOT NULL
);
`;

const b = (v: boolean | null | undefined): number | null =>
  v === null || v === undefined ? null : v ? 1 : 0;
const lc = (address: string): string => address.toLowerCase();

/**
 * The event table's chain-derived sort key: `(blockNumber << 32) | logIndex`. Matches the schema
 * comment (`seq INTEGER NOT NULL, -- chain order (block, logIndex)`), which the writer used to
 * violate by storing the array index instead (positional — renumbers on every re-fold, so
 * delete-and-reinsert was the only correct write). Encoding the real chain position makes `seq`
 * stable across re-folds: the SAME event always computes the SAME seq, so appending is an
 * `ON CONFLICT DO NOTHING` no-op rather than a rewrite (see {@link putProject}).
 *
 * A block's log index fits comfortably under 2^32 (a block would need billions of logs to
 * overflow it), so the shift never collides. The result routinely EXCEEDS
 * `Number.MAX_SAFE_INTEGER` — a Base Sepolia block height today already pushes `seq` past 2^53 —
 * so this returns a `bigint`, bound directly (`node:sqlite`'s `DatabaseSync` accepts `bigint`
 * params natively). Never round-trip this value through a JS `number`: reading an INTEGER column
 * that large back with the driver's default (`readBigInts` off) throws
 * `RangeError: Value is too large to be represented as a JavaScript number` — which is exactly why
 * every reader below either selects an explicit column list that excludes `seq`, or (the migration)
 * never materializes it in JS at all.
 */
function eventSeq(ev: {blockNumber: string; logIndex: number}): bigint {
  return (BigInt(ev.blockNumber) << 32n) | BigInt(ev.logIndex);
}

/**
 * The reference store: a single SQLite file (`.abx-self-host/index.db`).
 *
 * It keeps the elegant property of the file-based projection — *one disposable
 * artifact you can delete and replay* — while adding real indexes, queries, and
 * transactional writes. No server, no second container, no connection string:
 * SQLite is embedded, the indexer is the only writer, and the token API is
 * read-heavy, so WAL mode fits the access pattern exactly.
 *
 * The reconstructed state is normalized across `projects` / `tokens` /
 * `commitments` / `extensions` / `events`. Wiping those tables (keeping
 * `registrations`) and replaying yields identical state — that's the whole point.
 */
export class SqliteStore implements Store {
  readonly path: string;
  private db: DatabaseSync;

  constructor(dataDir?: string) {
    // Centralized in the SDK — see resolveDataDir's doc comment: this and four other
    // call sites each carried an independent copy of this fallback, which is exactly the setup
    // that can silently split a project's SQLite projection from its managed Arweave key.
    const dir = dataDir ?? resolveDataDir().dir;
    mkdirSync(dir, {recursive: true});
    this.path = resolve(dir, 'index.db');
    this.db = new DatabaseSync(this.path);
    this.premigrate();
    this.db.exec(SCHEMA);
    this.migrate();
    this.migrateSeq();
  }

  /** Shape changes that must land BEFORE the schema exec (its indexes reference new columns).
   *  effect_artifacts pre-data-plane shape (key/address/locator only) → drop; the schema recreates
   *  it. Dropping is safe pre-release: rows are producer-published and self-heal from a runner's
   *  next sweep (record-on-skip / republish) — no chain data is lost. */
  private premigrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(effect_artifacts)`).all() as Array<{name: string}>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'token_id')) {
      this.db.exec(`DROP TABLE effect_artifacts`);
    }
  }

  /** Idempotently add columns introduced after a DB was first created (CREATE IF NOT
   *  EXISTS won't backfill them). Keeps an existing projection working across upgrades. */
  private migrate(): void {
    const add = (table: string, col: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    };
    add('registrations', 'description TEXT');
    add('registrations', 'external_url TEXT');
    add('registrations', 'attributes TEXT');
    add('registrations', 'token_attributes TEXT');
    add('registrations', 'content_locators TEXT');
    add('tokens', "lifecycle TEXT NOT NULL DEFAULT 'unminted'");
    add('tokens', 'fields TEXT');
    add('tokens', 'locked_fields TEXT');
    add('projects', 'collection_fields TEXT');
    add('projects', 'locked_collection_fields TEXT');
    add('projects', 'token_uri_renderer TEXT');
    add('projects', 'token_uri_locked INTEGER');
    add('projects', 'contract_uri_renderer TEXT');
    add('projects', 'contract_uri_locked INTEGER');
    add('projects', 'contract_type TEXT');
    add('projects', 'max_invocations TEXT');
    add('projects', 'minter TEXT');
    add('projects', 'paused INTEGER');
    add('projects', 'primary_payee TEXT');
    // code-project state (params, schemas, hooks, seed source, script, dependencies) —
    // one JSON column; the shape is the ProjectState fields, spread back on hydrate.
    add('projects', 'code_state TEXT');
    add('tokens', 'params TEXT');
    // bound-output content (`effects.md → Bound vs referenced`): traits used to land in the
    // StorageBackend beside the referenced bytes; they belong with the row instead.
    add('effect_artifacts', 'bytes BLOB');
    // ERC-1155 editions: per-id supply + cap (decimal strings) and current holder balances (JSON
    // object address→balance, folded from TransferSingle/TransferBatch — see TokenState.holders).
    // Text columns like their 721-token siblings above; absent for a 721 token, so NULL is the
    // honest default rather than a fabricated '0'/'{}'.
    add('tokens', 'supply TEXT');
    add('tokens', 'max_supply TEXT');
    add('tokens', 'holders TEXT');
    // The collection-wide per-id default (`DefaultMaxSupplySet`) — the 1155 analogue of
    // `max_invocations` above, and what makes a stored `max_supply` of '0' readable: with the
    // override flag beside it, '0' is "closed forever" rather than "open".
    add('projects', 'default_max_supply TEXT');
    add('tokens', 'max_supply_overridden INTEGER');
  }

  /**
   * One-time data migration, gated on `PRAGMA user_version` (unused before this — starts at 0 on
   * every existing store). `migrate()` above only ever ADDs columns; recomputing `seq` rewrites
   * VALUES in an existing column, which a `PRAGMA table_info` presence check can't gate — hence a
   * separate versioned step.
   *
   * `events.seq` used to be the array index at write time (positional — renumbers on every re-fold).
   * This recomputes every existing row to the chain-derived value `(block_number << 32) | log_index`
   * — the same formula {@link eventSeq} uses going forward — so an upgraded store's history becomes
   * append-only-compatible without re-indexing from chain. No collisions are possible: `(block,
   * logIndex)` is already unique per project (the table's own history proves it — it was a valid
   * event log before this ran), and the shift preserves that uniqueness.
   *
   * A fresh install has no rows yet, so the `UPDATE` is a no-op — but `user_version` still advances,
   * so this never re-scans an empty table on every open. Wrapped in a transaction: a crash mid-way
   * leaves `user_version` at 0 and retries the whole thing next open, never a half-migrated table.
   */
  private migrateSeq(): void {
    const CURRENT = 1;
    const {user_version: version} = this.db.prepare(`PRAGMA user_version`).get() as {user_version: number};
    if (version >= CURRENT) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec(`UPDATE events SET seq = (CAST(block_number AS INTEGER) << 32) | CAST(log_index AS INTEGER)`);
      this.db.exec(`PRAGMA user_version = ${CURRENT}`);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── registrations ──────────────────────────────────────────────────────────
  register(reg: ProjectRegistration): void {
    this.db
      .prepare(
        `INSERT INTO registrations (address, chain_key, from_block, factory, label, description, external_url, attributes, token_attributes, content_locators, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           chain_key=excluded.chain_key, from_block=excluded.from_block,
           factory=excluded.factory, label=excluded.label,
           description=excluded.description, external_url=excluded.external_url,
           attributes=excluded.attributes, token_attributes=excluded.token_attributes,
           content_locators=excluded.content_locators,
           registered_at=excluded.registered_at`,
      )
      .run(
        lc(reg.address),
        reg.chainKey,
        reg.fromBlock,
        reg.factory,
        reg.label ?? null,
        reg.description ?? null,
        reg.externalUrl ?? null,
        reg.attributes ?? null,
        reg.tokenAttributes ?? null,
        reg.contentLocators ?? null,
        reg.registeredAt,
      );
  }

  listRegistrations(): ProjectRegistration[] {
    return this.db
      .prepare(`SELECT * FROM registrations ORDER BY registered_at`)
      .all()
      .map(rowToRegistration);
  }

  getRegistration(address: string): ProjectRegistration | null {
    const row = this.db.prepare(`SELECT * FROM registrations WHERE address = ?`).get(lc(address));
    return row ? rowToRegistration(row) : null;
  }

  dropProjection(address: string): void {
    this.deleteProjection(lc(address));
  }

  deregister(address: string): void {
    const key = lc(address);
    this.deleteProjection(key);
    // `deleteProjection` deliberately spares `events` (append-only, chain-derived — see its
    // docstring); forgetting a project entirely must still remove them, or a re-`abx add` at a
    // later block would resurrect old rows underneath a fresh registration.
    this.db.prepare(`DELETE FROM events WHERE project_address = ?`).run(key);
    this.db.prepare(`DELETE FROM effect_artifacts WHERE address = ?`).run(key);
    this.db.prepare(`DELETE FROM effect_status WHERE address = ?`).run(key);
    this.db.prepare(`DELETE FROM index_status WHERE address = ?`).run(key);
    this.db.prepare(`DELETE FROM registrations WHERE address = ?`).run(key);
  }

  // ── effect artifacts (the data plane's registry; producer-published) ──────────
  putEffectArtifact(row: EffectArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO effect_artifacts (key, address, token_id, effect_key, output_key, inputs_hash, locator, content_type, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           address=excluded.address, token_id=excluded.token_id, effect_key=excluded.effect_key,
           output_key=excluded.output_key, inputs_hash=excluded.inputs_hash,
           locator=excluded.locator, content_type=excluded.content_type,
           bytes=excluded.bytes, updated_at=excluded.updated_at`,
      )
      .run(
        row.key.toLowerCase(),
        lc(row.address),
        row.tokenId,
        row.effectKey,
        row.outputKey,
        row.inputsHash.toLowerCase(),
        row.locator,
        row.contentType,
        row.bytes ?? null,
        row.updatedAt ?? new Date().toISOString(),
      );
  }

  pruneBoundArtifactBytes(
    address: string,
    tokenId: string,
    effectKey: string,
    outputKey: string,
    currentHash: string,
  ): void {
    this.db
      .prepare(
        `UPDATE effect_artifacts SET bytes = NULL
          WHERE address = ? AND token_id = ? AND effect_key = ? AND output_key = ?
            AND inputs_hash <> ? AND bytes IS NOT NULL`,
      )
      .run(lc(address), tokenId, effectKey, outputKey, currentHash.toLowerCase());
  }

  getEffectArtifact(key: string): EffectArtifactRow | null {
    const row = this.db
      .prepare(`SELECT * FROM effect_artifacts WHERE key = ?`)
      .get(key.toLowerCase()) as ArtifactDbRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listEffectArtifacts(address: string, tokenId: string): EffectArtifactRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM effect_artifacts WHERE address = ? AND token_id = ? ORDER BY effect_key, output_key`)
        .all(lc(address), tokenId) as unknown as ArtifactDbRow[]
    ).map(rowToArtifact);
  }

  // ── node metadata (watcher watermark, …) ─────────────────────────────────────
  putMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as {value: string} | undefined;
    return row?.value ?? null;
  }

  // ── indexing lifecycle (queued | backfilling | live | stale | failed) ────────
  /**
   * Read-modify-write so a caller can advance ONE field without knowing the rest: the watcher marks
   * `stale` without touching `attempts`, a failure records the error without inventing a
   * `lastIndexedAt`. Omitted = preserved, explicit `null` = cleared (the same rule the off-chain
   * registration fields follow). Single writer per node, so a read-then-write is safe here.
   */
  setIndexStatus(address: string, patch: IndexStatusPatch): IndexStatusRow {
    const key = lc(address);
    const prior = this.getIndexStatus(key);
    const merged: IndexStatusRow = {
      address: key,
      status: patch.status ?? prior?.status ?? 'queued',
      errorClass: patch.error === undefined ? prior?.errorClass ?? null : patch.error === null ? null : patch.error.class,
      errorMessage:
        patch.error === undefined ? prior?.errorMessage ?? null : patch.error === null ? null : patch.error.message ?? null,
      attempts: patch.attempts ?? prior?.attempts ?? 0,
      lastAttemptAt: patch.lastAttemptAt === undefined ? prior?.lastAttemptAt ?? null : patch.lastAttemptAt,
      lastIndexedAt: patch.lastIndexedAt === undefined ? prior?.lastIndexedAt ?? null : patch.lastIndexedAt,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO index_status (address, status, error_class, error_message, attempts, last_attempt_at, last_indexed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           status=excluded.status, error_class=excluded.error_class, error_message=excluded.error_message,
           attempts=excluded.attempts, last_attempt_at=excluded.last_attempt_at,
           last_indexed_at=excluded.last_indexed_at, updated_at=excluded.updated_at`,
      )
      .run(
        merged.address,
        merged.status,
        merged.errorClass ?? null,
        merged.errorMessage ?? null,
        merged.attempts,
        merged.lastAttemptAt ?? null,
        merged.lastIndexedAt ?? null,
        merged.updatedAt!,
      );
    return merged;
  }

  getIndexStatus(address: string): IndexStatusRow | null {
    const row = this.db.prepare(`SELECT * FROM index_status WHERE address = ?`).get(lc(address));
    return row ? rowToIndexStatus(row as Record<string, unknown>) : null;
  }

  listIndexStatuses(): IndexStatusRow[] {
    return this.db
      .prepare(`SELECT * FROM index_status`)
      .all()
      .map((r) => rowToIndexStatus(r as Record<string, unknown>));
  }

  // ── transient effect status (runner-reported observability; rebuildable) ─────
  putEffectStatus(row: EffectStatusRow): void {
    this.db
      .prepare(
        `INSERT INTO effect_status (key, address, token_id, effect_key, status, error, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           address=excluded.address, token_id=excluded.token_id, effect_key=excluded.effect_key,
           status=excluded.status, error=excluded.error, attempts=excluded.attempts, updated_at=excluded.updated_at`,
      )
      .run(
        row.key.toLowerCase(),
        lc(row.address),
        row.tokenId,
        row.effectKey,
        row.status,
        row.error ?? null,
        row.attempts ?? null,
        row.updatedAt ?? new Date().toISOString(),
      );
  }

  clearEffectStatus(key: string): void {
    this.db.prepare(`DELETE FROM effect_status WHERE key = ?`).run(key.toLowerCase());
  }

  listEffectStatuses(address: string): EffectStatusRow[] {
    const rows = this.db
      .prepare(`SELECT key, address, token_id, effect_key, status, error, attempts, updated_at FROM effect_status WHERE address = ?`)
      .all(lc(address)) as Array<{key: string; address: string; token_id: string; effect_key: string; status: string; error: string | null; attempts: number | null; updated_at: string}>;
    return rows.map((r) => ({
      key: r.key,
      address: r.address,
      tokenId: r.token_id,
      effectKey: r.effect_key,
      status: r.status as 'rendering' | 'failed',
      error: r.error,
      attempts: r.attempts ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  // ── projection ───────────────────────────────────────────────────────────--
  /**
   * Persist a reconstructed `ProjectState`. O(delta), not O(history): the routine case — one new
   * mint on an otherwise-unchanged project — writes one project row and one token row, appends
   * whatever events are new, and touches nothing else. A delete-and-reinsert approach would rewrite
   * the entire projection (every token, every event) on every call.
   *
   * `contract_uri`/`token_uri` are bound NULL unconditionally regardless of what `state` carries —
   * see the schema comments on those columns. This is deliberate even when a caller passed populated
   * values (e.g. a reconstruct run with `readUriDocuments: true`): the store's job is never to cache
   * a value with no settled state, only to serve it live when asked.
   */
  putProject(state: ProjectState, opts?: {fullReplay?: boolean}): void {
    const key = lc(state.address);
    this.db.exec('BEGIN');
    try {
      // project row: full-column upsert, not delete-then-insert.
      this.db
        .prepare(
          `INSERT INTO projects (
             address, address_original, chain_id, abx_version, deploy_block, deploy_tx,
             factory, implementation, is_canonical, name, symbol, owner, contract_uri,
             token_uri_renderer, token_uri_locked, contract_uri_renderer, contract_uri_locked,
             royalty_receiver, royalty_bps, collection_fields, locked_collection_fields,
             contract_type, max_invocations, default_max_supply, minter, paused, primary_payee,
             code_state, from_block, to_block, event_count, reconstructed_at, rpc_url
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(address) DO UPDATE SET
             address_original=excluded.address_original, chain_id=excluded.chain_id,
             abx_version=excluded.abx_version, deploy_block=excluded.deploy_block,
             deploy_tx=excluded.deploy_tx, factory=excluded.factory,
             implementation=excluded.implementation, is_canonical=excluded.is_canonical,
             name=excluded.name, symbol=excluded.symbol, owner=excluded.owner,
             contract_uri=excluded.contract_uri, token_uri_renderer=excluded.token_uri_renderer,
             token_uri_locked=excluded.token_uri_locked,
             contract_uri_renderer=excluded.contract_uri_renderer,
             contract_uri_locked=excluded.contract_uri_locked,
             royalty_receiver=excluded.royalty_receiver, royalty_bps=excluded.royalty_bps,
             collection_fields=excluded.collection_fields,
             locked_collection_fields=excluded.locked_collection_fields,
             contract_type=excluded.contract_type, max_invocations=excluded.max_invocations,
             default_max_supply=excluded.default_max_supply,
             minter=excluded.minter, paused=excluded.paused, primary_payee=excluded.primary_payee,
             code_state=excluded.code_state, from_block=excluded.from_block,
             to_block=excluded.to_block, event_count=excluded.event_count,
             reconstructed_at=excluded.reconstructed_at, rpc_url=excluded.rpc_url`,
        )
        .run(
          key,
          state.address,
          state.chainId,
          state.abxVersion,
          state.deployBlock,
          state.deployTx,
          state.factory,
          state.implementation,
          b(state.isCanonical),
          state.name,
          state.symbol,
          state.owner,
          null, // contract_uri — always NULL; see the schema comment
          state.tokenURIRenderer,
          b(state.tokenURILocked),
          state.contractURIRenderer,
          b(state.contractURILocked),
          state.royalty?.receiver ?? null,
          state.royalty?.bps ?? null,
          JSON.stringify(state.collectionFields),
          JSON.stringify(state.lockedCollectionFields),
          state.contractType ?? null,
          state.maxInvocations ?? null,
          state.defaultMaxSupply ?? null,
          state.minter ?? null,
          b(state.paused),
          state.primaryPayee ?? null,
          JSON.stringify({
            contractParams: state.contractParams ?? null,
            paramSchemas: state.paramSchemas ?? null,
            paramHooks: state.paramHooks ?? null,
            delegateRegistry: state.delegateRegistry ?? null,
            seedSource: state.seedSource ?? null,
            script: state.script ?? null,
            dependencies: state.dependencies ?? null,
          }),
          state.fromBlock,
          state.toBlock,
          state.eventCount,
          state.reconstructedAt,
          state.rpcUrl ?? null,
        );

      // tokens: upsert every token in the new state, then delete any id that's no longer present
      // (a burn, or a re-fold dropping a placeholder — rare). Diffing against the STORED id list
      // rather than binding the whole new-id list into a big `NOT IN (...)` keeps the delete set to
      // exactly what actually vanished (usually nothing) instead of one parameter per surviving
      // token, which would also risk SQLite's bound-parameter ceiling on a large collection.
      const existingIds = (
        this.db.prepare(`SELECT token_id FROM tokens WHERE project_address = ?`).all(key) as Array<{token_id: string}>
      ).map((r) => r.token_id);
      const newIdSet = new Set(state.tokens.map((t) => t.tokenId));
      const removedIds = existingIds.filter((id) => !newIdSet.has(id));
      if (removedIds.length) {
        const delToken = this.db.prepare(`DELETE FROM tokens WHERE project_address = ? AND token_id = ?`);
        for (const id of removedIds) delToken.run(key, id);
      }
      const upsertToken = this.db.prepare(
        `INSERT INTO tokens (project_address, token_id, lifecycle, owner, token_uri, fields, locked_fields, params, supply, max_supply, max_supply_overridden, holders)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_address, token_id) DO UPDATE SET
           lifecycle=excluded.lifecycle, owner=excluded.owner, token_uri=excluded.token_uri,
           fields=excluded.fields, locked_fields=excluded.locked_fields, params=excluded.params,
           supply=excluded.supply, max_supply=excluded.max_supply,
           max_supply_overridden=excluded.max_supply_overridden, holders=excluded.holders`,
      );
      for (const t of state.tokens) {
        upsertToken.run(
          key,
          t.tokenId,
          t.lifecycle,
          t.owner,
          null, // token_uri — always NULL; see the schema comment
          JSON.stringify(t.fields),
          JSON.stringify(t.lockedFields),
          t.params?.length ? JSON.stringify(t.params) : null,
          // editions only; absent (undefined) for a 721 token stays NULL, never a fabricated '0'/'{}'.
          t.supply ?? null,
          t.maxSupply ?? null,
          // `undefined` (a 721 token) stays NULL; only an id with its own MaxSupplyUpdated writes 1.
          t.maxSupplyOverridden === undefined ? null : b(t.maxSupplyOverridden),
          t.holders && Object.keys(t.holders).length ? JSON.stringify(t.holders) : null,
        );
      }

      // extensions: a handful of rows per project — delete+reinsert stays simple and cheap; not
      // worth an upsert.
      this.db.prepare(`DELETE FROM extensions WHERE project_address = ?`).run(key);
      const insExt = this.db.prepare(
        `INSERT INTO extensions (project_address, id, name, version) VALUES (?,?,?,?)`,
      );
      for (const e of state.extensions) insExt.run(key, e.id, e.name, e.version);

      // events: append-only. `seq` is chain-derived (see {@link eventSeq}), so the SAME event always
      // lands on the SAME row — a re-fold that re-derives the whole log from chain is a no-op here
      // (every insert conflicts and is skipped), not a rewrite of however many thousand rows came
      // before it. The one exception is a FULL replay: it is the documented repair path (a reorg can
      // replace the event at a given (block, logIndex) with different content, and DO NOTHING would
      // preserve the stale row forever), so a full replay purges this project's log first and
      // rebuilds it from the fresh fold — restoring exactly the guarantee `abx index --full` claims.
      if (opts?.fullReplay) {
        this.db.prepare(`DELETE FROM events WHERE project_address = ?`).run(key);
      }
      const insEvent = this.db.prepare(
        `INSERT INTO events (project_address, seq, name, register, what, block_number, log_index, tx_hash, args)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_address, seq) DO NOTHING`,
      );
      for (const ev of state.events) {
        insEvent.run(key, eventSeq(ev), ev.name, ev.register, ev.what, ev.blockNumber, ev.logIndex, ev.txHash, JSON.stringify(ev.args));
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getProject(address: string): ProjectState | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE address = ?`).get(lc(address));
    return row ? this.hydrate(row as unknown as ProjectRow) : null;
  }

  listProjects(): ProjectState[] {
    return this.db
      .prepare(`SELECT * FROM projects ORDER BY reconstructed_at`)
      .all()
      .map((r) => this.hydrate(r as unknown as ProjectRow));
  }

  wipeProjections(): void {
    this.db.exec(`DELETE FROM events; DELETE FROM extensions; DELETE FROM tokens; DELETE FROM projects;`);
  }

  destroy(): void {
    this.db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = this.path + suffix;
      if (existsSync(f)) rmSync(f);
    }
  }

  // ── SQLite maintenance ───────────────────────────────────────────────────────
  // Deliberately NOT on the `Store` interface above: vacuuming is a SQLite-specific concern (a
  // Postgres-backed implementation has its own manual VACUUM story, run outside this codebase), so
  // callers that need it (the CLI's `abx vacuum`, `SelfHostIndexer.runIncrementalVacuum`) narrow to
  // `SqliteStore` first rather than this leaking into the generic contract every backend implements.

  /**
   * This store's actual `PRAGMA auto_vacuum` mode, right now. A store opened from a file created
   * before `SCHEMA` started setting `PRAGMA auto_vacuum = INCREMENTAL` BEFORE its first `CREATE
   * TABLE` (see the comment on that pragma above) is permanently stuck at `'none'` — the pragma
   * silently no-ops on a database that already has tables — until {@link vacuumConvert} runs. This
   * is the detection half of the two-part approach: every other read/write path in this class is
   * indifferent to the mode, so nothing breaks for a store still at `'none'`; only reclamation cares.
   */
  autoVacuumMode(): 'none' | 'full' | 'incremental' {
    const {auto_vacuum} = this.db.prepare(`PRAGMA auto_vacuum`).get() as {auto_vacuum: number};
    return auto_vacuum === 2 ? 'incremental' : auto_vacuum === 1 ? 'full' : 'none';
  }

  /** Diagnostics behind `abx vacuum status`: {@link autoVacuumMode} alongside the raw page/freelist
   *  counts a caller (or a test) can watch move as maintenance runs. */
  vacuumStats(): {mode: 'none' | 'full' | 'incremental'; freelistPages: number; pageCount: number} {
    const {freelist_count: freelistPages} = this.db.prepare(`PRAGMA freelist_count`).get() as {freelist_count: number};
    const {page_count: pageCount} = this.db.prepare(`PRAGMA page_count`).get() as {page_count: number};
    return {mode: this.autoVacuumMode(), freelistPages, pageCount};
  }

  /**
   * The one-time, EXPLICIT conversion for a store stuck at `auto_vacuum='none'`: sets the pragma —
   * on its own a no-op here, same as it was at construction, since the database already has tables
   * — and then runs a full `VACUUM`, the only operation that actually rebuilds the file under the
   * new mode. This is deliberately not run automatically anywhere in this class or in
   * {@link SelfHostIndexer}: a full `VACUUM` rewrites the ENTIRE database file and can briefly need
   * up to ~2x its on-disk size while it runs, so it must be an operator's explicit choice, made with
   * that cost understood — `abx vacuum convert` (and the docs it points at) is that explicit surface.
   * A no-op, returning the mode unchanged, once the store is already `'full'` or `'incremental'`.
   */
  vacuumConvert(): 'none' | 'full' | 'incremental' {
    if (this.autoVacuumMode() !== 'none') return this.autoVacuumMode();
    this.db.exec(`PRAGMA auto_vacuum = INCREMENTAL`);
    this.db.exec(`VACUUM`);
    return this.autoVacuumMode();
  }

  /**
   * Bounded `PRAGMA incremental_vacuum(N)`: reclaims at most `maxPages` freed pages THIS call, never
   * the whole freelist at once. `node:sqlite`'s `DatabaseSync` is SYNCHRONOUS and shares this process
   * with token-api reads on a co-located `abx serve` — an unbounded reclaim would block every request
   * in flight for however long a large freelist takes to drain. Bounding it is what makes it safe to
   * call automatically between watch-loop ticks (see {@link SelfHostIndexer.runIncrementalVacuum})
   * rather than only from the explicit `abx vacuum convert` command above.
   *
   * A no-op (returns 0, touches nothing) before the store has been converted to `'incremental'` mode
   * — `incremental_vacuum` only does anything in that mode, and running it blind on a `'none'` store
   * would be silent maintenance with no effect, which is worse than an honest no-op.
   *
   * Returns the number of pages actually REQUESTED of SQLite this call (capped by the freelist's
   * current size), not a guarantee it moved exactly that many — draining an already-small freelist
   * legitimately returns fewer than `maxPages`.
   */
  runIncrementalVacuum(maxPages: number): number {
    if (this.autoVacuumMode() !== 'incremental') return 0;
    const {freelist_count: freelistPages} = this.db.prepare(`PRAGMA freelist_count`).get() as {freelist_count: number};
    if (freelistPages <= 0) return 0;
    const n = Math.min(maxPages, freelistPages);
    if (n <= 0) return 0;
    // PRAGMA statements don't take bound parameters — `n` is computed internally above (never
    // user input), so inlining it is safe.
    this.db.exec(`PRAGMA incremental_vacuum(${n})`);
    return n;
  }

  /**
   * Drop one project's projection — `extensions` / `tokens` / `projects` — but deliberately NOT
   * `events`. The event log is append-only and chain-derived (`seq` is `(block << 32) | logIndex`,
   * so a re-fold always lands on the same rows): a re-index after this re-derives the identical
   * event set from chain and re-inserts it as a no-op (`ON CONFLICT DO NOTHING`), so nothing is lost
   * by leaving the rows in place, and `abx demo`'s "drop + replay" proof doesn't depend on the log
   * being gone. `deregister`/forget-the-project-entirely paths delete events explicitly — this
   * helper is for `dropProjection`, which keeps the registration precisely so the next reindex can
   * rebuild from it.
   */
  private deleteProjection(key: string): void {
    for (const table of ['extensions', 'tokens', 'projects']) {
      this.db.prepare(`DELETE FROM ${table} WHERE ${table === 'projects' ? 'address' : 'project_address'} = ?`).run(key);
    }
  }

  private hydrate(p: ProjectRow): ProjectState {
    const key = p.address;

    const tokens: TokenState[] = (
      this.db.prepare(`SELECT * FROM tokens WHERE project_address = ? ORDER BY CAST(token_id AS INTEGER)`).all(key) as unknown as TokenRow[]
    ).map((t) => ({
      tokenId: t.token_id,
      // A row written before the burn fold landed carries no lifecycle; treat the projection as
      // stale rather than inventing a state — a re-index rewrites it from the log.
      lifecycle: (t.lifecycle as TokenState['lifecycle']) ?? 'unminted',
      owner: (t.owner as Address) ?? null,
      tokenURI: t.token_uri ?? null,
      fields: (JSON.parse(t.fields ?? '[]') as MetadataField[]),
      lockedFields: (JSON.parse(t.locked_fields ?? '[]') as string[]),
      ...(t.params ? {params: JSON.parse(t.params) as TokenState['params']} : {}),
      // editions only — NULL stays absent (never fabricated as '0'/'{}'), mirroring `params` above.
      ...(t.supply !== null && t.supply !== undefined ? {supply: t.supply} : {}),
      ...(t.max_supply !== null && t.max_supply !== undefined ? {maxSupply: t.max_supply} : {}),
      ...(t.max_supply_overridden !== null && t.max_supply_overridden !== undefined
        ? {maxSupplyOverridden: !!t.max_supply_overridden}
        : {}),
      ...(t.holders ? {holders: JSON.parse(t.holders) as TokenState['holders']} : {}),
    }));

    const extensions: ExtensionInfo[] = (
      this.db.prepare(`SELECT * FROM extensions WHERE project_address = ? ORDER BY name`).all(key) as unknown as ExtensionRow[]
    ).map((e) => ({id: e.id as Hex, name: e.name, version: e.version}));

    // Explicit column list — deliberately excludes `seq`. `seq` can exceed
    // `Number.MAX_SAFE_INTEGER` (see {@link eventSeq}), and this driver throws a RangeError
    // materializing an INTEGER that large as a plain JS number unless the statement opts into
    // `setReadBigInts(true)`. `ORDER BY seq` still sorts correctly with the column left out of the
    // SELECT list — SQLite orders before projecting — and nothing downstream needs the raw value:
    // `SpineEvent` orders itself by `(blockNumber, logIndex)` (see `byOrder` in the SDK), not by seq.
    const events: SpineEvent[] = (
      this.db
        .prepare(`SELECT name, register, what, block_number, log_index, tx_hash, args FROM events WHERE project_address = ? ORDER BY seq`)
        .all(key) as unknown as EventRow[]
    ).map((e) => ({
      name: e.name,
      register: e.register as 1 | 2,
      what: e.what,
      blockNumber: e.block_number,
      logIndex: e.log_index,
      txHash: e.tx_hash as Hex,
      args: JSON.parse(e.args) as Record<string, string>,
    }));

    return {
      address: p.address_original as Address,
      chainId: p.chain_id,
      abxVersion: p.abx_version,
      deployBlock: p.deploy_block,
      deployTx: (p.deploy_tx as Hex) ?? null,
      factory: (p.factory as Address) ?? null,
      implementation: (p.implementation as Address) ?? null,
      isCanonical: p.is_canonical === null ? null : !!p.is_canonical,
      name: p.name,
      symbol: p.symbol,
      owner: (p.owner as Address) ?? null,
      contractURI: p.contract_uri,
      tokenURIRenderer: (p.token_uri_renderer as Address) ?? null,
      tokenURILocked: p.token_uri_locked === null ? null : !!p.token_uri_locked,
      contractURIRenderer: (p.contract_uri_renderer as Address) ?? null,
      contractURILocked: p.contract_uri_locked === null ? null : !!p.contract_uri_locked,
      royalty: p.royalty_receiver ? {receiver: p.royalty_receiver as Address, bps: p.royalty_bps ?? 0} : null,
      collectionFields: (JSON.parse(p.collection_fields ?? '[]') as MetadataField[]),
      lockedCollectionFields: (JSON.parse(p.locked_collection_fields ?? '[]') as string[]),
      contractType: (p.contract_type as ProjectState['contractType'] | null) ?? undefined,
      maxInvocations: p.max_invocations ?? null,
      defaultMaxSupply: p.default_max_supply ?? null,
      minter: (p.minter as Address) ?? null,
      paused: !!p.paused,
      primaryPayee: (p.primary_payee as Address) ?? null,
      ...hydrateCodeState(p.code_state),
      extensions,
      tokens,
      events,
      fromBlock: p.from_block,
      toBlock: p.to_block,
      eventCount: p.event_count,
      reconstructedAt: p.reconstructed_at,
      rpcUrl: p.rpc_url ?? undefined,
    };
  }
}

// ── row shapes (SQLite returns null-prototype objects keyed by column) ────────
interface ProjectRow {
  address: string;
  address_original: string;
  chain_id: number;
  abx_version: number | null;
  deploy_block: string | null;
  deploy_tx: string | null;
  factory: string | null;
  implementation: string | null;
  is_canonical: number | null;
  name: string | null;
  symbol: string | null;
  owner: string | null;
  contract_uri: string | null;
  token_uri_renderer: string | null;
  token_uri_locked: number | null;
  contract_uri_renderer: string | null;
  contract_uri_locked: number | null;
  royalty_receiver: string | null;
  royalty_bps: number | null;
  collection_fields: string | null;
  locked_collection_fields: string | null;
  contract_type: string | null;
  max_invocations: string | null;
  default_max_supply: string | null;
  minter: string | null;
  paused: number | null;
  primary_payee: string | null;
  code_state: string | null;
  from_block: string;
  to_block: string;
  event_count: number;
  reconstructed_at: string;
  rpc_url: string | null;
}
interface TokenRow {
  token_id: string;
  lifecycle: TokenState['lifecycle'] | null;
  owner: string | null;
  token_uri: string | null;
  fields: string | null;
  locked_fields: string | null;
  params: string | null;
  supply: string | null;
  max_supply: string | null;
  max_supply_overridden: number | null;
  holders: string | null;
}

/** Spread the code-project JSON column back into its ProjectState fields (see putProject). */
function hydrateCodeState(
  json: string | null,
): Pick<
  ProjectState,
  | 'contractParams'
  | 'paramSchemas'
  | 'paramHooks'
  | 'delegateRegistry'
  | 'seedSource'
  | 'script'
  | 'dependencies'
> {
  if (!json) {
    return {
      paramHooks: null,
      delegateRegistry: null,
      seedSource: null,
      script: null,
      dependencies: null,
    };
  }
  const c = JSON.parse(json) as Record<string, unknown>;
  return {
    contractParams: (c.contractParams as ProjectState['contractParams']) ?? undefined,
    paramSchemas: (c.paramSchemas as ProjectState['paramSchemas']) ?? undefined,
    paramHooks: (c.paramHooks as ProjectState['paramHooks']) ?? null,
    delegateRegistry: (c.delegateRegistry as ProjectState['delegateRegistry']) ?? null,
    seedSource: (c.seedSource as ProjectState['seedSource']) ?? null,
    script: (c.script as ProjectState['script']) ?? null,
    dependencies: (c.dependencies as ProjectState['dependencies']) ?? null,
  };
}
interface CommitmentRow {
  token_id: string;
  kind: string;
  kind_raw: string;
  value: string;
  locked: number;
}
interface ExtensionRow {
  id: string;
  name: string;
  version: number;
}
interface EventRow {
  name: string;
  register: number;
  what: string;
  block_number: string;
  log_index: number;
  tx_hash: string;
  args: string;
}

interface ArtifactDbRow {
  key: string;
  address: string;
  token_id: string;
  effect_key: string;
  output_key: string;
  inputs_hash: string;
  locator: string | null;
  content_type: string | null;
  bytes: Uint8Array | null;
  updated_at: string;
}

function rowToArtifact(row: ArtifactDbRow): EffectArtifactRow {
  return {
    key: row.key,
    address: row.address,
    tokenId: row.token_id,
    effectKey: row.effect_key,
    outputKey: row.output_key,
    inputsHash: row.inputs_hash,
    contentType: row.content_type ?? null,
    locator: row.locator ?? null,
    bytes: row.bytes ?? null,
    updatedAt: row.updated_at,
  };
}

function rowToIndexStatus(row: Record<string, unknown>): IndexStatusRow {
  return {
    address: row.address as string,
    status: row.status as IndexStatus,
    errorClass: (row.error_class as IndexErrorClass | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    attempts: (row.attempts as number | null) ?? 0,
    lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
    lastIndexedAt: (row.last_indexed_at as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

function rowToRegistration(row: unknown): ProjectRegistration {
  const r = row as {
    address: string;
    chain_key: string;
    from_block: string;
    factory: string | null;
    label: string | null;
    description: string | null;
    external_url: string | null;
    attributes: string | null;
    token_attributes: string | null;
    content_locators: string | null;
    registered_at: string;
  };
  return {
    address: r.address,
    chainKey: r.chain_key,
    fromBlock: r.from_block,
    factory: r.factory,
    label: r.label ?? undefined,
    description: r.description ?? undefined,
    externalUrl: r.external_url ?? undefined,
    attributes: r.attributes ?? undefined,
    tokenAttributes: r.token_attributes ?? undefined,
    contentLocators: r.content_locators ?? undefined,
    registeredAt: r.registered_at,
  };
}
