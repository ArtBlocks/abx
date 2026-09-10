/**
 * The remote-service client — the SDK's one HTTP surface, speaking the provider-neutral
 * control plane pinned by site/content/docs/using-abx/remote-services.mdx. A client is bound to an
 * endpoint + an injected bearer token, never to a brand: the reference CLI, the effects runner,
 * and any hosted agent drive a self-hosted node and a managed provider through this same class.
 *
 * The token authorizes index/metadata control only — never on-chain signing. No env reads here;
 * credential resolution is the caller's concern (the CLI's named-remote convention lives in
 * packages/cli/src/remote.ts).
 */

import type {Hex} from 'viem';
import type {OpenSeaAttribute} from './traits.js';
import type {ContractGenerationSummary} from './contract-generations.js';
import {linearBackoffDelay, sleep} from './util.js';

export const WELL_KNOWN_SERVICE_PATH = '/.well-known/abx-service';

/**
 * Versioned interface ids a service declares in its descriptor. Versions ride these ids
 * (they track the `/v1` path prefix); the descriptor has no separate format version.
 *
 * There are three optional interface families, and they are **all-or-nothing**: declaring one asserts every route it names
 * answers per the spec. The artifact-registry routes ride {@link CONTROL_PLANE_INTERFACE} rather
 * than an id of their own — once referenced output is locator-only, accepting a registration is a
 * database insert, so a separate capability flag would describe a distinction that doesn't exist.
 * A service that won't take a given caller's artifacts refuses on the credential (`403`), which is
 * the honest axis: interfaces describe wire grammar, tokens describe permission.
 */
export const TOKEN_API_INTERFACE = 'abx-token-api/v1';
export const CONTROL_PLANE_INTERFACE = 'abx-control-plane/v1';
/** Provider-specific feedback discovery, submission, and account history at `/feedback`. Core ABX
 *  feedback is deliberately not this interface: it belongs to the ABX team, not a remote provider. */
export const SERVICE_FEEDBACK_INTERFACE = 'abx-service-feedback/v1';

/**
 * Why this locator can't be accepted for a referenced artifact, or `null` if it passes.
 *
 * A locator is a **reachability** claim, not a durability one: it must resolve for a third party
 * with no producer credentials and no private-network assumption. The protocol deliberately has
 * **no preference among schemes** — `https://` (S3/R2, a producer's own public base, a chosen
 * IPFS/Arweave gateway), `ipfs://` and `ar://` are peers, because derived output is re-creatable and
 * a producer with an opinion about which gateway serves its content is making an operational call the
 * protocol has no standing to override.
 *
 * Reachability can't be *proved* without fetching, and fetching a third-party URL while handling an
 * authed write is byte custody through the back door plus an SSRF surface. So this checks the two
 * things that are decidable from the string alone and are always wrong:
 *   - a private / loopback host — resolvable only from the producer's own network;
 *   - a presigned, expiring URL — resolvable now, dead later, which is the worst failure shape
 *     (it passes every check at publish time and rots silently).
 */
export function locatorRejectionReason(locator: string): string | null {
  const trimmed = locator.trim();
  if (!/^(https?|ipfs|ar):/i.test(trimmed)) {
    return `unsupported scheme — use https://, ipfs:// or ar://`;
  }
  if (/^https?:/i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return 'not a parseable URL';
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateHost =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^f[cd][0-9a-f]{2}:/.test(host);
    if (privateHost) {
      return `'${url.hostname}' is a loopback/private host — a locator must resolve for anyone, not just from the producer's network`;
    }
    const q = url.searchParams;
    if (q.has('X-Amz-Signature') || q.has('Signature') || q.has('X-Goog-Signature') || q.has('sig') || q.has('Expires') || q.has('X-Amz-Expires')) {
      return 'looks like a presigned/expiring URL — it would resolve now and rot later; publish a durable public URL instead';
    }
  }
  return null;
}

/**
 * The indexing lifecycle a registration moves through, closed and provider-neutral
 * (site/content/docs/using-abx/remote-services.mdx → The indexing lifecycle). One vocabulary for a
 * managed provider and for your own node — the reference resolver stamps these too.
 *
 *   queued       registered + accepted; catch-up hasn't started
 *   backfilling  actively catching up (initial sync or a forced replay); may already serve partial state
 *   live         caught up to head; tracking head incrementally
 *   stale        was live, now lagging (watcher behind, or transient RPC trouble) — still serving
 *   failed       catch-up errored; carries `error`; will be retried
 *
 * Observability, never a source of truth: token resolution never consults it, and a project
 * reconstructs from chain regardless.
 */
export type IndexStatus = 'queued' | 'backfilling' | 'live' | 'stale' | 'failed';

/** Statuses a caller can stop waiting on — see {@link AbxServiceClient.awaitIndexed}. */
export const TERMINAL_INDEX_STATUSES: readonly IndexStatus[] = ['live', 'failed'];

/**
 * Why catch-up failed, as a closed machine class — never free-form prose the client must parse.
 * Deliberately NOT extended with a reorg class: the protocol defines no reorg detection (the repair
 * is the deterministic full replay), so no implementation could emit one honestly.
 */
export type IndexErrorClass =
  /** The RPC didn't answer (down, timing out, network). Retryable — nothing is wrong with the add. */
  | 'rpc_unavailable'
  /** The RPC answered "too many requests". Retryable, slower — the usual cause of a long backfill. */
  | 'rpc_rate_limited'
  /** The address doesn't look like an ABX contract on this chain. NOT emitted by the reference
   *  (it indexes what its operator tells it); a provider that validates clone-ness SHOULD refuse
   *  synchronously at register instead of accepting and failing here. */
  | 'not_abx_contract'
  /** Anything else. Carries no detail — the service logs the cause. */
  | 'internal';

/** A catch-up failure as it crosses the wire: a machine class plus a short, CREDENTIAL-FREE hint.
 *  Messages come from a closed set (see {@link classifyIndexError}) rather than from a scrubber, so
 *  "no RPC URL can leak through here" is checkable by reading the code. */
export interface IndexError {
  class: IndexErrorClass;
  message?: string;
}

/** The one message per class. Fixed strings — an upstream error is never interpolated, because a
 *  keyed RPC URL *is* a credential and upstream messages routinely embed one. */
const INDEX_ERROR_MESSAGES: Record<IndexErrorClass, string> = {
  rpc_unavailable: 'upstream RPC unavailable; will retry',
  rpc_rate_limited: 'upstream RPC rate-limited; will retry',
  not_abx_contract: 'address emits no ABX event spine on this chain',
  internal: 'indexing failed; see the service operator’s logs',
};

/** Map a catch-up failure to its wire form. Sniffs the underlying error's shape only to CHOOSE a
 *  class — nothing from it reaches the returned message. */
export function classifyIndexError(err: unknown): IndexError {
  const raw = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  const text = raw.toLowerCase();
  let cls: IndexErrorClass = 'internal';
  if (/rate.?limit|too many requests|\b429\b|quota|exceeded .*(?:compute|cu)|throttl/.test(text)) {
    cls = 'rpc_rate_limited';
  } else if (
    /timeout|timed out|econnrefused|econnreset|enotfound|eai_again|socket hang up|fetch failed|network|502|503|504|http request failed/.test(
      text,
    )
  ) {
    cls = 'rpc_unavailable';
  }
  return {class: cls, message: INDEX_ERROR_MESSAGES[cls]};
}

/** Machine error codes every conforming service uses — clients key off these, never off prose. */
export type ServiceErrorCode =
  | 'invalid_request'
  | 'unsupported_chain'
  | 'unauthorized'
  | 'forbidden'
  | 'not_registered'
  | 'disabled'
  /** The report belongs at a different feedback target; the response carries its canonical URL. */
  | 'feedback_target_moved'
  /** 404 — this node serves no route at that path AT ALL (as opposed to a known route whose shape
   *  was wrong, which is a 400 `invalid_request` carrying the correct template). The pair exists so
   *  a client can tell "I built the wrong URL" from "this project isn't indexed here" from "this
   *  node is older than the route I want" — a bare 404 conflates all three and reads as an outage. */
  | 'unknown_route'
  /**
   * **410** — this token id existed and is permanently gone (an ERC-721 burn). A statement about the
   * TOKEN, which is why `not_registered` could not carry it: that one is a statement about the
   * *contract* ("this node doesn't index it"), so it cannot truthfully describe a destroyed id.
   *
   * `410`, not `404`, and the rule generalizes: **a resolver answers what the contract's own URI
   * getter answers.** A burned 721's `tokenURI` reverts `NonexistentToken`, so composing metadata
   * for it would put a node in direct contradiction with the contract it speaks for — while `404`
   * reads as "wrong URL / not indexed yet" and invites a retry that can never succeed. It is worse
   * than cosmetic on the image route, which answers an unknown-but-in-cap id with a warming
   * placeholder: for a destroyed id that says "still loading" forever.
   *
   * **ERC-1155 editions never answer this.** `uri(id)` has no existence gate there, a zero-supply id
   * still resolves, and it can mint again — nothing is permanently gone, so `410` would be a lie.
   * Serve the document with `supply: 0`.
   */
  | 'burned'
  /** 500 — an unexpected server-side failure. Never carries internal detail (it could embed the
   *  operator's own credentials); the node logs the cause. Retryable. */
  | 'internal_error';

/** `GET /.well-known/abx-service` — what a service supports, agent-readably. */
export interface ServiceDescriptor {
  /** Display name + implementation version, for humans and directories — never dispatch. */
  service?: {name?: string; version?: string};
  /** The load-bearing declaration: which interface families this endpoint serves. */
  interfaces: string[];
  /** EIP-155 chain ids served; the control plane rejects others with `unsupported_chain`. */
  chains: number[];
  /** Contract generations this implementation understands, with operation-specific policy. */
  contractGenerations?: ContractGenerationSummary[];
  /** Present iff the control plane is enabled. `signupUrl` is provider-specific human
   * onboarding/recovery and `docsUrl` is provider documentation; OAuth discovery is separate. */
  auth?: {scheme: 'bearer'; signupUrl?: string; docsUrl?: string};
  /** Present when rendering runs behind this service (the resolver fronts its runner).
   *  `effects: null` = attached but unverified (the health probe didn't answer). */
  render?: {attached: boolean; effects: Array<{key: string; outputs: Array<{key: string; mimeType: string}>}> | null};
  /** The public base this node believes it serves — a sanity echo for misconfig detection. */
  baseUrl?: string;
}

export const FEEDBACK_KINDS = ['bug', 'friction', 'gap', 'confusion', 'praise', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];
export const ABX_FEEDBACK_AREAS = ['protocol', 'contracts', 'cli', 'sdk', 'skills', 'docs', 'other'] as const;
export type AbxFeedbackArea = (typeof ABX_FEEDBACK_AREAS)[number];

/** Optional evidence carried with a report. Providers may accept extra keys; credentials and
 *  private source never belong here. */
export interface FeedbackContext {
  command?: string;
  chainId?: number;
  address?: string;
  txHashes?: string[];
  addresses?: string[];
  cliVersion?: string;
  sdkVersion?: string;
  skill?: string;
  sessionId?: string;
  serviceUrl?: string;
  [key: string]: unknown;
}

export interface FeedbackFields {
  kind: FeedbackKind;
  summary: string;
  detail?: string;
  severity?: FeedbackSeverity;
  via?: 'agent' | 'human';
  context?: FeedbackContext;
}

export interface AbxFeedbackReport extends FeedbackFields {
  area: AbxFeedbackArea;
}

export interface ServiceFeedbackReport extends FeedbackFields {
  /** Provider-defined component name; omit when uncertain. */
  component?: string;
}

export type FeedbackReport = AbxFeedbackReport | ServiceFeedbackReport;

export interface FeedbackRecord extends FeedbackFields {
  id: string;
  target?: 'abx' | 'service';
  tenantId?: string | null;
  area?: string;
  component?: string;
  createdAt: string;
  processedAt?: string | null;
}

export interface FeedbackListFilters {
  area?: string;
  component?: string;
  kind?: FeedbackKind;
  limit?: number;
}

/** The server is authoritative for its current schema; clients keep this extensible. */
export interface FeedbackInstructions {
  target?: string;
  what?: string;
  authentication?: string;
  yourReports?: string;
  fields?: Record<string, unknown>;
  guidance?: string[];
  example?: unknown;
  [key: string]: unknown;
}

/** `POST /v1/projects` — the off-chain bridge: everything the host can't derive from chain. */
export interface RegisterProjectBody {
  chainId: number;
  address: string;
  /** Scan floor — the deploy block. Omit on a re-POST (the nudge) to keep the stored floor + reindex incrementally. */
  fromBlock?: string;
  factory?: string;
  label?: string;
  description?: string;
  externalUrl?: string;
  /** Off-chain operator traits (OpenSea attribute array) — stitched UNDER any on-chain `attributes`. */
  attributes?: OpenSeaAttribute[];
  /** Off-chain PER-TOKEN operator traits, `{ "<tokenId>": OpenSeaAttribute[] }` — a Series' editable
   *  traits (a token's entry wins over the collection-scope `attributes`; on-chain wins over both). */
  tokenAttributes?: Record<string, OpenSeaAttribute[]>;
  /** Durable locators keyed by on-chain hash, `{ "0x<keccak>": "ipfs://<cid>" }` — lets the resolver
   *  point `image` at IPFS/Arweave without holding the bytes. Merged over any already stored. */
  contentLocators?: Record<string, string>;
  /** Force a full replay even on a re-POST. */
  full?: boolean;
}

/** `200` — catch-up finished inside the request; the counts are facts. */
export interface RegisterProjectSummary {
  ok: boolean;
  /** Discriminator. Normalized from the HTTP status by {@link AbxServiceClient.registerProject}. */
  accepted: false;
  mode: 'full' | 'incremental';
  elapsedMs: number;
  project: {
    address: string;
    name: string | null;
    eventCount: number;
    tokenCount: number;
    mintedCount: number;
    /** Official generation, once the indexed factory and on-chain core version agree. */
    contractGeneration?: ContractGenerationSummary;
    /** Sum of every token's current supply — ERC-1155 editions only; absent for a 721 project. */
    copies?: string;
    status?: IndexStatus;
  };
}

/** `202` — the registration is durable and catch-up is deferred; there are no counts yet. Poll
 *  {@link AbxServiceClient.projectStatus} (or {@link AbxServiceClient.awaitIndexed}) for progress. */
export interface RegisterProjectAccepted {
  ok: boolean;
  accepted: true;
  project: {address: string; name?: string | null; status: IndexStatus};
}

/**
 * `POST /v1/projects` answers in one of two shapes and **the HTTP status code is the discriminator**
 * (200 = done, 202 = accepted). Both are conformant; a client MUST handle both, which is why this is
 * a union rather than a shape with everything optional. Narrow with {@link isAccepted}.
 */
export type RegisterProjectResult = RegisterProjectSummary | RegisterProjectAccepted;

/** Narrow a register response to the deferred-catch-up branch. */
export function isAccepted(r: RegisterProjectResult): r is RegisterProjectAccepted {
  return r.accepted === true;
}

/** One row of `GET /v1/projects` — the projects visible to this token. */
export interface RemoteProjectSummary {
  chainId: number;
  address: string;
  label?: string | null;
  name?: string | null;
  eventCount?: number;
  tokenCount?: number;
  mintedCount?: number;
  /** Official generation, once the indexed factory and on-chain core version agree. */
  contractGeneration?: ContractGenerationSummary;
  /** Sum of every token's current supply — ERC-1155 editions only; absent for a 721 project. */
  copies?: string;
  reconstructedAt?: string | null;
  /** Where this project is in the indexing lifecycle — so a list renders "3 live, 1 backfilling,
   *  1 failed" with no per-project round trip. */
  status?: IndexStatus;
  /** Present on `stale`/`failed` — the class only; the full hint lives on the status route. */
  error?: {class: IndexErrorClass};
}

/** `GET /v1/projects/{chainId}/{address}/status` — indexing freshness + lifecycle. */
export interface RemoteProjectStatus {
  chainId: number;
  address: string;
  /** Where this project is in the lifecycle. */
  status: IndexStatus;
  fromBlock: string;
  toBlock: string | null;
  /** Chain head as the service last saw it — so a client computes lag / % complete without knowing
   *  anything about the service's watcher. `null` when the service can't say. */
  headBlock?: string | null;
  eventCount: number;
  tokenCount: number;
  mintedCount: number;
  /** Official generation, once the indexed factory and on-chain core version agree. */
  contractGeneration?: ContractGenerationSummary;
  /** Sum of every token's current supply — ERC-1155 editions only; absent for a 721 project. */
  copies?: string;
  reconstructedAt: string | null;
  /** Present on `stale`/`failed`. Credential-free by contract. */
  error?: IndexError;
  /** Catch-up attempts since the last success. */
  attempts?: number;
  watcher?: {watching: boolean; pollAt: string | null; head: string | null; intervalMs?: number};
}

/**
 * How far along a BACKFILL is, from a status read — `null` when there is no meaningful ratio.
 *
 * Deliberately `null` for anything but `backfilling`, because `toBlock` measures two different things
 * depending on the state. During an initial sync it advances monotonically, so `toBlock` vs head IS
 * progress. Once a project is `live` it only moves when that project has *events* — so a perfectly
 * current project on a busy chain sits at a tiny fraction of head, and rendering that as "3%" reads
 * as broken when nothing is wrong. Same reason the reference measures staleness against its watcher's
 * watermark rather than a project's `toBlock`.
 */
export function indexProgress(s: RemoteProjectStatus): {done: bigint; total: bigint; percent: number} | null {
  if (s.status !== 'backfilling') return null;
  if (!s.headBlock || !s.toBlock) return null;
  try {
    const from = BigInt(s.fromBlock);
    const to = BigInt(s.toBlock);
    const head = BigInt(s.headBlock);
    if (head <= from || to < from) return null;
    const total = head - from;
    const done = (to > head ? head : to) - from;
    return {done, total, percent: Number((done * 100n) / total)};
  } catch {
    return null;
  }
}

/** `POST /v1/effect-artifacts` — a render producer publishes one output (locator or bytes). */
export interface PublishEffectArtifactBody {
  chainId: number;
  address: string;
  tokenId: string;
  /** The hash of the inputs this render depicts — the service never re-addresses to current state. */
  inputsHash: Hex;
  output?: string;
  effectKey?: string;
  contentType?: string;
  /**
   * REFERENCED outputs (`render/image`, a video, a model — anything the service doesn't stitch):
   * an `https://` / `ipfs://` / `ar://` pointer, reachable without the producer's credentials. The
   * service records it and 302-redirects; it never fetches or proxies the bytes. Required for this
   * class — sending {@link bytes_base64} instead is a `400`.
   */
  locator?: string;
  /**
   * BOUND outputs only (`render/traits` — content that stitches into the metadata JSON): the raw
   * output, ≤{@link BOUND_ARTIFACT_MAX_BYTES}, held by the service beside the artifact row. Sending
   * a {@link locator} for a bound output is a `400` — the content is assembled into `tokenURI`, so a
   * pointer there would be recorded and then never stitch.
   */
  bytes_base64?: string;
}

/** `POST /v1/effect-status` — a producer reports one run's transient state. */
export interface ReportEffectStatusBody {
  chainId: number;
  key: Hex;
  address: string;
  tokenId: string;
  effectKey: string;
  status: 'rendering' | 'failed' | 'done';
  error?: string;
  attempts?: number;
}

/** A non-2xx control-plane response (or an unreachable service, after retries). `code` is the
 *  spec's machine code when the service sent one — key behavior off it, never off `message`. */
export class AbxServiceError extends Error {
  readonly status: number;
  readonly code?: ServiceErrorCode;
  readonly url: string;
  /** The failure CLASS when the service volunteered one (a credential-free hint about *why* — an
   *  exhausted RPC reads very differently from a broken service). Optional on the wire. */
  readonly class?: IndexErrorClass;

  constructor(message: string, opts: {status: number; code?: ServiceErrorCode; url: string; class?: IndexErrorClass}) {
    super(message);
    this.name = 'AbxServiceError';
    this.status = opts.status;
    this.code = opts.code;
    this.url = opts.url;
    this.class = opts.class;
  }
}

/** Waiting for a project to reach a terminal status ran out of time. The registration is durable —
 *  this is "still working", never "the add failed". */
export class AbxIndexTimeoutError extends Error {
  readonly last?: RemoteProjectStatus;
  constructor(message: string, last?: RemoteProjectStatus) {
    super(message);
    this.name = 'AbxIndexTimeoutError';
    this.last = last;
  }
}

export interface AwaitIndexedOptions {
  /** Give up after this long (default 5 min). The registration stays durable regardless. */
  timeoutMs?: number;
  /** Poll cadence (default 3s). */
  intervalMs?: number;
  /** Called on every poll — drive a progress line from it. */
  onProgress?: (status: RemoteProjectStatus) => void;
}

export interface ServiceClientOptions {
  baseUrl: string;
  /** Bearer token for the control plane. Omit for descriptor-only use. */
  token?: string;
  /** Per-attempt timeout. A hung provider must not hang the caller. */
  timeoutMs?: number;
  /** Backoff unit between retries (`delay = retryDelayMs × attempt`). Tests shrink it. */
  retryDelayMs?: number;
}

/**
 * Retry discipline (shared with the effects runner's read lane): a hosted node can cold-start or
 * briefly 502, so network errors / 5xx / 429 get 4 attempts with linear backoff — but a genuine
 * 4xx is an answer, not weather, and throws immediately with the parsed `{error, code}` body.
 */
const ATTEMPTS = 4;

/** The descriptor is a cheap PUBLIC read used to decide whether a URL is even a service — usually
 *  interactively, often against a typo. Grinding the full ladder there just makes a wrong URL take
 *  five seconds to say so, so it gets one retry for a blip and no more. */
const DESCRIPTOR_ATTEMPTS = 2;

export class AbxServiceClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(opts: ServiceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retryDelayMs = opts.retryDelayMs ?? 750;
  }

  /** The public service descriptor — no auth, safe to fetch before trusting a provider. */
  async descriptor(): Promise<ServiceDescriptor> {
    return (await this.request('GET', WELL_KNOWN_SERVICE_PATH, undefined, {
      attempts: DESCRIPTOR_ATTEMPTS,
      authenticated: false,
    })) as ServiceDescriptor;
  }

  /** Public, machine-readable provider feedback instructions (`abx-service-feedback/v1`). */
  async feedbackInstructions(): Promise<FeedbackInstructions> {
    return (await this.request('GET', '/feedback', undefined, {
      attempts: DESCRIPTOR_ATTEMPTS,
      authenticated: false,
    })) as FeedbackInstructions;
  }

  /** File one report. Callers own the human-consent boundary before invoking this write. */
  async submitFeedback(report: FeedbackReport): Promise<{ok: boolean; id: string; createdAt: string}> {
    return (await this.request('POST', '/feedback', report)) as {ok: boolean; id: string; createdAt: string};
  }

  /** Reports visible to this credential at this target. */
  async listFeedback(filters: FeedbackListFilters = {}): Promise<FeedbackRecord[]> {
    const query = new URLSearchParams();
    if (filters.area) query.set('area', filters.area);
    if (filters.component) query.set('component', filters.component);
    if (filters.kind) query.set('kind', filters.kind);
    if (filters.limit !== undefined) query.set('limit', String(filters.limit));
    const suffix = query.size ? `?${query}` : '';
    const out = (await this.request('GET', `/feedback/mine${suffix}`)) as {feedback?: FeedbackRecord[]};
    return out.feedback ?? [];
  }

  /**
   * Register + index a project (the HTTP form of `abx add`; a re-POST is the nudge). Returns the
   * completed summary (HTTP 200) or the accepted-and-still-working shape (HTTP 202) — narrow with
   * {@link isAccepted}, and follow a 202 with {@link awaitIndexed}.
   *
   * A timed-out register is NOT retried blind. A conforming service persists the registration before
   * it starts catching up, so a timeout usually means "it's in there, still working" — and re-POSTing
   * would kick off a *second* full reconstruct against the RPC that was already too slow to answer.
   * So we ask the status route whether it landed, and if it did we return the async shape instead.
   */
  async registerProject(body: RegisterProjectBody): Promise<RegisterProjectResult> {
    const landed = async (): Promise<RegisterProjectResult | undefined> => {
      const st = await this.projectStatus(body.chainId, body.address).catch(() => null);
      if (!st) return undefined; // not there (or the service is truly unreachable) — keep retrying
      return {ok: true, accepted: true, project: {address: body.address, status: st.status}};
    };
    const {status, body: out} = await this.requestWithStatus('POST', '/v1/projects', body, {onTimeout: landed});
    return normalizeRegisterResult(status, out, body.address);
  }

  /**
   * Poll a project's status until it reaches a terminal lifecycle state (`live` or `failed`) — the
   * one implementation of the wait loop, so the CLI, the effects runner, and any hosted agent all
   * behave identically against any provider. `stale` keeps polling: it means lagging, not caught up.
   */
  async awaitIndexed(chainId: number, address: string, opts: AwaitIndexedOptions = {}): Promise<RemoteProjectStatus> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const intervalMs = opts.intervalMs ?? 3_000;
    const deadline = Date.now() + timeoutMs;
    let last: RemoteProjectStatus | undefined;
    for (;;) {
      last = await this.projectStatus(chainId, address);
      opts.onProgress?.(last);
      if (TERMINAL_INDEX_STATUSES.includes(last.status)) return last;
      if (Date.now() + intervalMs > deadline) {
        throw new AbxIndexTimeoutError(
          `${address} was still '${last.status}' after ${Math.round(timeoutMs / 1000)}s — the registration is durable and the service keeps working; check back with \`abx status ${address} --remote\``,
          last,
        );
      }
      await sleep(intervalMs);
    }
  }

  /** The projects this token may see. */
  async listProjects(): Promise<RemoteProjectSummary[]> {
    const out = (await this.request('GET', '/v1/projects')) as {projects?: RemoteProjectSummary[]};
    return out.projects ?? [];
  }

  /** Deregister (remote `abx forget`). `not_registered` means "already gone" — reported, not
   *  thrown — but `disabled` still throws: a node that can't accept removals hasn't removed it. */
  async removeProject(chainId: number, address: string): Promise<{removed: boolean}> {
    try {
      await this.request('DELETE', `/v1/projects/${chainId}/${address}`);
      return {removed: true};
    } catch (err) {
      if (err instanceof AbxServiceError && err.code === 'not_registered') return {removed: false};
      throw err;
    }
  }

  /** Nudge a re-index. Answers in the same two shapes as {@link registerProject} — a full replay is
   *  the *most* likely call to outlive one HTTP request. */
  async reindexProject(chainId: number, address: string): Promise<RegisterProjectResult> {
    const {status, body} = await this.requestWithStatus('POST', `/v1/projects/${chainId}/${address}/reindex`, undefined, {
      onTimeout: async () => {
        const st = await this.projectStatus(chainId, address).catch(() => null);
        return st ? {ok: true, accepted: true, project: {address, status: st.status}} : undefined;
      },
    });
    return normalizeRegisterResult(status, body, address);
  }

  /** Indexing freshness for one project. */
  async projectStatus(chainId: number, address: string): Promise<RemoteProjectStatus> {
    return (await this.request('GET', `/v1/projects/${chainId}/${address}/status`)) as RemoteProjectStatus;
  }

  /** Publish a render output so a resolver that doesn't share the producer's disk can serve it. */
  async publishEffectArtifact(body: PublishEffectArtifactBody): Promise<{ok: boolean; mode: 'locator' | 'bytes'; key: Hex}> {
    return (await this.request('POST', '/v1/effect-artifacts', body)) as {ok: boolean; mode: 'locator' | 'bytes'; key: Hex};
  }

  /** Report a run's transient state for the artifact key it is producing. */
  async reportEffectStatus(body: ReportEffectStatusBody): Promise<void> {
    await this.request('POST', '/v1/effect-status', body);
  }

  private async request(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<unknown> {
    return (await this.requestWithStatus(method, path, body, opts)).body;
  }

  private async requestWithStatus(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<{status: number; body: unknown}> {
    const attempts = opts?.attempts ?? ATTEMPTS;
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {};
    if (this.token && opts?.authenticated !== false) headers['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let lastFailure = '';
    let lastStatus = 0;
    let lastCode: ServiceErrorCode | undefined;
    let lastClass: IndexErrorClass | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastFailure = (err as Error).message;
        lastStatus = 0;
        // "We waited the full timeout" and "nothing is listening" are different failures, and for a
        // mutating POST the difference decides whether retrying is safe: the request may still be
        // running on the service. Let the caller check before we hammer it again.
        if (opts?.onTimeout && (err as Error).name === 'TimeoutError') {
          const resolved = await opts.onTimeout();
          if (resolved !== undefined) return {status: 202, body: resolved};
        }
        if (attempt < attempts) await sleep(linearBackoffDelay(attempt, this.retryDelayMs));
        continue;
      }
      if (resp.ok) {
        const text = await resp.text();
        return {status: resp.status, body: text ? (JSON.parse(text) as unknown) : {}};
      }
      if (resp.status >= 500 || resp.status === 429) {
        // Retryable — but KEEP the service's own words. A 5xx body carries the actual cause (an
        // exhausted RPC, a misconfigured node); discarding it left the caller with a bare status and
        // nothing to act on, which is the worst kind of error.
        const said = await bodyMessage(resp);
        lastStatus = resp.status;
        lastCode = said.code;
        lastClass = said.class;
        lastFailure = said.error ? `${resp.status} ${said.error}` : `${resp.status} ${resp.statusText}`;
        if (attempt < attempts) await sleep(linearBackoffDelay(attempt, this.retryDelayMs));
        continue;
      }
      // A genuine 4xx is an answer, not weather — surface the service's own words + code.
      const detail = await bodyMessage(resp);
      throw new AbxServiceError(`${method} ${url}: ${resp.status} ${detail.error ?? resp.statusText}`, {
        status: resp.status,
        code: detail.code,
        class: detail.class,
        url,
      });
    }
    // Retries exhausted. Distinguish "nothing answered" from "it answered, badly" — a 500 is not
    // unreachable, and saying so sends the caller looking for a network problem that isn't there.
    const summary = lastStatus
      ? `service failed after ${attempts} attempt(s) — last response ${lastFailure}`
      : `nothing responded after ${attempts} attempt(s) (${lastFailure})`;
    throw new AbxServiceError(`${method} ${url}: ${summary}`, {status: lastStatus, code: lastCode, class: lastClass, url});
  }
}

/** Normalize a register/reindex response: the HTTP status is the authoritative discriminator, and
 *  the `accepted` flag is derived from it so callers switch on one field even against a service that
 *  doesn't send it. */
function normalizeRegisterResult(status: number, out: unknown, fallbackAddress: string): RegisterProjectResult {
  if (status === 202) {
    const r = out as Partial<RegisterProjectAccepted>;
    return {
      ok: r.ok ?? true,
      accepted: true,
      project: {
        address: r.project?.address ?? fallbackAddress,
        name: r.project?.name ?? null,
        status: r.project?.status ?? 'backfilling',
      },
    };
  }
  return {...(out as RegisterProjectSummary), accepted: false};
}

interface RequestOptions {
  attempts?: number;
  /** Public discovery reads must not transmit a credential merely because this client has one. */
  authenticated?: boolean;
  /** Consulted when an attempt hits the per-attempt TIMEOUT (not a connect failure). Return a value
   *  to stop the ladder and hand it back as the response; return undefined to keep retrying. */
  onTimeout?: () => Promise<unknown>;
}

/** The service's own `{error, code, class?}` from a non-2xx body (never throws — a body may be
 *  empty/HTML). `class` is the optional credential-free failure hint. */
async function bodyMessage(resp: Response): Promise<{error?: string; code?: ServiceErrorCode; class?: IndexErrorClass}> {
  try {
    const parsed = (await resp.json()) as {error?: string; code?: string; class?: string};
    return {
      error: parsed.error,
      code: parsed.code as ServiceErrorCode | undefined,
      class: parsed.class as IndexErrorClass | undefined,
    };
  } catch {
    return {};
  }
}
