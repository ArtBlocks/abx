import {
  bytesToHex,
  concat,
  hexToBytes,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {seriesCodeAbi} from './abi/index.js';
import {decodeScalarParam, type ParamTypeName} from './spine.js';
import type {MetadataField, ParamSchema, ParamValue, ProjectState, TokenState} from './types.js';
import {bytesToBase64} from './util.js';

/**
 * The canonical `tokenData` assembly — the off-chain serializer the spec names as
 * authoritative (`site/content/docs/protocol/code-projects.mdx`). One flat object: the reserved
 * coordinates + every param (contract ∪ token scope, token wins) + the augment hook's
 * entries (augment wins per key), every value its canonical string (`chainId` alone is
 * a number). The serialization is canonical because it is *hashed*: an effect's
 * `inputsHash` commits to it, so this exact byte shape is what makes render outputs
 * addressable and self-invalidating.
 *
 * Decode rules: a schema'd param decodes per its type (`Select` → the option string,
 * `DecimalRange` ÷ 1e10, …); a schema-less literal stays the raw `bytes32` hex (a
 * schema is what buys a human decode — `seed` is the canonical example); a data-backed
 * value reads its blob (`String` → UTF-8, `Bytes`/schema-less → base64).
 */

/** The tokenData coordinates — never enumerable as params (the on-chain params store excludes
 *  `seed` from its key lists, and the generator/renderer skip the other three defensively).
 *  Exported because every off-chain surface that enumerates params must exclude exactly this
 *  set: two lists that have to agree are one list. */
export const RESERVED_TOKEN_DATA_KEYS: ReadonlySet<string> = new Set([
  'chainId',
  'contractAddress',
  'tokenId',
  'seed',
]);

const augmentHookAbi = parseAbi([
  'function augmentTokenParams(address token, uint256 tokenId) view returns ((bytes32 key, string value)[])',
]);

export interface TokenDataResult {
  /** The flat object (values are canonical strings; `chainId` is a number). */
  data: Record<string, string | number>;
  /** The canonical serialization: keys sorted lexicographically, no insignificant whitespace. */
  json: string;
}

/** The `code` collection field (directory mode), if any — locators only per the registry. */
export function codeField(state: ProjectState): MetadataField | null {
  return state.collectionFields.find((f) => f.field === 'code') ?? null;
}

/** Whether this project has executable content (a `code` field, or on-chain script chunks). */
export function isCodeProject(state: ProjectState): boolean {
  return codeField(state) !== null || ((state.script?.chunkCount ?? 0) > 0);
}

/** A well-known contract param's canonical string (e.g. `display.animation`), or null. */
export function contractParamString(state: ProjectState, key: string): string | null {
  const p = state.contractParams?.find((x) => x.key === key);
  if (!p || p.valueIsHash) return null;
  return decodeTagLoose(p.value);
}

/**
 * Assemble canonical tokenData. `client` null ⇒ best-effort (no blobs, no augment hook).
 *
 * `opts.augment` picks between the two canonical forms:
 *  - **full** (default, `augment: true`) — settled params + the augment hook's LIVE entries.
 *    What the live view injects: current by construction, stale the moment after.
 *  - **settled** (`augment: false`) — event-derived state only (explicit params ∪ seed ∪
 *    data-backed blobs; all deterministic chain reads). This is what effect outputs are
 *    ADDRESSED by: a still is a snapshot of settled state, so a volatile augment hook
 *    (block timestamp, an oracle) animates the live view without re-addressing the render
 *    every block — the cache stays hot, and re-render triggers are settled-state changes only.
 */
export async function buildTokenData(
  client: PublicClient | null,
  state: ProjectState,
  token: TokenState,
  opts: {augment?: boolean} = {},
): Promise<TokenDataResult> {
  const schemas = new Map((state.paramSchemas ?? []).map((s) => [s.key, s]));
  const data: Record<string, string | number> = {
    chainId: state.chainId,
    contractAddress: state.address.toLowerCase(),
    tokenId: token.tokenId,
  };

  // contract ∪ token scope, token wins — decoded per schema (or the schema-less rule)
  const merged = new Map<string, {p: ParamValue; tokenScope: boolean}>();
  for (const p of state.contractParams ?? []) merged.set(p.key, {p, tokenScope: false});
  for (const p of token.params ?? []) merged.set(p.key, {p, tokenScope: true});

  for (const [key, {p, tokenScope}] of merged) {
    // Coordinates win. `seed` is the one reserved key allowed through — but only from TOKEN
    // scope, matching the on-chain document exactly: `TokenDataLib.begin` reads
    // `tokenParam(tokenId, "seed")` and never falls back to contract scope. Letting a
    // contract-scope `seed` through here (the merged map holds both scopes) meant an unseeded
    // token carried a seed off-chain that the on-chain generator did not have — the two lanes
    // disagreeing about what a token's seed is, which is the one value they must agree on.
    // Contract-scope `seed` remains settable on-chain by design; it simply is not a token's seed.
    if (RESERVED_TOKEN_DATA_KEYS.has(key) && !(key === 'seed' && tokenScope)) continue;
    data[key] = (await decodeParam(client, state.address, token.tokenId, p, tokenScope, schemas.get(key))).value;
  }

  // augment hook — last, wins per key (except the reserved coordinates). Skipped for the
  // SETTLED form (opts.augment false): live data belongs in the live view, never in the
  // address of a render artifact.
  const hook = state.paramHooks?.augmentHook ?? null;
  if (client && hook && (opts.augment ?? true)) {
    try {
      const entries = (await client.readContract({
        address: hook as Address,
        abi: augmentHookAbi,
        functionName: 'augmentTokenParams',
        args: [state.address, BigInt(token.tokenId)],
      })) as ReadonlyArray<{key: Hex; value: string}>;
      for (const e of entries) {
        const key = decodeBytes32Key(e.key);
        if (RESERVED_TOKEN_DATA_KEYS.has(key)) continue;
        data[key] = e.value;
      }
    } catch {
      // best-effort by design: a broken augment hook must never take tokenData down
    }
  }

  return {data, json: canonicalTokenDataJson(data)};
}

/** The canonical serialization: lexicographically sorted keys, compact JSON, UTF-8. */
export function canonicalTokenDataJson(data: Record<string, string | number>): string {
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  return JSON.stringify(sorted);
}

/**
 * The effect run identity (`site/content/docs/protocol/effects.mdx`):
 * `keccak256(contentDigest ‖ canonical tokenData ‖ environmentId)`. Deterministic across
 * producers and consumers — the resolver computes the CURRENT hash and looks up exactly
 * that artifact, so a param change re-addresses output and stale renders are never served.
 */
export function inputsHash(
  contentDigest: Hex | null,
  canonicalJson: string,
  environmentId = 'web:any',
): Hex {
  return keccak256(
    concat([
      contentDigest ? hexToBytes(contentDigest) : new Uint8Array([0]),
      stringToBytes(canonicalJson),
      stringToBytes(environmentId),
    ]),
  );
}

/** The project's content digest: on-chain script digest (head-read), else keccak of the
 *  `code` field's locator value (content-addressed forms carry their own integrity). */
export function contentDigestOf(state: ProjectState): Hex | null {
  if (state.script?.digest) return state.script.digest;
  const code = codeField(state);
  return code ? keccak256(code.value) : null;
}

/**
 * The canonical artifact address for an effect output, mapped onto the hash-keyed
 * byte-custody interface: `keccak256` of the path
 * `{chainId}/{address}/{tokenId}/{effectKey}/{inputsHash}/{outputKey}` — so every
 * conforming producer (the `abx render` CLI, a hosted node) and consumer (this
 * resolver) agree on where a run's artifacts live, over any storage backend.
 */
export function renderArtifactKey(
  chainId: number,
  address: string,
  tokenId: string,
  hash: Hex,
  outputKey: string = 'image',
  effectKey = 'render',
): Hex {
  return keccak256(
    stringToBytes(`${chainId}/${address.toLowerCase()}/${tokenId}/${effectKey}/${hash}/${outputKey}`),
  );
}

/**
 * The **bound** effect outputs — `site/content/docs/protocol/effects.mdx → Bound vs referenced`. An output is
 * bound iff a binding stitches its *content* into the metadata JSON, which is what decides who holds
 * its bytes:
 *
 *  - **bound** (`render/traits` → `attributes`): the serving node holds the content, capped at
 *    {@link BOUND_ARTIFACT_MAX_BYTES} and servable only at the current settled `inputsHash`. A
 *    locator here cannot work — the content is assembled into `tokenURI`, so a locator would put a
 *    third-party fetch on the hottest read the resolver serves.
 *  - **referenced** (everything else — `render/image` projects a *URL*, a `video`/`model` only
 *    appears in the manifest): the PRODUCER holds the bytes and the node stores a locator. Holding
 *    these bytes buys a node no capability (it redirects either way) and costs it an object store.
 *
 * This is the wire rule for `POST /v1/effect-artifacts` in both directions: bytes for a referenced
 * output and a locator for a bound one are each a `400`. Growing this set is an interface change —
 * every serving node must be able to stitch a bound output's content.
 */
export const BOUND_EFFECT_OUTPUTS: ReadonlySet<string> = new Set(['render/traits']);

/** The cap a serving node MUST accept per bound output and MUST refuse above (~100× a real traits
 *  payload — generous for JSON, far too small to become blob storage). */
export const BOUND_ARTIFACT_MAX_BYTES = 64 * 1024;

/** Is `{effectKey}/{outputKey}` a bound output — content the serving node must hold and stitch?
 *  Unknown effects answer `false`: an output a node can't stitch is referenced by definition, since
 *  bytes it can't stitch are bytes it could only redirect to. */
export function isBoundOutput(effectKey: string, outputKey: string): boolean {
  return BOUND_EFFECT_OUTPUTS.has(`${effectKey}/${outputKey}`);
}

// ── the param decode ───────────────────────────────────────────────────────────

/** One param's canonical decode, with the blob's SIZE alongside. */
export interface DecodedParam {
  /** The canonical string — what tokenData carries for this key. */
  value: string;
  /** A data-backed param's full content length in bytes; `null` for a literal, and for a blob
   *  that didn't read (the value degraded to the hash). Callers that bound inline content —
   *  the off-chain resolver's params handling (spec v8 removed the `abx_params` projection from both lanes), mirroring the renderer's former inline ceiling (removed with the projection) —
   *  measure THIS, the same length the chain measures. */
  contentBytes: number | null;
}

/**
 * The canonical per-param decode — the one implementation every off-chain surface shares
 * (tokenData assembly here, `abx_params` in the resolver), so a value reads the same
 * everywhere and stays byte-parallel with the on-chain generator and renderer.
 */
export async function decodeParam(
  client: PublicClient | null,
  token: Address,
  tokenId: string,
  p: ParamValue,
  tokenScope: boolean,
  schema: ParamSchema | undefined,
): Promise<DecodedParam> {
  const literal = (value: string): DecodedParam => ({value, contentBytes: null});
  if (!p.valueIsHash) {
    // `seed`'s wire format is INVARIANT: always the raw 32-byte hex, schema or no schema. The
    // on-chain side (`TokenDataLib.begin`) emits `toHexString(seed, 32)` unconditionally and never
    // consults a schema, so consulting one here would fork the work. Concretely: a project that
    // lets an authorized party choose the seed value declares a `seed` schema (typically
    // `Uint256Range` — note this is "pick the value", not a re-roll: the caller supplies it), and this
    // decode would then hand the work `"777"` where the on-chain generator hands it
    // `"0x00…0309"` — the same token rendering differently depending on which surface served it.
    // A `seed` schema governs WHO may write it and within what bounds; it does not change how it
    // reads. Checked before the schema branch for exactly that reason.
    if (p.key === 'seed') return literal(p.value);
    if (!schema) return literal(decodeTagLoose(p.value));
    if (schema.paramType === 'Select') {
      const idx = Number(BigInt(p.value));
      return literal(schema.selectOptions[idx] ?? String(idx));
    }
    return literal(decodeScalarParam(schema.paramType as ParamTypeName, p.value));
  }
  // data-backed: read the blob (token scope falls back to contract scope by construction)
  if (!client) return literal(p.value); // best-effort floor: the hash itself
  try {
    const blob = (await client.readContract({
      address: token,
      abi: seriesCodeAbi,
      functionName: tokenScope ? 'tokenParamData' : 'contractParamData',
      args: tokenScope ? [BigInt(tokenId), keyToBytes32(p.key)] : [keyToBytes32(p.key)],
    })) as Hex;
    const bytes = hexToBytes(blob);
    const value =
      schema?.paramType === 'String'
        ? new TextDecoder().decode(bytes)
        : bytesToBase64(bytes); // Bytes + schema-less: base64 at read
    return {value, contentBytes: bytes.length};
  } catch {
    return literal(p.value);
  }
}

// ── internals ──────────────────────────────────────────────────────────────────

/** A readable-ASCII `bytes32` literal as its string (e.g. a `display.animation` value). */
function decodeTagLoose(value: Hex): string {
  const bytes = hexToBytes(value);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const trimmed = bytes.slice(0, end);
  const isAscii = trimmed.length > 0 && trimmed.every((b) => b >= 0x20 && b < 0x7f);
  return isAscii ? new TextDecoder().decode(trimmed) : value;
}

function decodeBytes32Key(key: Hex): string {
  return decodeTagLoose(key);
}

function keyToBytes32(key: string): Hex {
  const bytes = new Uint8Array(32);
  bytes.set(stringToBytes(key).slice(0, 32));
  return bytesToHex(bytes);
}
