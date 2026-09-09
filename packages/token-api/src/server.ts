import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {
  ABX_JS,
  fieldOf,
  makePublicClient,
  normalizeAttributes,
  renderArtifactKey,
  resolveChain,
  DEFAULT_CHAIN_KEY,
  verifyAgainstHash,
  type OpenSeaAttribute,
  METADATA_FIELD as F,
  METADATA_REPRESENTATION as R,
  type Address,
  type Hex,
  gatewayConfigFromEnv,
  projectGatewayPrefix,
  projectGatewayUrl,
  type ProjectState,
  type PublicClient,
  type TokenState,
} from '@artblocks/abx-sdk';
import {SelfHostIndexer} from '@artblocks/abx-indexer';
import {resolveBackend, type StorageBackend} from '@artblocks/abx-storage';
import {fallbackImageSvg, IMAGE_MEDIA_TYPE} from './content.js';
import {buildContractMetadata, buildTokenMetadata, fieldMimeType, tokenArtifacts, type DisplayMeta, type PlaneAccess} from './metadata.js';
import {currentRenderArtifact, currentSettledInputsHash, isCodeProject, liveViewAvailability, resolveLiveView, resolveLocatorUrl} from './code.js';
import {depStatusReport} from './deps.js';
import {resolveFieldBytes, resolveFieldRendered, COLLECTION_TOKEN_ID} from './resolve.js';
import {renderDashboard, renderIndex} from './dashboard.js';
import {watchIntervalMs} from './watcher.js';
import {
  requireBearer,
  routeControlPlane,
  safeLocators,
  sendError,
  sendJson,
  serviceDescriptor,
  summarize,
  type ControlPlaneContext,
} from './control-plane.js';

// EVERYTHING chain-derived in this module is resolved LAZILY, on first use.
//
// It used to be three module-scope consts, and that made an invalid `ABX_CHAIN` catastrophic in a
// way wildly out of proportion to the mistake: the CLI imports this package (for the generator
// runtime), so the throw happened during module evaluation — before `main()` existed to catch it.
// `ABX_CHAIN=mainnet abx doctor` printed a raw Node stack trace with an internal source path and
// exited 1, as did commands that should diagnose the environment. Deferring the work to first use
// keeps a bad value an ordinary, catchable error.
let _chainClient: PublicClient | null = null;
/** A read-only client for resolving on-chain `reader`-represented content (eth_call). */
function chainClientLazy(): PublicClient {
  return (_chainClient ??= makePublicClient());
}

let _serverChainId: number | null = null;
/**
 * The chain this resolver serves. The path grammar carries the chainId
 * (`/t/{chainId}/{address}/{tokenId}`), so a single host can serve many chains and reject paths for
 * chains it doesn't index. Today one resolver = one chain; this gates that.
 */
function serverChainId(): number {
  return (_serverChainId ??= resolveChain(process.env.ABX_CHAIN).id);
}

/** The chain *key* ('sepolia', …) the indexer registers projects under — the string form of the same
 *  chain {@link serverChainId} identifies. MUST match its default (base-sepolia): a stale 'sepolia'
 *  once desynced the key from the id. */
function serverChainKey(): string {
  return process.env.ABX_CHAIN ?? DEFAULT_CHAIN_KEY;
}

/** The context the /v1 control plane + descriptor run against (control-plane.ts owns the routes). */
function controlPlaneCtx(indexer: SelfHostIndexer, storage: StorageBackend, baseUrl: string): ControlPlaneContext {
  return {indexer, storage, chainId: serverChainId(), chainKey: serverChainKey(), baseUrl};
}

export interface ServerOptions {
  indexer: SelfHostIndexer;
  port?: number;
  baseUrl?: string;
  /** Byte-custody backend the image/verify routes resolve content from. Defaults to `resolveBackend()`. */
  storage?: StorageBackend;
}

/**
 * Resolve a token's image bytes by dispatching on the `image` field's single active
 * representation (token scope first, else the collection-wide field — the same fallback the
 * JSON assembly uses): on-chain content — `inline` / `inline-gzip` / `reader` / `reader-gzip`,
 * all decoded by the shared {@link resolveFieldBytes} (which calls `read(pointer)` for a
 * reader and gunzips the gzip variants) → computed content (`renderer` — eth_call, typed by
 * the returned contentType; `text/uri-list` means the bytes are a locator the route redirects
 * to) → off-chain custody located by the on-chain `keccak256`/`sha256` hash → graceful
 * placeholder. The node never errors on missing bytes.
 */
export async function resolveContent(
  state: ProjectState,
  token: TokenState,
  storage: StorageBackend,
): Promise<{contentType: string; body: Uint8Array | string}> {
  const image = fieldOf(token.fields, F.image) ?? fieldOf(state.collectionFields, F.image);
  const onChain = await resolveFieldBytes(chainClientLazy(), image); // inline / inline-gzip / reader / reader-gzip
  if (onChain) return {contentType: IMAGE_MEDIA_TYPE, body: onChain};
  // computed on-chain at read (`renderer`) — best-effort: a reverting renderer degrades to the
  // placeholder rather than erroring the route (mirrors the on-chain renderer's fallback rule).
  if (image?.representation === R.renderer) {
    try {
      const rendered = await resolveFieldRendered(chainClientLazy(), state.address, token.tokenId, F.image, image);
      if (rendered) return {contentType: rendered.contentType, body: rendered.bytes};
    } catch {
      // fall through to the placeholder
    }
  }
  // off-chain custody, located by the on-chain hash of the image
  if (image && (image.representation === R.keccak256 || image.representation === R.sha256)) {
    const stored = await storage.get(image.value);
    if (stored) return {contentType: stored.contentType, body: stored.bytes};
  }
  // graceful placeholder — the deterministic fallback the on-chain renderer also uses,
  // so a token with no resolvable image looks the same whether served here or self-resolved.
  return {contentType: IMAGE_MEDIA_TYPE, body: fallbackImageSvg(state.address, token.tokenId)};
}

/** Is `tokenId` a valid, not-yet-minted position within a multi-token contract's id-space cap
 *  (`0 <= id < N`)? `maxInvocations` caps the id space the same way for a Series and its edition
 *  twins (EditionImage/EditionCode) — "number of distinct works" is unchanged by copies-per-id
 *  — so this needs no contractType branch. A '1of1'/'1of1-edition' has no cap at all (id space
 *  fixed to {0}); that token gets its pre-mint view a different way — see {@link resolveTokenView}. */
function withinCap(tokenId: string, maxInvocations: string | null | undefined): boolean {
  if (maxInvocations == null) return false;
  try {
    const id = BigInt(tokenId);
    return id >= 0n && id < BigInt(maxInvocations);
  } catch {
    return false;
  }
}

/**
 * A destroyed token gets `410 Gone`, and every token route answers it before doing any other work.
 *
 * The rule is the contract's, not ours: a burned ERC-721's `tokenURI` reverts `NonexistentToken`
 * (`TokenURI.sol`), so serving a metadata document for that id would put this node in contradiction
 * with the contract it speaks for. `404` would be wrong twice over — it reads as "wrong URL / not
 * indexed yet", inviting a retry that can never succeed, and on `/image` an in-cap unknown id gets
 * the *warming placeholder*, so a destroyed token would say "still loading" forever.
 *
 * **There is deliberately no `contractType` check here.** An edition must never `410` — its `uri(id)`
 * has no existence gate and a zero-supply id can mint again — and the way that is guaranteed is that
 * `lifecycle` cannot *be* `'burned'` on that standard (it folds to `'no-live-copies'`). The first
 * version of this function carried an `isEditionState` guard beside the check, which meant the rule
 * lived in two places and held only as long as everyone remembered the second one. It is in the type
 * now: `'burned'` means permanent, on either standard, and this route needs to know nothing else.
 *
 * Returns `true` when it has answered the request.
 */
function goneIfBurned(res: ServerResponse, token: TokenState): boolean {
  if (token.lifecycle !== 'burned') return false;
  sendError(res, 410, 'burned', `token ${token.tokenId} was burned — it no longer exists on chain`, {burned: true});
  return true;
}

/**
 * The view to resolve for a requested tokenId. A token's metadata is its token id (no
 * decoupling), so identity and content both come from that token. Returns a synthesized,
 * unminted view for a not-yet-minted id within the cap (pre-mint warming — the multi-token
 * analogue of the 1/1's seed-token-0, which the SDK's fold seeds unconditionally — see
 * `reconstruct.ts`'s `assembleState`, so a fresh '1of1'/'1of1-edition' always has an `issued`
 * entry for id 0 despite carrying no `maxInvocations` cap), or `null` when the id is genuinely
 * unknown (→ 404).
 */
export function resolveTokenView(state: ProjectState, tokenId: string): TokenState | null {
  const issued = state.tokens.find((t) => t.tokenId === tokenId);
  if (!issued && !withinCap(tokenId, state.maxInvocations)) return null;
  return {
    tokenId,
    lifecycle: issued?.lifecycle ?? 'unminted',
    owner: issued?.owner ?? null,
    tokenURI: issued?.tokenURI ?? null,
    fields: issued?.fields ?? [],
    lockedFields: issued?.lockedFields ?? [],
    params: issued?.params,
    // ERC-1155 editions only — absent on `issued` (a 721 token, or an edition id the fold never
    // touched) stays absent here too; dropping them was a real bug (found while generalizing this
    // route for editions): every synthesized/passthrough view silently lost supply/cap/holders.
    supply: issued?.supply,
    maxSupply: issued?.maxSupply,
    maxSupplyOverridden: issued?.maxSupplyOverridden,
    holders: issued?.holders,
  };
}

export const DEFAULT_PORT = 8787;

/** The base URL this node is reachable at — what gets baked into on-chain URIs. */
export function resolveBaseUrl(port = DEFAULT_PORT): string {
  return process.env.ABX_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
}

/**
 * Guard the base URL a hosted resolver serves its own metadata URLs from. `.example` is RFC-2606
 * reserved — it can only be a leftover placeholder, so refuse it anywhere. A localhost base is fine
 * for a local `abx serve` (dev), but in a hosted image (ABX_HOSTED=1) it means the public URL was
 * never set — refuse so the deploy fails loudly instead of silently serving dead localhost links.
 * The scaffold now always bakes a real host, so this only fires on a stripped env or an old artifact.
 */
export function assertServableBaseUrl(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`ABX_PUBLIC_BASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}`);
  }
  if (host === 'example' || host.endsWith('.example')) {
    throw new Error(
      `ABX_PUBLIC_BASE_URL is a placeholder host (${host}). Set it to the resolver's real public URL ` +
        `(e.g. https://<app>.fly.dev, or your custom domain) — the metadata this node serves points ` +
        `image/animation URLs at this base, so a placeholder serves dead links.`,
    );
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  if (isLocal && process.env.ABX_HOSTED === '1') {
    throw new Error(
      `hosted resolver has no public ABX_PUBLIC_BASE_URL (resolved to ${baseUrl}). Set it to this host's ` +
        `URL (e.g. https://<app>.fly.dev) — otherwise it serves localhost links no client can reach.`,
    );
  }
}

export function createTokenApiServer(opts: ServerOptions): Server {
  const {indexer} = opts;
  const port = opts.port ?? Number(process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = opts.baseUrl ?? resolveBaseUrl(port);
  assertServableBaseUrl(baseUrl);
  const storage = opts.storage ?? resolveBackend();

  return createServer(async (req, res) => {
    try {
      await route(req, res, indexer, baseUrl, storage);
    } catch (err) {
      // NEVER hand a raw internal error to the client. An unexpected failure here is usually an
      // upstream RPC error, and viem's message embeds the full endpoint URL — which for a keyed
      // endpoint IS a credential. On a multi-tenant provider that would leak the operator's RPC key
      // to any tenant who can trigger a 500 (see site/content/docs/using-abx/remote-services.mdx). So:
      // full detail to the operator's log, a generic + redacted message on the wire.
      const detail = (err as Error).message ?? 'unknown error';
      console.error(`[server] ${req.method} ${req.url} failed: ${detail}`);
      sendJson(res, 500, {
        error: `internal error serving ${req.url ?? '/'} — see the node's logs for detail${upstreamHint(detail)}`,
        code: 'internal_error',
      });
    }
  });
}

/** A safe, credential-free hint about WHAT class of thing broke, so a caller isn't left blind by the
 *  generic 500. Recognizes the common upstream-RPC failures by status text only — never echoes the
 *  message (which can embed a keyed endpoint URL). */
function upstreamHint(detail: string): string {
  if (/\b429\b|Too Many Requests|rate limit/i.test(detail)) return ' (upstream RPC rate-limited this node — its operator needs a higher-capacity endpoint)';
  if (/\b(401|403)\b|Unauthorized|Forbidden/i.test(detail)) return " (this node's upstream RPC rejected its credentials)";
  if (/\b5\d\d\b|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(detail)) return " (this node's upstream RPC is unreachable or erroring)";
  return '';
}

export function startTokenApiServer(opts: ServerOptions): Promise<{server: Server; url: string}> {
  const port = opts.port ?? Number(process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = opts.baseUrl ?? resolveBaseUrl(port);
  const server = createTokenApiServer({...opts, port, baseUrl});
  return new Promise((resolve) => {
    server.listen(port, () => resolve({server, url: baseUrl}));
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  indexer: SelfHostIndexer,
  baseUrl: string,
  storage: StorageBackend,
): Promise<void> {
  res.setHeader('access-control-allow-origin', '*');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  // CORS preflight — without this, a browser client can never send Authorization to the
  // control plane (the wildcard origin above covers simple GETs only).
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  // GET / — read-only node index: which contracts this resolver serves (no actions).
  if (parts.length === 0) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(renderIndex(indexer.listProjects(), baseUrl, serverChainId()));
    return;
  }

  // GET /d/:chainId/:addr — the per-contract dashboard (read-only; namespaced so one host can
  // serve many contracts/chains). Actions live behind the admin token, not on this page.
  if (parts[0] === 'd' && parts[1] && parts[2]) {
    if (Number(parts[1]) !== serverChainId()) return wrongChain(res, parts[1]);
    const state = indexer.getProject(parts[2] as Address);
    if (!state) return unknownProject(res);
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(renderDashboard(state, baseUrl, serverChainId()));
    return;
  }

  // GET /health
  if (parts[0] === 'health') return sendJson(res, 200, {ok: true, baseUrl});

  // GET /.well-known/abx-service — the service descriptor (public): what this node supports,
  // agent-readably, so a client can match a project's needs to this service BEFORE trusting it
  // with a registration. See site/content/docs/using-abx/remote-services.mdx.
  if (parts[0] === '.well-known' && parts[1] === 'abx-service') {
    return sendJson(res, 200, await serviceDescriptor(controlPlaneCtx(indexer, storage, baseUrl)));
  }

  // GET /abx.js — the runtime companion (directory builds include it; the generator inlines it).
  if (parts[0] === 'abx.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    });
    res.end(ABX_JS);
    return;
  }

  // GET /a/:chainId/:addr/:id — the live view: the code project's document with canonical
  // tokenData delivered per the spec (directory mode: the build's entry document served
  // from here with window.abxTokenData injected — the ?abx= 302 redirect is the
  // entry-fetch-failure fallback; template mode: the generator document assembled from
  // chain). This is the same document a render node captures — the live view IS the input.
  if (parts[0] === 'a' && parts[1] && parts[2] && parts[3] !== undefined) {
    if (Number(parts[1]) !== serverChainId()) return wrongChain(res, parts[1]);
    const state = indexer.getProject(parts[2] as Address);
    if (!state) return unknownProject(res);
    const token = resolveTokenView(state, parts[3]);
    if (!token) return sendError(res, 404, 'not_registered', 'unknown token — not minted, and outside this project\'s supply cap');
    if (goneIfBurned(res, token)) return;
    // Both no-code verdicts are answered BEFORE the chain client, since neither needs an RPC (see
    // {liveViewAvailability} for why the two are distinguished at all — collapsing them cost a
    // tester a day). A plain 503 in this route's own `{error}` shape rather than a structured
    // `code`: the versioned control plane's ServiceErrorCode set is pinned by remote-services.md and
    // has no member for "not ready yet", and widening a published interface for one serving-route
    // diagnostic is a decision, not a bug fix. The status code carries the retry semantics.
    const availability = liveViewAvailability(state);
    if (availability === 'indexing') {
      res.writeHead(503, {'content-type': 'application/json; charset=utf-8', 'retry-after': '5'});
      res.end(
        JSON.stringify(
          {
            error:
              "this IS a code project, but its on-chain code has not been folded into the projection yet — retry shortly. If it persists, this node's scan floor is above the deploy block: re-add with --from-block <deployBlock>.",
          },
          null,
          2,
        ),
      );
      return;
    }
    if (availability === 'not-a-code-project') return sendJson(res, 404, {error: 'no live view — not a code project'});
    const view = await resolveLiveView(chainClientLazy(), state, token);
    if (!view) {
      return sendJson(res, 404, {
        error: 'no live view — this project has a `code` field whose locator is not serveable (the `code` field is locators-only: ipfs/arweave/url)',
      });
    }
    if (view.kind === 'redirect') {
      res.writeHead(302, {location: view.location, 'cache-control': 'no-store'});
      res.end();
      return;
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(view.html);
    return;
  }

  // /v1/* — the control plane (register/list/deregister/reindex/status + the effect-publish
  // lane). This is the ONE write surface on the resolver, and it's a *remote `abx add`*: it
  // tells THIS node (a different projection store from any local one) which contracts to index.
  // It never signs anything on-chain — the "no signing key on the host" rule is intact; the
  // bearer token authorizes indexing control only. Disabled unless ABX_RESOLVER_ADMIN_TOKEN is
  // set on the resolver. Routes + auth live in control-plane.ts.
  if (parts[0] === 'v1') {
    return routeControlPlane(req, res, controlPlaneCtx(indexer, storage, baseUrl), parts.slice(1));
  }

  // /api/*
  if (parts[0] === 'api') {
    if (parts[1] === 'projects') {
      return sendJson(res, 200, indexer.listProjects().map(summarize));
    }
    // GET /api/watch — chain-watcher liveness. Read from the `meta` table the watcher writes each
    // tick (this resolver's watcher shares the indexer store), so a HOSTED node — where you can't
    // tail the log — can still PROVE it's watching: `pollAt` advances, `head` tracks the chain.
    if (parts[1] === 'watch') {
      return sendJson(res, 200, watchStatusReport(indexer));
    }
    // GET /api/deps/:chainId/:addr — per-dep resolution status (a read-only dry run of the
    // same registry-order resolution the generator document uses, sharing its cache) plus
    // the URL-budget flag for directory projects. Public, like the other status reads.
    if (parts[1] === 'deps' && parts[2] && parts[3]) {
      if (Number(parts[2]) !== serverChainId()) return wrongChain(res, parts[2]);
      const state = indexer.getProject(parts[3] as Address);
      if (!state) return unknownProject(res);
      return sendJson(res, 200, await depStatusReport(chainClientLazy(), state));
    }
    if (parts[1] === 'project' && parts[2]) {
      const address = parts[2] as Address;
      // GET /api/project/:addr/verify — re-hashes served bytes against the on-chain anchor.
      // BEARER-ONLY: it triggers outbound chain + gateway fetches, so it isn't a public endpoint
      // (anyone can still verify independently via `abx verify` — no need for this node to do it).
      // Reindex moved to the control plane: POST /v1/projects/{chainId}/{address}/reindex.
      if (parts[3] === 'verify') {
        if (!requireBearer(req, res)) return;
        return sendJson(res, 200, await verifyProject(indexer.getProject(address), storage));
      }
      // GET /api/project/:addr/effects — per-token effect status. Derived, never stored:
      // `up-to-date` = artifact present at the CURRENT settled inputsHash (this node's store or a
      // published locator); `rendering`/`failed` = a runner-reported transient row at that key;
      // else `stale`. Rows for effects this resolver doesn't consume are reported verbatim.
      if (parts[3] === 'effects') {
        const state = indexer.getProject(address);
        if (!state) return unknownProject(res);
        return sendJson(res, 200, await effectStatusReport(indexer, state, storage));
      }
      // GET /api/project/:addr/artifacts?token=<id> — the typed artifact-manifest read behind
      // `abx artifacts --remote`. PUBLIC, like /effects and /api/project/:addr: it reports what this
      // node already serves in a tokenURI document, so bearer-gating it would hide nothing.
      // Per-token by construction — a code project's settled `inputsHash` is that token's own, so
      // there is no coherent all-tokens form of this answer.
      if (parts[3] === 'artifacts') {
        const state = indexer.getProject(address);
        if (!state) return unknownProject(res);
        const tokenId = url.searchParams.get('token');
        if (tokenId === null || !/^\d+$/.test(tokenId)) {
          return sendError(res, 400, 'invalid_request', 'artifacts is a per-token read — pass ?token=<decimal id>');
        }
        const token = state.tokens.find((t) => t.tokenId === tokenId);
        // Same code + wording the metadata routes already use for this exact condition, so a client
        // can't tell "unknown token" apart by which route it asked.
        if (!token) return sendError(res, 404, 'not_registered', "unknown token — not minted, and outside this project's supply cap");
        // A burned 721 has no artifacts to report, and saying so as an empty manifest would read as
        // "nothing rendered yet". Answer what the contract answers — the same gate the metadata and
        // image routes apply.
        if (goneIfBurned(res, token)) return;
        return sendJson(
          res,
          200,
          await tokenArtifacts(
            chainClientLazy(),
            state,
            token,
            baseUrl,
            serverChainId(),
            displayMeta(indexer, address),
            storage,
            planeAccess(indexer),
          ),
        );
      }
      // GET /api/project/:addr
      const state = indexer.getProject(address);
      if (!state) return unknownProject(res);
      return sendJson(res, 200, state);
    }
    return sendError(res, 404, 'unknown_route', 'unknown api route', {
      routes: ['/api/projects', '/api/watch', '/api/project/:address', '/api/project/:address/artifacts', '/api/project/:address/effects', '/api/project/:address/verify', '/api/deps/:chainId/:address'],
    });
  }

  // GET /t/:chainId/:addr/:id  and  /t/:chainId/:addr/:id/image
  if (parts[0] === 't' && parts[1] && parts[2] && parts[3] !== undefined) {
    if (Number(parts[1]) !== serverChainId()) return wrongChain(res, parts[1]);
    const address = parts[2] as Address;
    const tokenId = parts[3];
    const state = indexer.getProject(address);
    if (!state) return unknownProject(res);
    // Resolve the issuance token → its metadata-id slot (identity vs. content), synthesizing a
    // pre-mint view for a not-yet-issued id within the cap so metadata warms before mint.
    const token = resolveTokenView(state, tokenId);
    if (!token) return sendError(res, 404, 'not_registered', 'unknown token — not minted, and outside this project\'s supply cap');
    // Before the image / data / metadata branches below: all three would otherwise compose an answer
    // for an id the contract disowns (and `/image` would warm a placeholder for it forever).
    if (goneIfBurned(res, token)) return;

    if (parts[4] === 'image') {
      // the render-effect seam: no explicit image field + a code project ⇒ serve the
      // artifact stored at the CURRENT inputsHash address, when a producer has run.
      const hasImageField =
        token.fields.some((f) => f.field === 'image') ||
        state.collectionFields.some((f) => f.field === 'image');
      if (!hasImageField && isCodeProject(state)) {
        try {
          const {key, found} = await currentRenderArtifact(chainClientLazy(), state, token, storage);
          // `image` is a REFERENCED output (`effects.md → Bound vs referenced`): a producer that
          // doesn't share this node's disk registers a locator (ipfs/ar/https) and we 302 straight to
          // it (gateway resolved at serve time), never proxying its bytes. `found` is the co-located
          // case — the producer wrote the artifact into the backend we share.
          const published = indexer.store.getEffectArtifact(key);
          if (published?.locator) {
            res.writeHead(302, {location: resolveLocatorUrl(state, published.locator), 'cache-control': 'public, max-age=300'});
            res.end();
            return;
          }
          if (found) {
            const artifact = await storage.get(key);
            if (artifact) {
              res.writeHead(200, {
                'content-type': artifact.contentType || 'image/png',
                'cache-control': 'public, max-age=300',
              });
              res.end(artifact.bytes);
              return;
            }
          }
        } catch {
          // fall through to the standard resolution (placeholder) — the seam is best-effort
        }
      }
      const content = await resolveContent(state, token, storage);
      // a computed LOCATOR (renderer returning text/uri-list): the bytes ARE a URI — redirect.
      if (content.contentType === 'text/uri-list') {
        const target = typeof content.body === 'string' ? content.body : new TextDecoder().decode(content.body);
        res.writeHead(302, {location: resolveLocatorUrl(state, target.trim()), 'cache-control': 'public, max-age=300'});
        res.end();
        return;
      }
      res.writeHead(200, {'content-type': content.contentType, 'cache-control': 'public, max-age=300'});
      res.end(content.body);
      return;
    }
    // GET /t/:chainId/:addr/:id/data/{field} and /t/:chainId/:addr/:id/data/{effectKey}/{outputKey}
    // — the plane's byte-serving route (data-plane.md → Serving): declared Content-Type, 302 to a
    // durable locator when one is registered. Effect keys are dot-namespaced, never slashed, so
    // segment count disambiguates a field artifact (1) from an effect artifact (2).
    if (parts[4] === 'data' && parts[5]) {
      if (parts[6] !== undefined) {
        return serveEffectArtifact(res, state, token, parts[5], parts[6], storage, indexer);
      }
      return serveFieldArtifact(res, state, token, parts[5], storage, displayMeta(indexer, address));
    }
    return sendJson(
      res,
      200,
      await buildTokenMetadata(chainClientLazy(), state, token, baseUrl, serverChainId(), displayMeta(indexer, address), storage, planeAccess(indexer)),
    );
  }

  // GET /c/:chainId/:addr  and  /c/:chainId/:addr/data/{field}
  if (parts[0] === 'c' && parts[1] && parts[2]) {
    if (Number(parts[1]) !== serverChainId()) return wrongChain(res, parts[1]);
    const address = parts[2] as Address;
    const state = indexer.getProject(address);
    if (!state) return unknownProject(res);
    if (parts[3] === 'data' && parts[4]) {
      return serveFieldArtifact(res, state, null, parts[4], storage, displayMeta(indexer, address));
    }
    return sendJson(res, 200, await buildContractMetadata(chainClientLazy(), state, baseUrl, serverChainId(), displayMeta(indexer, address), storage));
  }

  return sendRouteError(res, parts);
}

/**
 * The last word of the router: nothing matched. A BARE 404 here is actively misleading — it's the
 * same answer as "this project isn't indexed", so a client that hand-built a URL (dropping the
 * `:id` off `/t/:chainId/:address/:id` and expecting collection metadata is the observed case)
 * reads its own mistake as a service outage and reports a non-bug.
 *
 * So: a KNOWN route prefix with the wrong segment count is a **400 `invalid_request`** naming the
 * correct template, and anything else is a **404 `unknown_route`**. Same `{error, code}` shape the
 * control plane already uses (remote-services.md → Errors), so clients key off `code`, not prose.
 *
 * These are hints, not a discoverable API: the route grammar is fixed by the `abx-token-api/v1`
 * interface and committed on-chain per contract (`tokenURIBase`/`contractURIBase`). The real fix for
 * a client is to read the URL off the contract (`abx tokenuri` / `abx contracturi`) rather than
 * assembling one — so every hint below points at the grammar it should already have, and never
 * invites a client to treat routes as per-node negotiable.
 */
const ROUTE_TEMPLATES: Record<string, {template: string; what: string}> = {
  t: {template: '/t/:chainId/:address/:id  (· /image · /data/:field)', what: 'token metadata (ERC-721 tokenURI / ERC-1155 uri target)'},
  c: {template: '/c/:chainId/:address  (· /data/:field)', what: 'ERC-7572 collection metadata'},
  a: {template: '/a/:chainId/:address/:id', what: 'the live view of a code project'},
  d: {template: '/d/:chainId/:address', what: 'the per-contract read-only dashboard'},
};

function sendRouteError(res: ServerResponse, parts: string[]): void {
  const known = parts[0] ? ROUTE_TEMPLATES[parts[0]] : undefined;
  if (known) {
    // The single highest-value hint: a `/t/:chainId/:address` with no token id is almost always
    // someone reaching for collection metadata. Name `/c/…` explicitly.
    const missingId = (parts[0] === 't' || parts[0] === 'a') && parts.length === 3;
    return sendError(
      res,
      400,
      'invalid_request',
      `malformed ${known.what} path — use ${known.template}` +
        (missingId ? '. For COLLECTION-level metadata (no token id) use /c/:chainId/:address' : ''),
      {route: known.template, ...(missingId ? {didYouMean: `/c/${parts[1]}/${parts[2]}`} : {})},
    );
  }
  return sendError(res, 404, 'unknown_route', 'this node serves no route at that path', {
    routes: Object.values(ROUTE_TEMPLATES).map((r) => r.template.split('  ')[0]),
    hint: 'a contract commits its own metadata URL on-chain (tokenURIBase/contractURIBase) — read it with `abx tokenuri` / `abx contracturi` instead of building a path',
  });
}

/** The manifest's read surface over the effect-artifact registry (metadata.ts stays store-free). */
function planeAccess(indexer: SelfHostIndexer): PlaneAccess {
  return {
    list: (address, tokenId) => indexer.store.listEffectArtifacts(address, tokenId),
    get: (key) => indexer.store.getEffectArtifact(key),
  };
}

/** Serve one EFFECT artifact's bytes at the CURRENT settled inputsHash. Three sources, in order,
 *  mirroring `effects.md → Bound vs referenced`:
 *   - a registered locator (a REFERENCED output) → **302**, never a proxy: the producer holds those
 *     bytes and its egress stays its own;
 *   - a BOUND output's content, held with the row (≤64KB, this node stitches it into the JSON too);
 *   - this node's own custody at the artifact key — a CO-LOCATED producer sharing the backend.
 *  Else 404 (not produced yet, or stale after a param change — self-invalidation, not an error). */
async function serveEffectArtifact(
  res: ServerResponse,
  state: ProjectState,
  token: TokenState,
  effectKey: string,
  outputKey: string,
  storage: StorageBackend,
  indexer: SelfHostIndexer,
): Promise<void> {
  if (!isCodeProject(state)) return sendJson(res, 404, {error: 'no effect artifacts — not a code project'});
  try {
    const hash = await currentSettledInputsHash(chainClientLazy(), state, token);
    const key = renderArtifactKey(state.chainId, state.address, token.tokenId, hash, outputKey, effectKey);
    const row = indexer.store.getEffectArtifact(key);
    if (row?.locator) {
      res.writeHead(302, {location: resolveLocatorUrl(state, row.locator), 'cache-control': 'public, max-age=300'});
      res.end();
      return;
    }
    if (row?.bytes) {
      res.writeHead(200, {
        'content-type': row.contentType || 'application/octet-stream',
        'cache-control': 'public, max-age=300',
      });
      res.end(row.bytes);
      return;
    }
    const stored = await storage.get(key);
    if (stored) {
      res.writeHead(200, {
        'content-type': row?.contentType || stored.contentType || 'application/octet-stream',
        'cache-control': 'public, max-age=300',
      });
      res.end(stored.bytes);
      return;
    }
  } catch {
    // fall through to the 404 — the route is best-effort, like the image seam
  }
  return sendJson(res, 404, {
    error: `no ${effectKey}/${outputKey} artifact at the current inputsHash — not produced yet, or re-addressed by a param change (re-runs on the next sweep)`,
  });
}

/** Serve one FIELD artifact's bytes (token scope with collection fallback; `token === null` =
 *  collection scope): on-chain content decoded (inline/reader ±gzip), computed content
 *  (`renderer` — eth_call, typed by the returned contentType), custody bytes by hash,
 *  302 for locator forms — with the declared-type ladder's Content-Type. */
async function serveFieldArtifact(
  res: ServerResponse,
  state: ProjectState,
  token: TokenState | null,
  field: string,
  storage: StorageBackend,
  display: DisplayMeta,
): Promise<void> {
  if (field === 'code') return sendJson(res, 404, {error: '`code` is never served verbatim — the live view serves the program'});
  const entry = (token ? fieldOf(token.fields, field) : null) ?? fieldOf(state.collectionFields, field);
  if (!entry) return sendJson(res, 404, {error: `no '${field}' field set`});
  const tokenId = token?.tokenId ?? '0';
  try {
    const onChain = await resolveFieldBytes(chainClientLazy(), entry);
    if (onChain) {
      res.writeHead(200, {
        'content-type': await fieldMimeType(chainClientLazy(), state, entry, field, tokenId, display, storage),
        'cache-control': 'public, max-age=300',
      });
      res.end(onChain);
      return;
    }
    // computed on-chain at read — the collection surface passes the sentinel id (no token).
    const rendered = await resolveFieldRendered(
      chainClientLazy(),
      state.address,
      token?.tokenId ?? COLLECTION_TOKEN_ID,
      field,
      entry,
    );
    if (rendered) {
      if (rendered.contentType === 'text/uri-list') {
        const target = new TextDecoder().decode(rendered.bytes).trim();
        res.writeHead(302, {location: resolveLocatorUrl(state, target), 'cache-control': 'public, max-age=300'});
        res.end();
        return;
      }
      res.writeHead(200, {'content-type': rendered.contentType, 'cache-control': 'public, max-age=300'});
      res.end(rendered.bytes);
      return;
    }
    if (entry.representation === R.keccak256 || entry.representation === R.sha256) {
      const stored = await storage.get(entry.value);
      if (stored) {
        res.writeHead(200, {
          'content-type': stored.contentType || 'application/octet-stream',
          'cache-control': 'public, max-age=300',
        });
        res.end(stored.bytes);
        return;
      }
      const bridged = display.contentLocators?.[entry.value.toLowerCase()];
      if (bridged) {
        res.writeHead(302, {location: resolveLocatorUrl(state, bridged), 'cache-control': 'public, max-age=300'});
        res.end();
        return;
      }
      return sendJson(res, 404, {error: `'${field}' bytes not in this node's custody (on-chain ${entry.representation} anchor only)`});
    }
    const locator = fieldLocatorUrl(state, entry, tokenId);
    if (locator) {
      res.writeHead(302, {location: resolveLocatorUrl(state, locator), 'cache-control': 'public, max-age=300'});
      res.end();
      return;
    }
  } catch (err) {
    return sendJson(res, 502, {error: `field '${field}' failed to resolve: ${(err as Error).message}`});
  }
  return sendJson(res, 404, {error: `'${field}' (${entry.representation}) is not byte-servable from this node`});
}

/** A locator-representation field's URL (`{id}` substituted), or null for non-locator forms. */
function fieldLocatorUrl(
  state: ProjectState,
  entry: {representation: string; value: Hex},
  tokenId: string,
): string | null {
  // Content-addressed values are IDENTITY, not URLs — since v11 a field stores the bare CID/txid,
  // so returning it raw would 302 a browser to `Location: bafy…`. Project it exactly as the
  // metadata document does, through the collection's preferred gateway.
  if (entry.representation === R.ipfs || entry.representation === R.arweave) {
    const network = entry.representation === R.ipfs ? 'ipfs' : 'arweave';
    const text = Buffer.from(entry.value.slice(2), 'hex').toString('utf8').trim();
    if (!text) return null;
    return projectGatewayUrl(network, text, projectGatewayPrefix(state, network, gatewayConfigFromEnv()), tokenId);
  }
  if (entry.representation === R.url) {
    const text = Buffer.from(entry.value.slice(2), 'hex').toString('utf8').trim();
    return text || null;
  }
  if (entry.representation === R.urlTemplate) {
    const text = Buffer.from(entry.value.slice(2), 'hex').toString('utf8');
    return text.split('{id}').join(tokenId);
  }
  return null; // renderer is dispatched above; anything else has no locator form
}

/** Operator display metadata (creator's description/external_url/traits + bridged locators) from the
 *  registration — survives re-index. The off-chain attributes + content locators are JSON columns. */
function displayMeta(indexer: SelfHostIndexer, address: Address): DisplayMeta {
  const reg = indexer.store.getRegistration(address);
  return {
    description: reg?.description,
    externalUrl: reg?.externalUrl,
    attributes: reg?.attributes ? safeAttributes(reg.attributes) : undefined,
    tokenAttributes: reg?.tokenAttributes ? safeTokenAttributes(reg.tokenAttributes) : undefined,
    contentLocators: reg?.contentLocators ? safeLocators(reg.contentLocators) : undefined,
  };
}

/** Parse a stored off-chain attributes JSON column → normalized OpenSea traits (never throws). */
function safeAttributes(json: string): DisplayMeta['attributes'] {
  try {
    return normalizeAttributes(JSON.parse(json));
  } catch {
    return undefined;
  }
}

/** Parse the per-token off-chain attributes column (`{ "<tokenId>": attrs }`) → normalized per token. */
function safeTokenAttributes(json: string): DisplayMeta['tokenAttributes'] {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return undefined;
    const out: Record<string, OpenSeaAttribute[]> = {};
    for (const [tokenId, v] of Object.entries(obj)) {
      const attrs = normalizeAttributes(v);
      if (attrs.length) out[tokenId] = attrs;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyProject(state: ProjectState | null, storage: StorageBackend) {
  if (!state) return {error: 'unknown project'};
  const tokens = await Promise.all(
    state.tokens.map(async (t) => {
      const {body} = await resolveContent(state, t, storage);
      // verify the served image bytes against the on-chain `image` field when it carries a hash
      const image = fieldOf(t.fields, F.image);
      const isHash = image && (image.representation === R.keccak256 || image.representation === R.sha256);
      const checks = isHash
        ? [{kind: image.representation, committed: image.value, verified: verifyAgainstHash(body, image)}]
        : [];
      return {tokenId: t.tokenId, checks};
    }),
  );
  return {address: state.address, tokens};
}

/**
 * Per-token effect status for a project — the "did every thumbnail land?" surface behind
 * `GET /api/project/:addr/effects` and `abx verify`. Status is DERIVED, in precedence order:
 * artifact present at the current settled inputsHash (own store or published locator) →
 * `up-to-date`; a runner-reported transient row at that key → `rendering` | `failed`; else
 * `stale` (work the effects layer hasn't landed yet). Non-render effects the resolver doesn't
 * consume are included verbatim from their reported rows — effect-agnostic by construction.
 */
async function effectStatusReport(
  indexer: SelfHostIndexer,
  state: ProjectState,
  storage: StorageBackend,
): Promise<Record<string, unknown>> {
  const reported = indexer.store.listEffectStatuses(state.address);
  const byKey = new Map(reported.map((r) => [r.key.toLowerCase(), r]));
  const tokens: Array<Record<string, unknown>> = [];
  const counts = {upToDate: 0, stale: 0, rendering: 0, failed: 0};
  if (isCodeProject(state)) {
    // Live tokens only: a destroyed id has no render to be up-to-date about, and reporting one
    // would keep a producer re-rendering it forever.
    for (const token of state.tokens.filter((t) => t.lifecycle === 'live')) {
      const {key, found} = await currentRenderArtifact(chainClientLazy(), state, token, storage);
      const published = !found && !!indexer.store.getEffectArtifact(key);
      const row = byKey.get(key.toLowerCase());
      let status: 'up-to-date' | 'rendering' | 'failed' | 'stale';
      if (found || published) status = 'up-to-date';
      else if (row) status = row.status;
      else status = 'stale';
      counts[status === 'up-to-date' ? 'upToDate' : status] += 1;
      byKey.delete(key.toLowerCase());
      tokens.push({
        tokenId: token.tokenId,
        effectKey: 'render',
        status,
        key,
        ...(row?.error ? {error: row.error} : {}),
        ...(row?.attempts ? {attempts: row.attempts} : {}),
        ...(row?.updatedAt ? {updatedAt: row.updatedAt} : {}),
      });
    }
  }
  // Any remaining reported rows belong to effects this resolver doesn't consume — pass through.
  const other = [...byKey.values()].map((r) => ({
    tokenId: r.tokenId,
    effectKey: r.effectKey,
    status: r.status,
    key: r.key,
    ...(r.error ? {error: r.error} : {}),
    ...(r.attempts ? {attempts: r.attempts} : {}),
    ...(r.updatedAt ? {updatedAt: r.updatedAt} : {}),
  }));
  return {address: state.address, counts, tokens: [...tokens, ...other]};
}

/**
 * Chain-watcher liveness behind `GET /api/watch`. Pure read of the `meta` k/v the watcher stamps
 * each tick (`watch:pollAt`, `watch:<chainKey>:head`, `watch:<chainKey>` = watched-through block,
 * `watch:lastDeltaAt`). `watching:false` when nothing has been recorded (watcher off / never ran).
 * The reader judges freshness from `pollAt` vs `intervalMs` — a stale `pollAt` means it stopped.
 */
function watchStatusReport(indexer: SelfHostIndexer): Record<string, unknown> {
  const pollAt = indexer.store.getMeta('watch:pollAt');
  const chainKeys = [...new Set(indexer.store.listRegistrations().map((r) => r.chainKey))];
  const chains: Record<string, {head: string | null; watchedThrough: string | null}> = {};
  for (const ck of chainKeys) {
    chains[ck] = {
      head: indexer.store.getMeta(`watch:${ck}:head`),
      watchedThrough: indexer.store.getMeta(`watch:${ck}`),
    };
  }
  return {
    watching: pollAt !== null,
    intervalMs: watchIntervalMs(),
    pollAt,
    lastDeltaAt: indexer.store.getMeta('watch:lastDeltaAt'),
    chains,
  };
}

/**
 * The path was well-formed and on the right chain — this node just doesn't index that contract.
 * Code `not_registered` (the control plane's own code for the same condition) so a client can tell
 * it apart from a malformed path (400 `invalid_request`) and a nonexistent route (404
 * `unknown_route`). Those three used to be one indistinguishable `{error: '…'}` 404.
 */
function unknownProject(res: ServerResponse): void {
  sendError(res, 404, 'not_registered', 'this node does not index that contract', {
    hint: 'register it with `abx add <address> --remote <name|url>` (bearer-gated control plane), then `abx index <address> --remote`',
  });
}

/**
 * A path whose chainId segment isn't the chain this resolver serves. **400 `unsupported_chain`**,
 * matching the control plane's `checkChain` exactly (control-plane.ts) — it's a request error, not a
 * missing resource, and answering 404 made it indistinguishable from "that project isn't indexed
 * here", which sent at least one client hunting a phantom outage. `chains` says what IS served.
 */
function wrongChain(res: ServerResponse, got: string): void {
  sendError(res, 400, 'unsupported_chain', `this resolver serves chain ${serverChainId()}, not ${got}`, {
    chains: [serverChainId()],
  });
}
