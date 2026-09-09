/**
 * Gateway resolution for content-addressed locators (`ipfs://…`, `ar://…`) is split into a pure
 * resolver and a
 * separate env-reading piece so a host with its own gateway config never has to touch
 * `process.env` through this module at all, and so this stays reachable from a browser bundle
 * (see `test/browser-bundle.test.ts` — no `process.env` read outside {@link gatewayConfigFromEnv},
 * which itself goes through {@link readEnv} and degrades to "no override" rather than throwing
 * where `process` doesn't exist).
 */
import {readEnv} from './util.js';
import {GATEWAY_FIELD, GATEWAY_FLOOR, METADATA_REPRESENTATION as R} from './spine.js';
import {inlineText} from './token.js';
import type {MetadataField, ProjectState} from './types.js';

/** The locator's network, which decides which gateways can be asked about it. `http` locators
 *  carry their own base (they are already an absolute URL) and resolve to `''` here — a caller
 *  returns them verbatim before consulting a gateway. */
export type LocatorNetwork = 'arweave' | 'ipfs' | 'http';

/** Resolved gateway overrides for the two content-addressed networks — the shape both
 *  {@link resolveGatewayBase} and {@link gatewayConfigFromEnv} speak. */
export interface GatewayOverrides {
  ipfs?: string;
  arweave?: string;
}

/**
 * The gateway BASE for a locator network, given already-resolved `overrides` — PURE, no env
 * read. Defaults to the generic public gateways (`ipfs.io` / `arweave.net`) when `overrides`
 * doesn't name one; any other `network` (e.g. `http`, which carries its own base) resolves to
 * `''`. Callers that want override → env → default precedence compose this with
 * {@link gatewayConfigFromEnv} themselves (see `@artblocks/abx-storage`'s `resolveGatewayBase`
 * for the reference compose) — kept separate so a host with its own config source never has this
 * function reach into `process.env` on its behalf.
 */
export function resolveGatewayBase(network: 'ipfs' | 'arweave' | string, overrides?: GatewayOverrides): string {
  if (network === 'ipfs') return overrides?.ipfs || 'https://ipfs.io';
  if (network === 'arweave') return overrides?.arweave || 'https://arweave.net';
  return '';
}

/**
 * The ONLY env-reading piece of this module: `ABX_IPFS_GATEWAY` / `ABX_ARWEAVE_GATEWAY`, read via
 * {@link readEnv} (safe where `process` doesn't exist). Exported separately from
 * {@link resolveGatewayBase} so a host with its own gateway configuration (a database row, a
 * remote config service) never has to touch `process.env` through this package at all — it just
 * never calls this function and passes its own overrides straight to the pure resolver instead.
 */
export function gatewayConfigFromEnv(): GatewayOverrides {
  const ipfs = readEnv('ABX_IPFS_GATEWAY');
  const arweave = readEnv('ABX_ARWEAVE_GATEWAY');
  const out: GatewayOverrides = {};
  if (ipfs) out.ipfs = ipfs;
  if (arweave) out.arweave = arweave;
  return out;
}

/** Build the URL that asks `gateway` for `id`. A locator that is already an absolute URL is asked
 *  verbatim — rewriting someone's URL would answer a question they didn't ask. */
export function gatewayUrlFor(network: LocatorNetwork, id: string, gateway: string): string {
  if (/^https?:\/\//i.test(id)) return id;
  const base = gateway.replace(/\/+$/, '');
  // A path suffix (a directory manifest entry, e.g. `<txid>/index.html`) rides along untouched.
  return network === 'ipfs' ? `${base}/ipfs/${id}` : `${base}/${id}`;
}


// ── the on-chain projection: content-addressed field → the https URL a marketplace can read ──
//
// The TWIN of `AbxMetadataRenderer._gatewayUrl` / `_gatewayPrefix` (spec v11) and of
// `AbxGenerator._gateway`. Two conforming resolvers given the same chain state must emit the same
// `image`, so this is deliberately NOT built on {@link gatewayUrlFor}: that one takes a gateway
// HOST (`https://ipfs.io`), normalizes trailing slashes and inserts the `/ipfs/` segment itself,
// which is the right shape for an operator's env var and the wrong shape for an on-chain value —
// it cannot express a custom path, and Arweave has no segment to insert. The on-chain form is
// Flex's: a full PREFIX including the trailing path, concatenated raw.

/** A scheme whose locator is content-addressed, and therefore its own integrity anchor. */
export type ContentAddressedNetwork = 'ipfs' | 'arweave';

const SCHEME: Record<ContentAddressedNetwork, string> = {ipfs: 'ipfs://', arweave: 'ar://'};

/**
 * Normalize a gateway HOST (the `ABX_IPFS_GATEWAY` / `ABX_ARWEAVE_GATEWAY` shape, and what
 * {@link resolveGatewayBase} returns) into the on-chain PREFIX shape — trailing path included, so
 * projection is a raw concat. A value that already ends in the scheme's path segment is left
 * alone, so an operator may configure either form.
 */
export function gatewayPrefixFrom(network: ContentAddressedNetwork, base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (!trimmed) return GATEWAY_FLOOR[network];
  if (network === 'arweave') return `${trimmed}/`;
  return trimmed.endsWith('/ipfs') ? `${trimmed}/` : `${trimmed}/ipfs/`;
}

/**
 * The gateway prefix this project prefers for a scheme: the collection's reserved
 * `abx_gateway_*` field, else the host's env/override default, else the public floor.
 *
 * The env read is a FLOOR, never an override. When a project has stated a preference on chain,
 * every conforming resolver must serve that one — otherwise the same token renders differently
 * depending on who is serving it, which is the property `abx_provenance` exists to make checkable.
 * When a project has stated nothing, a host with its own gateway is strictly better than
 * `ipfs.io`, and a managed provider serving a token it does not own has no other way to say so.
 */
export function projectGatewayPrefix(
  state: Pick<ProjectState, 'collectionFields'>,
  network: ContentAddressedNetwork,
  overrides?: GatewayOverrides,
): string {
  const onChain = state.collectionFields.find(
    // Only `inline` counts. A prefix is a short UTF-8 string, and accepting exactly one
    // representation keeps this rule identical on the renderer, the generator and here.
    (f: MetadataField) => f.field === GATEWAY_FIELD[network] && f.representation === R.inline,
  );
  if (onChain) {
    // No `.trim()`: the on-chain `_gatewayPrefix` returns the stored bytes verbatim (any non-empty
    // `inline` value wins), so trimming here would make the two serving planes disagree on a
    // whitespace-padded prefix — the same byte-parity class this projection exists to hold. The field
    // store rejects an empty value, so a set field is always non-empty.
    const stated = inlineText(onChain);
    if (stated) return stated;
  }
  const host = overrides?.[network];
  return host ? gatewayPrefixFrom(network, host) : GATEWAY_FLOOR[network];
}

/**
 * Project a content-addressed field value into its https URL, byte-identically to the deployed
 * renderer. `null` when the value locates nothing (`ipfs://` with no CID) — the caller omits an
 * optional field or falls back on a required one, rather than emitting a bare prefix that 404s.
 *
 * Order is load-bearing and mirrors the Solidity exactly: strip the scheme, THEN substitute
 * `{id}`, THEN check for an absolute URL. That last check is what stops a value which already
 * names its own host — precisely what a `backend.locator()` return looks like — from coming back
 * as `https://arweave.net/https://arweave.net/<txid>`.
 */
export function projectGatewayUrl(
  network: ContentAddressedNetwork,
  value: string,
  prefix: string,
  tokenId?: string,
): string | null {
  let id = value;
  const scheme = SCHEME[network];
  if (id.startsWith(scheme)) id = id.slice(scheme.length);
  if (!id) return null;
  // One collection-scope `ipfs` field addresses a whole pinned directory. Skipped on the
  // collection surface, which has no tokenId — the same reason `url-template` is omitted there.
  if (tokenId !== undefined) id = id.split('{id}').join(tokenId);
  if (/^https?:\/\//i.test(id)) return id;
  return prefix + id;
}

/**
 * The inverse of {@link gatewayUrlFor} / {@link projectGatewayUrl}: recover the bare content id
 * (CID or txid, plus any path suffix) from whatever form a locator arrived in.
 *
 * This exists because a storage backend's `locator()` returns a **gateway HTTPS URL** — the form an
 * operator can click — while an `ipfs` / `arweave` metadata field must hold IDENTITY, with the
 * gateway supplied at read time. Baking the operator's gateway host into the field is exactly the
 * weld this projection was built to remove: it makes a CID unmigratable and makes the chain report
 * `source: url` for bytes that live on IPFS.
 *
 * `null` when no id can be recovered — notably a subdomain-style gateway
 * (`https://<cid>.ipfs.dweb.link`), which ABX's own backends never produce. A caller that gets
 * `null` should keep the URL as a plain `url` field and SAY so, rather than guess.
 */
export function contentIdFromLocator(network: ContentAddressedNetwork, locator: string): string | null {
  const trimmed = locator.trim();
  if (!trimmed) return null;
  const scheme = SCHEME[network];
  if (trimmed.startsWith(scheme)) return trimmed.slice(scheme.length) || null;
  if (!/^https?:\/\//i.test(trimmed)) return trimmed; // already bare
  if (network === 'ipfs') {
    const at = trimmed.lastIndexOf('/ipfs/');
    return at === -1 ? null : trimmed.slice(at + '/ipfs/'.length) || null;
  }
  // Strip the origin by hand rather than via `new URL().pathname`, which percent-encodes: an Arweave
  // directory template `https://arweave.net/TXDIR/{id}.png` came back as `TXDIR/%7Bid%7D.png`, and
  // that value would have been COMMITTED ON CHAIN — where nothing substitutes `%7Bid%7D`, so every
  // token in the collection would resolve to the same missing file.
  const afterOrigin = trimmed.replace(/^https?:\/\/[^/]*\/?/i, '');
  return afterOrigin || null;
}
