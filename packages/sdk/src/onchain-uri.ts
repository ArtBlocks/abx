/**
 * The on-chain tokenURI lane for code projects (`abx deploy-code --onchain-uri`) — pure leg
 * composition + the verify-time honesty reads, all unit-testable with a mocked client.
 *
 * The lane (site/content/docs/protocol/code-projects.mdx → "The canonical generator — AbxGenerator" +
 * site/content/docs/protocol/metadata.mdx → "URI resolution"): the collection-scope `animation_url`
 * field points at the canonical generator via the `renderer` representation
 * (`abi.encode(address)`), and the token's `tokenURIRenderer` toggles tokenURI to the canonical
 * on-chain metadata renderer (`setContractURIRenderer` does the same for contractURI). Both ride
 * the EXISTING setup multicall, before the mints.
 *
 * The param surface is NOT part of that wiring: params enumerate ON-CHAIN (`contractParamKeys` /
 * `tokenParamKeys`, maintained by the write paths themselves), so the generator reads the key set
 * straight from the token. The old `params.keys` CSV convention is retired — nothing writes it any
 * more.
 */
import {encodeFunctionData, zeroAddress, type Address, type Hex} from 'viem';
import {decodeTag, encodeTag, METADATA_FIELD as F, METADATA_REPRESENTATION as R} from './spine.js';
import {seriesCodeAbi} from './abi/index.js';
import {readGeneratorStatus, type GeneratorReadClient, type GeneratorStatus} from './generator.js';
import {resolveGenerator} from './deployments.js';
import {decodeFieldRenderer, encodeFieldRenderer} from './token.js';
import {DEP_RESOLUTION, type DepCheck, type ParsedDependencyRef} from './deps.js';
import type {ProjectState} from './types.js';
import {parseDataUri, base64ToBytes} from './util.js';

/**
 * The `--onchain-uri` legs of the setup multicall, in order:
 *   1. collection-scope `animation_url` field → representation `renderer`,
 *      value `abi.encode(generator)` (the canonical generator computes the live view on-chain);
 *   2. `setTokenURIRenderer(metadataRenderer)` — tokenURI resolves ON-CHAIN from here on;
 *   3. `setContractURIRenderer(metadataRenderer)` — contractURI too (parity with the 1/1 lane).
 * Placed BEFORE the mint legs so every token is born with the on-chain lane fully configured.
 *
 * There is no param leg: the generator enumerates the param surface from the token itself
 * (`contractParamKeys` / `tokenParamKeys`), so there is nothing for a deploy to declare.
 */
export function onchainUriSetupCalls(args: {generator: Address; metadataRenderer: Address}): Hex[] {
  const calls: Hex[] = [];
  // The `animation_url` leg points at the generator (which computes the doc from a PROGRAM). A
  // renderer-only drop (in-chain SVG, no program) has no generator — and baking this leg at a ZERO
  // generator would make the metadata renderer staticcall a codeless address and REVERT every
  // tokenURI. So emit it only when there's a real generator; otherwise there's simply no animation_url
  // (optional by spec — the metadata renderer omits an unset field).
  if (args.generator !== zeroAddress) {
    calls.push(
      encodeFunctionData({
        abi: seriesCodeAbi,
        functionName: 'setContractField',
        args: [encodeTag(F.animationUrl), encodeTag(R.renderer), encodeFieldRenderer(args.generator)],
      }),
    );
  }
  calls.push(
    encodeFunctionData({abi: seriesCodeAbi, functionName: 'setTokenURIRenderer', args: [args.metadataRenderer]}),
    encodeFunctionData({abi: seriesCodeAbi, functionName: 'setContractURIRenderer', args: [args.metadataRenderer]}),
  );
  return calls;
}

// ── the param surface, enumerated FROM CHAIN ──────────────────────────────────
// `key ∈ list ⟺ the param isSet` — the contract maintains both key lists inside the write paths
// themselves, so nothing off-chain has to be kept in step. `seed` is deliberately never listed
// (every consumer reads it as a tokenData coordinate). Enumeration order is unspecified; the
// canonical serialization sorts.

/** The SET param keys: `contractParamKeys()`, plus `tokenParamKeys(tokenId)` when a token is named.
 *  Null when the getters are absent — a LEGACY project deployed before enumeration shipped (or a
 *  token type with no Params extension at all). */
export async function readSetParamKeys(
  client: GeneratorReadClient,
  contract: Address,
  tokenId?: bigint,
): Promise<{contract: string[]; token: string[]} | null> {
  try {
    const contractKeys = (await client.readContract({
      address: contract,
      abi: seriesCodeAbi,
      functionName: 'contractParamKeys',
      args: [],
    })) as readonly Hex[];
    const tokenKeys =
      tokenId === undefined
        ? ([] as readonly Hex[])
        : ((await client.readContract({
            address: contract,
            abi: seriesCodeAbi,
            functionName: 'tokenParamKeys',
            args: [tokenId],
          })) as readonly Hex[]);
    return {contract: contractKeys.map(decodeTag), token: tokenKeys.map(decodeTag)};
  } catch {
    return null;
  }
}

/** The DECLARED (governed) keys: `paramSchemaKeys()`, append-only — including keys declared but
 *  never yet written, which are otherwise undiscoverable. Null on a legacy project. */
export async function readParamSchemaKeys(client: GeneratorReadClient, contract: Address): Promise<string[] | null> {
  try {
    const keys = (await client.readContract({
      address: contract,
      abi: seriesCodeAbi,
      functionName: 'paramSchemaKeys',
      args: [],
    })) as readonly Hex[];
    return keys.map(decodeTag);
  } catch {
    return null;
  }
}

/** The project's three param-lifecycle hook addresses (`paramHooks()`), zeroes included — null on a
 *  project with no ConfigurableParams surface (a 1/1, a plain Series, an image edition).
 *
 *  The `transferHook` in this trio is a **veto**: its revert fails the transfer, and a mint is a
 *  transfer from `0x0`, so a reverting hook stops minting too. Whether the trio can still change is
 *  a separate read — `readParamHooksLocked` (ops.ts), or the `ParamHooksFrozen` fold. */
export async function readParamHooks(
  client: GeneratorReadClient,
  contract: Address,
): Promise<{configureHook: Address; augmentHook: Address; transferHook: Address} | null> {
  try {
    const [configureHook, augmentHook, transferHook] = (await client.readContract({
      address: contract,
      abi: seriesCodeAbi,
      functionName: 'paramHooks',
      args: [],
    })) as readonly [Address, Address, Address];
    return {configureHook, augmentHook, transferHook};
  } catch {
    return null;
  }
}

/** Does this token expose the enumeration surface at all? The one-call probe behind the repoint
 *  guard: the canonical generator reads params from chain, so pointing a token that lacks these
 *  getters at it makes every param silently invisible. */
export async function hasParamEnumeration(client: GeneratorReadClient, contract: Address): Promise<boolean> {
  try {
    await client.readContract({address: contract, abi: seriesCodeAbi, functionName: 'tokenParamKeys', args: [0n]});
    return true;
  } catch {
    return false;
  }
}

// ── the chain-complete expectation (deploy-time, from the P1 dependency report) ──

/** What the deploy can honestly promise about the generator's template branch, derived from
 *  the selection-time dependency report (never a new RPC): chain-complete iff every registry
 *  dep has proven ON-CHAIN bytes (OnChain refs read their data contract directly, so they
 *  count as on-chain; `abx verify` is the from-chain confirmation either way). */
export function expectedChainComplete(
  deps: ParsedDependencyRef[],
  checks: DepCheck[],
): {expected: boolean | null; detail: string} {
  if (deps.length === 0) return {expected: true, detail: 'no dependencies — the document assembles from the script chunks alone'};
  const registryDeps = deps.filter((d) => d.resolution === DEP_RESOLUTION.registry);
  if (registryDeps.length === 0) {
    return {expected: true, detail: 'all dependencies are on-chain data contracts (read directly)'};
  }
  const byDep = new Map(checks.map((c) => [c.dep, c]));
  const cdnOnly: string[] = [];
  const missing: string[] = [];
  let unknown = false;
  for (const d of registryDeps) {
    const chk = byDep.get(d.display);
    if (!chk || chk.status === 'skipped') unknown = true;
    else if (chk.status === 'not-found') missing.push(d.display);
    else if (!chk.details.availableOnChain) cdnOnly.push(d.display);
  }
  if (missing.length) return {expected: false, detail: `${missing.join(', ')} not on the registry — the generator will emit an unresolved marker`};
  if (cdnOnly.length) return {expected: false, detail: `${cdnOnly.join(', ')} CDN-served (the normal production path) — serves fine, NOT chain-complete`};
  if (unknown) return {expected: null, detail: 'registry check was skipped (RPC unreachable) — `abx verify` reads the truth from chain'};
  return {expected: true, detail: 'every dependency has ON-CHAIN bytes — no server, gateway, or CDN in the graph'};
}

// ── verify: the honesty reads (`onChainStatus` + a tokenURI probe) ─────────────

/** The generator this project's on-chain lane actually uses: the collection `animation_url`
 *  field's `renderer` value when set (that address is what the metadata renderer staticcalls),
 *  else the chain's canonical generator. Null when neither exists. */
export function generatorFor(state: ProjectState, override?: string): Address | null {
  const field = state.collectionFields.find((f) => f.field === F.animationUrl && f.representation === R.renderer);
  if (field) {
    try {
      return decodeFieldRenderer(field.value);
    } catch {
      /* malformed value — fall through to the manifest */
    }
  }
  return resolveGenerator(state.chainId, override) ?? null;
}

/** Whether verify should run the on-chain-URI report: the tokenURIRenderer toggle is on, or
 *  the collection `animation` field points at a field renderer (the generator). */
export function hasOnChainUriLane(state: ProjectState): boolean {
  const rendererSet = !!state.tokenURIRenderer && state.tokenURIRenderer !== zeroAddress;
  const animationRenderer = state.collectionFields.some(
    (f) => f.field === F.animationUrl && f.representation === R.renderer,
  );
  return rendererSet || animationRenderer;
}

const erc721TokenUriAbi = [
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{name: 'id', type: 'uint256'}],
    outputs: [{name: '', type: 'string'}],
  },
] as const;

/** The three ERC-1155 members of the `contractType` ladder — the ones that expose `uri(id)` instead
 *  of `tokenURI(id)`. Kept as a set so adding a token family is one edit, not a string-shape guess. */
const EDITION_CONTRACT_TYPES: ReadonlySet<string> = new Set(['1of1-edition', 'edition', 'edition-code']);

/** The 1155 twin of the probe above. An edition exposes `uri(id)`, NOT `tokenURI(id)` — probing a
 *  721 selector on an edition reverts, which surfaced as `verify` reporting "on-chain URI check
 *  unavailable" (plus a raw viem dump) for EVERY edition. Mirrors `reconstruct.ts`'s uriAbi/uriFn. */
const erc1155UriAbi = [
  {
    type: 'function',
    name: 'uri',
    stateMutability: 'view',
    inputs: [{name: 'id', type: 'uint256'}],
    outputs: [{name: '', type: 'string'}],
  },
] as const;

export interface TokenUriProbe {
  tokenId: string;
  /** Which accessor was actually read — `tokenURI` on a 721, `uri` on an ERC-1155 edition. Readouts
   *  quote this so an edition is never described in 721 terms. */
  accessor: 'tokenURI' | 'uri';
  /** tokenURI(id)/uri(id) is a `data:application/json;base64,` URI (resolves on-chain, any RPC). */
  onChainJson: boolean;
  uriPrefix: string; // the first bytes of the URI, for an honest mismatch message
  animation:
    | {form: 'data-html'; bytes: number; marker: string | null} // template: the document, inline
    | {form: 'url'; url: string} // directory: the parameterized gateway URL, verbatim
    | {form: 'data-other'; prefix: string} // wrapped, but not text/html
    | {form: 'missing'}; // no animation_url in the JSON
}

export interface OnChainUriReport {
  generator: Address;
  status: GeneratorStatus;
  /** Null when no token is minted yet (tokenURI would revert). */
  probe: TokenUriProbe | null;
}

/** An HTML comment marker the generator emits on degradation (`<!-- abx:… -->`), or null. */
function degradationMarker(html: string): string | null {
  const m = /<!--\s*abx:[^>]*-->/.exec(html);
  return m ? m[0] : null;
}

function probeAnimation(animationUrl: string | undefined): TokenUriProbe['animation'] {
  if (!animationUrl) return {form: 'missing'};
  const parsed = parseDataUri(animationUrl);
  if (parsed && parsed.mime === 'text/html' && parsed.base64) {
    const bytes = base64ToBytes(parsed.body);
    const html = new TextDecoder().decode(bytes);
    return {form: 'data-html', bytes: bytes.length, marker: degradationMarker(html)};
  }
  if (animationUrl.startsWith('data:')) return {form: 'data-other', prefix: animationUrl.slice(0, 40)};
  return {form: 'url', url: animationUrl};
}

/**
 * The verify-time on-chain-URI report: `generator.onChainStatus(token)` (branch ·
 * chain-completeness · unresolved refs · URL budget) plus a `tokenURI` probe of the lowest
 * minted token — decoded, with the `animation_url` form checked against the branch.
 */
export async function onChainUriReport(
  client: GeneratorReadClient,
  state: ProjectState,
  generatorOverride?: string,
): Promise<OnChainUriReport> {
  const generator = generatorFor(state, generatorOverride);
  if (!generator) {
    throw new Error(
      `no AbxGenerator known for chain ${state.chainId} — set ABX_GENERATOR=0x… (or update @artblocks/abx-sdk's deployments manifest)`,
    );
  }
  const status = await readGeneratorStatus(client, generator, state.address);

  // LIVE tokens only, and the reason is sharper than tidiness: this probe reads the LOWEST id it
  // finds, and `tokenURI` reverts `NonexistentToken` for a burned one. Burned ids must not make the
  // collection's on-chain-URI lane report as broken.
  const minted = state.tokens.filter((t) => t.lifecycle === 'live').map((t) => BigInt(t.tokenId));
  let probe: TokenUriProbe | null = null;
  if (minted.length) {
    const tokenId = minted.reduce((a, b) => (b < a ? b : a));
    const isEdition = EDITION_CONTRACT_TYPES.has(state.contractType ?? '');
    const uri = (await client.readContract({
      address: state.address,
      abi: isEdition ? erc1155UriAbi : erc721TokenUriAbi,
      functionName: isEdition ? 'uri' : 'tokenURI',
      args: [tokenId],
    })) as string;
    const parsed = parseDataUri(uri);
    const isOnChainJson = !!parsed && parsed.mime === 'application/json' && parsed.base64;
    let animation: TokenUriProbe['animation'] = {form: 'missing'};
    if (parsed && isOnChainJson) {
      try {
        const json = JSON.parse(new TextDecoder().decode(base64ToBytes(parsed.body))) as Record<string, unknown>;
        animation = probeAnimation(typeof json.animation_url === 'string' ? json.animation_url : undefined);
      } catch {
        /* undecodable JSON — reported as onChainJson with a missing animation */
      }
    }
    probe = {
      tokenId: tokenId.toString(),
      accessor: isEdition ? 'uri' : 'tokenURI',
      onChainJson: isOnChainJson,
      uriPrefix: uri.slice(0, 48),
      animation,
    };
  }
  return {generator, status, probe};
}
