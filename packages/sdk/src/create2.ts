import {concat, getContractAddress, keccak256, toBytes, type Address, type Hex} from 'viem';
import {
  abxChunkStoreBytecode,
  abxCodeLibBytecode,
  abxEditionLibBytecode,
  abxMetadataLibBytecode,
  abxFixedPriceMinterBytecode,
  abxFixedPriceMinter1155Bytecode,
  abxMetadataRendererBytecode,
  abxParamsLibBytecode,
  abxSeedSourceBytecode,
  editionCodeFactoryBytecode,
  editionImageFactoryBytecode,
  oneOfOneEditionFactoryBytecode,
  oneOfOneImageFactoryBytecode,
  seriesCodeFactoryBytecode,
  seriesImageFactoryBytecode,
} from './abi/index.js';

/**
 * Keyless CREATE2 deployment — the TS twin of `contracts/script/AbxSalts.sol`.
 *
 * ABX infra is deployed through the keyless CREATE2 proxy (present at the same address on every EVM
 * chain — the address `forge` routes `new X{salt: …}()` through) with a canonical salt, so a given
 * contract has the **same address on every chain**. Keeping the salts + proxy here lets the SDK/CLI
 * predict those addresses and deploy to them, so the toolkit's lazy deployers land at the exact
 * addresses the forge scripts (and the manifest) use — deterministic everywhere, no drift.
 */

/** The keyless CREATE2 proxy (Arachnid deterministic-deployment-proxy). Same address on every chain. */
export const CREATE2_PROXY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

/** Canonical salt strings — MUST stay byte-identical to `contracts/script/AbxSalts.sol`, since the
 *  deterministic address is `keccak256(0xff ++ proxy ++ keccak256(salt) ++ keccak256(initcode))`.
 *  `test/create2-salts.test.ts` diffs this table against that file, both ways, so drift can't be
 *  quiet: the two halves have to be one fact. */
export const ABX_SALT = {
  oneOfOneFactory: 'abx.factory.one-of-one.v1',
  seriesFactory: 'abx.factory.series.v1',
  seriesCodeFactory: 'abx.factory.series-code.v1',
  renderer: 'abx.renderer.v1',
  chunkStore: 'abx.chunk-store.v1',
  fixedPriceMinter: 'abx.minter.fixed-price.v1',
  seedSource: 'abx.seed-source.v1',
  generator: 'abx.generator.v1',
  // ERC-1155 editions (twins of the above; naming follows the parity plan verbatim).
  oneOfOneEditionFactory: 'abx.one-of-one-edition-factory.v1',
  editionFactory: 'abx.edition-factory.v1',
  editionCodeFactory: 'abx.edition-code-factory.v1',
  fixedPriceMinter1155: 'abx.fixed-price-minter-1155.v1',
  // Delegatecalled write-path libraries — CREATE2 like everything else here (see the
  // "delegatecalled write-path libraries" note below, and `DeployLibraries.s.sol`).
  paramsLib: 'abx.lib.params.v1',
  codeLib: 'abx.lib.code.v1',
  editionLib: 'abx.lib.edition.v1',
  metadataLib: 'abx.lib.metadata.v1',
} as const;

/** The 32-byte salt a CREATE2 deploy uses (`keccak256` of the canonical string). */
export const saltHash = (salt: string): Hex => keccak256(toBytes(salt));

/** The deterministic address `bytecode` deploys to under `salt` via the keyless proxy — identical
 *  on every chain. Pure: no chain access. */
export function predictCreate2Address(salt: string, bytecode: Hex): Address {
  return getContractAddress({opcode: 'CREATE2', from: CREATE2_PROXY, salt: saltHash(salt), bytecode});
}

/** The calldata a CREATE2-proxy deploy sends: 32-byte salt ++ initcode (the proxy CREATE2-deploys it). */
export function create2Calldata(salt: string, bytecode: Hex): Hex {
  return concat([saltHash(salt), bytecode]);
}

/** The canonical (cross-chain-identical) AbxChunkStore address for the current bytecode. */
export const predictChunkStore = (): Address => predictCreate2Address(ABX_SALT.chunkStore, abxChunkStoreBytecode);

/** The canonical (cross-chain-identical) AbxMetadataRenderer address for the current bytecode. */
export const predictRenderer = (): Address => predictCreate2Address(ABX_SALT.renderer, abxMetadataRendererBytecode);

/** The canonical (cross-chain-identical) AbxFixedPriceMinter address for the current bytecode. */
export const predictFixedPriceMinter = (): Address =>
  predictCreate2Address(ABX_SALT.fixedPriceMinter, abxFixedPriceMinterBytecode);

/** The canonical (cross-chain-identical) AbxSeedSource address. Deploy it standalone
 *  (`DeploySeedSource.s.sol`) so it compiles at the default profile — bundling it with the
 *  SeriesCode factory's `clone-impl` unit yields a different, non-canonical bytecode + address. */
export const predictSeedSource = (): Address => predictCreate2Address(ABX_SALT.seedSource, abxSeedSourceBytecode);

// ── ERC-1155 editions ──────────────────────────────────────────────────────────
//
// `DeployOneOfOneEdition.s.sol` / `DeployEdition.s.sol` / `DeployMinter1155.s.sol` each deploy
// their contract with a fixed `AbxSalts` salt and NO constructor args, so the salt + this build's
// bytecode fix the address before any deploy. `AbxFixedPriceMinter1155` is a plain singleton and is
// predicted right below; the two edition IMAGE factories are not — `OneOfOneEdition`/`EditionImage`
// both delegate bodies into `AbxEditionLib`, so their factories carry a link placeholder and their
// predictions live with the library-linked factories in the write-path-library section below
// (`predictOneOfOneEditionFactory`/`predictEditionFactory`), next to the two code factories.

/** The canonical (cross-chain-identical) `OneOfOneImageFactory` address for the current bytecode —
 *  the 721 1/1 trust anchor. */
export const predictFactory = (): Address =>
  predictCreate2Address(ABX_SALT.oneOfOneFactory, linkFactory());

/** The canonical (cross-chain-identical) `SeriesImageFactory` address for the current bytecode —
 *  the 721 multi-token trust anchor. */
export const predictSeriesFactory = (): Address =>
  predictCreate2Address(ABX_SALT.seriesFactory, linkSeriesFactory());

/** The canonical (cross-chain-identical) `AbxFixedPriceMinter1155` address for the current
 *  bytecode — the shared, ownerless edition sale singleton. */
export const predictFixedPriceMinter1155 = (): Address =>
  predictCreate2Address(ABX_SALT.fixedPriceMinter1155, abxFixedPriceMinter1155Bytecode);

// ── delegatecalled write-path libraries ────────────────────────────────────────
//
// A `public` library function is compiled as a `delegatecall` to a SEPARATELY deployed copy of the
// library, and solc leaves a `__$<id>$__` placeholder in the caller's bytecode where that copy's
// address goes. Linking is the substitution of an address into that placeholder.
//
// **Linking does not cost determinism.** These libraries are deployed through the same keyless
// CREATE2 proxy at the canonical salts above (`DeployLibraries.s.sol` is the forge twin), so a
// library's address is `f(proxy, salt, creation bytecode)` and nothing else — the deployer's nonce
// is not an input to a CREATE2 address (it is an input to plain `CREATE`, which is where the
// confusion came from). Predict the libraries, substitute them, and the linked factory's initcode
// is fixed too — hence the FOUR `predict*Factory` helpers at the bottom of this section.
//
// Worth stating plainly, because the opposite belief was load-bearing: two ERC-1155 token types
// (`OneOfOneEdition`/`EditionImage`) were held library-free and an EIP-170 size floor was relaxed to
// avoid "losing" a factory's deterministic address. What was actually true was narrower and
// self-inflicted — the SDK deployed its libraries with a plain EOA `CREATE` (`to: null`) by its own
// choice, so *it* could not predict them, and that local limitation was written up as a property of
// libraries in general. It isn't one. The broadcast artifacts always said so: every recorded library
// deploy went through the keyless proxy, and `AbxParamsLib` landed at ONE address on Sepolia and
// Base Sepolia from deployer nonces 215 apart. Both of those token types now delegate into
// `AbxEditionLib` exactly as `EditionCode` does, so FOUR factories here are library-linked, not two.
//
// **Losing track of that is a bug class, not a footnote.** Three separate times a contract became
// library-linked and this file went on hashing its UNLINKED bytecode, and the failure is silent:
// viem does not reject a `__$…$__` placeholder, it UTF-8-encodes it — so the prediction is a
// real-looking address that is the hash of ASCII garbage, for the addresses platforms allowlist, and
// the same bytes would go out as initcode. `link.test.ts`'s "nothing deployable carries a
// placeholder" guard derives its subject set from the exported bytecodes rather than a list of
// names, precisely so the next contract to become library-linked cannot escape the same way.
//
// **The real trap is compile-time linking, not linking.** Substituting into the placeholder happens
// AFTER compilation, so it cannot change the library's own creation bytecode. Handing solc the
// addresses at build time instead (`forge build/script --libraries src/…:Lib:0x…`) writes the
// library map into `settings.libraries` in every artifact's metadata, and the metadata hash is
// appended to the creation bytecode — so the library's own address moves, and so does the linked
// factory's. Optimizer settings do the same (the code tokens compile at `optimizer_runs = 200`,
// everything else at 1,000,000). One canonical bytecode per library, therefore: the one
// `sync-abis` reads from a plain `forge build`, which is what these predictions use.

/** Fully-qualified library names (solc's link keys — path-sensitive, so they must match how the
 *  contracts are compiled: `src/libraries/…` as `foundry.toml` sees them). */
export const LIB_FQN = {
  paramsLib: 'src/libraries/AbxParamsLib.sol:AbxParamsLib',
  codeLib: 'src/libraries/AbxCodeLib.sol:AbxCodeLib',
  editionLib: 'src/libraries/AbxEditionLib.sol:AbxEditionLib',
  metadataLib: 'src/libraries/AbxMetadataLib.sol:AbxMetadataLib',
} as const;

/** The solc link placeholder for a fully-qualified library name: `__$<keccak(fqn)[0:34]>$__`. */
export const libPlaceholder = (fullyQualified: string): string =>
  `__$${keccak256(toBytes(fullyQualified)).slice(2, 36)}$__`;

/**
 * Link `bytecode` against deployed libraries — the post-compile placeholder substitution `forge`
 * does at build time, done here so a sandbox / fresh chain needs no forge. Throws if any
 * placeholder is left over, since an unlinked `__$…$__` is not valid hex and the RPC would reject
 * the transaction with an opaque `Invalid byte sequence`.
 */
export function linkLibraries(bytecode: Hex, links: ReadonlyArray<readonly [fqn: string, address: Address]>): Hex {
  let out: string = bytecode;
  for (const [fqn, address] of links) out = out.split(libPlaceholder(fqn)).join(address.slice(2).toLowerCase());
  if (out.includes('__$')) throw new Error(`unlinked library placeholder remains: ${/__\$[0-9a-f]{34}\$__/.exec(out)?.[0]}`);
  return out as Hex;
}

/** The canonical (cross-chain-identical) `AbxParamsLib` address — the params write path both code
 *  token types delegatecall. */
export const predictParamsLib = (): Address => predictCreate2Address(ABX_SALT.paramsLib, abxParamsLibBytecode);

/** The canonical (cross-chain-identical) `AbxCodeLib` address — the script/code write path. */
export const predictCodeLib = (): Address => predictCreate2Address(ABX_SALT.codeLib, abxCodeLibBytecode);

/** The canonical (cross-chain-identical) `AbxEditionLib` address — the 1155 uri / creator-token /
 *  edition-supply write path that **all three** edition token types (`OneOfOneEdition`,
 *  `EditionImage`, `EditionCode`) delegatecall.
 *  `AbxEditionLib` itself delegatecalls `AbxParamsLib`, so it is linked before it is deployed: the
 *  one library here whose own initcode depends on another library's address. */
export const predictEditionLib = (): Address =>
  predictCreate2Address(ABX_SALT.editionLib, linkEditionLib());

/** The canonical `AbxMetadataLib` address. Linked by ALL SIX token types to preserve EIP-170
 *  headroom; externalizing the metadata field store makes even the plainest 721 factory
 *  library-linked. It links nothing itself, so it is deployed first. */
export const predictMetadataLib = (): Address =>
  predictCreate2Address(ABX_SALT.metadataLib, abxMetadataLibBytecode);

/** `AbxEditionLib`'s canonical initcode: its shipped bytecode linked against `AbxParamsLib`. */
export const linkEditionLib = (): Hex =>
  linkLibraries(abxEditionLibBytecode, [[LIB_FQN.paramsLib, predictParamsLib()]]);

/** `OneOfOneEditionFactory`'s canonical initcode: linked against `AbxEditionLib` (the only library
 *  its embedded `OneOfOneEdition` implementation delegates into). `AbxEditionLib`'s own address
 *  already accounts for its `AbxParamsLib` link — see {@link predictEditionLib}. */
export const linkOneOfOneEditionFactory = (): Hex =>
  linkLibraries(oneOfOneEditionFactoryBytecode, [
    [LIB_FQN.editionLib, predictEditionLib()],
    [LIB_FQN.metadataLib, predictMetadataLib()],
  ]);

/** `EditionImageFactory`'s canonical initcode: linked against `AbxEditionLib`, the sibling of
 *  {@link linkOneOfOneEditionFactory}. */
export const linkEditionFactory = (): Hex =>
  linkLibraries(editionImageFactoryBytecode, [
    [LIB_FQN.editionLib, predictEditionLib()],
    [LIB_FQN.metadataLib, predictMetadataLib()],
  ]);

/** `SeriesCodeFactory`'s canonical initcode: linked against the two write-path libraries. */
export const linkSeriesCodeFactory = (): Hex =>
  linkLibraries(seriesCodeFactoryBytecode, [
    [LIB_FQN.paramsLib, predictParamsLib()],
    [LIB_FQN.codeLib, predictCodeLib()],
    [LIB_FQN.metadataLib, predictMetadataLib()],
  ]);

/** `EditionCodeFactory`'s canonical initcode: linked against all three write-path libraries. */
export const linkEditionCodeFactory = (): Hex =>
  linkLibraries(editionCodeFactoryBytecode, [
    [LIB_FQN.paramsLib, predictParamsLib()],
    [LIB_FQN.codeLib, predictCodeLib()],
    [LIB_FQN.editionLib, predictEditionLib()],
    [LIB_FQN.metadataLib, predictMetadataLib()],
  ]);

/** The two ERC-721 image factories' canonical initcode. They linked NOTHING until the metadata
 *  field store was externalized; now every token type is library-linked. */
export const linkFactory = (): Hex =>
  linkLibraries(oneOfOneImageFactoryBytecode, [[LIB_FQN.metadataLib, predictMetadataLib()]]);

export const linkSeriesFactory = (): Hex =>
  linkLibraries(seriesImageFactoryBytecode, [[LIB_FQN.metadataLib, predictMetadataLib()]]);

/** The canonical (cross-chain-identical) `SeriesCodeFactory` address — the code-project trust
 *  anchor. Predictable because its libraries are (see the section note above). */
export const predictSeriesCodeFactory = (): Address =>
  predictCreate2Address(ABX_SALT.seriesCodeFactory, linkSeriesCodeFactory());

/** The canonical (cross-chain-identical) `EditionCodeFactory` address — the code-project EDITION
 *  trust anchor. */
export const predictEditionCodeFactory = (): Address =>
  predictCreate2Address(ABX_SALT.editionCodeFactory, linkEditionCodeFactory());

/** The canonical (cross-chain-identical) `OneOfOneEditionFactory` address — the 1/1-edition trust
 *  anchor. Predicted from LINKED initcode: `OneOfOneEdition` delegates its uri / creator-token /
 *  edition-supply bodies into `AbxEditionLib`, so the shipped factory bytecode carries a link
 *  placeholder (hashing it unlinked yields a plausible-looking address for a trust anchor that
 *  nothing can ever be deployed to — see the section note). */
export const predictOneOfOneEditionFactory = (): Address =>
  predictCreate2Address(ABX_SALT.oneOfOneEditionFactory, linkOneOfOneEditionFactory());

/** The canonical (cross-chain-identical) `EditionImageFactory` address — the multi-work edition
 *  trust anchor, the sibling of {@link predictOneOfOneEditionFactory} (same single library link). */
export const predictEditionFactory = (): Address =>
  predictCreate2Address(ABX_SALT.editionFactory, linkEditionFactory());
