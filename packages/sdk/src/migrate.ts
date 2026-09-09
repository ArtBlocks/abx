/**
 * Migrate a contract's OFF-CHAIN operator state from one resolver to another — the
 * toolkit's portability guarantee, made operational.
 *
 * Everything on-chain a new resolver gets for free: it replays the event spine from any
 * RPC (that's what the control plane's `POST /v1/projects` already does). The only
 * thing it can't reconstruct from chain is the operator's off-chain state — the four fields
 * on the registration row: `description`, `externalUrl`, off-chain `attributes`, and the
 * `keccak → gateway-URL` content locators.
 *
 * The key property: each resolver's served JSON is **self-describing** via `abx_provenance`,
 * which makes it self-MIGRATING. By reading the SOURCE resolver's public token/contract API
 * (plus the chain, for the locator KEYS — the on-chain hashes, which aren't in any served
 * JSON), we reconstruct exactly that off-chain state and bridge it to the destination through
 * the same control plane. The two resolvers never talk to each other; the operator's CLI
 * orchestrates from public endpoints alone — no shared database, no private channel.
 *
 * Two cases this can't paper over, both surfaced honestly:
 *  - **Stitched attributes** — an off-chain trait shadowed by an on-chain one of the same
 *    `trait_type` was never *served*, so it can't be recovered. We migrate the off-chain
 *    remainder (served traits whose `trait_type` has no on-chain entry), which is byte-exact
 *    for everything that was ever visible.
 *  - **Node-custody images** — an image committed by hash but never pinned to a durable
 *    backend is served from the source node's own `/image` route. There's no portable URL to
 *    copy; the bytes live only on the old host. We list these so the operator re-pins them
 *    (fetch → verify against the on-chain hash → re-upload) BEFORE tearing the old host down.
 *    (The actual re-pin — {@link NodeCustodyImage} → a durable locator — needs a storage
 *    backend, so it lives in `@artblocks/abx-storage`'s `migrate.ts`, not here.)
 */
import {fieldOf, inlineText} from './token.js';
import {normalizeAttributes, type OpenSeaAttribute} from './traits.js';
import {METADATA_REPRESENTATION as R} from './spine.js';
import type {MetadataField, ProjectState} from './types.js';

/** A single `abx_provenance` row as served (we only read the fields we branch on). */
interface ServedProvenance {
  field: string;
  source: string;
  onChain: boolean;
  status: string;
  anchor?: string;
}

interface ServedTokenJson {
  name?: string;
  image?: string;
  description?: string;
  external_url?: string;
  attributes?: OpenSeaAttribute[];
  abx_provenance?: ServedProvenance[];
}

interface ServedContractJson {
  name?: string;
  image?: string;
  description?: string;
  external_link?: string;
  abx_provenance?: ServedProvenance[];
}

/** An image that lives ONLY on the source host (committed by hash, never pinned to a durable
 *  backend) — there's no portable URL to copy, so its bytes must be re-pinned before cutover. */
export interface NodeCustodyImage {
  tokenId: string;
  /** On-chain content hash (the `keccak256`/`sha256` commitment) — what we verify re-pinned bytes against. */
  hash: string;
  /** The source's served image URL — the old host's own `/…/image` route; where we fetch the bytes. */
  imageUrl: string;
}

/** The off-chain state to bridge to the destination resolver + what couldn't be carried cleanly. */
export interface MigrationPlan {
  description?: string;
  externalUrl?: string;
  attributes?: OpenSeaAttribute[];
  /** `{ "0x<keccak>": "https://gw/ipfs/<cid>" }` — durable image locators recovered from the source. */
  contentLocators: Record<string, string>;
  /** Images served only by the source host (no durable locator) — re-pin before cutover. */
  nodeCustody: NodeCustodyImage[];
  /** Tokens whose served JSON we read to build this plan. */
  tokensRead: number;
}

const trim = (base: string): string => base.replace(/\/+$/, '');
export const tokenApiUrl = (base: string, chainId: number, addr: string, id: string): string =>
  `${trim(base)}/t/${chainId}/${addr.toLowerCase()}/${id}`;
export const contractApiUrl = (base: string, chainId: number, addr: string): string =>
  `${trim(base)}/c/${chainId}/${addr.toLowerCase()}`;

async function getJson<T>(url: string): Promise<T | null> {
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`couldn't reach the source resolver at ${url}: ${(err as Error).message}`);
  }
  if (resp.status === 404) return null; // unknown project / unminted token — not fatal per-token
  if (!resp.ok) throw new Error(`source resolver ${url} → ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

const provOf = (json: {abx_provenance?: ServedProvenance[]} | null, field: string): ServedProvenance | undefined =>
  json?.abx_provenance?.find((p) => p.field === field);

/** Off-chain attribute trait_types present on-chain (case-insensitive) — these are NOT migrated as
 *  off-chain (the destination re-derives them from chain and they win the stitch). */
function onChainTraitTypes(fields: MetadataField[]): Set<string> {
  const entry = fieldOf(fields, 'attributes');
  if (!entry || entry.representation !== R.inline) return new Set();
  try {
    const parsed = JSON.parse(inlineText(entry));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((a: OpenSeaAttribute) => String(a.trait_type).toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Build the migration plan by reading the SOURCE resolver's public API, using the locally
 * reconstructed on-chain state (`local`) for the hash KEYS the served JSON doesn't expose.
 */
export async function buildMigrationPlan(
  sourceBase: string,
  chainId: number,
  local: ProjectState,
): Promise<MigrationPlan> {
  const addr = local.address;
  const plan: MigrationPlan = {contentLocators: {}, nodeCustody: [], tokensRead: 0};

  // ── operator-level fields (one registration row applies across the collection) ──
  // Prefer the contract API; fall back to token #0. Take a value only when its provenance
  // says it's off-chain (a plain operator value) — on-chain values are re-derived by replay.
  const contractJson = await getJson<ServedContractJson>(contractApiUrl(sourceBase, chainId, addr));
  // A burned token is not a probe subject: its `tokenURI` reverts, so reading it would report the
  // whole migration source as broken.
  const firstToken = local.tokens.find((t) => t.lifecycle === 'live') ?? local.tokens[0];
  const tokenZeroJson = firstToken
    ? await getJson<ServedTokenJson>(tokenApiUrl(sourceBase, chainId, addr, firstToken.tokenId))
    : null;

  const offChainText = (
    json: {description?: string; external_url?: string; external_link?: string; abx_provenance?: ServedProvenance[]} | null,
    field: 'description' | 'external_url' | 'external_link',
    value: string | undefined,
  ): string | undefined => (value != null && provOf(json, field)?.status === 'off-chain' ? value : undefined);

  plan.description =
    offChainText(tokenZeroJson, 'description', tokenZeroJson?.description) ??
    offChainText(contractJson, 'description', contractJson?.description);
  plan.externalUrl =
    offChainText(tokenZeroJson, 'external_url', tokenZeroJson?.external_url) ??
    offChainText(contractJson, 'external_link', contractJson?.external_link);

  // attributes: the off-chain remainder = served traits whose trait_type has NO on-chain entry.
  if (tokenZeroJson?.attributes?.length && provOf(tokenZeroJson, 'attributes')?.status !== 'on-chain') {
    const onChain = onChainTraitTypes(firstToken?.fields ?? []);
    const offChain = tokenZeroJson.attributes.filter((a) => !onChain.has(String(a.trait_type).toLowerCase()));
    if (offChain.length) plan.attributes = normalizeAttributes(offChain);
  }

  // ── per-token content locators (image bytes that live off-chain by hash) ──
  for (const token of local.tokens) {
    const image = fieldOf(token.fields, 'image');
    if (!image || (image.representation !== R.keccak256 && image.representation !== R.sha256)) {
      continue; // on-chain content or an on-chain locator — the destination derives it from chain
    }
    const json = await getJson<ServedTokenJson>(tokenApiUrl(sourceBase, chainId, addr, token.tokenId));
    if (!json) continue; // unminted / not served
    plan.tokensRead++;
    const prov = provOf(json, 'image');
    const hash = image.value.toLowerCase();
    // A durable locator: the resolver served a portable URL (ipfs/arweave/url source). Node-custody:
    // the source served the bytes from its own host (source === the hash kind), so there's nothing to copy.
    if (json.image && prov && prov.onChain === false && (prov.source === 'ipfs' || prov.source === 'arweave' || prov.source === 'url')) {
      plan.contentLocators[hash] = json.image;
    } else if (json.image) {
      plan.nodeCustody.push({tokenId: token.tokenId, hash, imageUrl: json.image});
    }
  }

  return plan;
}

/** A parity check after bridging: does the destination now serve the same image/description/traits? */
export interface ParityResult {
  tokenId: string;
  imageMatch: boolean;
  descriptionMatch: boolean;
  attributesMatch: boolean;
  sourceImage?: string;
  destImage?: string;
}

const sameAttrs = (a: OpenSeaAttribute[] = [], b: OpenSeaAttribute[] = []): boolean => {
  const key = (xs: OpenSeaAttribute[]) =>
    xs
      .map((x) => `${String(x.trait_type).toLowerCase()}=${String(x.value)}`)
      .sort()
      .join('|');
  return key(a) === key(b);
};

export async function verifyParity(
  sourceBase: string,
  destBase: string,
  chainId: number,
  addr: string,
  tokenId: string,
): Promise<ParityResult> {
  const [src, dst] = await Promise.all([
    getJson<ServedTokenJson>(tokenApiUrl(sourceBase, chainId, addr, tokenId)),
    getJson<ServedTokenJson>(tokenApiUrl(destBase, chainId, addr, tokenId)),
  ]);
  return {
    tokenId,
    imageMatch: !!src && !!dst && src.image === dst.image,
    descriptionMatch: (src?.description ?? null) === (dst?.description ?? null),
    attributesMatch: sameAttrs(src?.attributes, dst?.attributes),
    sourceImage: src?.image,
    destImage: dst?.image,
  };
}
