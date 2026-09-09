import {concat, getAddress, toHex, zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import {
  oneOfOneImageFactoryAbi,
  seriesImageFactoryAbi,
  abxMetadataRendererAbi,
  seriesCodeFactoryAbi,
  abxMetadataLibBytecode,
  abxParamsLibBytecode,
  abxCodeLibBytecode,
  oneOfOneEditionFactoryAbi,
  editionImageFactoryAbi,
  editionCodeFactoryAbi,
} from './abi/index.js';
import {
  predictFactory,
  predictSeriesFactory,
  predictRenderer,
  predictFixedPriceMinter,
  predictSeedSource,
  predictOneOfOneEditionFactory,
  predictEditionFactory,
  predictFixedPriceMinter1155,
  predictCreate2Address,
  predictSeriesCodeFactory,
  predictEditionCodeFactory,
  linkSeriesCodeFactory,
  linkEditionCodeFactory,
  linkEditionLib,
  create2Calldata,
  CREATE2_PROXY,
  ABX_SALT,
} from './create2.js';
import {
  prepareDeployFactory,
  prepareDeploySeriesFactory,
  prepareDeployRenderer,
  prepareDeployFixedPriceMinter,
  prepareDeploySeedSource,
  prepareDeployOneOfOne,
  prepareDeploySeries,
  prepareDeployOneOfOneEdition,
  prepareDeployOneOfOneEditionFactory,
  prepareDeployEditionImage,
  prepareDeployEditionFactory,
  prepareDeployFixedPriceMinter1155,
} from './ops.js';
import type {SendTx} from './execute.js';

/** One on-chain metadata field to set at deploy (bytes32 `field`/`representation`, bytes `value`). */
export interface OnChainFieldInput {
  field: Hex;
  representation: Hex;
  value: Hex;
}

/** Mirrors `OneOfOneImage.InitParams` (the deploy-time configuration). */
export interface OneOfOneInitParams {
  owner: Address;
  /** Recipient of the token at deploy; `0x0` (zeroAddress) defers the mint to a later `mint(to)`. */
  mintTo: Address;
  name: string;
  symbol: string;
  /** Off-chain resolver base; the per-token pointer is derived on-chain as
   *  `{base}/{chainId}/{address}/{tokenId}`. Empty ⇒ no off-chain pointer. */
  tokenURIBase: string;
  /** On-chain renderer for the token URI; `0x0` ⇒ resolve off-chain via the base. */
  tokenURIRenderer: Address;
  /** Off-chain resolver base for the collection; derived as `{base}/{chainId}/{address}`. */
  contractURIBase: string;
  /** On-chain renderer for the collection URI; `0x0` ⇒ resolve off-chain via the base. */
  contractURIRenderer: Address;
  royaltyReceiver: Address;
  royaltyBps: number;
  /** Royalty ceiling in basis points (0–10000, up to 100%). Owner-set at deploy and reduce-only
   *  after (`reduceMaxRoyaltyBps`); the initial `royaltyBps` must be <= this. Tooling defaults it
   *  to 1000 (10%). A monotonic-down cap is a buyer-readable "royalty can never exceed X" guarantee. */
  maxRoyaltyBps: number;
  /** Opt-in burn (default `false`). `true` lets holders (or approved operators) burn their token via
   *  `burn(...)`; `false` means the token can never be destroyed, by anyone. Fixed at deploy. */
  burnable: boolean;
  /** `zeroAddress` = plain ERC-721 (the default — no trace of 721C, ever); non-zero = permanent
   *  ERC-721C enrollment with that transfer validator (must have code on-chain, else the deploy
   *  reverts `InvalidTransferValidator()`). Enrollment is deploy-time-only and irreversible —
   *  the owner can later re-point or suspend (zero) the validator, never un-enroll. */
  transferValidator: Address;
  /** Optional on-chain metadata fields for token 0 and for the collection. */
  tokenFields: OnChainFieldInput[];
  contractFields: OnChainFieldInput[];
}

/** One per-token on-chain metadata field to set at deploy — keyed by `tokenId`. */
export interface SeriesTokenFieldInput {
  tokenId: bigint | number;
  field: Hex;
  representation: Hex;
  value: Hex;
}

/** Mirrors `SeriesImage.InitParams` (the multi-token deploy-time configuration). */
export interface SeriesInitParams {
  owner: Address;
  name: string;
  symbol: string;
  /** Off-chain resolver base; per-token pointer derived as `{base}/{chainId}/{address}/{tokenId}`. */
  tokenURIBase: string;
  /** On-chain renderer for the token URI; `0x0` ⇒ resolve off-chain via the base. */
  tokenURIRenderer: Address;
  contractURIBase: string;
  contractURIRenderer: Address;
  royaltyReceiver: Address;
  royaltyBps: number;
  /** Royalty ceiling in basis points (0–10000, up to 100%). Owner-set at deploy and reduce-only
   *  after (`reduceMaxRoyaltyBps`); the initial `royaltyBps` must be <= this. Tooling defaults it
   *  to 1000 (10%). A monotonic-down cap is a buyer-readable "royalty can never exceed X" guarantee. */
  maxRoyaltyBps: number;
  /** Opt-in burn (default `false`). `true` lets holders (or approved operators) burn their token via
   *  `burn(...)`; `false` means the token can never be destroyed, by anyone. Fixed at deploy. */
  burnable: boolean;
  /** `zeroAddress` = plain ERC-721 (the default — no trace of 721C, ever); non-zero = permanent
   *  ERC-721C enrollment with that transfer validator (must have code on-chain, else the deploy
   *  reverts `InvalidTransferValidator()`). Enrollment is deploy-time-only and irreversible —
   *  the owner can later re-point or suspend (zero) the validator, never un-enroll. */
  transferValidator: Address;
  /** Series size N (> 0): the supply cap. Monotonically non-increasing after deploy. */
  maxInvocations: bigint | number;
  /** Primary-sale payout destination (`0x0` = none). */
  primaryPayee: Address;
  /** Initial authorized minter — a single address (`0x0` = owner-only minting). */
  minter: Address;
  /** Initial mint-pause state — `true` = owner-only minting until unpaused (deploy-time
   *  reserves still mint). Projects usually deploy paused and unpause to go live. */
  paused: boolean;
  /** Recipient for the deploy-time mint (`0x0` defers all minting). */
  mintTo: Address;
  /** Tokens to mint in order (`[0, mintCount)`) at deploy; `<= maxInvocations`. */
  mintCount: bigint | number;
  /** Optional per-token on-chain metadata fields (keyed by token id). */
  tokenFields: SeriesTokenFieldInput[];
  contractFields: OnChainFieldInput[];
}

/** {@link SeriesInitParams} plus the code-project extension config ({SeriesCode.InitParams}). */
export interface SeriesCodeInitParams extends SeriesInitParams {
  /** IAbxSeedSource the token calls at mint (`0x0` = no mint-time seed). */
  seedSource: Address;
  /** Opt out of delegate.xyz on the TokenOwner auth leg (default false = canonical registry). */
  disableTokenOwnerDelegation: boolean;
}

// ── ERC-1155 editions (copies of a work, not unique works) ─────────────────────
// The three InitParams shapes below mirror their Solidity structs field-for-field (see
// `contracts/src/tokens/{OneOfOneEdition,EditionImage,EditionCode}.sol`). Field ORDER in these TS
// interfaces need not match the struct's textual order — `encodeFunctionData` matches a tuple's
// object-form args by component NAME, not position, exactly like `OneOfOneInitParams`/
// `SeriesInitParams` already rely on above.

/** One per-token on-chain metadata field to set at deploy, keyed by `tokenId` — the edition twin
 *  of {@link SeriesTokenFieldInput} (identical shape; ABX's `OnChainMetadata.TokenFieldInput` has
 *  no standard-specific fields). Reused directly rather than duplicated. */
export type EditionTokenFieldInput = SeriesTokenFieldInput;

/** Mirrors `OneOfOneEdition.InitParams` — copies of a single work, id space fixed to `{0}`. */
export interface OneOfOneEditionInitParams {
  owner: Address;
  /** Recipient of the deploy-time mint (`0x0` or `mintAmount: 0` ⇒ defer all minting). */
  mintTo: Address;
  /** Copies of id 0 to mint to `mintTo` at deploy (`0` ⇒ none). */
  mintAmount: bigint | number;
  name: string;
  symbol: string;
  /** Off-chain resolver base for `uri(id)`; the pointer is derived on-chain as
   *  `{base}/{chainId}/{address}/{id}`. */
  tokenURIBase: string;
  /** On-chain renderer for `uri(id)`; `0x0` ⇒ resolve off-chain via the base. */
  tokenURIRenderer: Address;
  contractURIBase: string;
  contractURIRenderer: Address;
  royaltyReceiver: Address;
  royaltyBps: number;
  /** Royalty ceiling in basis points (0–10000, up to 100%). Owner-set at deploy and reduce-only
   *  after (`reduceMaxRoyaltyBps`); the initial `royaltyBps` must be <= this. Tooling defaults it
   *  to 1000 (10%). A monotonic-down cap is a buyer-readable "royalty can never exceed X" guarantee. */
  maxRoyaltyBps: number;
  /** Opt-in burn (default `false`). `true` lets holders (or approved operators) burn their token via
   *  `burn(...)`; `false` means the token can never be destroyed, by anyone. Fixed at deploy. */
  burnable: boolean;
  /** `zeroAddress` = a plain ERC-1155 forever (the default). Non-zero = permanent ERC-1155C
   *  enrollment with that transfer validator (must have code on-chain). */
  transferValidator: Address;
  /** The default supply cap for id 0 (`0` = open edition, uncapped). */
  editionSize: bigint | number;
  /** Primary-sale payout destination (`0x0` = none). */
  primaryPayee: Address;
  /** Initial authorized minter — a single address (`0x0` = owner-only). */
  minter: Address;
  /** Initial mint-pause state — `true` restricts minting to the owner until unpaused (deploy-time
   *  reserves still mint). */
  paused: boolean;
  /** Optional on-chain metadata fields for id 0 (each field → one representation). */
  tokenFields: OnChainFieldInput[];
  contractFields: OnChainFieldInput[];
}

/** Mirrors `EditionImage.InitParams` — copies of many distinct works (N ids × copies each). */
export interface EditionImageInitParams {
  owner: Address;
  name: string;
  symbol: string;
  tokenURIBase: string;
  tokenURIRenderer: Address;
  contractURIBase: string;
  contractURIRenderer: Address;
  royaltyReceiver: Address;
  royaltyBps: number;
  /** Royalty ceiling in basis points (0–10000, up to 100%). Owner-set at deploy and reduce-only
   *  after (`reduceMaxRoyaltyBps`); the initial `royaltyBps` must be <= this. Tooling defaults it
   *  to 1000 (10%). A monotonic-down cap is a buyer-readable "royalty can never exceed X" guarantee. */
  maxRoyaltyBps: number;
  /** Opt-in burn (default `false`). `true` lets holders (or approved operators) burn their token via
   *  `burn(...)`; `false` means the token can never be destroyed, by anyone. Fixed at deploy. */
  burnable: boolean;
  transferValidator: Address;
  /** The id-space cap N (> 0): the number of distinct works this project may ever have.
   *  Monotonically non-increasing (floor = the id high-water mark, NOT `totalSupply()` — ids are
   *  caller-named, not sequential). */
  maxInvocations: bigint | number;
  /** The default per-id copy cap for EVERY id (`0` = open edition, uncapped). */
  editionSize: bigint | number;
  primaryPayee: Address;
  minter: Address;
  paused: boolean;
  /** Recipient for the deploy-time mint (`0x0` ⇒ defer all minting). */
  mintTo: Address;
  /** Distinct works to mint at deploy, ids `[0, mintCount)`; `<= maxInvocations`. */
  mintCount: bigint | number;
  /** Copies of EACH deploy-minted id (must be `> 0` if `mintCount > 0`). */
  mintAmount: bigint | number;
  /** Optional per-token on-chain metadata fields, keyed by id. */
  tokenFields: EditionTokenFieldInput[];
  contractFields: OnChainFieldInput[];
}

/** {@link EditionImageInitParams} plus the code-project extension config ({EditionCode.InitParams}).
 *  NOTE: unlike {@link SeriesCodeInitParams}, there is no `disableTokenOwnerDelegation` — editions
 *  have no TokenOwner-leg delegation to opt out of (see `ConfigurableParams`'s edition init path;
 *  the auth leg generalizes to "any holder" instead — `balanceOf(sender, id) > 0`). */
export interface EditionCodeInitParams extends EditionImageInitParams {
  /** IAbxSeedSource the token calls at each id's FIRST mint (`0x0` = no mint-time seed). */
  seedSource: Address;
}

export interface DeployResult<T extends string> {
  txHash: Hex;
  blockNumber: bigint;
}

/** 12 bytes of entropy — the non-guard tail of a deterministic-deploy salt. */
function entropy12(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(12)));
}

/**
 * A salt that reserves the deployed address to `deployer`. The factory's salt
 * guard requires the leading 20 bytes to equal `msg.sender` when non-zero, so
 * encoding the deployer there makes the address **front-run-proof**: nobody else
 * can land their params on the address this salt predicts. The trailing 12 bytes
 * are entropy (pass your own to mine a vanity suffix; random otherwise). Works for
 * any account type — an EOA, an ERC-4337 smart account, or a Safe — since each is
 * the `msg.sender` the factory checks.
 */
export function saltFor(deployer: Address, entropy: Hex = entropy12()): Hex {
  return concat([getAddress(deployer), entropy]); // 20 + 12 = 32 bytes
}

/**
 * A permissionless salt: an all-zero guard prefix, so **anyone** may deploy to the
 * address it predicts (a shared, canonical deployment). No front-run protection —
 * use only when a publicly-deployable, caller-independent address is the point.
 *
 * **Never use this for a pre-published or pre-funded address.** If you predict an address with
 * this salt and share it (or send value to it) before deploying, a third party can occupy that
 * exact address first with their own `InitParams` (their owner, their URIs). For any address a
 * creator reserves, use {@link saltFor} — its deployer-bound prefix is front-run-proof.
 */
export function permissionlessSalt(entropy: Hex = entropy12()): Hex {
  return concat([zeroAddress, entropy]); // zero prefix + 12 bytes
}

/** The address a salt reserves the deploy to (`0x0` ⇒ permissionless). */
export function saltGuard(salt: Hex): Address {
  return getAddress(`0x${salt.slice(2, 42)}`);
}

/** The chain id a `PublicClient` is bound to — `makePublicClient` always sets `.chain`, but a
 *  caller-constructed one might not, so fall back to the live read rather than assume. */
async function chainIdOf(publicClient: PublicClient): Promise<number> {
  return publicClient.chain?.id ?? (await publicClient.getChainId());
}

/**
 * Deploy the canonical clone factory — the trust anchor. Ownerless and immutable;
 * once deployed, its address is what platforms allowlist. Deploy this once per
 * (chain, core version) and reuse it for every clone.
 */
export async function deployFactory(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'factory'> & {factory: Address; implementation: Address; metadataLib: Address}> {
  const chainId = await chainIdOf(publicClient);
  // OneOfOneImage links AbxMetadataLib since the metadata field store was externalized. These two
  // factories linked NOTHING before, so this leg is new here rather than merely reordered —
  // and without it the factory deploys against an unresolved placeholder.
  const metadataLib = await ensureMetadataLib(send, publicClient, chainId, 'OneOfOneImage');
  // CREATE2 via the keyless proxy: the tx targets the PROXY, so it is a call, not a contract
  // creation, and `receipt.contractAddress` is null by protocol. Compute the address instead —
  // the same thing `deployRenderer` and every newer factory bootstrap here already do. Reading
  // the receipt made the first bootstrap on a fresh chain always throw AFTER the factory had
  // actually landed, so `--bootstrap-factory` appeared broken while a second run "fixed" it.
  const factory = predictFactory();
  const receipt = await send(prepareDeployFactory({chainId}));
  const implementation = (await publicClient.readContract({
    address: factory,
    abi: oneOfOneImageFactoryAbi,
    functionName: 'implementation',
  })) as Address;
  return {factory, implementation, metadataLib, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Deploy the canonical Series clone factory — the trust anchor for multi-token drops.
 * Ownerless and immutable; the sibling of `deployFactory`. Deploy once per (chain, core
 * version). The shared renderer + chunk store are reused (deploy them separately).
 */
export async function deploySeriesFactory(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'seriesFactory'> & {factory: Address; implementation: Address; metadataLib: Address}> {
  const chainId = await chainIdOf(publicClient);
  // SeriesImage links AbxMetadataLib since the metadata field store was externalized. These two
  // factories linked NOTHING before, so this leg is new here rather than merely reordered —
  // and without it the factory deploys against an unresolved placeholder.
  const metadataLib = await ensureMetadataLib(send, publicClient, chainId, 'SeriesImage');
  // Deterministic address, not a receipt read — see `deployFactory` for why the receipt is null.
  const factory = predictSeriesFactory();
  const receipt = await send(prepareDeploySeriesFactory({chainId}));
  const implementation = (await publicClient.readContract({
    address: factory,
    abi: seriesImageFactoryAbi,
    functionName: 'implementation',
  })) as Address;
  return {factory, implementation, metadataLib, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * CREATE2-deploy one write-path library through the keyless proxy at its canonical salt — the TS
 * twin of `DeployLibraries.s.sol`, so an SDK-bootstrapped chain and a forge-bootstrapped chain put
 * the library at the SAME address, and every chain agrees with every other.
 *
 * Idempotent out of necessity, not politeness: the proxy reverts when the target address already
 * has code, so a chain that forge (or an earlier bootstrap) already set up must be detected and
 * reused rather than re-deployed. That is also what makes a partially-bootstrapped chain
 * recoverable — re-running finishes the job instead of failing on step one.
 */
async function ensureLibrary(
  send: SendTx,
  publicClient: PublicClient,
  args: {op: string; salt: string; bytecode: Hex; chainId: number; summary: string},
): Promise<Address> {
  const address = predictCreate2Address(args.salt, args.bytecode);
  const code = await publicClient.getCode({address});
  if (code && code !== '0x') return address; // already on this chain (forge, or an earlier bootstrap)
  await send({
    op: args.op,
    to: CREATE2_PROXY,
    data: create2Calldata(args.salt, args.bytecode),
    value: '0x0',
    chainId: args.chainId,
    summary: args.summary,
    fields: {address},
  });
  return address;
}

// The three write-path library legs, one wrapper each over {@link ensureLibrary}. Named rather than
// inlined per factory because FOUR of ABX's six factories are library-linked and each links a
// different subset: SeriesCodeFactory {params, code}, EditionCodeFactory {params, code, edition},
// OneOfOneEditionFactory + EditionImageFactory {params, edition} (params because AbxEditionLib
// itself delegatecalls it). A factory bootstrap composes the legs it needs, in order; whichever
// legs another bootstrap already ran are reused from chain, never redeployed.

/** `AbxMetadataLib` at its canonical salt — the metadata field store that ALL SIX token types
 *  delegatecall. It links nothing itself, so it can be deployed first and unconditionally; every
 *  factory bootstrap needs it, including the two ERC-721 image ones that linked nothing before. */
const ensureMetadataLib = (send: SendTx, publicClient: PublicClient, chainId: number, forWhom: string): Promise<Address> =>
  ensureLibrary(send, publicClient, {
    op: 'deploy-metadata-lib',
    salt: ABX_SALT.metadataLib,
    bytecode: abxMetadataLibBytecode,
    chainId,
    summary: `Deploy AbxMetadataLib (${forWhom} metadata field store, CREATE2 — deterministic address)`,
  });

/** `AbxParamsLib` at its canonical salt — the params write path, and `AbxEditionLib`'s own dependency. */
const ensureParamsLib = (send: SendTx, publicClient: PublicClient, chainId: number, forWhom: string): Promise<Address> =>
  ensureLibrary(send, publicClient, {
    op: 'deploy-params-lib',
    salt: ABX_SALT.paramsLib,
    bytecode: abxParamsLibBytecode,
    chainId,
    summary: `Deploy AbxParamsLib (${forWhom} write-path library, CREATE2 — deterministic address)`,
  });

/** `AbxCodeLib` at its canonical salt — the script/code write path of the two code token types. */
const ensureCodeLib = (send: SendTx, publicClient: PublicClient, chainId: number, forWhom: string): Promise<Address> =>
  ensureLibrary(send, publicClient, {
    op: 'deploy-code-lib',
    salt: ABX_SALT.codeLib,
    bytecode: abxCodeLibBytecode,
    chainId,
    summary: `Deploy AbxCodeLib (${forWhom} write-path library, CREATE2 — deterministic address)`,
  });

/** `AbxEditionLib` at its canonical salt — the 1155 uri / creator-token / edition-supply write path
 *  that ALL THREE edition token types delegatecall. Must be called after {@link ensureParamsLib}:
 *  this library's own bytecode delegatecalls `AbxParamsLib`, so `linkEditionLib()` — and therefore
 *  the address it lands at — is a function of `predictParamsLib()`. Deploying it raw is the opaque
 *  `Invalid byte sequence` bug; `__$…$__` is not hex. */
const ensureEditionLib = (send: SendTx, publicClient: PublicClient, chainId: number, forWhom: string): Promise<Address> =>
  ensureLibrary(send, publicClient, {
    op: 'deploy-edition-lib',
    salt: ABX_SALT.editionLib,
    bytecode: linkEditionLib(),
    chainId,
    summary: `Deploy AbxEditionLib (${forWhom} write-path library, CREATE2 — deterministic address)`,
  });

/** Guard the one failure mode a CREATE2 deploy has: the address is already taken (the keyless proxy
 *  reverts, with nothing useful in the revert data). Says so in words instead. */
async function assertVacant(publicClient: PublicClient, what: string, address: Address, chainId: number): Promise<void> {
  const code = await publicClient.getCode({address});
  if (code && code !== '0x') {
    throw new Error(
      `${what} is already deployed at its canonical address ${address} on chain ${chainId} — resolve it instead of deploying (CREATE2 cannot redeploy to an occupied address)`,
    );
  }
}

/**
 * Deploy the code-project trust root on a chain with no canonical set: the two delegatecalled
 * write-path libraries first ({AbxParamsLib}, {AbxCodeLib}), the factory bytecode LINKED against
 * them (solc placeholders replaced — what forge does at build time, done here so a sandbox/fresh
 * chain needs no forge), then the factory (whose constructor deploys the {SeriesCode}
 * implementation).
 *
 * All three go through the keyless CREATE2 proxy at canonical `AbxSalts` salts, so all three land at
 * addresses that are the same on every chain and computable before the first transaction — the
 * factory's included: linking substitutes an address into already-compiled bytecode, so once the
 * libraries are predictable the linked initcode is fixed too (`predictSeriesCodeFactory()`). The
 * ordering below is still sequential, but now for a plain data-dependency reason rather than a
 * nonce one. See `create2.ts`'s write-path-library note for why the old "libraries are
 * nonce-dependent" story was wrong, and for the compile-time-linking trap that IS real.
 */
export async function deploySeriesCodeFactory(
  send: SendTx,
  publicClient: PublicClient,
): Promise<{factory: Address; implementation: Address; metadataLib: Address; paramsLib: Address; codeLib: Address; txHash: Hex; blockNumber: bigint}> {
  const chainId = await chainIdOf(publicClient);
  const metadataLib = await ensureMetadataLib(send, publicClient, chainId, 'SeriesCode');
  const paramsLib = await ensureParamsLib(send, publicClient, chainId, 'SeriesCode');
  const codeLib = await ensureCodeLib(send, publicClient, chainId, 'SeriesCode');

  const linked = linkSeriesCodeFactory();
  const factory = predictSeriesCodeFactory();
  await assertVacant(publicClient, 'SeriesCodeFactory', factory, chainId);

  const receipt = await send({
    op: 'deploy-series-code-factory',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.seriesCodeFactory, linked),
    value: '0x0',
    chainId,
    summary: 'Deploy the SeriesCode clone factory (trust anchor), linked against AbxParamsLib/AbxCodeLib',
    fields: {factory, metadataLib, paramsLib, codeLib},
  });
  const implementation = (await publicClient.readContract({
    address: factory,
    abi: seriesCodeFactoryAbi,
    functionName: 'implementation',
  })) as Address;
  return {factory, implementation, metadataLib, paramsLib, codeLib, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/** Deploy the canonical pseudorandom seed source (for chains without one shipped). CREATE2 via the
 *  keyless proxy + canonical salt → the SAME address on every chain (matches `DeploySeedSource.s.sol`
 *  and the manifest). The seed source is single-profile, so — unlike the SeriesCode factory — the
 *  SDK's bytecode is the canonical one. */
export async function deploySeedSource(send: SendTx, publicClient: PublicClient): Promise<{seedSource: Address; txHash: Hex}> {
  const chainId = await chainIdOf(publicClient);
  const seedSource = predictSeedSource();
  const receipt = await send(prepareDeploySeedSource({chainId}));
  return {seedSource, txHash: receipt.transactionHash};
}

/**
 * Deploy `AbxMetadataRenderer` — the canonical on-chain metadata renderer.
 * Stateless and shared: deploy once per chain, then point any number of tokens at it via
 * their URI-renderer config. It reads each token's on-chain fields and returns a
 * `data:application/json` URI, so a token using it resolves with zero off-chain infra.
 */
export async function deployRenderer(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'renderer'> & {renderer: Address; specVersion: bigint}> {
  // CREATE2 via the keyless proxy + canonical salt → the SAME address on every chain (matches the
  // forge `DeployRenderer` script and the manifest). Address is deterministic, so compute it (the
  // tx targets the proxy, not a contract creation, so `receipt.contractAddress` is null).
  const chainId = await chainIdOf(publicClient);
  const renderer = predictRenderer();
  const receipt = await send(prepareDeployRenderer({chainId}));
  const specVersion = (await publicClient.readContract({
    address: renderer,
    abi: abxMetadataRendererAbi,
    functionName: 'specVersion',
  })) as bigint;
  return {renderer, specVersion, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Deploy `AbxFixedPriceMinter` — the canonical, ownerless, multi-tenant fixed-price sale
 * singleton (the Minter spine reference). Deploy once per chain; every project shares it
 * (config is keyed by token address, authority defers to each token's owner). Sibling of
 * `deployRenderer` — ownerless, no constructor args, safe for any funded signer to stand up.
 */
export async function deployFixedPriceMinter(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'fixedPriceMinter'> & {minter: Address}> {
  // CREATE2 via the keyless proxy + canonical salt → the SAME address on every chain (matches the
  // forge `DeployMinter` script and the manifest). Address is deterministic, so compute it.
  const chainId = await chainIdOf(publicClient);
  const minter = predictFixedPriceMinter();
  const receipt = await send(prepareDeployFixedPriceMinter({chainId}));
  return {minter, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * The address `deployOneOfOne` will produce for this (factory, salt). It's a pure
 * function of the salt — independent of who deploys — so it can be predicted and
 * its URIs baked in before any signer is known. (Front-running is governed by the
 * salt's guard prefix; see `saltFor` / `permissionlessSalt`.)
 */
export async function predictClone(
  publicClient: PublicClient,
  args: {factory: Address; salt: Hex},
): Promise<Address> {
  return (await publicClient.readContract({
    address: args.factory,
    abi: oneOfOneImageFactoryAbi,
    functionName: 'predictDeterministicAddress',
    args: [args.salt],
  })) as Address;
}

/**
 * Deploy a 1/1 image NFT as an immutable EIP-1167 clone, at a deterministic
 * address (so URIs can be baked in before deploy). Returns the clone address and
 * the block it landed in — the indexer's start block.
 */
export async function deployOneOfOne(
  send: SendTx,
  publicClient: PublicClient,
  args: {factory: Address; params: OneOfOneInitParams; salt: Hex},
): Promise<DeployResult<'clone'> & {clone: Address}> {
  const clone = await predictClone(publicClient, {factory: args.factory, salt: args.salt});
  const chainId = await chainIdOf(publicClient);
  const receipt = await send(prepareDeployOneOfOne({factory: args.factory, params: args.params, salt: args.salt, chainId, clone}));
  return {clone, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Deploy a Series (multi-token) NFT as an immutable EIP-1167 clone, at a deterministic
 * address. The sibling of `deployOneOfOne`. `predictClone` works unchanged — the
 * `predictDeterministicAddress` fragment is identical across factories, and each factory
 * computes with its own implementation. `params.mintCount`/`mintTo` decide the deploy-time
 * mint; anything larger mints post-deploy under a gas budget.
 */
export async function deploySeries(
  send: SendTx,
  publicClient: PublicClient,
  args: {factory: Address; params: SeriesInitParams; salt: Hex},
): Promise<DeployResult<'clone'> & {clone: Address}> {
  const clone = await predictClone(publicClient, {factory: args.factory, salt: args.salt});
  const chainId = await chainIdOf(publicClient);
  const receipt = await send(prepareDeploySeries({factory: args.factory, params: args.params, salt: args.salt, chainId, clone}));
  return {clone, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

// ── ERC-1155 editions ──────────────────────────────────────────────────────────

/**
 * Deploy the canonical `OneOfOneEditionFactory` — the 1/1-edition trust anchor. Unlike {@link
 * deployFactory} (the 721 1/1 factory, a plain contract creation), this one goes through the
 * keyless CREATE2 proxy with the canonical `AbxSalts.ONE_OF_ONE_EDITION_FACTORY` salt — matching
 * how `contracts/script/DeployOneOfOneEdition.s.sol` actually deploys it — so its address is the
 * SAME on every chain and predictable before the deploy tx (`predictOneOfOneEditionFactory()`).
 *
 * Library-linked, like the two code factories: `OneOfOneEdition` delegates its uri /
 * creator-token / edition-supply bodies into `AbxEditionLib`, so this deploys `AbxParamsLib` +
 * `AbxEditionLib` first ({@link ensureEditionLibraries}) and sends the factory's initcode LINKED
 * against the settled library address. Linking costs nothing in determinism — see `create2.ts`'s
 * write-path-library note.
 */
export async function deployOneOfOneEditionFactory(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'factory'> & {factory: Address; implementation: Address; metadataLib: Address; paramsLib: Address; editionLib: Address}> {
  const chainId = await chainIdOf(publicClient);
  const metadataLib = await ensureMetadataLib(send, publicClient, chainId, 'OneOfOneEdition');
  const paramsLib = await ensureParamsLib(send, publicClient, chainId, 'OneOfOneEdition');
  const editionLib = await ensureEditionLib(send, publicClient, chainId, 'OneOfOneEdition');
  const factory = predictOneOfOneEditionFactory();
  await assertVacant(publicClient, 'OneOfOneEditionFactory', factory, chainId);
  const receipt = await send(prepareDeployOneOfOneEditionFactory({chainId}));
  const implementation = (await publicClient.readContract({
    address: factory,
    abi: oneOfOneEditionFactoryAbi,
    functionName: 'implementation',
  })) as Address;
  return {factory, implementation, metadataLib, paramsLib, editionLib, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/** Deploy the canonical `EditionImageFactory` — the multi-work edition trust anchor. CREATE2
 *  via the keyless proxy + the canonical `AbxSalts.EDITION_FACTORY` salt (see {@link
 *  deployOneOfOneEditionFactory}'s doc note on why this differs from the 721 series factory's
 *  plain-creation bootstrap, and why `AbxEditionLib` has to land first). */
export async function deployEditionFactory(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'factory'> & {factory: Address; implementation: Address; metadataLib: Address; paramsLib: Address; editionLib: Address}> {
  const chainId = await chainIdOf(publicClient);
  const metadataLib = await ensureMetadataLib(send, publicClient, chainId, 'EditionImage');
  const paramsLib = await ensureParamsLib(send, publicClient, chainId, 'EditionImage');
  const editionLib = await ensureEditionLib(send, publicClient, chainId, 'EditionImage');
  const factory = predictEditionFactory();
  await assertVacant(publicClient, 'EditionImageFactory', factory, chainId);
  const receipt = await send(prepareDeployEditionFactory({chainId}));
  const implementation = (await publicClient.readContract({
    address: factory,
    abi: editionImageFactoryAbi,
    functionName: 'implementation',
  })) as Address;
  return {factory, implementation, metadataLib, paramsLib, editionLib, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/** Deploy `AbxFixedPriceMinter1155` — the canonical, ownerless, multi-tenant edition sale
 *  singleton (the Minter spine's edition lane). Sibling of `deployFixedPriceMinter`, one id
 *  finer at the contract level (`(token, id)`-keyed sales) — the deploy itself is identical in
 *  shape: CREATE2 via the keyless proxy + canonical salt. */
export async function deployFixedPriceMinter1155(
  send: SendTx,
  publicClient: PublicClient,
): Promise<DeployResult<'fixedPriceMinter1155'> & {minter: Address}> {
  const chainId = await chainIdOf(publicClient);
  const minter = predictFixedPriceMinter1155();
  const receipt = await send(prepareDeployFixedPriceMinter1155({chainId}));
  return {minter, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Deploy a 1/1 edition NFT as an immutable EIP-1167 clone, at a deterministic address. The
 * edition twin of `deployOneOfOne` — `predictClone` works unchanged (the
 * `predictDeterministicAddress` fragment is identical across every factory, 721 or 1155).
 */
export async function deployOneOfOneEdition(
  send: SendTx,
  publicClient: PublicClient,
  args: {factory: Address; params: OneOfOneEditionInitParams; salt: Hex},
): Promise<DeployResult<'clone'> & {clone: Address}> {
  const clone = await predictClone(publicClient, {factory: args.factory, salt: args.salt});
  const chainId = await chainIdOf(publicClient);
  const receipt = await send(
    prepareDeployOneOfOneEdition({factory: args.factory, params: args.params, salt: args.salt, chainId, clone}),
  );
  return {clone, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Deploy an EditionImage (multi-work edition) NFT as an immutable EIP-1167 clone, at a
 * deterministic address. The edition twin of `deploySeries`.
 */
export async function deployEditionImage(
  send: SendTx,
  publicClient: PublicClient,
  args: {factory: Address; params: EditionImageInitParams; salt: Hex},
): Promise<DeployResult<'clone'> & {clone: Address}> {
  const clone = await predictClone(publicClient, {factory: args.factory, salt: args.salt});
  const chainId = await chainIdOf(publicClient);
  const receipt = await send(
    prepareDeployEditionImage({factory: args.factory, params: args.params, salt: args.salt, chainId, clone}),
  );
  return {clone, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}

/**
 * Deploy the code-project edition trust root on a chain with no canonical set: the THREE
 * delegatecalled write-path libraries first ({AbxParamsLib}, {AbxCodeLib}, {AbxEditionLib} — the
 * edition twin of `deploySeriesCodeFactory`'s two-lib dance, plus the 1155 write path {@link
 * deployOneOfOneEditionFactory} and {@link deployEditionFactory} link too), the factory bytecode
 * LINKED against all three, then the factory (whose constructor deploys the {EditionCode}
 * implementation). CREATE2 at canonical `AbxSalts` salts throughout, exactly like
 * {@link deploySeriesCodeFactory}, so the whole set is cross-chain-identical and predictable
 * (`predictEditionCodeFactory()`). This is the only factory linking all three libraries; it is NOT
 * the only one linking {AbxEditionLib} — all three 1155 token types delegate into it.
 *
 * One wrinkle the 721 twin doesn't have: {AbxEditionLib} delegatecalls {AbxParamsLib}, so its OWN
 * shipped bytecode carries an unlinked placeholder and has to be linked before it can be deployed
 * ({@link ensureEditionLib} does this via `linkEditionLib()`). Deploying it raw is what made this
 * function fail with an opaque `Invalid byte sequence` — `__$…$__` is not hex, and the old
 * unlinked-placeholder guard only checked the factory's bytecode, never the library's.
 */
export async function deployEditionCodeFactory(
  send: SendTx,
  publicClient: PublicClient,
): Promise<{
  factory: Address;
  implementation: Address;
  metadataLib: Address;
  paramsLib: Address;
  codeLib: Address;
  editionLib: Address;
  txHash: Hex;
  blockNumber: bigint;
}> {
  const chainId = await chainIdOf(publicClient);
  const metadataLib = await ensureMetadataLib(send, publicClient, chainId, 'EditionCode');
  const paramsLib = await ensureParamsLib(send, publicClient, chainId, 'EditionCode');
  const codeLib = await ensureCodeLib(send, publicClient, chainId, 'EditionCode');
  const editionLib = await ensureEditionLib(send, publicClient, chainId, 'EditionCode');

  const linked = linkEditionCodeFactory();
  const factory = predictEditionCodeFactory();
  await assertVacant(publicClient, 'EditionCodeFactory', factory, chainId);

  const receipt = await send({
    op: 'deploy-edition-code-factory',
    to: CREATE2_PROXY,
    data: create2Calldata(ABX_SALT.editionCodeFactory, linked),
    value: '0x0',
    chainId,
    summary: 'Deploy the EditionCode clone factory (trust anchor), linked against AbxParamsLib/AbxCodeLib/AbxEditionLib',
    fields: {factory, metadataLib, paramsLib, codeLib, editionLib},
  });
  const implementation = (await publicClient.readContract({
    address: factory,
    abi: editionCodeFactoryAbi,
    functionName: 'implementation',
  })) as Address;
  return {factory, implementation, metadataLib, paramsLib, codeLib, editionLib, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber};
}
