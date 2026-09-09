import {
  decodeParam,
  fieldOf,
  inlineText,
  renderArtifactKey,
  stitchAttributes,
  verifyAgainstHash,
  METADATA_FIELD as F,
  METADATA_REPRESENTATION as R,
  RESERVED_TOKEN_DATA_KEYS,
  gatewayConfigFromEnv,
  projectGatewayPrefix,
  projectGatewayUrl,
  type Hex,
  type MetadataField,
  type OpenSeaAttribute,
  type ParamValue,
  type ProjectState,
  type PublicClient,
  type TokenState,
} from '@artblocks/abx-sdk';
import {contentTypeFromPath, type StorageBackend} from '@artblocks/abx-storage';
import {resolveFieldBytes, resolveFieldRendered, COLLECTION_TOKEN_ID} from './resolve.js';
import {currentRenderArtifact, currentSettledInputsHash, isCodeProject, liveViewEnabled, liveViewUrl} from './code.js';

/**
 * Standard, marketplace-facing metadata, built from the reconstructed projection by the
 * protocol rule: each field has ONE active on-chain representation — if set, it wins;
 * otherwise the off-chain operator value fills in; otherwise a default. Every served field
 * gets an `abx_provenance` entry saying where it came from and whether the chain vouches for it.
 */

export function tokenImageUrl(baseUrl: string, chainId: number, address: string, tokenId: string): string {
  return `${baseUrl}/t/${chainId}/${address}/${tokenId}/image`;
}

/** Operator-supplied off-chain display metadata (from the registration — survives re-index). */
export interface DisplayMeta {
  description?: string;
  externalUrl?: string;
  /** Operator's OpenSea attributes, stitched UNDER any on-chain `attributes` (on-chain wins).
   *  Collection-scope (a 1/1's traits, or a Series' shared/fallback). */
  attributes?: OpenSeaAttribute[];
  /** Operator's PER-TOKEN off-chain attributes, keyed by tokenId string — a Series' editable traits.
   *  A token's entry wins over the collection-scope `attributes`; on-chain `attributes` wins over both. */
  tokenAttributes?: Record<string, OpenSeaAttribute[]>;
  /**
   * Durable, gateway-agnostic locators for off-chain content, keyed by the field's on-chain
   * `keccak256`/`sha256` hash (lowercased) → e.g. `ipfs://<cid>`. Bridged from the deployer's
   * content index via the admin control plane, so a remote resolver can point the `image` at
   * IPFS/Arweave directly — without holding the bytes or any storage credentials itself.
   */
  contentLocators?: Record<string, string>;
}

/**
 * Per-field source transparency — emitted as `abx_provenance` in the served JSON.
 *
 * `status` replaces the old ambiguous `verifiedAgainstChain: boolean | null` (which conflated
 * "the value IS on-chain, nothing to verify" with "an off-chain value we haven't checked"):
 *  - `on-chain`   — the value lives on-chain (or is reconstructable from chain); nothing to verify.
 *  - `verified`   — an off-chain value we re-hashed against its on-chain anchor — it matched.
 *  - `mismatch`   — re-hashed against the anchor — it did NOT match (served bytes are wrong).
 *  - `anchored`   — off-chain bytes with an on-chain hash anchor, not re-hashed at build time
 *                   (anyone can verify any gateway's bytes against the anchor — `abx verify` / `/verify`).
 *  - `off-chain`  — a plain off-chain operator value with no on-chain anchor. A benign by-design
 *                   state (e.g. an operator-supplied description), NOT a failure — distinct from a
 *                   hash check that didn't run (`anchored`) or didn't match (`mismatch`).
 *  - `n/a`        — a placeholder/default; provenance doesn't apply.
 */
export type ProvenanceStatus = 'on-chain' | 'verified' | 'mismatch' | 'anchored' | 'off-chain' | 'n/a';

export interface FieldProvenance {
  field: string;
  source:
    | 'inline'
    | 'inline-gzip'
    | 'reader'
    | 'reader-gzip'
    | 'renderer'
    | 'keccak256'
    | 'sha256'
    | 'arweave'
    | 'ipfs'
    | 'url'
    | 'url-template'
    | 'off-chain'
    | 'fallback'
    | 'placeholder'
    | `effect:${string}` // an effect output at the current inputsHash (re-creatable, chain-addressed)
    | 'live-view'; // the derived live-view route for a code project (params injected at load)
  /** NOTE: there is deliberately no `onChain` boolean. It was exactly `status === 'on-chain'`, so it
   *  carried no information — and it carried the on-chain renderer's ambiguity with it, where the
   *  same field claimed `false` for a `url` (whose URL string IS stored on chain) and `true` for an
   *  `inline` value that was itself a pointer. `source` says where the bytes came from and `status`
   *  says what was verified about them; whether a given value resolves on chain is visible in the
   *  value, and that determination belongs to the reader. */
  status: ProvenanceStatus;
  /** Integrity-anchor kind for off-chain bytes, e.g. `keccak256` — the on-chain hash you verify against. */
  anchor?: 'keccak256' | 'sha256';
  note: string;
}

/** One entry of the `artifacts` manifest (`site/content/docs/protocol/data-plane.mdx`) — exactly
 *  `{key, mimeType, uri}`, all required, nothing optional. */
export interface ArtifactEntry {
  key: string;
  mimeType: string;
  uri: string;
}

/** The shape of a producer-registered effect-artifact row this module consumes (structurally
 *  `@artblocks/abx-indexer`'s EffectArtifactRow — kept structural so tests need no store). */
export interface PlaneArtifactRow {
  key: string;
  effectKey: string;
  outputKey: string;
  contentType: string | null;
  locator: string | null;
  /** A BOUND output's content (`site/content/docs/protocol/effects.mdx → Bound vs referenced`) — the bytes that
   *  stitch into this JSON, held with the row. `null`/absent for every referenced output. */
  bytes?: Uint8Array | null;
  /** The inputsHash this row was rendered at, when the plane reports one. Optional and read-only:
   *  the manifest's own currency filter never consults it (it recomputes the row's KEY against the
   *  live inputsHash instead — see `buildTokenArtifacts` below), so an older row or a minimal test
   *  double may omit it without affecting what gets served. It exists purely for a read that wants
   *  to SHOW a stale row's own hash rather than merely knowing it doesn't match (`tokenArtifacts`). */
  inputsHash?: string;
}

/** The resolver's read surface over the effect-artifact registry — how the manifest enumerates
 *  the plane's effect source without learning any effect's internals. */
export interface PlaneAccess {
  /** Every registered row for (project, token) — filtered here by current-inputsHash key match. */
  list(address: string, tokenId: string): PlaneArtifactRow[];
  /** One row by artifact key (the image seam's published-locator check). */
  get(key: string): PlaneArtifactRow | null;
}

/** How the bytes reached the document — the off-chain twin of `AbxMetadataRenderer._sourceNote`.
 *  `url`/`url-template` say "locator" because that is what the REPRESENTATION means by
 *  construction, not because anything parsed the string. */
const sourceNote = (rep: string): string => {
  if (rep === R.url) return 'stored on chain; the value is a locator';
  if (rep === R.urlTemplate) return 'composed on chain from a stored template; a locator';
  if (rep === R.renderer) return 'computed on chain (field renderer)';
  if (rep === R.inlineGzip || rep === R.readerGzip) return `stored on chain (${rep} — inflated off-chain)`;
  if (rep === R.reader) return 'stored on chain (chunked)';
  return 'stored on chain';
};

const onChainProv = (field: string, rep: string, fromCollection = false): FieldProvenance => ({
  field,
  source: rep as FieldProvenance['source'],
  status: 'on-chain',
  // Mirrors AbxMetadataRenderer._sourceNote exactly — the two lanes describe the same routes in
  // the same words, and neither claims anything about where a value RESOLVES.
  note: scopeNote(sourceNote(rep), fromCollection),
});

/** Tag a provenance note with `[collection]` when the value came from the collection scope
 *  (a token field fell back to the contract-wide field). Mirrors the on-chain renderer. */
const scopeNote = (note: string, fromCollection: boolean): string => (fromCollection ? `${note} [collection]` : note);

/** Substitute the decimal tokenId for every `{id}` in a URL template (mirrors the renderer). */
const applyTemplate = (template: string, tokenId: string): string => template.split('{id}').join(tokenId);

/**
 * Read a token field with COLLECTION-scope fallback: the token-scope field wins; else the
 * contract-wide field. Mirrors {AbxMetadataRenderer._field}, so one collection-scope field
 * (e.g. an `image` `url-template`) covers every token in O(1) storage.
 */
function fieldWithFallback(
  tokenFields: MetadataField[],
  collectionFields: MetadataField[] | undefined,
  field: string,
): {entry: MetadataField | null; fromCollection: boolean} {
  const t = fieldOf(tokenFields, field);
  if (t) return {entry: t, fromCollection: false};
  const c = collectionFields ? fieldOf(collectionFields, field) : null;
  return {entry: c, fromCollection: !!c};
}

/** Provenance for an off-chain-served value, verified against the field's hash anchor if it carries one. */
function offChainProv(field: string, entry: MetadataField | null, served: string): FieldProvenance {
  const verified = entry ? verifyAgainstHash(served, entry) : null;
  const anchor =
    entry && (entry.representation === R.keccak256 || entry.representation === R.sha256)
      ? (entry.representation as 'keccak256' | 'sha256')
      : undefined;
  const status: ProvenanceStatus = verified === true ? 'verified' : verified === false ? 'mismatch' : 'off-chain';
  // Notes are a short, DECLARATIVE gloss for whoever reads the served JSON (marketplaces, clients)
  // — never an operator instruction ("run abx …"); the structured fields carry the signal, and
  // how-to-act guidance lives in the CLI/skill, not the public metadata.
  const note =
    verified === true
      ? `off-chain bytes; on-chain ${anchor} anchor verified`
      : verified === false
        ? `off-chain bytes; on-chain ${anchor} anchor MISMATCH`
        : 'off-chain operator metadata; no on-chain anchor';
  return {field, source: 'off-chain', status, anchor, note};
}

const placeholderProv = (field: string, note = 'placeholder — unset'): FieldProvenance => ({
  field,
  source: 'placeholder',
  status: 'n/a',
  note,
});

/** The `name` fallback: the contract's `name()` (on-chain storage — `CollectionMetadataLib`,
 *  shared by the 721 and 1155 bases) + tokenId. `source` is "fallback" (not from the metadata
 *  field store) but the value is reconstructable from chain alone, so it's `on-chain` — mirrors
 *  the on-chain renderer's _resolveName. */
const fallbackNameProv = (note: string): FieldProvenance => ({
  field: F.name,
  source: 'fallback',
  status: 'on-chain',
  note,
});

/**
 * The `name` fallback's provenance, told truthfully about which read actually produced it.
 *
 * `state.name` is a value the spine only *pings*, so `reconstructProject` reads it at head — and a
 * head read that fails is persisted as `null`, indistinguishable from a contract that genuinely has
 * no name. The fallback then serves `state.address`, and the old note still claimed the value came
 * from `ERC-721 name()`. A hosted node served `"name": "0xb844…c35e56 #0"` beside
 * `note: "on-chain (ERC-721 name() + #id)"` while that contract's `name()` was `ABXdoku`; it
 * self-corrected on the next re-index, which is the signature of the head-read theory.
 *
 * The wrong name is cosmetic. Provenance is the surface you'd point a creator at to audit their own
 * metadata, so a false positive there costs more than the name does. We deliberately do NOT
 * adjudicate *why* the read came back empty — the projection cannot tell an unnamed contract from a
 * failed read, and guessing is how the original note came to lie.
 */
const nameFallbackProv = (named: boolean, suffix: string): FieldProvenance =>
  fallbackNameProv(
    named
      ? `on-chain (name()${suffix})`
      : `on-chain (contract address${suffix}) — name() returned no value`,
  );

/** Resolve a text field: on-chain content (inline/reader ±gzip, or `renderer` computed at read) →
 *  off-chain operator value → fallback default. On-chain content is decoded via the shared resolver
 *  (eth_call for `reader` and `renderer`), so a large reader-backed description resolves off-chain
 *  exactly as on-chain.
 *
 *  `opts.uriRoute` marks a **URI-valued** field (`animation_url`): its stored bytes ARE the document,
 *  so they cannot land as the value — a marketplace iframe would get HTML where it expected a URL.
 *  The on-chain renderer has no URL space and must inline them as a `data:` URI; this node has one,
 *  so it serves the same bytes at `uriRoute` (the data plane's `/…/data/{field}` route, declared
 *  Content-Type, 302 to a durable locator when one exists) and carries the route as the value —
 *  exactly what `image` has always done for the same content, through the same kind of route.
 *
 *  Why not the `data:` wrap here too: the value is repeated verbatim into the `artifacts` listing, so
 *  a multi-megabyte inline document shipped TWICE in a document marketplaces re-fetch on every view,
 *  while the sibling `image` — usually the smaller asset — shipped as a link. The wrap was also
 *  already the exception rather than the rule off chain: a code project's `animation_url` has always
 *  been the live-view route. A locator representation (`url`/`url-template`, or a computed
 *  `text/uri-list`) still lands verbatim — it is already a URI, and re-hosting it would hide it.
 *
 *  `tokenAddress` is positional, not an opt, deliberately: it is only needed for the `renderer`
 *  eth_call, and an optional field that silently disables a whole representation is exactly how
 *  that branch went missing here in the first place. The compiler now makes every call site say it. */
async function resolveText(
  client: PublicClient,
  tokenAddress: string,
  fields: MetadataField[],
  field: string,
  offChain: string | undefined,
  fallback: string | null,
  // Explicit `| undefined` rather than optional: `opts` after it carries the REQUIRED gateway
  // prefixes, and an optional parameter cannot precede a required one. Every call site already
  // passes this positionally anyway.
  fallbackProv: FieldProvenance | undefined,
  opts: {gateways: GatewayPrefixes; collectionFields?: MetadataField[]; tokenId?: string; uriRoute?: string},
): Promise<{value: string | null; prov: FieldProvenance}> {
  const {entry, fromCollection} = fieldWithFallback(fields, opts.collectionFields, field);
  // on-chain content (inline/reader, ±gzip) → the document bytes, decoded.
  const onChain = await resolveFieldBytes(client, entry);
  if (onChain !== null && entry) {
    // The bytes reached the document either way; `uriRoute` only decides whether they ride IN it.
    const value = opts.uriRoute ?? new TextDecoder().decode(onChain);
    return {value, prov: onChainProv(field, entry.representation, fromCollection)};
  }
  // Computed on-chain at read (`renderer`) — the field's value is a field-renderer address, so the
  // content only exists after an eth_call. This branch mirrors {AbxMetadataRenderer._appendText}'s
  // R_RENDERER arm **exactly**, because the two must agree: with `tokenURIRenderer` set the chain
  // assembles this JSON and this resolver merely re-serves it, so any difference here is a resolver
  // that contradicts the token's own tokenURI. Hence the declared contentType is used verbatim
  // (`renderer` is the one representation that types itself on-chain) rather than assuming HTML.
  //
  // The `text/uri-list` exception (RFC 2483 — "this payload is a URI") carries the whole reason a
  // URI-valued field can't just be data-wrapped: the computed bytes ARE a locator, so they land
  // verbatim and stay dereferenceable. That is the canonical generator's directory branch.
  let rendererFailure: string | null = null;
  if (entry && entry.representation === R.renderer) {
    try {
      const rendered = await resolveFieldRendered(
        client,
        tokenAddress,
        opts.tokenId ?? COLLECTION_TOKEN_ID,
        field,
        entry,
      );
      if (rendered) {
        const uriList = rendered.contentType === 'text/uri-list';
        const text = new TextDecoder().decode(rendered.bytes);
        // A computed locator lands verbatim (it IS a URI); computed CONTENT on a URI-valued field
        // goes to the route, same as stored content above; a plain text field carries the text.
        const value = uriList ? text.trim() : (opts.uriRoute ?? text);
        // ONE provenance for both arms. The `text/uri-list` arm used to hand-build an object that
        // was byte-identical to this call — same keys, same order, the same note string typed a
        // second time — so the only thing the branch could ever do was drift from `sourceNote`.
        return {value, prov: onChainProv(field, R.renderer, fromCollection)};
      }
    } catch (err) {
      // `IAbxFieldRenderer`'s first invariant is NEVER REVERT, but a resolver cannot rely on a
      // third-party contract honouring it — a reverting renderer must degrade this one field, not
      // 500 the whole token's metadata. We still fall through to the operator's off-chain value
      // (better than nothing), but the provenance says the on-chain attempt failed rather than
      // quietly reporting `off-chain` as if nothing were committed on-chain.
      rendererFailure = (err as Error).message;
      console.warn(`[metadata] field renderer for '${field}' on ${tokenAddress} reverted: ${rendererFailure}`);
    }
  }
  const noteRendererFailure = <T extends {prov: FieldProvenance}>(out: T): T =>
    rendererFailure === null
      ? out
      : {...out, prov: {...out.prov, note: `${out.prov.note} — on-chain field renderer reverted, so it could not be used`}};
  // Content-addressed locator (`ipfs`/`arweave`): the CID/txid is identity, the collection's
  // preferred gateway is what makes it dereferenceable. Mirrors {AbxMetadataRenderer._appendText}'s
  // v11 arm. A value that locates nothing (`ipfs://` with no CID) falls through and omits, rather
  // than emitting a bare gateway prefix that 404s.
  if (entry && (entry.representation === R.ipfs || entry.representation === R.arweave)) {
    const wrapped = gatewayFieldUrl(
      entry,
      opts.gateways,
      opts.tokenId === COLLECTION_TOKEN_ID ? undefined : opts.tokenId,
    );
    if (wrapped !== null) {
      return {
        value: wrapped,
        prov: {
          field,
          source: entry.representation as FieldProvenance['source'],
          status: 'on-chain',
          note: scopeNote(GATEWAY_SOURCE_NOTE, fromCollection),
        },
      };
    }
  }
  // on-chain locator carried AS the text value (url, or url-template with {id} substituted).
  if (entry && (entry.representation === R.url || entry.representation === R.urlTemplate)) {
    const raw = inlineText(entry);
    const value = entry.representation === R.urlTemplate && opts.tokenId != null ? applyTemplate(raw, opts.tokenId) : raw;
    return {
      value,
      prov: {
        field,
        source: entry.representation as FieldProvenance['source'],
        status: 'on-chain',
        note: scopeNote('stored on chain; the value is a locator', fromCollection),
      },
    };
  }
  if (offChain != null) {
    return noteRendererFailure({value: offChain, prov: offChainProv(field, entry, offChain)});
  }
  if (fallback != null) {
    return noteRendererFailure({
      value: fallback,
      prov: fallbackProv ?? placeholderProv(field, 'default (no on-chain or off-chain value)'),
    });
  }
  return noteRendererFailure({value: null, prov: placeholderProv(field)});
}

/**
 * The project's preferred gateway prefix per scheme, resolved ONCE per document.
 *
 * The off-chain twin of `AbxMetadataRenderer._gatewayPrefix` (spec v11): the collection's reserved
 * `abx_gateway_ipfs` / `abx_gateway_arweave` field, else this host's env default, else the public
 * floor. Two conforming resolvers given the same chain must emit the same `image`, so the env read
 * is a FLOOR and never an override — a project that stated a preference on chain gets that
 * preference from every resolver, and a host's own gateway only ever fills a silence (which is the
 * only way a managed provider serving a token it does not own can offer a better default).
 */
export function projectGateways(state: Pick<ProjectState, 'collectionFields'>): GatewayPrefixes {
  const env = gatewayConfigFromEnv();
  return {
    ipfs: projectGatewayPrefix(state, 'ipfs', env),
    arweave: projectGatewayPrefix(state, 'arweave', env),
  };
}

/** The two prefixes, threaded through a document build. Required rather than optional wherever it
 *  is passed, for the reason {@link resolveText} gives about `tokenAddress`: an optional input that
 *  silently disables a whole representation is how the `renderer` branch went missing here once. */
export interface GatewayPrefixes {
  ipfs: string;
  arweave: string;
}

/** The provenance note for a content-addressed locator. Byte-identical to the deployed renderer's
 *  `_sourceNote` for `ipfs`/`arweave` — deliberately "served through", never "verified": the
 *  locator is on chain, the bytes are not, and nothing here re-hashes what a gateway returns. */
const GATEWAY_SOURCE_NOTE =
  "stored on chain; a content-addressed locator, served through the collection's preferred gateway";

/** Project a content-addressed field value the way the deployed renderer does, or `null` when the
 *  value locates nothing. `tokenId` omitted ⇒ no `{id}` substitution (the collection surface). */
function gatewayFieldUrl(entry: MetadataField, gateways: GatewayPrefixes, tokenId?: string): string | null {
  const network = entry.representation === R.ipfs ? 'ipfs' : 'arweave';
  return projectGatewayUrl(network, inlineText(entry).trim(), gateways[network], tokenId);
}

/**
 * Map a locator to the provenance `source` describing where the bytes actually live. Locators are
 * typically **gateway HTTPS URLs** (`https://<gw>/ipfs/<cid>`, `https://<gw>/<txid>`) — the form
 * that renders everywhere — so we detect the backend from the URL shape, not just a `ipfs://`/`ar://`
 * scheme. An IPFS gateway URL still reports `source: ipfs` (not the generic `url`).
 */
function sourceForLocator(locator: string): FieldProvenance['source'] {
  const l = locator.toLowerCase();
  if (l.startsWith('ipfs://') || l.includes('/ipfs/') || /\.ipfs\./.test(l)) return 'ipfs';
  if (l.startsWith('ar://') || l.includes('arweave.net')) return 'arweave';
  return 'url';
}

/**
 * The `image` URL the metadata points at, with matching provenance. The image is *required*,
 * so this always returns a usable URL. Cases, by the field's single active representation:
 *  - on-chain content (`inline`/`reader`, ±gzip) → this node's `/…/image` route serves the
 *    decoded bytes; `on-chain`.
 *  - off-chain by hash (`keccak256`/`sha256`) → a durable `ipfs://`/`ar://` locator when we have
 *    one (bridged or from the active backend) so the heavy asset resolves peer-to-peer; else
 *    this node's `/…/image` route serves it from custody. Either way it's `anchored` by the
 *    on-chain hash (verify via `/verify`).
 *  - content-addressed on-chain (`ipfs`/`arweave`) → the CID/txid wrapped in the collection's
 *    preferred gateway prefix, so what lands in `image` is an `https://` a wallet can render;
 *    `on-chain`.
 *  - locator on-chain (`url`) → the on-chain pointer IS the URL; `on-chain`.
 *  - unset → this node's `/…/image` route serves the deterministic generative placeholder.
 */
async function resolveImage(
  state: ProjectState,
  token: TokenState,
  baseUrl: string,
  chainId: number,
  display: DisplayMeta,
  storage?: StorageBackend,
): Promise<{url: string; prov: FieldProvenance}> {
  const nodeUrl = tokenImageUrl(baseUrl, chainId, state.address, token.tokenId);
  // token-scope image wins; else the collection-scope image (the O(1) directory pattern).
  const {entry, fromCollection} = fieldWithFallback(token.fields, state.collectionFields, F.image);
  if (!entry) {
    return {url: nodeUrl, prov: placeholderProv(F.image, 'placeholder — generative-from-address (no committed image)')};
  }

  // On-chain content: the node serves the decoded bytes; nothing off-chain to locate.
  if (
    entry.representation === R.inline ||
    entry.representation === R.inlineGzip ||
    entry.representation === R.reader ||
    entry.representation === R.readerGzip
  ) {
    return {url: nodeUrl, prov: onChainProv(F.image, entry.representation, fromCollection)};
  }

  // Locator with a {id} placeholder → substitute the tokenId (one collection field → whole
  // directory). The on-chain pointer IS the URL, keyed to a pinned IPFS dir / Arweave manifest.
  if (entry.representation === R.urlTemplate) {
    const url = applyTemplate(inlineText(entry), token.tokenId);
    return {
      url,
      prov: {
        field: F.image,
        source: 'url-template',
        status: 'on-chain',
        note: scopeNote('on-chain url template -> off-chain content', fromCollection),
      },
    };
  }

  // Off-chain bytes anchored by an on-chain hash. Point at a durable locator if we have one.
  if (entry.representation === R.keccak256 || entry.representation === R.sha256) {
    const anchor = entry.representation as 'keccak256' | 'sha256';
    const bridged = display.contentLocators?.[entry.value.toLowerCase()];
    const locator = bridged ?? (storage?.locator ? await storage.locator(entry.value) : null);
    if (locator) {
      return {
        url: locator,
        prov: {
          field: F.image,
          source: sourceForLocator(locator),
          status: 'anchored',
          anchor,
          note: `off-chain bytes (${sourceForLocator(locator)}); on-chain ${anchor} integrity anchor`,
        },
      };
    }
    // No durable locator known here: serve from this node's custody, still anchored on-chain.
    return {
      url: nodeUrl,
      prov: {
        field: F.image,
        source: anchor,
        status: 'anchored',
        anchor,
        note: `off-chain bytes (served by this node); on-chain ${anchor} integrity anchor`,
      },
    };
  }

  // Computed on-chain (`renderer`): the value is a field-renderer address, not a locator — point
  // at this node's route, which eth_calls the renderer and serves the computed bytes (302-ing to the
  // locator if the computed content turns out to BE one). The provenance is the shared one: the route
  // the bytes took is identical to any other on-chain content, and only the served `image` VALUE is
  // this field's documented exception. A hand-built note here drifted from the deployed renderer's
  // `_sourceNote` wording for the same representation.
  if (entry.representation === R.renderer) {
    return {url: nodeUrl, prov: onChainProv(F.image, R.renderer, fromCollection)};
  }

  // Content-addressed ON-CHAIN (ipfs/arweave): the value is identity, not a URL. Wrap it in the
  // collection's preferred gateway — the twin of {AbxMetadataRenderer._resolveImage}'s v11 arm.
  // Before v11 both planes emitted the raw `ipfs://…` here, which no marketplace dereferences, and
  // `--onchain-uri --backend ipfs` worked around it by baking a gateway host into a `url` field.
  if (entry.representation === R.ipfs || entry.representation === R.arweave) {
    const wrapped = gatewayFieldUrl(entry, projectGateways(state), token.tokenId);
    if (wrapped !== null) {
      return {
        url: wrapped,
        prov: {
          field: F.image,
          source: entry.representation as FieldProvenance['source'],
          status: 'on-chain',
          note: scopeNote(GATEWAY_SOURCE_NOTE, fromCollection),
        },
      };
    }
    // locates nothing → fall through to the node's placeholder route rather than a bare prefix
    return {url: nodeUrl, prov: placeholderProv(F.image, 'placeholder — the committed locator names no content')};
  }

  // Locator committed ON-CHAIN (url): the on-chain value is itself the address.
  const onChainLocator = inlineText(entry).trim();
  return {
    url: onChainLocator || nodeUrl,
    prov: {
      field: F.image,
      source: entry.representation as FieldProvenance['source'],
      status: 'on-chain',
      note: scopeNote(`on-chain pointer (${entry.representation}) — bytes off-chain, located on-chain`, fromCollection),
    },
  };
}

// ── the `artifacts` manifest (site/content/docs/protocol/data-plane.mdx) ───────────────────────

/** The registry's reserved field vocabulary — projection/display keys. Every other field tag a
 *  creator sets is a first-class plane artifact. */
const RESERVED_FIELDS = new Set<string>(Object.values(F));

/** contentType cache per (renderer address, field) — stable per renderer in practice. */
const rendererTypeCache = new Map<string, string>();

/** Best-effort declared contentType of a `renderer` field (null on any failure). */
async function rendererContentType(
  client: PublicClient,
  tokenAddress: string,
  entry: MetadataField,
  field: string,
  tokenId: string,
): Promise<string | null> {
  try {
    const cacheKey = `${entry.value}:${field}`;
    const hit = rendererTypeCache.get(cacheKey);
    if (hit) return hit;
    const rendered = await resolveFieldRendered(client, tokenAddress, tokenId, field, entry);
    if (rendered?.contentType) rendererTypeCache.set(cacheKey, rendered.contentType);
    return rendered?.contentType || null;
  } catch {
    return null;
  }
}

/**
 * The declared-type ladder for a FIELD artifact (`data-plane.md → Declared type, never sniffed`):
 * the representation is the declaration channel — `renderer` returns its contentType from chain;
 * on-chain image bytes are SVG by the registry convention; custody bytes carry the type declared
 * at upload; locator forms get a *labeled* extension-map fallback (never byte-sniffing). Unknown
 * → `application/octet-stream`, never omitted (the complete-listing rule).
 */
export async function fieldMimeType(
  client: PublicClient,
  state: ProjectState,
  entry: MetadataField,
  field: string,
  tokenId: string,
  display: DisplayMeta,
  storage?: StorageBackend,
): Promise<string> {
  const rep = entry.representation;
  if (rep === R.renderer) {
    return (await rendererContentType(client, state.address, entry, field, tokenId)) ?? 'application/octet-stream';
  }
  if (rep === R.inline || rep === R.inlineGzip || rep === R.reader || rep === R.readerGzip) {
    // registry conventions for on-chain content bytes: an `image` is SVG, an `animation_url` is
    // the HTML document the renderer wraps as `data:text/html` (spec v4). Anything else: the floor.
    if (field === F.image) return 'image/svg+xml';
    return field === F.animationUrl ? 'text/html' : 'application/octet-stream';
  }
  if (rep === R.keccak256 || rep === R.sha256) {
    const stored = storage ? await storage.get(entry.value).catch(() => null) : null;
    if (stored?.contentType) return stored.contentType;
    const bridged = display.contentLocators?.[entry.value.toLowerCase()];
    return bridged ? contentTypeFromPath(bridged) : 'application/octet-stream';
  }
  const raw = inlineText(entry).trim();
  // For ipfs/arweave the extension (if any) rides the stored value — no need to wrap first, and
  // wrapping would only add a gateway host that never carries the extension.
  return contentTypeFromPath(rep === R.urlTemplate ? applyTemplate(raw, tokenId) : raw);
}

/** A field artifact's `uri`: locator forms verbatim (content-addressed preferred, `{id}`
 *  substituted); custody-hash forms prefer the bridged durable locator; everything this node
 *  serves itself (inline/reader/renderer) rides the given `/data/{field}` route. Total — every
 *  representation resolves to some uri (the complete-listing rule). */
function fieldArtifactUri(
  entry: MetadataField,
  dataRoute: string,
  tokenId: string,
  display: DisplayMeta,
  gateways: GatewayPrefixes,
): string {
  const rep = entry.representation;
  // Content-addressed forms carry the same gateway wrap the projected fields get, so a manifest
  // entry and the `image` it duplicates never point at two different URLs for the same bytes.
  if (rep === R.ipfs || rep === R.arweave) return gatewayFieldUrl(entry, gateways, tokenId) ?? dataRoute;
  if (rep === R.url) return inlineText(entry).trim() || dataRoute;
  if (rep === R.urlTemplate) return applyTemplate(inlineText(entry), tokenId);
  if (rep === R.keccak256 || rep === R.sha256) {
    return display.contentLocators?.[entry.value.toLowerCase()] ?? dataRoute;
  }
  return dataRoute; // inline / reader / renderer — this node serves the bytes
}

/** Provenance for a non-reserved field artifact (reserved fields carry their projection rows). */
function artifactFieldProv(field: string, entry: MetadataField, fromCollection: boolean): FieldProvenance {
  const rep = entry.representation;
  if (rep === R.inline || rep === R.inlineGzip || rep === R.reader || rep === R.readerGzip) {
    return onChainProv(field, rep, fromCollection);
  }
  // Same call as the branch above — `renderer` is on-chain content like `inline`/`reader`, and the
  // note belongs to `sourceNote` (which mirrors the deployed renderer's `_sourceNote` verbatim). This
  // branch used to hand-build the object with a longer note of its own, so one function delegated in
  // one arm and duplicated in the next.
  if (rep === R.renderer) return onChainProv(field, rep, fromCollection);
  if (rep === R.keccak256 || rep === R.sha256) {
    const anchor = rep as 'keccak256' | 'sha256';
    return {
      field,
      source: anchor,
      status: 'anchored',
      anchor,
      note: `off-chain bytes; on-chain ${anchor} integrity anchor`,
    };
  }
  return {
    field,
    source: rep as FieldProvenance['source'],
    status: 'on-chain',
    note: scopeNote(`on-chain pointer (${rep}) — bytes off-chain, located on-chain`, fromCollection),
  };
}

/**
 * Assemble the token's `artifacts` manifest — the COMPLETE listing of its data plane
 * (`data-plane.md → The manifest`): creator-set content fields (including ones already projected
 * into reserved keys — deliberate duplication; the manifest alone reconstructs the file set) plus
 * every producer-registered effect output whose row matches the CURRENT settled inputsHash (a
 * param change re-addresses → stale rows go silently unlisted). Deterministic order: image,
 * animation_url, non-reserved fields (alpha), then effect entries by effectKey/outputKey.
 */
async function buildTokenArtifacts(
  client: PublicClient,
  state: ProjectState,
  token: TokenState,
  baseUrl: string,
  chainId: number,
  display: DisplayMeta,
  storage: StorageBackend | undefined,
  plane: PlaneAccess | undefined,
  resolved: {
    imageUrl: string;
    imageEntry: MetadataField | null;
    animationValue: string | null;
    animationEntry: MetadataField | null;
    settledHash: Hex | null;
  },
): Promise<{entries: ArtifactEntry[]; prov: FieldProvenance[]}> {
  const entries: ArtifactEntry[] = [];
  const prov: FieldProvenance[] = [];
  const cf = state.collectionFields;

  // image — a creator-set field only (an unset image projected from the render effect is listed
  // as its render/image entry below; the deterministic placeholder is not an artifact).
  if (resolved.imageEntry) {
    entries.push({
      key: F.image,
      mimeType: await fieldMimeType(client, state, resolved.imageEntry, F.image, token.tokenId, display, storage),
      uri: resolved.imageUrl,
    });
  }

  // animation_url — the explicit field only (the derived live view is a projection of the code;
  // `code` never appears in served JSON per the field registry).
  if (resolved.animationEntry && resolved.animationValue) {
    entries.push({
      key: F.animationUrl,
      mimeType: await fieldMimeType(client, state, resolved.animationEntry, F.animationUrl, token.tokenId, display, storage),
      uri: resolved.animationValue,
    });
  }

  // every non-reserved field the creator set (token scope wins collection) — first-class artifacts.
  const names = [...new Set([...token.fields, ...(cf ?? [])].map((x) => x.field))]
    .filter((name) => !RESERVED_FIELDS.has(name) && name !== 'code')
    .sort();
  for (const name of names) {
    const {entry, fromCollection} = fieldWithFallback(token.fields, cf, name);
    if (!entry) continue;
    entries.push({
      key: name,
      mimeType: await fieldMimeType(client, state, entry, name, token.tokenId, display, storage),
      uri: fieldArtifactUri(
        entry,
        `${baseUrl}/t/${chainId}/${state.address}/${token.tokenId}/data/${name}`,
        token.tokenId,
        display,
        projectGateways(state),
      ),
    });
    prov.push(artifactFieldProv(name, entry, fromCollection));
  }

  // effect outputs at the CURRENT settled inputsHash — the registry rows are producer-published;
  // the currency filter recomputes each row's expected address and drops what doesn't match.
  if (plane && resolved.settledHash) {
    const hash = resolved.settledHash;
    const rows = plane
      .list(state.address, token.tokenId)
      .filter(
        (row) =>
          row.key.toLowerCase() ===
          renderArtifactKey(state.chainId, state.address, token.tokenId, hash, row.outputKey, row.effectKey).toLowerCase(),
      )
      .sort((a, b) => `${a.effectKey}/${a.outputKey}`.localeCompare(`${b.effectKey}/${b.outputKey}`));
    for (const row of rows) {
      const key = `${row.effectKey}/${row.outputKey}`;
      entries.push({
        key,
        mimeType: row.contentType ?? 'application/octet-stream',
        uri: row.locator ?? `${baseUrl}/t/${chainId}/${state.address}/${token.tokenId}/data/${key}`,
      });
      prov.push({
        field: key,
        source: `effect:${row.effectKey}`,
        status: 'off-chain',
        note: 'derived effect output at the current inputsHash (re-creatable bytes)',
      });
    }
  }
  return {entries, prov};
}

/**
 * One producer-registered effect-artifact row, reported with its currency against the token's
 * CURRENT settled inputsHash — the visibility `buildTokenArtifacts` above deliberately does NOT
 * provide (it silently drops anything that doesn't match, which is correct for what gets SERVED
 * but wrong for a read whose whole job is telling current from stale apart).
 */
export interface EffectArtifactStatus {
  /** `${effectKey}/${outputKey}` — the same composite key a manifest entry for this output uses. */
  key: string;
  effectKey: string;
  outputKey: string;
  status: 'current' | 'stale';
  /** This row's own recorded inputsHash, when the plane reports one — `null` when unknown (never
   *  guessed; see {@link PlaneArtifactRow.inputsHash}). */
  inputsHash: string | null;
  contentType: string | null;
  /** Where the bytes are — a producer's locator, or this node's own `/data/{key}` route. Never
   *  fetched or resolved here; a locator is reported verbatim. */
  uri: string;
}

/**
 * The direct, typed artifact read behind `abx artifacts` / the SDK's `tokenArtifacts()`; see
 * site/content/docs/protocol/data-plane.mdx. Every entry in `entries` is EXACTLY what the served
 * tokenURI document's `artifacts` key carries right now — this calls `buildTokenArtifacts` itself rather
 * than re-deriving its filter, so the two cannot drift. A remote resolver that independently
 * reimplements this logic instead of reading it from here is a SEPARATE surface, which is why a
 * caller must be told which one answered.
 *
 * Nothing here is on-chain data itself — every entry is a resolver-published projection, whether
 * the bytes it names are anchored on-chain or produced off-chain by an effect. Read each entry's
 * `abx_provenance` row (`prov`) for that distinction; never infer it from an entry's mere presence.
 */
export interface TokenArtifactsResult {
  entries: ArtifactEntry[];
  prov: FieldProvenance[];
  /** Every producer-registered effect row for this token, current AND stale. Empty both for a
   *  project with no effect surface AND when the caller passed no `plane` — `planeConsulted` is
   *  what tells those two apart. */
  effects: EffectArtifactStatus[];
  /** Whether an effect-artifact registry (a `plane`) was actually consulted. `false` means this
   *  read has no way to know about producer-registered outputs at all — "no resolver [registry]
   *  configured for this read", not "this project has none". Always `false` for a project with no
   *  effect surface (a static image/Series never has one to consult). */
  planeConsulted: boolean;
  /** The settled inputsHash effect rows are judged against — the active effect key a caller
   *  compares a stale row's own `inputsHash` to, to see how far behind it is. `null` for a project
   *  with no effect surface. */
  currentInputsHash: Hex | null;
}

export async function tokenArtifacts(
  client: PublicClient,
  state: ProjectState,
  token: TokenState,
  baseUrl: string,
  chainId: number,
  display: DisplayMeta = {},
  storage?: StorageBackend,
  plane?: PlaneAccess,
): Promise<TokenArtifactsResult> {
  const f = token.fields;
  const cf = state.collectionFields;
  const opts = {collectionFields: cf, tokenId: token.tokenId, gateways: projectGateways(state)};

  // Mirrors buildTokenMetadata's own field resolution exactly (same helpers, same call shape),
  // purely so `buildTokenArtifacts` receives the identical `resolved` shape it gets from the real
  // document build — reusing the filter itself rather than re-deriving it.
  const image = await resolveImage(state, token, baseUrl, chainId, display, storage);
  const animation = await resolveText(client, state.address, f, F.animationUrl, undefined, null, undefined, {
    ...opts,
    uriRoute: `${baseUrl}/t/${chainId}/${state.address}/${token.tokenId}/data/${F.animationUrl}`,
  });
  const currentInputsHash = isCodeProject(state) ? await currentSettledInputsHash(client, state, token).catch(() => null) : null;

  const {entries, prov} = await buildTokenArtifacts(client, state, token, baseUrl, chainId, display, storage, plane, {
    imageUrl: image.url,
    imageEntry: fieldWithFallback(f, cf, F.image).entry,
    animationValue: animation.value,
    animationEntry: animation.value !== null ? fieldWithFallback(f, cf, F.animationUrl).entry : null,
    settledHash: currentInputsHash,
  });

  // The visibility this read ADDS over the manifest: every registered row, current or stale, each
  // labeled. `plane.list` is unfiltered — the manifest's own currency filter runs separately, above
  // via `buildTokenArtifacts` — so recompute each row's OWN current-key match here rather than
  // trusting the manifest's inclusion, which already dropped anything stale.
  const effects: EffectArtifactStatus[] = [];
  if (plane && currentInputsHash) {
    const rows = [...plane.list(state.address, token.tokenId)].sort((a, b) =>
      `${a.effectKey}/${a.outputKey}`.localeCompare(`${b.effectKey}/${b.outputKey}`),
    );
    for (const row of rows) {
      const key = `${row.effectKey}/${row.outputKey}`;
      // `state.chainId` (the project's OWN chain), not the `chainId` param (which only shapes served
      // URLs) — matching `buildTokenArtifacts`'/`currentRenderArtifact`'s own key computation exactly.
      const expected = renderArtifactKey(state.chainId, state.address, token.tokenId, currentInputsHash, row.outputKey, row.effectKey);
      effects.push({
        key,
        effectKey: row.effectKey,
        outputKey: row.outputKey,
        status: row.key.toLowerCase() === expected.toLowerCase() ? 'current' : 'stale',
        inputsHash: row.inputsHash ?? null,
        contentType: row.contentType,
        uri: row.locator ?? `${baseUrl}/t/${chainId}/${state.address}/${token.tokenId}/data/${key}`,
      });
    }
  }

  return {entries, prov, effects, planeConsulted: !!plane, currentInputsHash};
}

const looksLikeSvg = (s: string): boolean => /^\s*<(\?xml|svg)/i.test(s);

/** On-chain `attributes` inline-JSON (if any) + the operator's off-chain attributes, stitched
 *  (on-chain wins per trait_type). Returns the merged array + a provenance row, or null when
 *  neither source has traits (so `attributes` is simply omitted — no boilerplate, no ABX facts). */
function resolveAttributes(
  fields: MetadataField[],
  offChain: OpenSeaAttribute[] | undefined,
  collectionFields?: MetadataField[],
  fromRender = false,
): {attributes: OpenSeaAttribute[]; prov: FieldProvenance} | null {
  const {entry} = fieldWithFallback(fields, collectionFields, F.attributes);
  let onChain: OpenSeaAttribute[] | null = null;
  let onChainBad = false;
  if (entry && entry.representation === R.inline) {
    try {
      const parsed = JSON.parse(inlineText(entry));
      onChain = Array.isArray(parsed) ? (parsed as OpenSeaAttribute[]) : null;
    } catch {
      onChainBad = true;
    }
  }
  const merged = stitchAttributes(onChain, offChain);
  if (merged.length === 0 && !onChainBad) return null;

  let prov: FieldProvenance;
  if (onChain && offChain && offChain.length) {
    prov = {
      field: F.attributes,
      source: 'inline',
      status: 'on-chain',
      note: fromRender
        ? 'on-chain inline JSON + render-effect traits (+ operator), stitched (on-chain wins per trait_type)'
        : 'on-chain inline JSON + off-chain operator traits, stitched (on-chain wins per trait_type)',
    };
  } else if (onChain) {
    prov = onChainProv(F.attributes, R.inline);
  } else if (onChainBad) {
    prov = placeholderProv(F.attributes, 'on-chain attributes unparseable — omitted');
  } else {
    prov = {
      field: F.attributes,
      source: fromRender ? 'effect:render' : 'off-chain',
      status: 'off-chain',
      note: fromRender
        ? 'script-reported traits captured at render (+ operator traits; render wins per trait_type)'
        : 'off-chain operator traits',
    };
  }
  return {attributes: merged, prov};
}

/** Token metadata JSON — the `tokenURI` target (ERC-721) / the `uri(id)` target (ERC-1155
 *  editions), assembled identically either way + `abx_provenance` + `artifacts`. */
export async function buildTokenMetadata(
  client: PublicClient,
  state: ProjectState,
  token: TokenState,
  baseUrl: string,
  chainId: number,
  display: DisplayMeta = {},
  storage?: StorageBackend,
  // The effect-artifact registry read surface: rows a producer PUBLISHED to this resolver (or
  // recorded co-located). Feeds the `artifacts` manifest and the image seam's locator check —
  // without it a locator-backed image reads "placeholder" while it serves fine.
  plane?: PlaneAccess,
): Promise<Record<string, unknown>> {
  const f = token.fields;
  const provenance: FieldProvenance[] = [];
  const image = await resolveImage(state, token, baseUrl, chainId, display, storage);

  // ONE settled-inputsHash computation per build — shared by the image seam, the traits stitch,
  // and the manifest's currency filter (they must all agree on "current").
  const settledHash = isCodeProject(state)
    ? await currentSettledInputsHash(client, state, token).catch(() => null)
    : null;

  // the render-effect seam: an unset image on a code project serves the artifact at the
  // CURRENT inputsHash address when a producer has stored one (a param change re-addresses
  // output, so this is self-invalidating — stale renders are never claimed). A render can live
  // in this node's `storage` (co-located) OR as a published locator (the bridge) — check both, so
  // the provenance matches what `/…/image` actually serves (the false-placeholder bug).
  if (image.prov.source === 'placeholder' && isCodeProject(state) && (storage || plane)) {
    try {
      const {key, found} = await currentRenderArtifact(client, state, token, storage ?? undefined, 'image', {
        hash: settledHash ?? undefined,
      });
      const viaLocator = !found && !!plane?.get(key);
      if (found || viaLocator) {
        image.prov = {
          field: F.image,
          source: 'effect:render',
          status: 'off-chain',
          note: viaLocator
            ? 'render effect output at the current inputsHash, published as a durable locator (resolver 302-redirects)'
            : 'render effect output for the current inputsHash (re-creatable derived bytes)',
        };
      }
    } catch {
      // seam is best-effort — the placeholder stays honest
    }
  }

  // Required fields (always present, with on-chain-computable fallbacks — mirrors the
  // on-chain renderer). Everything else is optional: included only when it actually
  // resolves (on-chain wins → operator-supplied off-chain → otherwise omitted, never a
  // boilerplate filler). The off-chain caveat to renderer parity: this resolver may stitch
  // operator/custody data + derive enrichment the on-chain renderer can't reach.
  // token fields resolve token-scope first, then fall back to the collection scope (mirrors the
  // on-chain renderer's `_field`), and url-template fields substitute this token's id.
  const cf = state.collectionFields;
  const tid = token.tokenId;
  const opts = {collectionFields: cf, tokenId: tid, gateways: projectGateways(state)};
  const name = await resolveText(client, state.address, f, F.name, undefined, `${state.name ?? state.address} #${token.tokenId}`, nameFallbackProv(state.name != null, ' + #id'), opts);
  const description = await resolveText(client, state.address, f, F.description, display.description, null, undefined, opts); // optional → omit if unset
  const externalUrl = await resolveText(client, state.address, f, F.externalUrl, display.externalUrl, null, undefined, opts); // optional → omit if unset
  const backgroundColor = await resolveText(client, state.address, f, F.backgroundColor, undefined, null, undefined, opts);
  const youtubeUrl = await resolveText(client, state.address, f, F.youtubeUrl, undefined, null, undefined, opts);
  provenance.push(name.prov); // name is required — always present

  // image: required — always served via our URL; image_data carries inline SVG if on-chain SVG.
  const img = fieldOf(f, F.image);
  const imageData = img && img.representation === R.inline && looksLikeSvg(inlineText(img)) ? inlineText(img) : null;
  provenance.push(image.prov);

  // optional text fields → record provenance only when actually present.
  if (description.value !== null) provenance.push(description.prov);
  if (externalUrl.value !== null) provenance.push(externalUrl.prov);

  // animation_url: an explicit `animation` field wins; else a code project derives the
  // live-view route (suppressible via the `display.animation = none` contract param). On-chain
  // content is served at this node's data route rather than inlined (see `uriRoute`); locator forms
  // pass through untouched. The on-chain renderer still inlines it — it has no route to offer.
  const animation = await resolveText(client, state.address, f, F.animationUrl, undefined, null, undefined, {
    ...opts,
    uriRoute: `${baseUrl}/t/${chainId}/${state.address}/${token.tokenId}/data/${F.animationUrl}`,
  });
  let animationValue = animation.value;
  let animationProv = animation.prov;
  if (animationValue === null && liveViewEnabled(state)) {
    animationValue = liveViewUrl(baseUrl, chainId, state.address, token.tokenId);
    animationProv = {
      field: F.animationUrl,
      source: 'live-view',
      status: 'off-chain',
      note: 'live view derived from the on-chain code (canonical tokenData injected at load)',
    };
  }
  if (animationValue !== null) provenance.push(animationProv);

  // attributes: real OpenSea traits only — three creator-controlled sources, stitched:
  // on-chain inline JSON wins per trait_type over the render effect's script-reported
  // traits (captured at the current inputsHash), which win over the operator's off-chain
  // traits. ABX facts (version, canonical, royalty) are NOT traits; they live in this
  // provenance block / ERC-2981, never in the marketplace trait array.
  // `traits` is a BOUND output (`effects.md → Bound vs referenced`): its content is held by this
  // node, so there are exactly two places it can be, and BOTH are hash-gated by the key itself —
  // a param change re-addresses the key, so stale traits go unstitched rather than being attributed
  // to a state they don't depict.
  //   - the registry row (a producer REGISTERED it over /v1/effect-artifacts: bytes ride the row),
  //   - this node's storage (a CO-LOCATED runner wrote the artifact to the shared backend).
  let renderTraits: OpenSeaAttribute[] | null = null;
  if (isCodeProject(state) && (plane || storage)) {
    try {
      const {key, found} = await currentRenderArtifact(client, state, token, storage ?? undefined, 'traits', {
        hash: settledHash ?? undefined,
      });
      const boundBytes = plane?.get(key)?.bytes ?? null;
      const raw = boundBytes ?? (found ? (await storage?.get(key))?.bytes ?? null : null);
      const parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
      // scripts report either the OpenSea array or the natural object form
      // (`abx.traits({Palette: 'Dusk'})`) — normalize the latter.
      if (Array.isArray(parsed)) renderTraits = parsed as OpenSeaAttribute[];
      else if (parsed && typeof parsed === 'object') {
        renderTraits = Object.entries(parsed as Record<string, unknown>).map(
          ([trait_type, value]) => ({trait_type, value: value as string | number}),
        );
      }
    } catch {
      // seam is best-effort — traits simply don't stitch until a render lands
    }
  }
  // Per-token off-chain traits (a Series' editable attributes) win over the collection-scope
  // `display.attributes` (which a 1/1 uses); on-chain attributes still win over both (resolveAttributes).
  const offChainBase = display.tokenAttributes?.[String(tid)] ?? display.attributes;
  const offChainTraits = renderTraits ? stitchAttributes(renderTraits, offChainBase) : offChainBase;
  const attr = resolveAttributes(f, offChainTraits, cf, renderTraits !== null);
  if (attr) provenance.push(attr.prov);

  if (backgroundColor.value) provenance.push(backgroundColor.prov);
  if (youtubeUrl.value) provenance.push(youtubeUrl.prov);

  // NO `abx_params` block. It was emitted here and by the on-chain renderer and read back by
  // nobody — the only consumers in the repo were its own tests. Params already enumerate directly
  // from the contract (`tokenParamKeys` / `tokenParam` / `paramSchemaKeys`), which is canonical and
  // needs no indexer, and a code project's script gets them through `tokenData`. So the projection
  // was a third serialization of data available two better ways: uncapped in size, quadratic to
  // build, and duplicated across two implementations — which is precisely the sibling drift that
  // produced the computed-image-locator bug. Traits that belong to marketplaces go in `attributes`.

  // the `artifacts` manifest — the plane's complete listing (data-plane.md). Omitted when empty.
  const artifacts = await buildTokenArtifacts(client, state, token, baseUrl, chainId, display, storage, plane, {
    imageUrl: image.url,
    imageEntry: fieldWithFallback(f, cf, F.image).entry,
    animationValue: animation.value,
    animationEntry: animation.value !== null ? fieldWithFallback(f, cf, F.animationUrl).entry : null,
    settledHash,
  });
  provenance.push(...artifacts.prov);

  const json: Record<string, unknown> = {
    name: name.value,
    image: image.url,
    abx_provenance: provenance,
  };
  if (attr) json.attributes = attr.attributes;
  if (description.value !== null) json.description = description.value;
  if (externalUrl.value !== null) json.external_url = externalUrl.value;
  if (imageData) json.image_data = imageData;
  if (animationValue !== null) json.animation_url = animationValue;
  if (backgroundColor.value) json.background_color = backgroundColor.value;
  if (youtubeUrl.value) json.youtube_url = youtubeUrl.value;
  if (artifacts.entries.length) json.artifacts = artifacts.entries;
  return json;
}

/** ERC-7572 collection metadata JSON (the `contractURI` target) + `abx_provenance`. */
export async function buildContractMetadata(
  client: PublicClient,
  state: ProjectState,
  baseUrl: string,
  chainId: number,
  display: DisplayMeta = {},
  storage?: StorageBackend,
): Promise<Record<string, unknown>> {
  const f = state.collectionFields;
  const provenance: FieldProvenance[] = [];
  // Representative image: the first token that actually carries an `image` field, else the
  // first token — so "first with an image" surfaces a real work rather than a placeholder.
  const rep = state.tokens.find((t) => fieldOf(t.fields, F.image)) ?? state.tokens[0];
  const image = rep ? await resolveImage(state, rep, baseUrl, chainId, display, storage) : undefined;

  // The collection surface has no token, so a `renderer`-represented field is called with the
  // sentinel id — the same one {AbxMetadataRenderer} passes for its collection reads, so a field
  // renderer that serves both scopes sees an identical call from chain and from here.
  const collOpts = {tokenId: COLLECTION_TOKEN_ID, gateways: projectGateways(state)};

  // name is required (fallback = the on-chain collection name); description + external_link
  // are optional → omit when neither on-chain nor operator-supplied (no boilerplate).
  const name = await resolveText(client, state.address, f, F.name, undefined, state.name ?? state.address, nameFallbackProv(state.name != null, ''), collOpts);
  const description = await resolveText(client, state.address, f, F.description, display.description, null, undefined, collOpts);
  const externalLink = await resolveText(client, state.address, f, F.externalLink, display.externalUrl, null, undefined, collOpts);
  // authorship + rights (collection scope) — reserved fields, on-chain-only (no operator source):
  // included only when the creator set them on-chain, omitted otherwise (no boilerplate).
  const creator = await resolveText(client, state.address, f, F.creator, undefined, null, undefined, collOpts);
  const displayNotes = await resolveText(client, state.address, f, F.displayNotes, undefined, null, undefined, collOpts);
  const creatorLinks = await resolveText(client, state.address, f, F.creatorLinks, undefined, null, undefined, collOpts);
  const license = await resolveText(client, state.address, f, F.license, undefined, null, undefined, collOpts);
  provenance.push(name.prov);
  if (image) provenance.push(image.prov);
  if (description.value !== null) provenance.push(description.prov);
  if (externalLink.value !== null) provenance.push(externalLink.prov);
  if (creator.value !== null) provenance.push(creator.prov);
  if (displayNotes.value !== null) provenance.push(displayNotes.prov);
  if (creatorLinks.value !== null) provenance.push(creatorLinks.prov);
  if (license.value !== null) provenance.push(license.prov);

  // The two reserved collection IMAGE keys. Both are top-level here, and both are top-level on the
  // on-chain renderer as of spec v10 — the point of the three-list table in
  // site/content/docs/protocol/metadata.mdx is that a key BOTH planes can emit must not be emitted by only
  // one of them. Two things were wrong before v10: `featured_image` appeared in `artifacts` alone
  // (reserved, so filtered out of the top level, yet still listed — "reserved but only in artifacts",
  // which is neither), and `banner_image` was top-level only for `representation === url`, so an
  // `inline` or `reader` banner silently dropped even though both resolve fine. Every chain-reachable
  // representation now counts, matching `_appendContractText` on the renderer.
  const bannerImage = await resolveText(client, state.address, f, F.bannerImage, undefined, null, undefined, collOpts);
  const featuredImage = await resolveText(client, state.address, f, F.featuredImage, undefined, null, undefined, collOpts);
  if (bannerImage.value !== null) provenance.push(bannerImage.prov);
  if (featuredImage.value !== null) provenance.push(featuredImage.prov);

  // the collection-scope `artifacts` manifest — content-bearing collection fields (banner,
  // featured image, plus any non-reserved field). The representative-token image is a projection
  // courtesy, not a collection artifact; a collection-scope `image` doubles as the per-token
  // default (the url-template pattern), so it lists on tokens, not here. Omitted when empty.
  const artifacts: ArtifactEntry[] = [];
  const artifactNames = [...new Set(f.map((x) => x.field))]
    .filter((n) => (n === F.bannerImage || n === F.featuredImage || !RESERVED_FIELDS.has(n)) && n !== 'code')
    .sort();
  for (const n of artifactNames) {
    const entry = fieldOf(f, n);
    if (!entry || entry.representation === R.urlTemplate) continue; // a per-token template lists on tokens
    artifacts.push({
      key: n,
      // collection surface has no token — a field renderer gets the sentinel id (mirrors on-chain)
      mimeType: await fieldMimeType(client, state, entry, n, COLLECTION_TOKEN_ID, display, storage),
      uri: fieldArtifactUri(entry, `${baseUrl}/c/${chainId}/${state.address}/data/${n}`, '0', display, collOpts.gateways),
    });
    if (!RESERVED_FIELDS.has(n)) provenance.push(artifactFieldProv(n, entry, false));
  }

  const json: Record<string, unknown> = {
    name: name.value,
    abx_provenance: provenance,
  };
  if (image) json.image = image.url;
  if (description.value !== null) json.description = description.value;
  if (externalLink.value !== null) json.external_link = externalLink.value;
  if (creator.value !== null) json.creator = creator.value;
  if (displayNotes.value !== null) json.display_notes = displayNotes.value;
  if (creatorLinks.value !== null) json.creator_links = creatorLinks.value;
  if (license.value !== null) json.license = license.value;
  if (bannerImage.value !== null) json.banner_image = bannerImage.value;
  if (featuredImage.value !== null) json.featured_image = featuredImage.value;
  if (artifacts.length) json.artifacts = artifacts;
  return json;
}
