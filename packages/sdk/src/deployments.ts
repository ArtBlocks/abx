/**
 * Canonical, shared ABX infrastructure — shipped as constants, keyed by EIP-155 chainId.
 *
 * The clone **factories** (trust anchors) and the stateless singletons (renderer, chunk store,
 * minter, seed source) are deployed as public goods and recorded here, so the toolkit resolves
 * them with zero local state — no per-user cache, no `config.json`. This is what lets the CLI be
 * stateless about which infrastructure to use.
 *
 * DETERMINISTIC ADDRESSES: everything except the generator is deployed through the keyless CREATE2
 * proxy (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with canonical salts (see
 * `contracts/script/AbxSalts.sol`), so a given contract has the **same address on every chain** —
 * that's why `CANONICAL` below is a single record, spread into each chain. Adding a chain deploys
 * the same salts + initcode → the same addresses (computable before the first tx). The one
 * exception is the **generator**: its constructor bakes chain-specific immutables (per-chain
 * runtime-asset pointers + dependency registry), so it's recorded per chain.
 *
 * Precedence for every address is **explicit override → env → this manifest**:
 *   - override: a `--factory` / `--renderer` / `--chunk-store` flag (advanced / one-off)
 *   - env: `ABX_FACTORY` / `ABX_RENDERER` / `ABX_CHUNK_STORE` (a chain you run that isn't
 *     shipped yet, or a private deployment — the operator declares it, the tool never writes it)
 *   - manifest: the canonical address below
 *
 * ALPHA SCOPE: the npm alpha supports Base Sepolia (the default, chainId 84532) and Sepolia
 * (11155111). Mainnet entries are absent until canonical infrastructure is deployed and recorded.
 *
 * Changing a contract → redeploy → repoint here: see contracts/README.md#changing-a-contract.
 */
import type {Address} from 'viem';
import {readEnv} from './util.js';

export {
  ANCHOR_GENERATIONS,
  currentAnchorGeneration,
  findAnchorGenerationByCoreVersion,
  findAnchorGenerationByFactory,
  findAnchorGenerationById,
  supportsGenerationOperation,
} from './contract-generations.js';
export type {
  AnchorGeneration,
  GenerationLifecycle,
  GenerationOperation,
  GenerationSupport,
} from './contract-generations.js';

export interface ChainDeployment {
  factory?: Address; // OneOfOneImageFactory (1/1 trust anchor)
  seriesFactory?: Address; // SeriesImageFactory (multi-token trust anchor)
  seriesCodeFactory?: Address; // SeriesCodeFactory (code-project trust anchor)
  renderer?: Address;
  chunkStore?: Address;
  fixedPriceMinter?: Address; // AbxFixedPriceMinter (shared ownerless sale singleton)
  seedSource?: Address; // AbxSeedSource (canonical pseudorandom mint-time randomizer)
  generator?: Address; // AbxGenerator (canonical on-chain generator — the animation_url field renderer)
  // ERC-1155 editions — deployed and canonical on both chains.
  oneOfOneEditionFactory?: Address; // OneOfOneEditionFactory (1/1-edition trust anchor)
  editionFactory?: Address; // EditionImageFactory (multi-work edition trust anchor)
  editionCodeFactory?: Address; // EditionCodeFactory (code-project edition trust anchor)
  fixedPriceMinter1155?: Address; // AbxFixedPriceMinter1155 (shared ownerless edition sale singleton)
  // The delegatecalled write-path libraries. Recorded because a token implementation is only
  // meaningful together with the libraries it links: `abx verify` and the deploy lane check the
  // linked addresses against these, so a factory bound to an un-manifested copy is detectable
  // rather than silent.
  metadataLib?: Address; // AbxMetadataLib — the on-chain metadata field store (ALL SIX token types)
  paramsLib?: Address; // AbxParamsLib — params + configurable-params write paths
  codeLib?: Address; // AbxCodeLib — script + dependencies write paths (code projects)
  editionLib?: Address; // AbxEditionLib — the shared ERC-1155 body (all three edition types)
}

/**
 * The cross-chain-identical set — CREATE2 (keyless proxy + `AbxSalts`), so these addresses are the
 * SAME on every chain. Factory addresses list their EIP-1167 implementation; the implementations are
 * identical cross-chain too (a factory does exactly one CREATE at nonce 1 from its own — identical —
 * address). The renderer is **spec v11** — the version `isCurrentRenderer` gates on, and the reason a
 * behind-spec renderer is treated as stale rather than merely older: each bump changed what the
 * document actually contains (v5 escaped the provenance note, v6 changed rendered output for hostile
 * input, v7 renamed the `artist` collection field to `creator`, v8 retired the `abx_params` block and
 * narrowed provenance to the route a field took rather than a claim about its destination, v9 stopped
 * duplicating a computed image into `artifacts`, which changes what the document contains, v10 added
 * four reserved keys neither plane emitted, and v11 moved `ipfs`/`arweave` out of the fallback set:
 * a v10 renderer serves the placeholder SVG for chain state a v11 renderer resolves).
 *
 * The delegatecalled write-path libraries are CREATE2-deterministic and identical everywhere too —
 * that is a property of CREATE2, not a lucky accident, and linking a library does not cost the
 * linking factory its own deterministic address (see `create2.ts`'s write-path-library note, which
 * explains what IS a real trap here). They are deployed EXPLICITLY at `AbxSalts.METADATA_LIB` /
 * `.PARAMS_LIB` / `.CODE_LIB` / `.EDITION_LIB` (`abx.lib.metadata.v1` / `abx.lib.params.v1` /
 * `abx.lib.code.v1` / `abx.lib.edition.v1`) by
 * `DeployLibraries.s.sol` and by the SDK's own bootstrap — not by forge's automatic linking, which
 * routes through the same proxy but at its own salt of zero. So every library address below is
 * recomputable from (proxy, salt, creation bytecode) alone: `predictMetadataLib()` /
 * `predictParamsLib()` / `predictCodeLib()` / `predictEditionLib()`.
 *
 * NO SUPERSEDED ADDRESS IS EVER LIVE STATE IN THIS FILE, deliberately — and the rule is narrower and
 * more useful than "no old addresses anywhere", which is what it used to say while the entries below
 * carried `replaces 0x…` notes. The hazard was never provenance; it is a stale address sitting where
 * something might *bind* it, because several superseded contracts still have code on chain and a
 * factory bound to an un-manifested library is the exact failure this file exists to prevent. So:
 *
 *   · The live record ({@link CANONICAL} + the per-chain blocks) holds only what is current. A
 *     superseded address may appear beside it as a `replaces 0x…` note, which is prose, and in the
 *     contract-generation registry, which holds only the six FACTORY anchors — never a library,
 *     renderer, minter or seed source, the entries where a wrong bind would do damage.
 *   · {@link ANCHOR_GENERATIONS} is **provenance, never trust.** It answers "was this deployed by an
 *     ABX factory, and which generation" — it must never widen an allowlist or feed
 *     `verifyCanonical`.
 *
 */
const CANONICAL = {
  // Superseded addresses stay out of the live manifest. Two properties hold for every entry:
  //   1. Identical on Sepolia and Base Sepolia — CREATE2 through the keyless proxy at the canonical
  //      salts in `AbxSalts.sol` / `ABX_SALT`. Only `generator` differs per chain (its constructor
  //      bakes chain-specific immutables), which is why it lives in the per-chain blocks below.
  //   2. Recomputable from this build alone — `predictFactory()`, `predictRenderer()`,
  //      `predictSeriesCodeFactory()` and friends reproduce every one of them, and the write-path
  //      libraries are now deployed EXPLICITLY by `DeployLibraries.s.sol` at named salts rather
  //      than by forge's automatic linking at salt zero.
  //
  // Implementations are noted inline because a factory's implementation is the code a clone runs;
  // `abxVersion()` reads 2 on all six, and `specVersion()` reads 11 on the renderer.
  factory: '0x2824F4b4b4301dB2FcA10b2D80D45b4d463Ba57E', // impl 0x58b5CA27C76c0a1FA00b6ebe28d55d3A98eB1425
  seriesFactory: '0x685B4DfC835b6854590B5437C79D62BB7D52698b', // impl 0x1A8d16407247E801bf15e3c6Dbf2000673Ff474d
  seriesCodeFactory: '0xdDA5174A868A8e099E159E67569900a4F936CFFe', // impl 0xdaEF4B7068c07E380068895aCb48a210cdA30297
  oneOfOneEditionFactory: '0x6ecc7fAd2186965BaECD0Aa215b00239a3459ddF', // impl 0xCbD54eb6781F7A430C974fcbe125B48d4dF1f415
  editionFactory: '0xB6a8f051B08A8d6Fb0B6DA53BD23006CE2da31b7', // impl 0x90A674bce7540eBae92CAa3Ea77ccE1b7eb15f61
  editionCodeFactory: '0x9441Cc75318E20Ae6237EDb213b4C3019d756Bf0', // impl 0x68E57D289288dcAf31256d91c64583254bBb6601

  renderer: '0x85C1aE1F076d808fF7c1729F21B85038Fa16105E', // spec v11
  chunkStore: '0x1Ca63a4ADEeF5e722ADA25b892BA40E3b2bcB905',
  seedSource: '0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A',
  fixedPriceMinter: '0x1E321A12386cF6BEe49d1270A5EC54DecA88db48',
  fixedPriceMinter1155: '0x8FcC37dCb00A02367838Fa5B37347dCEec060981',

  // The delegatecalled write-path libraries. Every one of the six token implementations links
  // `AbxMetadataLib` — the on-chain metadata field store is external as of this generation, which is
  // what bought the two code types their EIP-170 headroom (and is why the two ERC-721 image
  // factories, which linked NOTHING before, link one now). On top of that: `AbxParamsLib` +
  // `AbxCodeLib` for the two code types, `AbxEditionLib` for all three ERC-1155 types (and
  // `AbxEditionLib` itself links `AbxParamsLib`, which is why it is deployed after it).
  // Recomputable via `predictMetadataLib()` / `predictParamsLib()` / `predictCodeLib()` /
  // `predictEditionLib()`.
  metadataLib: '0x02b819Bb9065cAf0c598A5CB2f5D37A4eb07460f',
  paramsLib: '0x396848cD90aDAbE1F463Cb825ed6507A026dC833',
  codeLib: '0x8dF597246C851E2DF264C8a322c07657395415fc',
  editionLib: '0x7c7D213383D6FC3F1e26A0cB3Ad554c1Aa0011dA',
} as const satisfies Omit<ChainDeployment, 'generator'>;

export const DEPLOYMENTS: Record<number, ChainDeployment> = {
  // Sepolia (testnet). Generator wired to Art Blocks' Sepolia DependencyRegistryV0
  // (0x5Fcc415BCFb164C5F826B5305274749BeB684e9b); SSTORE2 asset pointers
  // abxJsPointer 0xe34D9e7054c85E5dCfAFBD0c1E8ff48E206ebBf7,
  // gunzipScriptPointer 0xC8739F87eDE0278532ACE0f51936b4A3fA8d5C55.
  11155111: {
    ...CANONICAL,
    // Replaces 0xf099C8fc301340dE2C4D1D2b76fcA05D852dF14A: the directory branch reads the
    // collection's `abx_gateway_*` field instead of the `display.gateway` param. Redeployed with the
    // pointers above PINNED, so only the generator moved — the assets did not have to be rewritten.
    generator: '0xb7104ADfa6fb5615E46e2a681A2Ff043B08fADB5',
  },
  // Base Sepolia (testnet). No Art Blocks DependencyRegistry on this chain, so the generator is
  // deployed with defaultDependencyRegistry = address(0) — collections point at their own. SSTORE2
  // asset pointers: abxJsPointer 0xF5c9CE4486574c962fA61EdB297845085B6736Ab,
  // gunzipScriptPointer 0xB162Fa1B55b9Ad6e1c211c02f4c3f60c87036f03. Recorded here because they are
  // the ONLY way to re-run `DeployAbxGenerator` idempotently — without them the script writes fresh
  // pointers, which moves the generator's CREATE2 address and quietly deploys a second one.
  84532: {
    ...CANONICAL,
    generator: '0x2C1B7Cf6c54E4ACbcB54FCC395f7Af88eb4fc8CE',
  },
};

/** The canonical deployment record a *new* deploy on this chain should use (empty if the chain
 *  isn't shipped yet). Not "what this already-deployed collection points at" — reconstruct that
 *  collection, then read `state.tokenURIRenderer` and `generatorFor(state)`. Later releases can
 *  move the canonical singletons without changing addresses already stored by a collection. */
export function getDeployment(chainId: number): ChainDeployment {
  return DEPLOYMENTS[chainId] ?? {};
}

// override → env → manifest. Returns undefined when none of the three has a value.
function pick(override: string | undefined, env: string | undefined, manifest: Address | undefined): Address | undefined {
  return (override ?? env ?? manifest) as Address | undefined;
}

export function resolveFactory(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_FACTORY'), getDeployment(chainId).factory);
}

export function resolveSeriesFactory(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_SERIES_FACTORY'), getDeployment(chainId).seriesFactory);
}

export function resolveRenderer(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_RENDERER'), getDeployment(chainId).renderer);
}

export function resolveChunkStore(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_CHUNK_STORE'), getDeployment(chainId).chunkStore);
}

export function resolveFixedPriceMinter(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_FIXED_PRICE_MINTER'), getDeployment(chainId).fixedPriceMinter);
}

export function resolveSeriesCodeFactory(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_SERIES_CODE_FACTORY'), getDeployment(chainId).seriesCodeFactory);
}

export function resolveSeedSource(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_SEED_SOURCE'), getDeployment(chainId).seedSource);
}

// ERC-1155 editions — same override → env → manifest precedence as every resolver above.

export function resolveOneOfOneEditionFactory(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_ONE_OF_ONE_EDITION_FACTORY'), getDeployment(chainId).oneOfOneEditionFactory);
}

export function resolveEditionFactory(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_EDITION_FACTORY'), getDeployment(chainId).editionFactory);
}

export function resolveEditionCodeFactory(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_EDITION_CODE_FACTORY'), getDeployment(chainId).editionCodeFactory);
}

export function resolveFixedPriceMinter1155(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_FIXED_PRICE_MINTER_1155'), getDeployment(chainId).fixedPriceMinter1155);
}

export function resolveGenerator(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_GENERATOR'), getDeployment(chainId).generator);
}

/**
 * Is `generator` the chain's CURRENT canonical generator — the per-collection pointer check
 * `abx verify` runs for the singleton `generatorFor(state)` resolves (see site/content/docs).
 *
 * Binary by construction, on purpose: it answers current / not-current and nothing finer. A
 * mismatch can mean either "pinned to a prior canonical generation" or "a fully custom field
 * renderer", and this file's own docstring is explicit that no superseded generator address is
 * EVER kept as live state here — so there is nothing recorded to tell those two apart against.
 * Building that historical registry is deliberately out of scope (the factory-generation
 * ladder already has one, {@link ANCHOR_GENERATIONS}; the generator deliberately does not).
 *
 * `null` ⇒ this chain has no canonical generator recorded at all (unshipped) — a different fact
 * from "doesn't match the canonical one", so a caller must not collapse the two into `false`.
 */
export function isCurrentGenerator(chainId: number, generator: Address, override?: string): boolean | null {
  const canonical = resolveGenerator(chainId, override);
  if (!canonical) return null;
  return generator.toLowerCase() === canonical.toLowerCase();
}

/**
 * The known `name@version` resolution roots per chain — Art Blocks' DependencyRegistryV0
 * (site/content/docs/protocol/code-projects.mdx). ABX points at it and speaks its READ interface;
 * we never deploy our own. The pointer a collection stores is soft and non-validating, so
 * a chain with no entry simply deploys without one (the resolver falls back to its built-in
 * CDN map) — never a blocker.
 */
export const AB_DEPENDENCY_REGISTRY: Record<number, Address> = {
  1: '0x37861f95882ACDba2cCD84F5bFc4598e2ECDDdAF', // mainnet
  11155111: '0x5Fcc415BCFb164C5F826B5305274749BeB684e9b', // Sepolia
};

export function resolveDependencyRegistry(chainId: number, override?: string): Address | undefined {
  return pick(override, readEnv('ABX_DEPENDENCY_REGISTRY'), AB_DEPENDENCY_REGISTRY[chainId]);
}
