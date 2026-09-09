/**
 * The /v1 control plane + the service descriptor — the resolver's ONE write surface, speaking the
 * provider-neutral interface pinned by site/content/docs/using-abx/remote-services.mdx. Everything here
 * is index/metadata control (register, list, deregister, reindex, status, artifact registration): the
 * bearer token never signs anything on-chain, so the "no signing key on the host" rule is intact.
 *
 * This module never imports server.ts (one-way dependency), which is why the shared HTTP helpers
 * (sendJson, the bearer guard) live here and the read plane imports them.
 */

import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {
  discoverDeployBlock,
  isBoundOutput,
  locatorRejectionReason,
  normalizeAttributes,
  renderArtifactKey,
  resolveChain,
  BOUND_ARTIFACT_MAX_BYTES,
  CONTROL_PLANE_INTERFACE,
  TOKEN_API_INTERFACE,
  type Address,
  type Hex,
  type IndexErrorClass,
  type IndexStatus,
  type OpenSeaAttribute,
  type ProjectState,
  type ServiceDescriptor,
  type ServiceErrorCode,
} from '@artblocks/abx-sdk';
import type {SelfHostIndexer} from '@artblocks/abx-indexer';
import type {StorageBackend} from '@artblocks/abx-storage';
import {notifyEffects, watchIntervalMs} from './watcher.js';

export interface ControlPlaneContext {
  indexer: SelfHostIndexer;
  storage: StorageBackend;
  /** The chain this node serves — every control-plane call names a chainId and is checked against it. */
  chainId: number;
  /** The chain KEY ('sepolia', …) the indexer registers projects under — the string form of chainId. */
  chainKey: string;
  /** The public base this node believes it serves — echoed in the descriptor. */
  baseUrl: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(body, null, 2));
}

/** Every non-2xx control-plane response: `{error: <human>, code: <machine>}` — clients key off
 *  `code`, never off prose (site/content/docs/using-abx/remote-services.mdx → Errors). */
export function sendError(res: ServerResponse, status: number, code: ServiceErrorCode, message: string, extra?: Record<string, unknown>): void {
  sendJson(res, status, {error: message, code, ...extra});
}

/**
 * How long a register/reindex may hold the HTTP request open before answering `202 backfilling` and
 * finishing in the background. Registration is durable BEFORE catch-up starts, so the deadline only
 * decides who waits — never whether the add survives.
 *
 * The default keeps the common case synchronous (a fresh deploy is a few-hundred-block window: the
 * client gets real counts, which is the honest answer) and stops the pathological case from holding a
 * socket for minutes (a cold replay of an old contract on a rate-limited RPC — the case where the
 * client used to time out and re-POST, doubling the load on the RPC that was already the problem).
 */
function registerDeadlineMs(): number {
  const raw = process.env.ABX_REGISTER_DEADLINE_MS;
  if (raw === undefined || raw === '') return 8_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 8_000;
}

/** Resolve to the catch-up result if it finishes within the deadline, else `undefined` — the work
 *  keeps running either way (the caller must attach its own completion/failure handling). */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    // The rejection case belongs to the caller's handler; here a failure just means "not finished
    // in time with a result", and the caller reports the recorded status instead.
    return await Promise.race([work.catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/** The lifecycle state to report for a project right now — never a silent nothing (see
 *  `SelfHostIndexer.indexStatus` for what an unstamped registration reads as). */
function indexStatusOf(ctx: ControlPlaneContext, address: string): IndexStatus {
  return ctx.indexer.indexStatus(address as Address).status;
}

/** The lifecycle fields shared by the status route and the register/reindex responses. */
function lifecycle(ctx: ControlPlaneContext, address: string): {
  status: IndexStatus;
  error?: {class: IndexErrorClass; message?: string};
  attempts?: number;
} {
  const row = ctx.indexer.indexStatus(address as Address);
  return {
    status: row.status,
    ...(row.errorClass ? {error: {class: row.errorClass, ...(row.errorMessage ? {message: row.errorMessage} : {})}} : {}),
    attempts: row.attempts,
  };
}

/**
 * The ONE bearer guard for every gated route: 404 code `disabled` when no token is configured on
 * the host (the write surface honestly doesn't exist — the descriptor omits the control-plane
 * interface too), 401 code `unauthorized` on a missing/bad bearer. Returns false if it handled
 * the response (caller must stop), true when the request may proceed. 403 (`forbidden`) is
 * spec-defined for multi-tenant providers; this single-token reference never emits it.
 */
export function requireBearer(req: IncomingMessage, res: ServerResponse): boolean {
  if (!process.env.ABX_RESOLVER_ADMIN_TOKEN) {
    sendError(res, 404, 'disabled', 'control plane disabled — set ABX_RESOLVER_ADMIN_TOKEN on this node (operate via the abx CLI)');
    return false;
  }
  if (!bearerAuthorized(req)) {
    sendError(res, 401, 'unauthorized', 'unauthorized — send Authorization: Bearer <token>');
    return false;
  }
  return true;
}

/** Constant-time bearer check against ABX_RESOLVER_ADMIN_TOKEN (read per request, so rotation
 *  needs no restart). */
function bearerAuthorized(req: IncomingMessage): boolean {
  const token = process.env.ABX_RESOLVER_ADMIN_TOKEN;
  if (!token) return false;
  const header = req.headers['authorization'];
  const raw = (Array.isArray(header) ? header[0] : header) ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Read + JSON-parse a request body, capped so a bad caller can't exhaust memory. */
async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Is this an ERC-1155 edition contract type (any of the three)? Mirrors the SDK's own
 *  three-way check (`reconstruct.ts`'s `isEdition`) — kept local rather than exported from the
 *  SDK, since this phase's SDK edits are additive-only in `service.ts`. */
function isEditionContractType(contractType: ProjectState['contractType']): boolean {
  return contractType === '1of1-edition' || contractType === 'edition' || contractType === 'edition-code';
}

/** Sum of every token's current supply — the collector-facing "how many copies exist right now"
 *  figure, additive alongside `mintedCount` (which keeps meaning unchanged: `supply > 0`).
 *  `undefined` for a non-edition project, so a 721 status response is byte-identical to before. */
function copiesOf(s: ProjectState): string | undefined {
  if (!isEditionContractType(s.contractType)) return undefined;
  let total = 0n;
  for (const t of s.tokens) total += BigInt(t.supply ?? '0');
  return total.toString();
}

/**
 * How many ids are live, and how many were destroyed.
 *
 * `mintedCount` counts live ids, so it decreases when a burnable token is destroyed.
 * `burnedCount` is omitted when zero, deliberately: a project with no burns serves byte-identical
 * JSON to before, which keeps a consumer's fixtures (and their parity audit) honest about what
 * actually changed. Both figures are the same shape the hosted resolver settled on, so the two
 * implementations agree on the wire rather than each inventing a name.
 */
function tokenCounts(s: ProjectState): {mintedCount: number; burnedCount?: number} {
  let live = 0;
  let burned = 0;
  for (const t of s.tokens) {
    if (t.lifecycle === 'live') live++;
    // `'burned'` is terminal and 721-only, so this counts destroyed tokens and nothing else. An
    // edition's zero-supply ids fold to `'no-live-copies'` and are deliberately not counted here:
    // they may mint again, and `copies` already reports live copies for that lane.
    else if (t.lifecycle === 'burned') burned++;
  }
  return {mintedCount: live, ...(burned ? {burnedCount: burned} : {})};
}

/** The one-line project summary shared by `GET /api/projects` and the register/reindex responses. */
export function summarize(s: ProjectState) {
  const copies = copiesOf(s);
  return {
    address: s.address,
    name: s.name,
    symbol: s.symbol,
    owner: s.owner,
    abxVersion: s.abxVersion,
    isCanonical: s.isCanonical,
    extensions: s.extensions.map((e) => e.name),
    eventCount: s.eventCount,
    tokenCount: s.tokens.length,
    ...tokenCounts(s),
    ...(copies !== undefined ? {copies} : {}),
    reconstructedAt: s.reconstructedAt,
  };
}

/** Parse a stored content-locators JSON column → `{hash: locator}` (lowercased keys, never throws). */
export function safeLocators(json: string): Record<string, string> | undefined {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k.toLowerCase()] = v;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Merge incoming content locators over the stored ones (additive — a re-add can bring new hashes
 *  without dropping known ones). Returns a JSON string for the column, or undefined if empty. */
function mergeLocators(existingJson: string | undefined, incoming: unknown): string | undefined {
  const base = existingJson ? safeLocators(existingJson) ?? {} : {};
  if (incoming && typeof incoming === 'object') {
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (typeof v === 'string' && v) base[k.toLowerCase()] = v;
    }
  }
  return Object.keys(base).length ? JSON.stringify(base) : undefined;
}

/**
 * Decide the scan floor + whether a full replay is needed when registering a project via the
 * control plane. Pure (the discovery/refusal fallback for the null case is the caller's):
 *   - explicit `bodyFromBlock` wins; else the `existingFromBlock` already stored.
 *   - `null` ⇒ NEITHER supplied nor stored — the caller must derive the deploy block or refuse
 *     (never default to genesis: a range-capped RPC would sweep millions of blocks).
 *   - `full` is true only when forced, on a first registration (no existing floor), or when the
 *     floor actually CHANGED — so re-sending the SAME floor (the CLI now always forwards the deploy
 *     block, even on a nudge) stays incremental: registering twice ≠ two full scans.
 */
export function planRegistrationFloor(
  bodyFromBlock: string | undefined,
  existingFromBlock: string | undefined,
  forceFull = false,
): {fromBlock: string; full: boolean} | null {
  const fromBlock = bodyFromBlock !== undefined ? String(bodyFromBlock) : existingFromBlock;
  if (fromBlock === undefined) return null;
  const full = forceFull || existingFromBlock === undefined || fromBlock !== existingFromBlock;
  return {fromBlock, full};
}

// ── the service descriptor ──────────────────────────────────────────────────────

/** This package's own name+version (dev and published resolve the same — npm always ships
 *  package.json). Never throws; identity is display-only, not dispatch. */
function packageIdentity(): {name: string; version: string} {
  try {
    const pkgDir = resolve(fileURLToPath(import.meta.url), '..', '..');
    const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {name?: string; version?: string};
    return {name: raw.name ?? '@artblocks/abx-token-api', version: raw.version ?? '0.0.0'};
  } catch {
    return {name: '@artblocks/abx-token-api', version: '0.0.0'};
  }
}

type RunnerEffects = Array<{key: string; outputs: Array<{key: string; mimeType: string}>}>;

// The runner /health probe is cached briefly (and keyed by URL, so a config change invalidates):
// the descriptor must stay cheap to serve, and a dead runner must not slow it down.
let effectsProbe: {at: number; url: string; effects: RunnerEffects | null} | null = null;
const EFFECTS_PROBE_TTL_MS = 60_000;

async function probeRunnerEffects(url: string): Promise<RunnerEffects | null> {
  if (effectsProbe && effectsProbe.url === url && Date.now() - effectsProbe.at < EFFECTS_PROBE_TTL_MS) {
    return effectsProbe.effects;
  }
  let effects: RunnerEffects | null = null;
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/health`, {signal: AbortSignal.timeout(1500)});
    const body = (await resp.json()) as {effects?: unknown};
    if (Array.isArray(body.effects)) effects = body.effects as RunnerEffects;
  } catch {
    effects = null; // attached-but-unverified — distinct from "attached, zero effects"
  }
  effectsProbe = {at: Date.now(), url, effects};
  return effects;
}

/**
 * `GET /.well-known/abx-service` — what this node supports, agent-readably (public, no auth).
 * The control-plane interface (and `auth`) appears iff the bearer token is configured: a token-less
 * self-host node honestly advertises no remote control surface — which is how a client tells
 * "disabled" from "wrong URL". The artifact-registry routes ride `abx-control-plane/v1` rather than
 * an id of their own: once referenced output is locator-only, accepting a registration is a database
 * insert, so there is no infrastructure a node could lack that would justify a separate capability
 * flag. `render` appears when a runner rides behind this resolver (ABX_EFFECTS_URL); its declared
 * effects come from a best-effort `/health` probe. Provider identity (name, signup/docs URLs) is
 * deployment env — no provider ships in this code.
 */
export async function serviceDescriptor(ctx: ControlPlaneContext): Promise<ServiceDescriptor> {
  const controlPlane = !!process.env.ABX_RESOLVER_ADMIN_TOKEN;
  const pkg = packageIdentity();
  const descriptor: ServiceDescriptor = {
    service: {name: process.env.ABX_SERVICE_NAME ?? pkg.name, version: pkg.version},
    interfaces: controlPlane ? [TOKEN_API_INTERFACE, CONTROL_PLANE_INTERFACE] : [TOKEN_API_INTERFACE],
    chains: [ctx.chainId],
    baseUrl: ctx.baseUrl,
  };
  if (controlPlane) {
    descriptor.auth = {
      scheme: 'bearer',
      ...(process.env.ABX_SERVICE_SIGNUP_URL ? {signupUrl: process.env.ABX_SERVICE_SIGNUP_URL} : {}),
      ...(process.env.ABX_SERVICE_DOCS_URL ? {docsUrl: process.env.ABX_SERVICE_DOCS_URL} : {}),
    };
  }
  const effectsUrl = process.env.ABX_EFFECTS_URL;
  if (effectsUrl) {
    descriptor.render = {attached: true, effects: await probeRunnerEffects(effectsUrl)};
  }
  return descriptor;
}

// ── the /v1 routes ──────────────────────────────────────────────────────────────

/**
 * Dispatch a `/v1/*` request (`parts` excludes the leading `v1`). Every route is bearer-gated;
 * `chainId` is explicit everywhere (body on collection POSTs, path elsewhere) and validated, so a
 * project can never silently register against the wrong chain. Wrong method on a known path ⇒ 405.
 */
export async function routeControlPlane(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  parts: string[],
): Promise<void> {
  if (!requireBearer(req, res)) return;
  const method = req.method ?? 'GET';

  if (parts[0] === 'projects') {
    if (parts.length === 1) {
      if (method === 'POST') return registerProject(req, res, ctx);
      if (method === 'GET') return listProjects(res, ctx);
      return sendError(res, 405, 'invalid_request', 'use POST /v1/projects (register) or GET /v1/projects (list)');
    }
    const [, chainSeg, addrSeg, sub] = parts;
    if (!addrSeg || parts.length > 4) {
      return sendError(res, 404, 'invalid_request', 'unknown control-plane route — projects are /v1/projects/{chainId}/{address}');
    }
    if (!checkChain(res, ctx, chainSeg)) return;
    if (!ADDRESS_RE.test(addrSeg)) {
      return sendError(res, 400, 'invalid_request', 'address path segment must be a 0x-prefixed 20-byte address');
    }
    const address = addrSeg as Address;
    if (sub === undefined) {
      if (method === 'DELETE') return removeProject(res, ctx, address);
      return sendError(res, 405, 'invalid_request', 'use DELETE /v1/projects/{chainId}/{address}');
    }
    if (sub === 'reindex') {
      if (method === 'POST') return reindexProject(res, ctx, address);
      return sendError(res, 405, 'invalid_request', 'use POST /v1/projects/{chainId}/{address}/reindex');
    }
    if (sub === 'status') {
      if (method === 'GET') return projectStatus(res, ctx, address);
      return sendError(res, 405, 'invalid_request', 'use GET /v1/projects/{chainId}/{address}/status');
    }
    return sendError(res, 404, 'invalid_request', `unknown project action '${sub}' — reindex | status`);
  }

  if (parts[0] === 'effect-artifacts' && parts.length === 1) {
    if (method === 'POST') return publishEffectArtifact(req, res, ctx);
    return sendError(res, 405, 'invalid_request', 'use POST /v1/effect-artifacts');
  }

  if (parts[0] === 'effect-status' && parts.length === 1) {
    if (method === 'POST') return reportEffectStatus(req, res, ctx);
    return sendError(res, 405, 'invalid_request', 'use POST /v1/effect-status');
  }

  return sendError(res, 404, 'invalid_request', 'unknown control-plane route');
}

/** Validate a chainId (path segment or body value) against the chain this node serves. */
function checkChain(res: ServerResponse, ctx: ControlPlaneContext, value: unknown): boolean {
  const n = typeof value === 'number' ? value : value == null || value === '' ? NaN : Number(value);
  if (!Number.isInteger(n)) {
    sendError(res, 400, 'invalid_request', 'chainId is required (an EIP-155 chain id)');
    return false;
  }
  if (n !== ctx.chainId) {
    sendError(res, 400, 'unsupported_chain', `this service serves chain ${ctx.chainId}, not ${n}`, {chains: [ctx.chainId]});
    return false;
  }
  return true;
}

/**
 * `POST /v1/projects {chainId, address, fromBlock?, factory?, label?, description?, externalUrl?,
 *    attributes?, tokenAttributes?, contentLocators?, full?}` — attributes are off-chain operator
 *    traits; contentLocators bridge `{ "0x<keccak>": "ipfs://<cid>" }` so the image points at IPFS
 *    without holding bytes.
 *   → register the contract with THIS node and replay it from chain. Idempotent: a re-POST is the
 *     post-deploy "nudge" that pulls events that landed since.
 *
 * We deliberately do NOT factory-scope here: if you operate this node and you tell it a contract,
 * it does its best to index it. Factory allowlisting is a multi-tenant-provider policy, not a
 * self-hosting requirement.
 */
async function registerProject(req: IncomingMessage, res: ServerResponse, ctx: ControlPlaneContext): Promise<void> {
  const {indexer} = ctx;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'invalid_request', (err as Error).message);
  }
  if (!checkChain(res, ctx, body.chainId)) return;
  const address = body.address as string | undefined;
  if (!address || !ADDRESS_RE.test(address)) {
    return sendError(res, 400, 'invalid_request', 'body.address must be a 0x-prefixed 20-byte address');
  }
  // A re-POST is the post-deploy nudge: preserve the existing scan floor + metadata
  // (don't reset fromBlock and re-scan), and re-index incrementally. A first add — or one
  // that supplies a *new* fromBlock — replays fully from that floor. (See planRegistrationFloor.)
  const existing = indexer.store.getRegistration(address);
  let plan = planRegistrationFloor(body.fromBlock as string | undefined, existing?.fromBlock, body.full === true);
  if (!plan) {
    // No floor supplied and none stored. NEVER default to genesis — a range-capped RPC would
    // grind millions of blocks (the "resolver won't index" trap). Derive the deploy block from
    // chain; refuse if we can't (archive getCode unavailable) rather than guess a bad floor.
    const discovered = await discoverDeployBlock(indexer.publicClient(ctx.chainKey), address as Address);
    if (discovered === null) {
      return sendError(
        res,
        400,
        'invalid_request',
        'first registration needs fromBlock (the contract deploy block) — refusing a from-genesis scan. ' +
          'The abx CLI derives it automatically; if calling the API directly, pass fromBlock, or point the resolver at an archive RPC that serves historical eth_getCode.',
      );
    }
    plan = {fromBlock: discovered.toString(), full: true};
  }
  const {fromBlock, full} = plan;
  // Attributes / locators arrive as JSON values; store them as text. Normalize attributes so a
  // bad payload can't poison the served traits. Each preserves the existing value when omitted.
  let attributes = existing?.attributes;
  if (body.attributes !== undefined) {
    attributes = body.attributes === null ? undefined : JSON.stringify(normalizeAttributes(body.attributes));
  }
  // Per-token off-chain traits (a Series' editable attributes): a `{ "<tokenId>": attrs }` object,
  // each value normalized. Same preserve-on-omit / clear-on-null semantics as `attributes`.
  let tokenAttributes = existing?.tokenAttributes;
  if (body.tokenAttributes !== undefined) {
    if (body.tokenAttributes === null) tokenAttributes = undefined;
    else {
      const norm: Record<string, OpenSeaAttribute[]> = {};
      for (const [tokenId, v] of Object.entries(body.tokenAttributes as Record<string, unknown>)) {
        const a = normalizeAttributes(v);
        if (a.length) norm[tokenId] = a;
      }
      tokenAttributes = Object.keys(norm).length ? JSON.stringify(norm) : undefined;
    }
  }
  let contentLocators = existing?.contentLocators;
  if (body.contentLocators !== undefined) {
    contentLocators = mergeLocators(existing?.contentLocators, body.contentLocators);
  }
  // DURABLE FIRST (normative): the registration is written before any catch-up, so a flaky RPC
  // mid-reconstruct can never lose the add — it becomes a slower backfill, not a failed request.
  indexer.register({
    address: address as Address,
    chainKey: ctx.chainKey,
    fromBlock,
    factory: (body.factory as string | undefined) ?? existing?.factory ?? process.env.ABX_FACTORY ?? null,
    label: (body.label as string | undefined) ?? existing?.label,
    description: (body.description as string | undefined) ?? existing?.description,
    externalUrl: (body.externalUrl as string | undefined) ?? existing?.externalUrl,
    attributes,
    tokenAttributes,
    contentLocators,
  });
  return catchUpAndRespond(res, ctx, address as Address, {full});
}

/**
 * Start (or join) catch-up and answer in one of the two conformant shapes: `200` with the completed
 * summary when it lands inside the deadline, `202` + the lifecycle state when it doesn't. Shared by
 * register and reindex so both branches behave identically.
 *
 * Single process, no queue: the work continues on the same event loop after the 202 goes out, and
 * `reindexShared` guarantees a second POST joins that run instead of starting a rival reconstruct.
 */
async function catchUpAndRespond(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  address: Address,
  opts: {full?: boolean},
): Promise<void> {
  const {indexer} = ctx;
  const work = indexer.reindexShared(address, opts);
  // Attach terminal handling ONCE, up front: whichever way we answer, a completed catch-up must
  // notify the effects layer and a failed one must not surface as an unhandled rejection (its status
  // is already recorded by reindex()).
  let finished = false;
  const settled = work.then(
    (r) => {
      finished = true;
      notifyEffects(address);
      return r;
    },
    (err) => {
      finished = true;
      console.error(`[control-plane] catch-up failed for ${address}: ${(err as Error).message}`);
      return undefined;
    },
  );
  const done = await withinDeadline(settled, registerDeadlineMs());
  if (!done && !finished) {
    // About to tell the client "wait": make sure the stored state says so. An INCREMENTAL catch-up
    // deliberately keeps its prior status (so a live project doesn't flicker on every watcher tick) —
    // but a client polling a run we deferred must not read `live` and stop waiting on stale counts.
    // Guarded by `finished` so a run that just completed keeps its own `live`/`failed`.
    const current = indexStatusOf(ctx, address);
    if (current !== 'backfilling' && current !== 'failed') {
      indexer.store.setIndexStatus(address, {status: 'backfilling'});
    }
  }
  if (done) {
    return sendJson(res, 200, {
      ok: true,
      mode: done.mode,
      elapsedMs: done.elapsedMs,
      project: {...summarize(done.state), status: indexStatusOf(ctx, address)},
    });
  }
  // Still working (or it failed and the client should read the class from status, not from a 500 that
  // would imply the registration didn't land).
  return sendJson(res, 202, {
    ok: true,
    accepted: true,
    project: {
      address,
      name: indexer.getProject(address)?.name ?? null,
      ...lifecycle(ctx, address),
    },
  });
}

/** `GET /v1/projects` — the projects visible to this token. Single-tenant reference: the token IS
 *  the node's one credential, so it sees every registration. */
function listProjects(res: ServerResponse, ctx: ControlPlaneContext): void {
  const projects = ctx.indexer.store.listRegistrations().map((reg) => {
    const state = ctx.indexer.getProject(reg.address as Address);
    let chainId = ctx.chainId;
    try {
      chainId = resolveChain(reg.chainKey).id;
    } catch {
      /* unknown stored key — fall back to the node's chain */
    }
    // `status` (+ the error CLASS, never the hint) rides the list so a client renders
    // "3 live, 1 backfilling, 1 failed (rpc_rate_limited)" without a round trip per project.
    const life = lifecycle(ctx, reg.address);
    const copies = state ? copiesOf(state) : undefined;
    return {
      chainId,
      address: reg.address,
      label: reg.label ?? null,
      name: state?.name ?? null,
      status: life.status,
      ...(life.error ? {error: {class: life.error.class}} : {}),
      eventCount: state?.eventCount ?? 0,
      tokenCount: state?.tokens.length ?? 0,
      ...(state ? tokenCounts(state) : {mintedCount: 0}),
      ...(copies !== undefined ? {copies} : {}),
      reconstructedAt: state?.reconstructedAt ?? null,
    };
  });
  return sendJson(res, 200, {projects});
}

/** `DELETE /v1/projects/{chainId}/{address}` — stop indexing it (drops the projection). */
function removeProject(res: ServerResponse, ctx: ControlPlaneContext, address: Address): void {
  const existed = !!ctx.indexer.store.getRegistration(address);
  if (!existed) return sendError(res, 404, 'not_registered', 'not registered');
  ctx.indexer.store.deregister(address);
  return sendJson(res, 200, {ok: true, address});
}

/** `POST /v1/projects/{chainId}/{address}/reindex` — full replay from chain. Bearer-gated: a full
 *  replay is expensive + mutating, so it must never be a public action (`abx index --remote`). */
async function reindexProject(res: ServerResponse, ctx: ControlPlaneContext, address: Address): Promise<void> {
  if (!ctx.indexer.store.getRegistration(address)) {
    return sendError(res, 404, 'not_registered', 'not registered');
  }
  return catchUpAndRespond(res, ctx, address, {full: true});
}

/** `GET /v1/projects/{chainId}/{address}/status` — indexing freshness: the registration's floor,
 *  the projection's watermarks, and the chain watcher's liveness (all already in the store). */
async function projectStatus(res: ServerResponse, ctx: ControlPlaneContext, address: Address): Promise<void> {
  const reg = ctx.indexer.store.getRegistration(address);
  if (!reg) return sendError(res, 404, 'not_registered', 'not registered');
  const state = ctx.indexer.getProject(address);
  const pollAt = ctx.indexer.store.getMeta('watch:pollAt');
  // The head the watcher last saw. Top-level (not just under `watcher`) because it's what a client
  // computes lag / "N of M blocks" from, and it must not require knowing this node HAS a watcher.
  const watcherHead = ctx.indexer.store.getMeta(`watch:${reg.chainKey}:head`);
  // No watcher head yet (a fresh node's first backfill — exactly when a client most wants a
  // percentage, and when it's most likely to be polling) ⇒ read head once, cached.
  const head = watcherHead ?? (await cachedHead(ctx, reg.chainKey));
  const copies = state ? copiesOf(state) : undefined;
  return sendJson(res, 200, {
    chainId: ctx.chainId,
    address: reg.address,
    ...lifecycle(ctx, address),
    fromBlock: reg.fromBlock,
    toBlock: state?.toBlock ?? null,
    headBlock: head,
    eventCount: state?.eventCount ?? 0,
    tokenCount: state?.tokens.length ?? 0,
    ...(state ? tokenCounts(state) : {mintedCount: 0}),
    ...(copies !== undefined ? {copies} : {}),
    reconstructedAt: state?.reconstructedAt ?? null,
    watcher: {
      watching: pollAt !== null,
      pollAt,
      head: watcherHead,
      intervalMs: watchIntervalMs(),
    },
  });
}

// Head is per-chain and moves slowly relative to a client's poll cadence, so one cached read serves
// a whole wait loop. Best-effort by design: a status read must never fail because the RPC is down —
// that's precisely when a caller needs the status.
let headCache: {at: number; chainKey: string; head: string} | null = null;
const HEAD_CACHE_MS = 5_000;

async function cachedHead(ctx: ControlPlaneContext, chainKey: string): Promise<string | null> {
  if (headCache && headCache.chainKey === chainKey && Date.now() - headCache.at < HEAD_CACHE_MS) return headCache.head;
  try {
    const head = (await ctx.indexer.publicClient(chainKey).getBlockNumber()).toString();
    headCache = {at: Date.now(), chainKey, head};
    return head;
  } catch {
    return null;
  }
}

/**
 * `POST /v1/effect-artifacts {chainId, address, tokenId, inputsHash, output?, effectKey?, locator? |
 *    bytes_base64?, contentType?}` — a conforming producer REGISTERS one render output so a resolver
 *  that does NOT share the producer's storage disk can serve it. A pointer registry, not an upload
 *  endpoint: which form is legal is decided by the output's BINDING, never by the producer
 *  (`site/content/docs/protocol/effects.mdx → Bound vs referenced`):
 *    - **referenced** (`render/image`, a video, a model, any output this node can't stitch) → `locator`
 *      (ipfs://<cid> | ar://<txid> | https://…), stored as a pointer; the read plane 302-redirects to
 *      it and never proxies. `bytes_base64` here is a 400: this node would gain no capability from the
 *      bytes (it redirects either way) and would acquire an object store, retention and egress.
 *    - **bound** (`render/traits`) → `bytes_base64`, ≤64KB, held next to the row. A locator here is
 *      also a 400 — the content stitches into the metadata JSON, so a locator would put a third-party
 *      fetch on `tokenURI` (and, historically, was recorded and then silently never stitched).
 *  Both refusals are loud on purpose: accept-and-drop leaves a token permanently unrenderable, or
 *  serves a confidently wrong answer, with nothing for the producer to act on.
 *  This node NEVER fetches a locator while handling the request — that would be byte custody through
 *  the back door plus an SSRF surface on an authed route.
 *  The artifact key is computed from the producer-supplied `inputsHash` — NOT recomputed from current
 *  state — so a render is never re-addressed to a state it doesn't depict (a param change instead makes
 *  it unreachable, the correct self-invalidation). Bearer-gated; never signs on-chain.
 */
async function publishEffectArtifact(req: IncomingMessage, res: ServerResponse, ctx: ControlPlaneContext): Promise<void> {
  const {indexer} = ctx;
  let body: Record<string, unknown>;
  try {
    // Bound bytes are capped at 64KB; base64 inflates by 4/3, and the rest of the body is small.
    // (This used to allow 8MB so a thumbnail could be pushed as bytes — exactly the custody this
    // route no longer accepts.)
    body = await readJsonBody(req, Math.ceil((BOUND_ARTIFACT_MAX_BYTES * 4) / 3) + 8 * 1024);
  } catch (err) {
    return sendError(res, 400, 'invalid_request', (err as Error).message);
  }
  if (!checkChain(res, ctx, body.chainId)) return;
  const address = body.address as string | undefined;
  if (!address || !ADDRESS_RE.test(address)) {
    return sendError(res, 400, 'invalid_request', 'body.address must be a 0x-prefixed 20-byte address');
  }
  if (body.tokenId === undefined || body.tokenId === null) {
    return sendError(res, 400, 'invalid_request', 'body.tokenId required');
  }
  const tokenId = String(body.tokenId);
  const inputsHashHex = body.inputsHash as string | undefined;
  if (!inputsHashHex || !/^0x[0-9a-fA-F]{64}$/.test(inputsHashHex)) {
    return sendError(res, 400, 'invalid_request', 'body.inputsHash must be the 0x 32-byte hash the runner rendered (this node does NOT recompute it)');
  }
  // Any declared output key (the data plane's generality) — 'image'/'traits' are just the
  // reference render effect's two.
  const output = typeof body.output === 'string' && body.output ? body.output : 'image';
  const effectKey = typeof body.effectKey === 'string' && body.effectKey ? body.effectKey : 'render';
  const contentType = (body.contentType as string | undefined) ?? (output === 'traits' ? 'application/json' : 'image/png');
  const key = renderArtifactKey(ctx.chainId, address as Address, tokenId, inputsHashHex as Hex, output, effectKey);
  // BOTH classes register a row — the row is the `artifacts` manifest's enumeration surface. What
  // differs is what rides with it: a locator (referenced) or the content itself (bound).
  const row = {key, address, tokenId, effectKey, outputKey: output, inputsHash: inputsHashHex, contentType};
  const bound = isBoundOutput(effectKey, output);
  const locator = typeof body.locator === 'string' && body.locator ? body.locator : undefined;
  const bytesB64 = typeof body.bytes_base64 === 'string' && body.bytes_base64 ? body.bytes_base64 : undefined;

  if (bound) {
    // Bound: content only. A locator can never work here — the bytes stitch into the metadata JSON.
    if (locator) {
      return sendError(
        res,
        400,
        'invalid_request',
        `'${effectKey}/${output}' is a BOUND output — its content stitches into the token JSON, so it must be published as body.bytes_base64, not a locator. ` +
          `A locator would be recorded here and then never stitch (a wrong answer served confidently), and it would put a third-party fetch on tokenURI.`,
      );
    }
    if (!bytesB64) {
      return sendError(res, 400, 'invalid_request', `'${effectKey}/${output}' is a BOUND output — provide body.bytes_base64 (≤${BOUND_ARTIFACT_MAX_BYTES} bytes)`);
    }
    const bytes = new Uint8Array(Buffer.from(bytesB64, 'base64'));
    if (bytes.length > BOUND_ARTIFACT_MAX_BYTES) {
      return sendError(
        res,
        400,
        'invalid_request',
        `bound output '${effectKey}/${output}' is ${bytes.length} bytes — the cap is ${BOUND_ARTIFACT_MAX_BYTES}. ` +
          `An output this size belongs in the producer's own storage, registered as a locator.`,
      );
    }
    indexer.store.putEffectArtifact({...row, locator: null, bytes});
    // Retention is this node's POLICY, not a conformance rule (the normative half is that superseded
    // content is never served or stitched — so nothing may read it). We drop eagerly: rows at older
    // hashes stay as provenance, their content goes. Otherwise every param change would add another
    // copy and held bytes would grow without bound instead of being capped by supply.
    indexer.store.pruneBoundArtifactBytes(address, tokenId, effectKey, output, inputsHashHex);
    return sendJson(res, 200, {ok: true, mode: 'bytes', key, output, bytes: bytes.length});
  }

  // Referenced: locator only. We store the pointer and never fetch it — the read plane 302s.
  if (bytesB64) {
    return sendError(
      res,
      400,
      'invalid_request',
      `'${effectKey}/${output}' is a REFERENCED output — publish it as body.locator (an https://, ipfs:// or ar:// URI reachable without your credentials). ` +
        `This node serves referenced output by redirect, so holding its bytes would gain it nothing and cost it object storage. ` +
        `A producer that can't expose a locator needs a storage backend that can (S3/R2, IPFS, Arweave, or its own public base), or to run co-located with the resolver.`,
    );
  }
  if (!locator) {
    return sendError(res, 400, 'invalid_request', `'${effectKey}/${output}' is a REFERENCED output — provide body.locator (an https://, ipfs:// or ar:// URI)`);
  }
  // A locator is a REACHABILITY claim (any scheme; no durability preference — a gateway URL and an
  // ipfs:// are peers here). We can't prove reachability without fetching, and fetching a
  // third-party URL while handling an authed write is exactly the custody/SSRF surface this route
  // refuses — so we reject what's decidable from the string: private hosts, and presigned URLs that
  // would pass today and rot later.
  const bad = locatorRejectionReason(locator);
  if (bad) return sendError(res, 400, 'invalid_request', `body.locator rejected: ${bad}`);
  indexer.store.putEffectArtifact({...row, locator});
  return sendJson(res, 200, {ok: true, mode: 'locator', key, output, locator});
}

/**
 * `POST /v1/effect-status {chainId, key, address, tokenId, effectKey, status, error?, attempts?}` —
 * a runner reports one run's transient state for the artifact `key` it is producing (the runner
 * computes the key; this node never re-derives it, mirroring /v1/effect-artifacts). `status`
 * 'done' clears the row (artifact presence takes over as truth); 'rendering'/'failed' upsert.
 */
async function reportEffectStatus(req: IncomingMessage, res: ServerResponse, ctx: ControlPlaneContext): Promise<void> {
  const {indexer} = ctx;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'invalid_request', (err as Error).message);
  }
  if (!checkChain(res, ctx, body.chainId)) return;
  const key = body.key as string | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return sendError(res, 400, 'invalid_request', 'body.key must be the 0x 32-byte artifact key this run produces');
  }
  const address = body.address as string | undefined;
  if (!address || !ADDRESS_RE.test(address)) {
    return sendError(res, 400, 'invalid_request', 'body.address must be a 0x-prefixed 20-byte address');
  }
  const status = body.status as string | undefined;
  if (status === 'done') {
    indexer.store.clearEffectStatus(key);
    return sendJson(res, 200, {ok: true, cleared: key});
  }
  if (status !== 'rendering' && status !== 'failed') {
    return sendError(res, 400, 'invalid_request', "body.status must be 'rendering' | 'failed' | 'done'");
  }
  indexer.store.putEffectStatus({
    key,
    address,
    tokenId: String(body.tokenId ?? ''),
    effectKey: typeof body.effectKey === 'string' && body.effectKey ? body.effectKey : 'render',
    status,
    error: typeof body.error === 'string' ? body.error.slice(0, 2000) : null,
    attempts: typeof body.attempts === 'number' ? body.attempts : undefined,
  });
  return sendJson(res, 200, {ok: true, key, status});
}
