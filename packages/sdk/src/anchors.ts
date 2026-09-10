import type {Address, Hex, PublicClient} from 'viem';
import {
  oneOfOneImageAbi,
  oneOfOneImageFactoryAbi,
  seriesImageAbi,
  seriesImageFactoryAbi,
  abxMetadataRendererAbi,
  oneOfOneEditionAbi,
  oneOfOneEditionFactoryAbi,
  editionImageAbi,
  editionImageFactoryAbi,
} from './abi/index.js';
import {
  ANCHOR_GENERATIONS,
  currentAnchorGeneration,
  findAnchorGenerationByFactory,
  resolveFactory,
  resolveSeriesFactory,
  resolveRenderer,
  resolveSeriesCodeFactory,
  resolveSeedSource,
  resolveOneOfOneEditionFactory,
  resolveEditionFactory,
  resolveEditionCodeFactory,
} from './deployments.js';
import type {GenerationLifecycle, GenerationSupport} from './contract-generations.js';
import {
  predictRenderer,
  predictSeedSource,
  predictFactory,
  predictSeriesFactory,
  predictOneOfOneEditionFactory,
  predictEditionFactory,
  predictSeriesCodeFactory,
  predictEditionCodeFactory,
} from './create2.js';
import {
  deployFactory,
  deploySeriesFactory,
  deployRenderer,
  deploySeriesCodeFactory,
  deploySeedSource,
  deployOneOfOneEditionFactory,
  deployEditionFactory,
  deployEditionCodeFactory,
} from './deploy.js';
import {discoverDeployBlock} from './reconstruct.js';
import {AnchorUnavailableError, type AnchorKind} from './errors.js';
import type {SendTx} from './execute.js';

/**
 * Bootstrap-or-refuse resolution for ABX's six trust anchors + singletons — the six clone
 * factories (1/1, Series, SeriesCode and their three ERC-1155 edition twins) and the shared,
 * stateless renderer + seed source — plus the
 * read-only protocol questions that come with owning a deployed clone (which canonical factory made
 * it; its earliest plausible deploy block).
 *
 * Each `ensure*` follows the same shape as {@link ensureChunkStore} (chunks.ts): resolve the listed
 * address → verify code + capability → (renderer / seed-source only — see {@link AnchorEvent})
 * try the CREATE2-deterministic address → deploy via an injected {@link SendTx}, reporting progress
 * through `onEvent` so the SDK never prints. This lived only inside the CLI, hand-duplicated five
 * times with slightly different capability probes — exporting it is what lets a non-CLI integrator
 * bootstrap a chain identically instead of rediscovering "is this factory the current version?" the
 * hard way, the same reasoning `ensureChunkStore`'s own doc comment gives.
 */

/** Progress from an `ensure*` trust-anchor resolution, so a caller can narrate without the SDK
 *  printing anything itself (mirrors {@link ChunkStoreEvent}'s vocabulary). Not every anchor emits
 *  every kind: `canonical` (found at the CREATE2-deterministic address) applies to the renderer,
 *  the seed source, the two edition factories
 *  (`one-of-one-edition-factory`/`edition-factory`), the two 721 factories
 *  (`factory`/`series-factory`) and the two code factories
 *  (`series-code-factory`/`edition-code-factory`) — all FOUR of the edition/code factories link
 *  write-path libraries, which are themselves CREATE2-deployed at canonical salts, so the linked
 *  factory has a deterministic address like everything else (see `create2.ts`'s write-path-library
 *  note). Every anchor the SDK deploys now goes through the keyless proxy at a canonical salt, so
 *  every one of them can self-heal to its predicted address. The optional
 *  `deployed` fields are anchor-specific: `implementation` for every factory, `specVersion` for
 *  the renderer, and the linked write-path libraries each factory actually needs —
 *  `metadataLib` for ALL SIX (the metadata field store is externalized), plus
 *  `paramsLib`/`codeLib` for `SeriesCodeFactory`, all of them for `EditionCodeFactory`, and
 *  `paramsLib`/`editionLib` for the two 1155 image factories (`AbxEditionLib` is delegatecalled by
 *  ALL THREE edition token types, and it links `AbxParamsLib` itself). */
export type AnchorEvent = {anchor: AnchorKind} & (
  | {kind: 'resolved'; address: Address} // the configured/listed address checks out — nothing to deploy
  | {kind: 'stale'; address: Address; reason: 'no-code' | 'stale-version'} // listed but unusable; allowBootstrap continues
  | {kind: 'canonical'; address: Address} // found at the CREATE2-deterministic address instead
  | {kind: 'deploying'}
  | {
      kind: 'deployed';
      address: Address;
      inManifest: boolean;
      txHash: Hex;
      implementation?: Address;
      specVersion?: bigint;
      metadataLib?: Address;
      paramsLib?: Address;
      codeLib?: Address;
      editionLib?: Address;
    }
);

// ── the canonical 1/1 clone factory ───────────────────────────────────────────

/** Is the deployed factory this build's version? Reads its implementation and probes the
 *  NEWEST capability the current implementation exposes — `totalSupply()` (the live-count
 *  read) — so an older factory whose impl predates it is detected and a fresh, source-current
 *  (and thus Etherscan-verifiable) one deployed. A stale impl reverts the probe. (Bump this to
 *  the newest capability with each impl change.) */
/** `AbxVersion.CORE_VERSION` in `contracts/src/libraries/AbxVersion.sol`. MUST move in lockstep with
 *  it — the Solidity constant's own NatSpec says so, and `test/anchor-version.test.ts` pins the two
 *  together so a bump on one side cannot ship alone. */
export const ABX_CORE_VERSION = 2n;

/** Is this implementation built from the current core?
 *
 *  A VERSION gate, deliberately, replacing the capability probes that used to stand in for one.
 *  Those asked "does the implementation expose feature X" — a question older builds
 *  also answers yes to — and carried a comment instructing the next author to hand-bump the probed
 *  capability on every implementation change. That convention can report an older factory as
 *  `resolved` and keep stamping clones on an outdated implementation. `abxVersion()` has been on
 *  every token the whole time; nothing read it. */
async function implCoreVersionIsCurrent(publicClient: PublicClient, impl: Address): Promise<boolean> {
  try {
    const v = (await publicClient.readContract({
      address: impl,
      abi: oneOfOneImageAbi, // `abxVersion()` is on AbxBeaconCore — identical on all six token types
      functionName: 'abxVersion',
    })) as number | bigint;
    return BigInt(v) === ABX_CORE_VERSION;
  } catch {
    return false; // no `abxVersion()` at all ⇒ far older than the current core
  }
}

export async function isCurrentFactory(publicClient: PublicClient, factory: Address): Promise<boolean> {
  try {
    const impl = (await publicClient.readContract({
      address: factory,
      abi: oneOfOneImageFactoryAbi,
      functionName: 'implementation',
    })) as Address;
    // The core-version gate runs FIRST: it is the question that actually distinguishes builds. The
    // capability probe below stays as a cheap sanity check on the implementation's shape.
    if (!(await implCoreVersionIsCurrent(publicClient, impl))) return false;
    // `totalSupply()` is a view → readContract; it reverts on an impl that predates it.
    await publicClient.readContract({address: impl, abi: oneOfOneImageAbi, functionName: 'totalSupply'});
    return true;
  } catch {
    return false;
  }
}

/**
 * Get (or deploy) the chain's canonical 1/1 clone factory — the trust anchor: a factory is THE
 * address platforms allowlist by. Resolves the manifest (override → env → manifest); on a chain
 * with no current entry, deploys a fresh one when `allowBootstrap` is set (else throws
 * {@link AnchorUnavailableError} so the caller can refuse with guidance instead of silently
 * fragmenting trust across duplicate "canonical" factories).
 */
export async function ensureFactory(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; allowBootstrap?: boolean; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  // Resolve the canonical factory from the shipped manifest (flag → env → manifest); on a chain
  // with no entry, deploy a fresh trust anchor and tell the operator how to reuse it.
  const known = resolveFactory(opts.chainId, opts.override);
  if (known) {
    // sanity: is there code there, and is it *this* version of the factory?
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') {
      if (await isCurrentFactory(publicClient, known)) {
        notify({anchor: 'factory', kind: 'resolved', address: known});
        return known;
      }
      if (!opts.allowBootstrap) throw new AnchorUnavailableError('factory', 'stale-version', known);
      notify({anchor: 'factory', kind: 'stale', address: known, reason: 'stale-version'});
    } else {
      if (!opts.allowBootstrap) throw new AnchorUnavailableError('factory', 'no-code', known);
      notify({anchor: 'factory', kind: 'stale', address: known, reason: 'no-code'});
    }
  }
  // A CREATE2 address is bytecode-bound to the build that predicted it, so this build's OneOfOneImageFactory
  // sitting at its canonical address is already the right anchor — reuse it instead of deploying a
  // duplicate. This is what makes a chain missing from the manifest a non-event.
  const predicted = predictFactory();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x' && (await isCurrentFactory(publicClient, predicted))) {
      notify({anchor: 'factory', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  if (!known && !opts.allowBootstrap) throw new AnchorUnavailableError('factory', 'not-configured');
  notify({anchor: 'factory', kind: 'deploying'});
  const {factory, implementation, metadataLib, txHash} = await deployFactory(send, publicClient);
  notify({anchor: 'factory', kind: 'deployed', address: factory, implementation, metadataLib, txHash, inManifest: false});
  return factory;
}

// ── the canonical Series trust anchor ─────────────────────────────────────────

/** Is the deployed Series factory this build's version? Probes the impl for `nextTokenId()`
 *  (the Series-specific issuance cursor), which a stale/incompatible impl won't expose. */
export async function isCurrentSeriesFactory(publicClient: PublicClient, factory: Address): Promise<boolean> {
  try {
    const impl = (await publicClient.readContract({
      address: factory,
      abi: seriesImageFactoryAbi,
      functionName: 'implementation',
    })) as Address;
    // The core-version gate runs FIRST: it is the question that actually distinguishes builds. The
    // capability probe below stays as a cheap sanity check on the implementation's shape.
    if (!(await implCoreVersionIsCurrent(publicClient, impl))) return false;
    // Probe the NEWEST capability the current implementation exposes — ERC-165 support for the
    // IAbxSequentialMint primitive (mint(address) → uint256, the fixed-price-minter target).
    // A pre-minter-spine impl (mint returns void, id not advertised) returns false → a fresh,
    // source-current factory is deployed. (Bump this to the newest capability with each impl change.)
    return (await publicClient.readContract({
      address: impl,
      abi: seriesImageAbi,
      functionName: 'supportsInterface',
      args: ['0x6a627842'], // type(IAbxSequentialMint).interfaceId = bytes4(keccak256("mint(address)"))
    })) as boolean;
  } catch {
    return false;
  }
}

/** Get (or deploy) the chain's `SeriesImageFactory` — the multi-token trust anchor, the sibling
 *  of {@link ensureFactory}. Ownerless + immutable; one deployment serves every Series. */
export async function ensureSeriesFactory(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; allowBootstrap?: boolean; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveSeriesFactory(opts.chainId, opts.override);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x' && (await isCurrentSeriesFactory(publicClient, known))) {
      notify({anchor: 'series-factory', kind: 'resolved', address: known});
      return known;
    }
    if (!opts.allowBootstrap) throw new AnchorUnavailableError('series-factory', 'stale-version', known);
    notify({anchor: 'series-factory', kind: 'stale', address: known, reason: 'stale-version'});
  }
  // A CREATE2 address is bytecode-bound to the build that predicted it, so this build's SeriesImageFactory
  // sitting at its canonical address is already the right anchor — reuse it instead of deploying a
  // duplicate. This is what makes a chain missing from the manifest a non-event.
  const predicted = predictSeriesFactory();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x' && (await isCurrentSeriesFactory(publicClient, predicted))) {
      notify({anchor: 'series-factory', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  if (!known && !opts.allowBootstrap) throw new AnchorUnavailableError('series-factory', 'not-configured');
  notify({anchor: 'series-factory', kind: 'deploying'});
  const {factory, implementation, metadataLib, txHash} = await deploySeriesFactory(send, publicClient);
  notify({anchor: 'series-factory', kind: 'deployed', address: factory, implementation, metadataLib, txHash, inManifest: false});
  return factory;
}

// ── the canonical on-chain renderer ────────────────────────────────────────────

/** Is the configured renderer the spec version this build expects (**v11**)? A behind-spec renderer
 *  is treated as stale so {@link ensureRenderer} deploys a fresh one (greenfield redeploy-freely:
 *  this number is what tells the CLI a deployed renderer predates behavior the current build emits).
 *  Bump in lockstep with `AbxMetadataRenderer.SPEC_VERSION`.
 *
 *  **This is a security floor, not just a feature floor**, which is why it has moved twice for
 *  reasons unrelated to the params projection:
 *  - v4 → v5: v4 left the `abx_provenance` `note` unescaped, and that note carries owner-chosen
 *    bytes — enough to flip `onChain` to true, shadow the real `image`, or make `tokenURI`
 *    unparseable. A v4 renderer does not merely lag a projection; it will lie about provenance.
 *  - v5 → v6: removed two on-chain checks in favour of stated trust assumptions
 *    and closed an empty-render case that produced an unparseable document. Rendered output differs,
 *    so the version has to.
 *  - v6 → v7: the `artist` collection field became `creator`.
 *  - v7 → v8: fixed a computed `image` locator being data-wrapped, so it
 *    was not dereferenceable at all; `abx_provenance` lost `onChain` and `verifiedAgainstChain`
 *    (the first was wrong in both directions, the second always null); and `abx_params` left
 *    `tokenURI` entirely — params enumerate from the contract, which is canonical, and nothing read
 *    the projection back.
 *  - v8 → v9: a computed `image` was emitted twice — once as `image`, once again inside `artifacts`
 *    — nearly doubling the inner payload of the on-chain-SVG lane's `tokenURI`. The data-plane spec
 *    always allowed an on-chain renderer to omit reserved-key duplicates; v9 takes it, so
 *    `artifacts` no longer appears on the on-chain lanes at all. Rendered output differs, so the
 *    version has to.
 *  - v9 → v10: four reserved keys the spec had always listed were projected by neither plane on
 *    chain — `background_color`, `youtube_url`, `banner_image`, `featured_image`. A documented
 *    reserved key that nothing emits is a protocol hole, so the renderer now emits all four when
 *    their representation is chain-reachable. A v9 renderer silently drops them.
 *  - v10 → v11: `ipfs` and `arweave` — the two representations that are content-addressed, the two
 *    the protocol tells creators to prefer — used to fall back rather than resolve, so
 *    `--onchain-uri --backend ipfs` had to bake a gateway HOST into a `url` field and report
 *    `source: url` for bytes that live on IPFS. v11 projects them through the collection's
 *    preferred gateway (`abx_gateway_ipfs` / `abx_gateway_arweave`, public floors otherwise). A v10
 *    renderer serves the placeholder SVG for the very same chain state.
 *
 *  Read `specVersion()` rather than probing for a feature: a capability probe answers yes for every
 *  build that has the feature, which is exactly how a stale factory once reported as current. */
export async function isCurrentRenderer(publicClient: PublicClient, renderer: Address): Promise<boolean> {
  try {
    const v = (await publicClient.readContract({
      address: renderer,
      abi: abxMetadataRendererAbi,
      functionName: 'specVersion',
    })) as bigint;
    return v === 11n;
  } catch {
    return false;
  }
}

/** Get (or deploy) the chain's shared `AbxMetadataRenderer` — the on-chain metadata
 *  renderer that fully-on-chain tokens point at. Stateless + shared, so one deployment
 *  serves every project; redeployed only if missing or a stale spec version. */
export async function ensureRenderer(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveRenderer(opts.chainId, opts.override);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x' && (await isCurrentRenderer(publicClient, known))) {
      notify({anchor: 'renderer', kind: 'resolved', address: known});
      return known;
    }
    notify({anchor: 'renderer', kind: 'stale', address: known, reason: 'stale-version'});
  }
  // The current renderer is CREATE2-deterministic, so it may already exist at its predicted address
  // (deployed by the forge script, or a prior lazy deploy, with the manifest not yet updated). Check
  // there before deploying — self-healing, and never a duplicate. `deployRenderer` lands here too.
  const predicted = predictRenderer();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x' && (await isCurrentRenderer(publicClient, predicted))) {
      notify({anchor: 'renderer', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  notify({anchor: 'renderer', kind: 'deploying'});
  const {renderer, specVersion, txHash} = await deployRenderer(send, publicClient);
  notify({anchor: 'renderer', kind: 'deployed', address: renderer, specVersion, txHash, inManifest: false});
  return renderer;
}

// ── the code-project (SeriesCode) trust anchor ────────────────────────────────

/** The code-project trust anchor: use the canonical factory, else the CREATE2-deterministic address,
 *  else deploy one (a sandbox / fresh chain — libraries linked in-flight; see {@link
 *  deploySeriesCodeFactory}). Unlike the 1/1 and Series factories there is no version probe (no
 *  `isCurrentSeriesCodeFactory` — a configured factory with code is always accepted); it needs none
 *  at the deterministic address, because a CREATE2 address is bytecode-bound — code sitting at
 *  `predictSeriesCodeFactory()` is necessarily THIS build, linked against these libraries. */
export async function ensureSeriesCodeFactory(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; allowBootstrap?: boolean; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveSeriesCodeFactory(opts.chainId, opts.override);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') {
      notify({anchor: 'series-code-factory', kind: 'resolved', address: known});
      return known;
    }
    if (!opts.allowBootstrap) throw new AnchorUnavailableError('series-code-factory', 'no-code', known);
    notify({anchor: 'series-code-factory', kind: 'stale', address: known, reason: 'no-code'});
  }
  // Self-heal: the forge script (or an earlier bootstrap) may have put this build's factory at its
  // deterministic address without the manifest catching up. Check there before spending a deploy.
  const predicted = predictSeriesCodeFactory();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x') {
      notify({anchor: 'series-code-factory', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  if (!known && !opts.allowBootstrap) throw new AnchorUnavailableError('series-code-factory', 'not-configured');
  notify({anchor: 'series-code-factory', kind: 'deploying'});
  const r = await deploySeriesCodeFactory(send, publicClient);
  notify({
    anchor: 'series-code-factory',
    kind: 'deployed',
    address: r.factory,
    implementation: r.implementation,
    metadataLib: r.metadataLib,
    paramsLib: r.paramsLib,
    codeLib: r.codeLib,
    txHash: r.txHash,
    inManifest: false,
  });
  return r.factory;
}

// ── ERC-1155 editions: the three edition trust anchors ────────────────────────
//
// `IAbxEditionMint`'s selector-as-interfaceId (`mint(address,uint256,uint256)`, a
// single-function interface, per ERC-165 convention) — verified via `cast sig
// "mint(address,uint256,uint256)"` → `0x156e29f6`. Every current-build edition implementation
// advertises both this AND ERC-1155 itself (`0xd9b67a26`) via `supportsInterface`.
const EDITION_MINT_INTERFACE_ID = '0x156e29f6' as const;
const ERC1155_INTERFACE_ID = '0xd9b67a26' as const;

/** Is the deployed 1/1-edition factory this build's version? Reads its implementation and probes
 *  the newest capabilities the current implementation exposes: ERC-165 support for ERC-1155
 *  itself AND the edition mint primitive (`IAbxEditionMint`). A stale/incompatible impl fails
 *  either probe. (Bump these to the newest capability with each impl change — mirrors {@link
 *  isCurrentFactory}'s style.) */
export async function isCurrentOneOfOneEditionFactory(publicClient: PublicClient, factory: Address): Promise<boolean> {
  try {
    const impl = (await publicClient.readContract({
      address: factory,
      abi: oneOfOneEditionFactoryAbi,
      functionName: 'implementation',
    })) as Address;
    // The core-version gate runs FIRST: it is the question that actually distinguishes builds. The
    // capability probe below stays as a cheap sanity check on the implementation's shape.
    if (!(await implCoreVersionIsCurrent(publicClient, impl))) return false;
    const [isErc1155, isEditionMint] = await Promise.all([
      publicClient.readContract({address: impl, abi: oneOfOneEditionAbi, functionName: 'supportsInterface', args: [ERC1155_INTERFACE_ID]}),
      publicClient.readContract({address: impl, abi: oneOfOneEditionAbi, functionName: 'supportsInterface', args: [EDITION_MINT_INTERFACE_ID]}),
    ]);
    return Boolean(isErc1155) && Boolean(isEditionMint);
  } catch {
    return false;
  }
}

/**
 * Get (or deploy) the chain's canonical 1/1-edition clone factory — the trust anchor for a
 * priced open/limited edition of a single work. The edition twin of {@link ensureFactory},
 * but — because `OneOfOneEditionFactory` is CREATE2-deterministic (see `create2.ts`'s
 * class-level dev note), unlike the 721 1/1 factory's own bootstrap path — this one ALSO
 * self-heals to the predicted address, mirroring {@link ensureRenderer}'s style. The bootstrap
 * leg deploys `AbxParamsLib` + `AbxEditionLib` first (reusing whatever is already on-chain) and
 * links the factory against them — see {@link deployOneOfOneEditionFactory}.
 */
export async function ensureOneOfOneEditionFactory(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; allowBootstrap?: boolean; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveOneOfOneEditionFactory(opts.chainId, opts.override);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') {
      if (await isCurrentOneOfOneEditionFactory(publicClient, known)) {
        notify({anchor: 'one-of-one-edition-factory', kind: 'resolved', address: known});
        return known;
      }
      if (!opts.allowBootstrap) throw new AnchorUnavailableError('one-of-one-edition-factory', 'stale-version', known);
      notify({anchor: 'one-of-one-edition-factory', kind: 'stale', address: known, reason: 'stale-version'});
    } else {
      if (!opts.allowBootstrap) throw new AnchorUnavailableError('one-of-one-edition-factory', 'no-code', known);
      notify({anchor: 'one-of-one-edition-factory', kind: 'stale', address: known, reason: 'no-code'});
    }
  }
  const predicted = predictOneOfOneEditionFactory();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x' && (await isCurrentOneOfOneEditionFactory(publicClient, predicted))) {
      notify({anchor: 'one-of-one-edition-factory', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  if (!known && !opts.allowBootstrap) throw new AnchorUnavailableError('one-of-one-edition-factory', 'not-configured');
  notify({anchor: 'one-of-one-edition-factory', kind: 'deploying'});
  const {factory, implementation, metadataLib, paramsLib, editionLib, txHash} = await deployOneOfOneEditionFactory(send, publicClient);
  notify({
    anchor: 'one-of-one-edition-factory',
    kind: 'deployed',
    address: factory,
    implementation,
    metadataLib,
    paramsLib,
    editionLib,
    txHash,
    inManifest: false,
  });
  return factory;
}

/** Is the deployed edition-image factory this build's version? Same two-probe shape as {@link
 *  isCurrentOneOfOneEditionFactory} (ERC-1155 + `IAbxEditionMint`) — `MaxInvocations`'s id-space
 *  cap isn't a distinguishing probe here since it's shared, unchanged, with the 721 Series
 *  factory (see `reconstruct.ts`'s `contractType` fold for that same reasoning). */
export async function isCurrentEditionFactory(publicClient: PublicClient, factory: Address): Promise<boolean> {
  try {
    const impl = (await publicClient.readContract({
      address: factory,
      abi: editionImageFactoryAbi,
      functionName: 'implementation',
    })) as Address;
    // The core-version gate runs FIRST: it is the question that actually distinguishes builds. The
    // capability probe below stays as a cheap sanity check on the implementation's shape.
    if (!(await implCoreVersionIsCurrent(publicClient, impl))) return false;
    const [isErc1155, isEditionMint] = await Promise.all([
      publicClient.readContract({address: impl, abi: editionImageAbi, functionName: 'supportsInterface', args: [ERC1155_INTERFACE_ID]}),
      publicClient.readContract({address: impl, abi: editionImageAbi, functionName: 'supportsInterface', args: [EDITION_MINT_INTERFACE_ID]}),
    ]);
    return Boolean(isErc1155) && Boolean(isEditionMint);
  } catch {
    return false;
  }
}

/** Get (or deploy) the chain's `EditionImageFactory` — the multi-work edition trust anchor,
 *  the sibling of {@link ensureSeriesFactory}. CREATE2-deterministic, so it self-heals to its
 *  predicted address exactly like {@link ensureOneOfOneEditionFactory} — and, like it, links
 *  `AbxEditionLib` (+ that library's own `AbxParamsLib`) on the bootstrap leg. */
export async function ensureEditionFactory(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; allowBootstrap?: boolean; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveEditionFactory(opts.chainId, opts.override);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') {
      if (await isCurrentEditionFactory(publicClient, known)) {
        notify({anchor: 'edition-factory', kind: 'resolved', address: known});
        return known;
      }
      if (!opts.allowBootstrap) throw new AnchorUnavailableError('edition-factory', 'stale-version', known);
      notify({anchor: 'edition-factory', kind: 'stale', address: known, reason: 'stale-version'});
    } else {
      if (!opts.allowBootstrap) throw new AnchorUnavailableError('edition-factory', 'no-code', known);
      notify({anchor: 'edition-factory', kind: 'stale', address: known, reason: 'no-code'});
    }
  }
  const predicted = predictEditionFactory();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x' && (await isCurrentEditionFactory(publicClient, predicted))) {
      notify({anchor: 'edition-factory', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  if (!known && !opts.allowBootstrap) throw new AnchorUnavailableError('edition-factory', 'not-configured');
  notify({anchor: 'edition-factory', kind: 'deploying'});
  const {factory, implementation, metadataLib, paramsLib, editionLib, txHash} = await deployEditionFactory(send, publicClient);
  notify({
    anchor: 'edition-factory',
    kind: 'deployed',
    address: factory,
    implementation,
    metadataLib,
    paramsLib,
    editionLib,
    txHash,
    inManifest: false,
  });
  return factory;
}

/** The code-project EDITION trust anchor: use the canonical factory, else the CREATE2-deterministic
 *  address, else deploy one (a sandbox / fresh chain — three libraries linked in-flight; see {@link
 *  deployEditionCodeFactory}). Exactly {@link ensureSeriesCodeFactory}'s stance, extended to a third
 *  library: no version probe (a configured factory with code is always accepted), and the same
 *  bytecode-bound self-heal at `predictEditionCodeFactory()`. */
export async function ensureEditionCodeFactory(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; override?: string; allowBootstrap?: boolean; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveEditionCodeFactory(opts.chainId, opts.override);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') {
      notify({anchor: 'edition-code-factory', kind: 'resolved', address: known});
      return known;
    }
    if (!opts.allowBootstrap) throw new AnchorUnavailableError('edition-code-factory', 'no-code', known);
    notify({anchor: 'edition-code-factory', kind: 'stale', address: known, reason: 'no-code'});
  }
  const predicted = predictEditionCodeFactory();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x') {
      notify({anchor: 'edition-code-factory', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  if (!known && !opts.allowBootstrap) throw new AnchorUnavailableError('edition-code-factory', 'not-configured');
  notify({anchor: 'edition-code-factory', kind: 'deploying'});
  const r = await deployEditionCodeFactory(send, publicClient);
  notify({
    anchor: 'edition-code-factory',
    kind: 'deployed',
    address: r.factory,
    implementation: r.implementation,
    metadataLib: r.metadataLib,
    paramsLib: r.paramsLib,
    codeLib: r.codeLib,
    editionLib: r.editionLib,
    txHash: r.txHash,
    inManifest: false,
  });
  return r.factory;
}

// ── the canonical seed source ─────────────────────────────────────────────────

/** The canonical seed source — a clean keyless singleton (like the renderer / chunk store / minter):
 *  single-profile, so CREATE2 lands at THE canonical address on any chain. Resolves from the manifest,
 *  self-heals to the predicted address (deployed but not yet repointed), else auto-deploys via CREATE2. */
export async function ensureSeedSource(
  publicClient: PublicClient,
  send: SendTx,
  opts: {chainId: number; onEvent?: (e: AnchorEvent) => void},
): Promise<Address> {
  const notify = opts.onEvent ?? (() => {});
  const known = resolveSeedSource(opts.chainId);
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') {
      notify({anchor: 'seed-source', kind: 'resolved', address: known});
      return known;
    }
  }
  const predicted = predictSeedSource();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x') {
      notify({anchor: 'seed-source', kind: 'canonical', address: predicted});
      return predicted;
    }
  }
  const {seedSource, txHash} = await deploySeedSource(send, publicClient);
  notify({anchor: 'seed-source', kind: 'deployed', address: seedSource, txHash, inManifest: false});
  return seedSource;
}

// ── protocol reads: which factory, and from when ──────────────────────────────

/**
 * **The** enumeration of a chain's trust anchors: the three ERC-721 factories (1/1, Series,
 * SeriesCode) and the three ERC-1155 edition twins (OneOfOneEdition, EditionImage, EditionCode).
 * Deduplicated, env overrides honoured, missing entries dropped.
 *
 * Exported because it is the set a platform allowlists, and because it existed twice inside this
 * file — once in {@link detectCanonicalFactory} and once in {@link verifyCanonical} — which is one
 * copy too many for a list whose completeness IS the trust model. When the edition anchors were
 * missing from one of those copies, every canonical edition read `canonical: NO`: not "unverified",
 * a confident wrong answer on the one signal platforms gate on. **Any new token family is added
 * here, once.**
 */
export function canonicalFactories(chainId: number, opts: {override?: string} = {}): Address[] {
  if (opts.override) return [opts.override as Address];
  return [
    ...new Set(
      [
        resolveSeriesCodeFactory(chainId),
        resolveSeriesFactory(chainId),
        resolveFactory(chainId),
        resolveEditionCodeFactory(chainId),
        resolveEditionFactory(chainId),
        resolveOneOfOneEditionFactory(chainId),
      ].filter((f): f is Address => !!f),
    ),
  ];
}

/** Ask a set of factories, in one multicall, which (if any) claims `address` as its clone.
 *  Returns the winner plus how many anchors actually ANSWERED — the number that separates a
 *  coverage gap from evidence, and the reason a caller can distinguish `false` from `null`. */
async function askAnchors(
  publicClient: PublicClient,
  address: Address,
  candidates: Address[],
): Promise<{hit?: Address; answered: number}> {
  if (!candidates.length) return {answered: 0};
  try {
    const results = (await publicClient.multicall({
      contracts: candidates.map((f) => ({
        address: f,
        abi: oneOfOneImageFactoryAbi,
        functionName: 'isAbxClone',
        args: [address],
      })) as never,
      allowFailure: true,
    })) as Array<{status: 'success'; result: unknown} | {status: 'failure'}>;
    const answered = results.filter((r) => r?.status === 'success').length;
    const hit = candidates.find(
      (_, i) => results[i]?.status === 'success' && (results[i] as {result: unknown}).result === true,
    );
    return {hit, answered};
  } catch {
    return {answered: 0}; // RPC hiccup — no anchor answered, which is an unknown, never a "no"
  }
}

/**
 * Pick the canonical factory for a clone being added. An explicit override or a stored value
 * wins; otherwise probe ALL SIX of the chain's known factories — the three 721 anchors (SeriesCode,
 * Series, 1/1) and the three ERC-1155 edition anchors (EditionCode, EditionImage, OneOfOneEdition) —
 * for the ONE whose `isAbxClone` confirms this address, so `abx add` of any project records the RIGHT
 * factory and canonicity actually verifies. Without this, `add` defaulted to the 1/1 factory, so a
 * code/Series clone read `canonical: unverified` (the check ran against the wrong factory). One
 * multicall, only when the factory isn't already known; falls back to the 1/1 default on any miss/RPC
 * error (`isAbxClone` shares a selector across all factory ABIs, so one ABI probes them all).
 *
 * The edition anchors were missing here when the 1155 lane shipped, and the failure was worse than
 * "unverified": the 1/1 fallback answers `isAbxClone` = **false**, so every genuinely-canonical
 * edition read `canonical: NO` — a confident wrong answer about the trust anchor, on the one signal
 * platforms allowlist against. Any new token family MUST be added to this list in the same change.
 */
export async function detectCanonicalFactory(
  publicClient: PublicClient,
  address: Address,
  opts: {chainId: number; override?: string; stored?: string | null},
): Promise<Address | undefined> {
  if (opts.override) return opts.override as Address;
  if (opts.stored) return opts.stored as Address;
  const candidates = canonicalFactories(opts.chainId);
  if (candidates.length <= 1) return candidates[0]; // nothing to disambiguate
  // An RPC hiccup falls through to the default, so canonicity shows unverified — never wrong.
  const {hit} = await askAnchors(publicClient, address, candidates);
  return hit ?? resolveFactory(opts.chainId) ?? undefined;
}

/**
 * Is this address a clone of one of the chain's trust anchors? A tri-state, read straight from chain
 * — no projection, no indexer, no prior `abx add`.
 *
 * `true` = some anchor's `isAbxClone` confirms it. `false` = every anchor we know answered and none
 * claimed it: a superseded factory, or a contract deployed outside the toolkit entirely. `null` = the
 * check could not run (no anchors configured for this chain, or the RPC failed) — which is NOT the
 * same answer and must never be shown as one.
 *
 * Exists because `abx state` — the command anyone reaches for to ask "what IS this contract?" — read
 * owner, supply, royalty and renderer off any ERC-721-shaped address and said nothing about whether it
 * was canonical. An agent that built its own contracts instead of using the factory therefore left
 * nothing behind that the creator could discover, from the one tool whose job is to tell them.
 * Canonicity is the single signal platforms allowlist against, and it cannot be added later.
 */
export async function verifyCanonical(
  publicClient: PublicClient,
  address: Address,
  chainId: number,
  opts: {factories?: Address[]} = {},
): Promise<boolean | null> {
  // `opts.factories` REPLACES the manifest set; it never appends to it. That direction is the whole
  // point for a multi-tenant host: an operator who pinned a trust set expects a gate to be exactly
  // as permissive as they asked, and appending ours would silently widen it.
  const candidates = opts.factories ?? canonicalFactories(chainId);
  if (!candidates.length) return null; // nothing to check against — not a verdict
  const {hit, answered} = await askAnchors(publicClient, address, candidates);
  if (hit) return true;
  // Only a verdict if at least one anchor actually answered; all-failures is an unknown, not a "no".
  return answered > 0 ? false : null;
}

/** What {@link verifyProvenance} found: canonicity, and — when an anchor claimed the clone — WHICH
 *  generation of the trust anchors stamped it, so "canonical, prior generation" is sayable at all. */
export interface ProvenanceResult {
  /** `true` = an anchor claims it. `false` = anchors answered and none did. `null` = no evidence. */
  canonical: boolean | null;
  /** `'current'` = the live anchors. `'prior'` = a retired generation (canonically ABX, older).
   *  `null` = no generation claimed it (or nothing answered). */
  generation: 'current' | 'prior' | null;
  /** Stable identifier for the matching generation. */
  generationId: string | null;
  /** Human-facing state. Dispatch on `support`, not this label. */
  generationLifecycle: GenerationLifecycle | null;
  /** Operations ABX software supports for this generation. */
  support: GenerationSupport | null;
  /** The core spec version that generation stamps — the sayable identity ("canonically ABX v2").
   *  Cross-check it against the clone's own `abxVersion()`, which is where it is verifiable. */
  coreVersion: number | null;
  /** The anchor that claimed it, when one did. */
  factory?: Address;
  /** How many anchors answered at all. `0` with `canonical: null` is a coverage gap, not a verdict. */
  anchorsAnswered: number;
}

/**
 * Canonicity **plus provenance**: not just "is this ours" but "which generation of ours", so a
 * consumer can tell *"deployed by an ABX factory that has since been replaced"* from *"deployed
 * outside the toolkit entirely"*. Today those are the same `false` from {@link verifyCanonical} —
 * which its own docstring admits ("a superseded factory, **or** a contract deployed outside the
 * toolkit") — and they are very different things to show a collector.
 *
 * Checks the live anchors first, then each retired generation in {@link ANCHOR_GENERATIONS}. A
 * retired generation NEVER makes `canonical` mean "trusted": it is labelled `generation: 'prior'`
 * precisely so a caller has to decide, and `verifyCanonical` — the gate — does not consult these
 * anchors at all.
 *
 * Prior testnet generations are not backfilled, so today this answers `'current'` or nothing. From the
 * first batch that retires an anchor set, the answer exists rather than needing a protocol change at
 * the moment it is first asked for.
 */
export async function verifyProvenance(
  publicClient: PublicClient,
  address: Address,
  chainId: number,
  opts: {factories?: Address[]} = {},
): Promise<ProvenanceResult> {
  const live = opts.factories ?? canonicalFactories(chainId);
  const current = await askAnchors(publicClient, address, live);
  if (current.hit) {
    // A caller-supplied trust set may contain non-ABX factories. It can establish trust for that
    // caller, but it cannot manufacture ABX generation provenance.
    const generation = opts.factories
      ? findAnchorGenerationByFactory(current.hit)
      : currentAnchorGeneration();
    return {
      canonical: true,
      generation: generation ? (generation.lifecycle === 'current' ? 'current' : 'prior') : null,
      generationId: generation?.id ?? null,
      generationLifecycle: generation?.lifecycle ?? null,
      support: generation?.support ?? null,
      coreVersion: generation?.coreVersion ?? null,
      factory: current.hit,
      anchorsAnswered: current.answered,
    };
  }
  // An explicit trust set is exactly that: don't quietly widen the search to prior generations.
  const prior = opts.factories ? [] : ANCHOR_GENERATIONS.filter((g) => g.lifecycle !== 'current');
  let answered = current.answered;
  for (const gen of prior) {
    const res = await askAnchors(publicClient, address, Object.values(gen.factories));
    answered += res.answered;
    if (res.hit) {
      return {
        canonical: true,
        generation: 'prior',
        generationId: gen.id,
        generationLifecycle: gen.lifecycle,
        support: gen.support,
        coreVersion: gen.coreVersion,
        factory: res.hit,
        anchorsAnswered: answered,
      };
    }
  }
  return {
    canonical: answered > 0 ? false : null,
    generation: null,
    generationId: null,
    generationLifecycle: null,
    support: null,
    coreVersion: null,
    anchorsAnswered: answered,
  };
}

/** Progress from {@link resolveScanFloor}'s on-chain discovery fallback, so a caller can narrate
 *  without the SDK printing. */
export type ScanFloorEvent =
  | {kind: 'genesis-warning'} // an explicit from-block of 0 was passed — a full-chain scan
  | {kind: 'discovered'; block: bigint}; // the deploy block was found via getCode binary search

/**
 * Resolve the scan floor (fromBlock) for an add/index: an explicit override wins, else the deploy
 * block the local deploy already stored, else discover it from chain (getCode binary search). It
 * NEVER silently defaults to genesis — a from-0 full scan of a live chain must be an explicit
 * opt-in, because on a range-capped RPC it's the difference between an instant index and grinding
 * millions of blocks (the #1 reason a hosted resolver appears "not to index"). Returns a decimal
 * block string. Only touches RPC in the discovery fallback (rare — a foreign contract we didn't
 * deploy here), so the common post-deploy path makes no extra call.
 */
export async function resolveScanFloor(
  publicClient: PublicClient,
  address: Address,
  opts: {explicit?: string; localFromBlock?: string; onEvent?: (e: ScanFloorEvent) => void} = {},
): Promise<string> {
  const notify = opts.onEvent ?? (() => {});
  if (opts.explicit !== undefined) {
    if (/^0+$/.test(opts.explicit.trim())) notify({kind: 'genesis-warning'});
    return opts.explicit;
  }
  if (opts.localFromBlock !== undefined) return opts.localFromBlock; // the deploy stored the exact block
  const discovered = await discoverDeployBlock(publicClient, address);
  if (discovered !== null) {
    notify({kind: 'discovered', block: discovered});
    return discovered.toString();
  }
  throw new Error(
    `couldn't determine ${address}'s deploy block (no local record, and on-chain discovery failed). ` +
      `That can be a non-archive RPC, a rate-limited endpoint, or a node that refuses historical getCode — ` +
      `not a diagnosis \`abx doctor\` already settled. Pass --from-block <deployBlock> so indexing starts there ` +
      `instead of sweeping from genesis. (--from-block 0 forces a full-chain scan if you really want it.)`,
  );
}
