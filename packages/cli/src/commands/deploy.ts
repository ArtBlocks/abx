/**
 * Deploy commands — the biggest domain, kept as ONE module (they share the salt/dry-run/staging
 * machinery too tightly to split further without duplicating it):
 *
 *   `abx demo` / `abx deploy`   a 1/1 image NFT (SeriesImage's sibling contract, OneOfOneImage)
 *   `abx deploy-series`         a multi-token image Series from a folder of media
 *   `abx deploy-code`           a generative/code drop (SeriesCode) — on-chain script chunks or a
 *                               directory build, PostParam schemas, optional `--resume` to finish
 *                               an existing contract whose setup tx never landed
 *
 * Private helpers: the deploy-command-line reproducers (pinned-salt copy/paste), the
 * placeholder-identity + preview-deployer guards, content staging narration (image fields,
 * storage-plan readiness), and the demo-only walkthrough (spine/rebuild/read-back) sections.
 */
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {basename, extname, join as joinPath, resolve as resolvePath} from 'node:path';
import {SelfHostIndexer} from '@artblocks/abx-indexer';
import {
  type Address,
  DEFAULT_CHAIN_KEY,
  DEP_RESOLUTION,
  type DepCheck,
  METADATA_FIELD as F,
  contentIdFromLocator,
  type OnChainFieldInput,
  type OpenSeaAttribute,
  type ProjectState,
  type PublicClient,
  METADATA_REPRESENTATION as R,
  type ResumeReader,
  type EditionResumeReader,
  type SendTx,
  type SeriesInitParams,
  type SeriesTokenFieldInput,
  type SetupLegs,
  type SetupLegsCore,
  type EditionSetupLegs,
  type OneOfOneEditionInitParams,
  type EditionImageInitParams,
  type EditionCodeInitParams,
  type EditionTokenFieldInput,
  type PreparedTx,
  analyzeScript,
  assertChainId,
  checkRegistryDeps,
  dependencySetupCalls,
  DEFAULT_TX_GAS_BUDGET,
  MEASURED_ESTIMATE_GAS_ALLOWANCE,
  SETUP_LEG_GAS,
  estimateChunkGasForBytes,
  packCallsByGas,
  deployOneOfOne,
  deploySeries,
  deployOneOfOneEdition,
  deployEditionImage,
  discoverDeployBlock,
  encodeFieldRenderer,
  encodeTag,
  expectedChainComplete,
  makeHotSender,
  makePublicClient,
  makeWalletClient,
  normalizeAttributes,
  onchainUriSetupCalls,
  oneOfOneImageAbi,
  oneOfOneEditionAbi,
  editionCodeAbi,
  parseTraitPairs,
  planResume,
  planEditionResume,
  predictClone,
  probeSeedSource,
  prepareCodeSetup,
  prepareDeployOneOfOne,
  prepareDeploySeries,
  prepareDeploySeriesCode,
  prepareDeployOneOfOneEdition,
  prepareDeployEditionImage,
  prepareDeployEditionCode,
  redactRpcUrl,
  resolveChain,
  resolveDepRegistryPointer,
  resolveGenerator,
  probeTransferValidator,
  resolveRecommendedTransferValidator,
  resolveRpcUrl,
  resolveSeedSource,
  resolveSeriesCodeFactory,
  saltFor,
  seriesCodeAbi,
  seriesCodeFactoryAbi,
  tryReadContract,
  AbxServiceClient,
} from '@artblocks/abx-sdk';
import {
  DIRECT_URL_BACKENDS,
  type StorageBackend,
  contentTypeFromPath,
  decideImageContentLane,
  hashContent,
  isTurboArweave,
  resolveBackend,
  validateRenderStorageCombo,
} from '@artblocks/abx-storage';
import {DEFAULT_PORT, contentHash, generateContent, resolveBaseUrl, startTokenApiServer} from '@artblocks/abx-token-api';
import {type Hex, encodeFunctionData, getAddress, toHex, zeroAddress} from 'viem';
import {
  CHAIN,
  explorerBase,
  type StorageOverrides,
  assertTurboFundsForUpload,
  backendResolution,
  collectContentLocators,
  ensureArweaveIdentityForUpload,
  factoryAddress,
  faucetHint,
  localIndexer,
  loopbackBaseUrl,
  noteArweavePlan,
  noteStorageReadiness,
  rendererAddress,
  seriesFactoryAddress,
  oneOfOneEditionFactoryAddress,
  editionFactoryAddress,
  editionCodeFactoryAddress,
  storageOptions,
  storageOverrides,
  storageSignerChoice,
} from '../config.js';
import {parseDepFlag} from '../deps.js';
import {type Flags, isDryRun, parseSaltFlag, refuseStrayFlags, unknownFlags, warnSignWithoutFor} from '../flags.js';
import {isEditionContract} from '../kind.js';
import {jsonSafe, withJson} from '../jsonout.js';
import {planOnChainScript} from '../script-chunks.js';
import {
  assertPortFree,
  bold,
  c,
  dim,
  ensureFactory,
  ensureRenderer,
  ensureSeedSource,
  ensureSeriesCodeFactory,
  ensureSeriesFactory,
  ensureOneOfOneEditionFactory,
  ensureEditionFactory,
  ensureEditionCodeFactory,
  g,
  info,
  keepAlive,
  ok,
  p,
  portInUse,
  printServing,
  registerAndIndexLocally,
  reindexAfterDeploy,
  step,
  warn as printWarn,
} from '../output.js';
import {
  DEPLOY_PLAN_SCHEMA_VERSION,
  stripAnsiForPlan,
  type DeployPlan,
  type DeployPlanFamily,
  type DeployPlanImageFile,
} from '../deploy-plan.js';
import {
  parseRoyaltyBps,
  AUTHORSHIP_DEPLOY_FIELDS,
  ONCHAIN_PROJECT_SOFT_LIMIT,
  ONCHAIN_READ_WARN_BYTES,
  tokenUriGasEstimate,
  authorshipContractFields,
  gatewayContractFields,
  servingGateway,
  computeContentPlan,
  envStagingSender,
  parseCompress,
  parseSeedSourceValue,
  canonicalSeedSource,
  refuseUnusableSeedSource,
  parseTransferValidatorValue,
  guardOnChainSize,
  previewImageStaging,
  refusePrewrappedImage,
  sessionStagingSender,
  stageImageField,
  stageImageFieldsBatch,
} from '../ownerops.js';
import {canonicalLabel} from '../remote.js';
import {assertLaneCanSign, confirmSend, gatedSend, laneFromFlags} from '../riskgate.js';
import {describeSchema, editionSchemaAdvisory, parseSchemaSpecs} from '../schema.js';
import {parseSeriesTraits} from '../series-traits.js';
import {decodeOnChainJson} from '../served.js';
import {openWalletSession, signHotSequence, signTx, type SignResult} from '../signer.js';

// ── plan-object warning capture ──────────────────────────────────────────────────────────────────
// The structured `--json` plan object (deploy-plan.ts) reports "the warnings the lane raised"
// alongside every other computed field — but ~400 `warn()` call sites in this file exist purely as
// human prose, and rewriting each to ALSO push onto a collector would be exactly the kind of
// touch-every-call-site change the plan-object work was scoped to avoid (a wording regression is one
// typo away, across 17 test files that assert on this prose byte-for-byte). Re-binding the name
// instead means every existing `warn(...)` call — unchanged, still reading `warn` from this file's own
// scope — transparently also feeds the plan. `planWarnings` is reset at the top of each
// `cmdDeploy*Body` (`beginPlanWarnings`) and read once, right before that invocation's `emit()` call(s).
// Not reentrant/thread-safe by construction — fine, since one CLI process runs exactly one command.
let planWarnings: string[] = [];
function beginPlanWarnings(): void {
  planWarnings = [];
}
function warn(s: string): void {
  planWarnings.push(stripAnsiForPlan(s));
  printWarn(s);
}

// Product dimensions — what you can launch. Two concrete contract FAMILIES exist today: the 721
// ladder (`--type`, below — 1/1 image or Series) and, orthogonally, ERC-1155 editions (`--copies`,
// on ANY of the three deploy commands — see `parseCopies`). `--type` picks among unique-token
// shapes; `--copies` switches uniqueness for copies of the same shape. They are independent knobs,
// which is why editions get no entry of their own here rather than a fourth dimension.
export const DIMENSIONS: Record<string, {label: string; aliases: string[]}> = {
  '1of1': {label: '1/1 image NFT', aliases: ['one-of-one', 'oneofone', '1-of-1']},
  series: {label: 'multi-token image Series', aliases: ['multi', 'collection']},
};
export function resolveDimension(type: string): string {
  const key = Object.keys(DIMENSIONS).find((k) => k === type || DIMENSIONS[k].aliases.includes(type));
  if (!key) {
    const known = Object.keys(DIMENSIONS).join(', ');
    throw new Error(`Unknown --type '${type}'. Implemented: ${known}. (More dimensions land as their contracts are exposed.)`);
  }
  return key;
}

// ── --copies: the flag that routes a deploy to its ERC-1155 edition twin ─────────────────────────
// The kernel (specs/protocol — the parity plan): a Series is many UNIQUE tokens; an Edition is many
// COPIES of a token. The creator's trigger word is "copies" — nobody says "ERC-1155" or "1155",
// and this flag is the only surface that exists: no `--standard` flag, no separate top-level
// commands. Absent → the 721 lane, byte-identical to before `--copies` existed.

/** Parse `--copies <N|open>` into the `editionSize` InitParams field (`0n` = open/uncapped). Throws
 *  with a pointed message on anything else — a bare `--copies` (no value), a non-integer, or the
 *  literal `0` (which already has an on-chain meaning — "open" says the same thing without the
 *  ambiguity of "did they mean zero copies, or unlimited?"). */
export function parseCopies(raw: string | undefined): bigint {
  if (raw === undefined) throw new Error('--copies needs a value: a positive integer (copies per id), or "open" for an uncapped edition.');
  const v = raw.trim();
  if (v === 'true') throw new Error('--copies needs a value: a positive integer (copies per id), or "open" for an uncapped edition — a bare --copies has neither.');
  if (v.toLowerCase() === 'open') return 0n;
  if (!/^\d+$/.test(v)) throw new Error(`--copies must be a positive integer (copies per id) or "open" (uncapped); got '${raw}'.`);
  if (v === '0') throw new Error(`--copies 0 is ambiguous with the on-chain meaning of 0 (open/uncapped) — say what you mean: --copies open.`);
  return BigInt(v);
}

/** `--copies 1` is legal — a single-copy ERC-1155 edition — but it is almost never what a creator
 *  actually wants (the plain 721 lane makes a simpler, more marketplace-familiar token for exactly
 *  one copy). Advisory only; never refused — `--copies` exists precisely so nobody has to reach for
 *  a different flag to get an edition. */
export function copiesOneNote(cmd: string): string {
  return `--copies 1 makes a single-copy ERC-1155 edition. If you want one unique token, drop --copies — \`abx ${cmd}\` (no --copies) is the simpler, more marketplace-familiar 721 lane.`;
}

/** A non-negative-integer flag (`--mint-amount`, …) — the shared parse + bound-check so every
 *  edition flag that takes "a count" reports the same, plain-language rejection. */
export function parseNonNegativeIntFlag(raw: string, flag: string): bigint {
  if (!/^\d+$/.test(raw.trim()) || raw.trim() === '') throw new Error(`--${flag} must be a non-negative integer; got '${raw}'.`);
  return BigInt(raw.trim());
}

/**
 * A `--dry-run` computes the deterministic deploy address, which is a pure function of
 * (factory, salt, deployer) — so it needs a deployer even though it signs nothing. Resolve it the
 * same way the preview will (`--for`, else an env key) and fail EARLY with the fix if neither
 * exists, rather than after the preview has printed several steps of work.
 */
/**
 * A dry run only checks whether a factory address is CONFIGURED, not whether it has code on this
 * chain — and the manifest always has an address, so a chain where the trust anchor isn't deployed
 * (a private/local chain, or a wrong-network RPC) sailed past this and died inside
 * `predictDeterministicAddress` with a raw `returned no data ("0x")` and a list of ABI hypotheses.
 * The real deploy and `abx predict` both explain that case; a preview of the same deploy must too.
 * Returns false when the caller should stop (message already printed).
 */
export async function previewFactoryLive(client: PublicClient, factory: Address, label: string): Promise<boolean> {
  const code = await client.getCode({address: factory}).catch(() => undefined);
  if (code && code !== '0x') return true;
  warn(`the configured ${label} ${factory} has no code on '${CHAIN}' (asked ${redactRpcUrl(resolveRpcUrl(CHAIN))}).`);
  info('so this preview can\'t compute the deterministic address. Either point at a chain where the trust anchor is deployed');
  info(`(${bold('ABX_CHAIN=' + DEFAULT_CHAIN_KEY)} is the default and has one), or deploy your own on this chain with ${bold('--bootstrap-factory')}`);
  info(dim('(a private anchor — platforms won\'t recognize its clones, so it\'s for private/sandbox chains).'));
  console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
  return false;
}

/**
 * Placeholder-identity guard, shared by ALL THREE deploy commands. `name`/`symbol` are written
 * on-chain as the public collection identity and are effectively permanent, so a real deploy must
 * never bake a tool default silently: warn in a preview, HARD-STOP a real send unless `--yes`.
 *
 * It was duplicated per command, and `deploy-series` simply never got a copy — its default
 * "ABX Series"/"ABXS" went on-chain with at most a warning, while the skill promises the CLI
 * refuses demo defaults. (deploy-code's copy even said "mirror deploy/deploy-series", which made
 * the gap look closed.) One predicate now, like `loopbackBaseUrl()`, so a fourth command can't drift.
 */
export function assertRealIdentity(flags: Flags, o: {name: string; symbol: string; dryRun: boolean}): void {
  if (flags.name && flags.symbol) return;
  if (!flags.name) warn(`no --name → default "${o.name}" would be the on-chain collection name`);
  if (!flags.symbol) warn(`no --symbol → default "${o.symbol}" would be the on-chain symbol`);
  if (o.dryRun || flags.yes) return; // a preview still runs; --yes is the explicit opt-in
  throw new Error(
    'refusing to write tool placeholders as your public on-chain identity — pass --name "Your Title" --symbol SYM ' +
      '(or --yes to accept the defaults). On-chain identity is effectively permanent.',
  );
}

export function assertPreviewDeployer(flags: Flags): void {
  if (flags.for) return;
  try {
    makeWalletClient({chainKey: CHAIN});
  } catch {
    throw new Error(
      'dry run needs a deployer address to compute the deterministic deploy address — pass --for 0x.. ' +
        '(a preview signs nothing, so no key is needed). For the REAL deploy with no key in .env, use the ' +
        'wallet lane: --sign --for 0x.. (you approve in your own wallet).',
    );
  }
}

// Funding preflight — a 0-balance signer fails only at the tx, with a confusing error. Surface it
// up front. Especially the wallet lane (--sign/--for), which has no env key for `doctor` to check.
export async function warnUnfunded(publicClient: PublicClient, address: Address): Promise<void> {
  try {
    const bal = await publicClient.getBalance({address});
    if (bal === 0n) warn(`signer ${address} has 0 ${CHAIN} ETH — ${faucetHint(CHAIN)}, then sign.`);
  } catch {
    /* RPC hiccup — skip the advisory preflight, the real send still validates */
  }
}

// Reconstruct a copy-pasteable `abx deploy` from the flags used + a pinned salt, so a previewed
// address is reproducible in one paste (a plain re-run reserves a different salt → different addr).
//
// A reproduce line is meant to be copy-pasted into a shell, so every value MUST be shell-safe. The
// old rule (wrap only whitespace values in DOUBLE quotes) corrupted any name/description containing
// a quote, `&`, `<`, `$`, etc. — the shell reparsed it and silently truncated/mangled the text
// (round-3 finding: `Bob's "Café" & Friends` came back broken). POSIX single-quote escaping is the
// robust fix: it makes ANY string a single safe token (embedded `'` → `'\''`).
export function shArg(v: string): string {
  return /^[A-Za-z0-9,._+:@%/=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

export function deployCommandLine(flags: Flags, salt: string): string {
  const parts = ['abx deploy'];
  const str = (k: string, v?: string) => { if (v) parts.push(`--${k} ${shArg(v)}`); };
  const bool = (k: string) => { if (flags[k] === '' || flags[k] === 'true') parts.push(`--${k}`); };
  str('image', flags.image); str('name', flags.name); str('symbol', flags.symbol);
  str('description', flags.description); str('external-url', flags['external-url']);
  str('traits', flags.traits); str('attributes', flags.attributes);
  bool('traits-onchain'); bool('description-onchain'); bool('onchain-uri'); bool('onchain-image');
  str('compress', flags.compress); str('royalty-bps', flags['royalty-bps']); str('royalty-cap', flags['royalty-cap']); bool('burnable'); bool('no-mint');
  str('721c', flags['721c'] === 'true' ? 'recommended' : flags['721c']); // bare --721c ≡ recommended
  str('backend', flags.backend); str('gateway', flags.gateway); str('bucket', flags.bucket);
  str('ipfs-gateway', flags['ipfs-gateway']); str('arweave-gateway', flags['arweave-gateway']);
  str('public-base-url', flags['public-base-url']);
  if (flags.sign !== undefined) parts.push('--sign');
  if (flags.unsigned !== undefined) parts.push('--unsigned');
  str('for', flags.for as string | undefined);
  parts.push(`--salt ${salt}`);
  return parts.join(' ');
}

// Copy-pasteable `abx deploy-series` with the pinned salt — the STATELESS way to reproduce a
// previewed address in one line (we print it; nothing is remembered). `--for`/`--sign` are carried
// through so the reproduced command keeps the same signer enforcement (a safety feature, not dropped).
export function deploySeriesCommandLine(flags: Flags, salt: string): string {
  const parts = ['abx deploy-series'];
  const str = (k: string, v?: string) => { if (v) parts.push(`--${k} ${shArg(v)}`); };
  const bool = (k: string) => { if (flags[k] === '' || flags[k] === 'true') parts.push(`--${k}`); };
  str('dir', flags.dir); str('count', flags.count); str('name', flags.name); str('symbol', flags.symbol);
  str('description', flags.description); str('external-url', flags['external-url']); str('attributes', flags.attributes); // were DROPPED → the "redeploy identically" line lost the description
  bool('onchain-uri'); bool('onchain-image'); str('compress', flags.compress);
  str('backend', flags.backend); str('gateway', flags.gateway); str('bucket', flags.bucket);
  str('ipfs-gateway', flags['ipfs-gateway']); str('arweave-gateway', flags['arweave-gateway']);
  str('public-base', flags['public-base']); str('public-base-url', flags['public-base-url']);
  bool('mint-all'); str('mint-count', flags['mint-count']); bool('no-mint'); bool('unpaused');
  str('minter', flags.minter); str('primary-payee', flags['primary-payee']); str('royalty-bps', flags['royalty-bps']); str('royalty-cap', flags['royalty-cap']); bool('burnable');
  str('721c', flags['721c'] === 'true' ? 'recommended' : flags['721c']); // bare --721c ≡ recommended
  if (flags.sign !== undefined) parts.push('--sign');
  if (flags.unsigned !== undefined) parts.push('--unsigned');
  str('for', flags.for as string | undefined);
  parts.push(`--salt ${salt}`);
  return parts.join(' ');
}

// Copy-pasteable `abx deploy-code` with the pinned salt — same stateless reproduce contract as the
// 1/1 / Series lines above (a plain re-run reserves a different salt → a different clone address).
export function deployCodeCommandLine(flags: Flags, salt: string): string {
  const parts = ['abx deploy-code'];
  const str = (k: string, v?: string) => { if (v) parts.push(`--${k} ${shArg(v)}`); };
  const bool = (k: string) => { if (flags[k] === '' || flags[k] === 'true') parts.push(`--${k}`); };
  str('script', flags.script); str('code-dir', flags['code-dir']);
  str('name', flags.name); str('symbol', flags.symbol); str('description', flags.description); str('external-url', flags['external-url']);
  str('image-renderer', flags['image-renderer']); str('image-base', flags['image-base']); str('attributes-renderer', flags['attributes-renderer']);
  str('max', flags.max); str('schema', flags.schema); bool('no-seed'); str('seed-source', flags['seed-source']);
  bool('onchain-uri'); str('generator', flags.generator); str('renderer', flags.renderer);
  str('dep', flags.dep); str('dep-registry', flags['dep-registry']); // repeats already comma-joined — one --dep reproduces them in order
  bool('mint-all'); str('mint-count', flags['mint-count']); bool('no-mint'); bool('unpaused');
  str('minter', flags.minter); str('primary-payee', flags['primary-payee']); str('royalty-bps', flags['royalty-bps']); str('royalty-cap', flags['royalty-cap']); bool('burnable');
  str('721c', flags['721c'] === 'true' ? 'recommended' : flags['721c']); // bare --721c ≡ recommended
  str('backend', flags.backend); str('gateway', flags.gateway); str('public-base-url', flags['public-base-url']);
  str('ipfs-gateway', flags['ipfs-gateway']); str('arweave-gateway', flags['arweave-gateway']);
  if (flags.sign !== undefined) parts.push('--sign');
  if (flags.unsigned !== undefined) parts.push('--unsigned');
  str('for', flags.for as string | undefined);
  parts.push(`--salt ${salt}`);
  return parts.join(' ');
}

// ── content custody ───────────────────────────────────────────────────────--
// Build the token's `image` field as an on-chain keccak256 commitment over the bytes,
// and (with --image) store those bytes in custody keyed by that hash so the resolver
// can serve + verify them. Without --image, fall back to the demo's generative-from-
// address content (recomputable, nothing to store). Returns on-chain field inputs.
export const imageKeccakField = (value: Hex): OnChainFieldInput => ({
  field: encodeTag(F.image),
  representation: encodeTag(R.keccak256),
  value,
});

export const imageInlineField = (svg: string): OnChainFieldInput => {
  refusePrewrappedImage(svg, 'inline image');
  return {
    field: encodeTag(F.image),
    representation: encodeTag(R.inline),
    value: toHex(svg),
  };
};

/** An `image` field pointing at an off-chain URL (the renderer emits it verbatim). */
export const imageUrlField = (url: string): OnChainFieldInput => ({
  field: encodeTag(F.image),
  representation: encodeTag(R.url),
  value: toHex(url),
});

/** An `image` field as a `url-template` — `{id}` is substituted with the tokenId at render, so ONE
 *  (collection-scope) field addresses a whole pinned directory / Arweave manifest. */
export const imageUrlTemplateField = (template: string): OnChainFieldInput => ({
  field: encodeTag(F.image),
  representation: encodeTag(R.urlTemplate),
  value: toHex(template),
});

/**
 * An `image` field carrying a CONTENT-ADDRESSED identity — the bare CID / txid, with the serving
 * gateway supplied at read time from the collection's `abx_gateway_*` preference (renderer spec v11).
 *
 * This replaces what `--onchain-uri --backend ipfs|arweave` used to write. That path stored the
 * backend's gateway HTTPS URL as a `url` field, which looked identical in a marketplace and was
 * wrong in two ways that only showed up later: the creator's chosen gateway host was welded into a
 * value they might have locked, so a dead gateway became a dead token rather than a repoint; and
 * `abx_provenance` reported `source: url` for bytes that live on IPFS, so the chain stopped saying
 * where the work actually was. The CID is identity and the gateway is a preference — one field each.
 *
 * `{id}` in the value still substitutes at read (the O(1) directory pattern), so a collection-scope
 * `ipfs` field addresses a whole pinned folder exactly as `url-template` does for a plain CDN.
 */
export const imageContentAddressedField = (
  network: 'ipfs' | 'arweave',
  contentId: string,
): OnChainFieldInput => ({
  field: encodeTag(F.image),
  representation: encodeTag(network === 'ipfs' ? R.ipfs : R.arweave),
  value: toHex(contentId),
});

/**
 * The `image` field for a locator a durable backend just produced — ONE decision point, so every
 * lane (1/1, series, both edition twins) writes the same shape for the same backend.
 *
 * `ipfs` / `arweave` store IDENTITY: recover the bare CID/txid from the backend's gateway URL and
 * commit that, leaving the serving prefix to the collection's `abx_gateway_*` preference. Any path
 * suffix rides along, so a directory upload's `<cid>/{id}.png` is still one collection-scope field
 * covering every token — the renderer substitutes `{id}` for `ipfs`/`arweave` exactly as it does for
 * `url-template`.
 *
 * `cloud` and friends keep the plain `url` / `url-template` they always had: an https CDN locator IS
 * the address, with no identity underneath to separate out.
 */
/**
 * The URL a creator's token will actually carry, for a locator a durable backend just produced.
 *
 * For `ipfs`/`arweave` the backend's locator is an UPLOAD-gateway URL, and the on-chain field holds
 * only the bare CID/txid — so narrating the locator verbatim told the creator a host their token
 * does not use (a live deploy printed `gateway.pinata.cloud/…` while committing a CID served from
 * `ipfs.io`). Rebuild it under the serving preference instead, and say which one that is, since
 * "the floor is filling a silence" and "you chose this" have different futures.
 *
 * Every other backend is returned verbatim: an https CDN locator IS the address.
 */
function servedImageUrl(backendId: string, locator: string, flags: Flags): {url: string; note: string} {
  if (backendId !== 'ipfs' && backendId !== 'arweave') return {url: locator, note: ''};
  const contentId = contentIdFromLocator(backendId, locator);
  if (!contentId) return {url: locator, note: ''};
  const {prefix, chosen} = servingGateway(backendId, flags);
  return {
    url: `${prefix}${contentId}`,
    note: chosen ? `gateway: yours, written on-chain` : `gateway: public default — repoint any time with ${bold('abx set-gateway')}`,
  };
}

/** How a lane should describe what it just committed, so the narration matches the field written. */
function describeLocatorField(backendId: string): string {
  return backendId === 'ipfs' || backendId === 'arweave'
    ? `ON-CHAIN image as a bare ${backendId} id — the gateway is the collection's preference, repointable with ${bold('abx set-gateway')}`
    : 'ON-CHAIN image url (the locator IS the address)';
}

function imageLocatorField(backendId: string, locator: string, isTemplate = false): OnChainFieldInput {
  const network = backendId === 'ipfs' || backendId === 'arweave' ? backendId : null;
  if (network) {
    const contentId = contentIdFromLocator(network, locator);
    if (contentId) return imageContentAddressedField(network, contentId);
    // A subdomain-style gateway (`https://<cid>.ipfs.dweb.link`), which ABX's own backends never
    // produce. Degrade to the old shape rather than guess at the CID — and say so, because the
    // consequence (a welded host) is exactly what the caller thought they were avoiding.
    warn(
      `could not recover the ${network} content id from ${locator} — writing the gateway URL as a plain ` +
        `'url' field instead. That URL's host is then part of the on-chain value: a gateway change ` +
        `needs ${bold('abx set-field')}, not ${bold('abx set-gateway')}.`,
    );
  }
  return isTemplate ? imageUrlTemplateField(locator) : imageUrlField(locator);
}

export const looksLikeSvg = (s: string): boolean => /^\s*<(\?xml|svg)/i.test(s);

/**
 * Does the IMAGE itself end up on-chain for this deploy? Two ways it can:
 *   • `--onchain-image` — the bytes are staged in the chunk store and read back via a `reader` field.
 *   • `--onchain-uri` with an SVG — v1 inlines SVG directly as a data: URI (raster cannot be).
 * Anything else falls through to keccak256 custody, and the on-chain renderer serves its PLACEHOLDER
 * image. This distinction is the difference between a token that is durable and one that only looks
 * durable, so it must be computed from the actual file — never inferred from the flag alone (the
 * success banner used to claim "fully on-chain, no hosting needed" for a keccak-anchored raster).
 */
/**
 * Will `tokenURI` resolve to the creator's REAL image, with nothing to keep running?
 *
 * Three ways yes, and they are not the same promise: the bytes are on-chain
 * ({@link imageEndsUpOnChain}), or they sit at a durable public URL that the on-chain JSON points at
 * (a direct-URL backend — the "no server" pattern). Only `fs` custody under `--onchain-uri` fails,
 * because the renderer then holds a hash and nothing can serve it. Keep this separate from
 * "fully on-chain": conflating them is what let a keccak-anchored raster ship under a permanence
 * banner it did not earn.
 */
export function imageResolvesWithoutServer(flags: Flags, onchainImage: boolean): boolean {
  if (imageEndsUpOnChain(flags, onchainImage)) return true;
  return !!flags.image && DIRECT_URL_BACKENDS.has(backendResolution(storageOverrides(flags)).backend);
}

export function imageEndsUpOnChain(flags: Flags, onchainImage: boolean): boolean {
  if (onchainImage) return true;
  const image = typeof flags.image === 'string' ? flags.image : undefined;
  if (!image) return false;
  try {
    const p = resolvePath(image);
    if (!statSync(p).isFile()) return false;
    // Only the head matters — looksLikeSvg tests the leading tag.
    return looksLikeSvg(readFileSync(p).subarray(0, 256).toString('utf8'));
  } catch {
    return false;
  }
}

/** A browser wallet reached through an open sign session, used as the Turbo (Arweave) upload
 *  identity so the wallet's own credits pay — `signMessage` returns the `0x` EIP-191 signature. */
export type RemoteEthUpload = {address: Address; signMessage: (message: Uint8Array) => Promise<string>};

export async function prepareContent(
  imagePath: string | undefined,
  clone: Address,
  overrides: StorageOverrides,
  store = true, // false for --dry-run: compute the hash but don't custody bytes
  onChain = false, // true (--onchain-uri): put the image ON-CHAIN (inline SVG) so it self-resolves
  remoteEth?: RemoteEthUpload, // wallet-lane Turbo uploads: sign+pay with the connected browser wallet
  walletAddr?: string, // the deployer wallet — checked for existing Turbo credits if the managed key is short
  gatewayFlags: Flags = {}, // the --ipfs-gateway/--arweave-gateway preference, so narration shows the SERVED url
): Promise<{tokenFields: OnChainFieldInput[]; contentNote: string}> {
  if (!imagePath) {
    // demo default = generative SVG. On-chain mode inlines it (self-resolving, no custody);
    // off-chain mode commits its keccak and regenerates/serves it.
    if (onChain) {
      return {
        tokenFields: [imageInlineField(generateContent(clone))],
        contentNote: 'content: generative SVG, INLINE on-chain (self-resolving, no custody)',
      };
    }
    return {
      tokenFields: [imageKeccakField(contentHash(clone))],
      contentNote: 'content: generative SVG from the contract address (demo default)',
    };
  }
  const path = resolvePath(imagePath);
  const bytes = new Uint8Array(readFileSync(path));
  const contentType = contentTypeFromPath(path);

  // On-chain mode can inline SVG directly (the renderer emits it as a data: URI). A raster can't be
  // inlined in v1. That used to mean "fall through to keccak custody and let the renderer show a
  // placeholder" — which quietly made the documented pattern-2 recipe (image off-chain, JSON
  // on-chain, no server) impossible for a 1/1 even though `deploy-series` did it fine. Now the 1/1
  // takes the same route the Series takes: upload to a durable, publicly-readable backend and bake
  // the resulting URL on-chain as the image field, so `tokenURI` resolves from the chain to a real
  // image with nothing to keep running. Only a backend that can hand out a public read URL
  // qualifies; `fs` (this machine only) still falls through to custody. `decideImageContentLane`
  // (the SDK's storage package — it's the one that knows which backends serve a public URL) makes
  // this call from local facts alone: the file's sniffed bytes + the resolved backend id.
  let onchainUrlLane = false;
  if (onChain) {
    const text = Buffer.from(bytes).toString('utf8');
    const decision = decideImageContentLane({onChain, isSvg: looksLikeSvg(text), backendId: backendResolution(overrides).backend});
    if (decision.lane === 'inline-svg') {
      return {
        tokenFields: [imageInlineField(text)],
        contentNote: `content: ${basename(path)} (${bytes.length} bytes SVG) INLINE on-chain`,
      };
    }
    onchainUrlLane = decision.lane === 'onchain-url';
    if (decision.onchainFallback) {
      warn(
        `--onchain-uri can't inline ${contentType} on-chain (v1 inlines SVG only), and '${backendResolution(overrides).backend}' can't serve a public URL — ` +
          `storing in custody, so the on-chain image will be a placeholder. Add ${bold('--backend arweave')} (or ipfs/cloud) to bake a real image URL, or ${bold('--onchain-image')} to put the bytes themselves on-chain.`,
      );
    }
  }

  const hash = hashContent(bytes);
  const opts = storageOptions(overrides); // flags override config/env
  // Wallet-lane Turbo: route uploads through the connected browser wallet (its ETH Turbo credits pay).
  if (remoteEth && opts.arweave) opts.arweave = {...opts.arweave, remoteEth, jwk: undefined, ethSignerKey: undefined};
  noteArweavePlan(opts, bytes.length); // free-vs-credit readout (Turbo) — shown for dry-run too
  if (!store) {
    const backendId = backendResolution(overrides).backend;
    if (onchainUrlLane) {
      return {
        tokenFields: [imageLocatorField(backendId, `<${backendId}-url>`)],
        contentNote: `content: ${basename(path)} (${bytes.length} bytes, ${contentType}) → would upload to ${backendId}; ${describeLocatorField(backendId)}`,
      };
    }
    return {
      tokenFields: [imageKeccakField(hash)],
      contentNote: `content: ${basename(path)} (${bytes.length} bytes, ${contentType}) · image keccak256 ${hash} (would be stored on deploy)`,
    };
  }
  ensureArweaveIdentityForUpload(opts); // create + announce the Turbo identity if this is its first upload
  // Balance guard for the local-identity Turbo lanes. Skip it for a remote wallet — checking balance
  // there needs the signer's pubkey (an extra personal_sign prompt); the upload itself surfaces any shortfall.
  if (!opts.arweave?.remoteEth) await assertTurboFundsForUpload(opts, [bytes.length], walletAddr);
  const backend = resolveBackend(opts);
  if (onchainUrlLane) {
    // One file, uploaded as a one-entry directory — the same call `deploy-series` uses for its
    // uniform-extension folder, so both commands produce the same URL shape from the same code path.
    // Named `0.<ext>` because a 1/1 is token 0. Falls back to custody if the backend turns out not to
    // support directories, rather than silently producing a token whose image never resolves.
    const ext = extname(path).toLowerCase() || '.bin';
    if (backend.putDirectory) {
      const {base} = await backend.putDirectory([{name: `0${ext}`, bytes, contentType}]);
      const url = `${base}/0${ext}`;
      // Keep the bytes under their hash too: `abx verify` can then still prove the served image
      // matches what was uploaded, even though the on-chain field addresses it by URL.
      await backend.put(hash, {bytes, contentType});
      const served = servedImageUrl(backend.id, url, gatewayFlags);
      ok(`image → ${served.url}  ${dim(`(${backend.id}; baked on-chain, no server)`)}`);
      if (served.note) info(dim(`  ${served.note}`));
      return {
        tokenFields: [imageLocatorField(backend.id, url)],
        contentNote: `content: ${basename(path)} (${bytes.length} bytes, ${contentType}) on ${backend.id} · ON-CHAIN image ${describeLocatorField(backend.id)}`,
      };
    }
    warn(`'${backend.id}' cannot upload a directory, so no public image URL could be baked — falling back to custody (the on-chain image will be a placeholder).`);
  }
  await backend.put(hash, {bytes, contentType});
  return {
    tokenFields: [imageKeccakField(hash)],
    contentNote: `content: stored ${basename(path)} (${bytes.length} bytes, ${contentType}) in '${backend.id}' custody · image keccak256 ${hash}`,
  };
}

/**
 * Real OpenSea traits supplied by the creator, from `--attributes <file.json>` (canonical array or
 * `{name: value}` map) and/or `--traits "Background=Blue; Edition=3"` (quick inline form). These are
 * the marketplace trait array — NOT a place for protocol facts. Empty when neither flag is given.
 */
export function parseDeployTraits(flags: Flags): OpenSeaAttribute[] {
  const out: OpenSeaAttribute[] = [];
  if (flags.attributes) {
    const raw = readFileSync(resolvePath(process.cwd(), flags.attributes), 'utf8');
    out.push(...normalizeAttributes(JSON.parse(raw)));
  }
  if (flags.traits) out.push(...parseTraitPairs(flags.traits));
  return out;
}

/** Encode creator traits as the on-chain `attributes` field (inline JSON bytes) — for `--traits-onchain`. */
export const attributesInlineField = (attrs: OpenSeaAttribute[]): OnChainFieldInput => ({
  field: encodeTag(F.attributes),
  representation: encodeTag(R.inline),
  value: toHex(JSON.stringify(attrs)),
});

/**
 * Warn when IPFS/Arweave custody is pointed at a LOCAL gateway.
 *
 * Two distinct problems ride on one flag, and the warning names the one that actually applies. The
 * bytes are pinned only to a node on this machine, so nothing off it can retrieve them — that is the
 * real damage and it survives any later `set-gateway`. It ALSO used to weld that localhost host into
 * the on-chain value; since the field holds a bare CID it no longer does (the serving prefix is the
 * collection's preference), so promising "the served URL resolves only on THIS machine" would now be
 * false and would point the creator at the wrong repair.
 */
export function localGatewayWarning(flags: Flags): string | null {
  const opts = storageOptions(storageOverrides(flags));
  const gateway = opts.backend === 'ipfs' ? opts.ipfs?.gateway : opts.backend === 'arweave' ? opts.arweave?.gateway : undefined;
  if (gateway && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(gateway)) {
    return (
      `${opts.backend} gateway is ${gateway} — a LOCAL gateway, so the bytes would be pinned only to a node on THIS ` +
      `machine and nobody else could retrieve them. The on-chain field holds the bare content id (a gateway change is ` +
      `later just ${bold('abx set-gateway')}), but no gateway can serve content that was never pinned publicly. Pin to a ` +
      `service with a PUBLIC gateway (e.g. a Pinata dedicated gateway) via --gateway https://… or ABX_IPFS_GATEWAY.`
    );
  }
  return null;
}

/** A readout line for an optional creator text field — states exactly what's written (and where),
 *  or that NOTHING is, so the deploy never silently invents one. */
export function describeDeployField(label: string, value: string | undefined, onchain: boolean): string {
  if (value) return `${label} "${value}"  ${dim(onchain ? '(on-chain, inline)' : '(off-chain operator metadata)')}`;
  return `${label}: ${dim(`none — none is written (pass --${label} to set it)`)}`;
}

/** Readout lines for whichever authorship/rights fields a deploy will write (always on-chain,
 *  inline collection fields). Empty when none are set — so the readout stays quiet by default. */
export function authorshipReadout(flags: Flags): string[] {
  return AUTHORSHIP_DEPLOY_FIELDS.filter(([flag]) => flags[flag]).map(([flag]) => describeDeployField(flag, flags[flag], true));
}

/** A readout line for creator traits — the exact traits written (and where), or that none are. */
export function describeTraits(traits: OpenSeaAttribute[], onchain: boolean): string {
  if (!traits.length) return `traits: ${dim('none — none is written (add --traits "Key=Value" or --attributes file.json)')}`;
  const list = traits.map((t) => `${t.trait_type}=${t.value}`).join(', ');
  return `traits: ${list}  ${dim(onchain ? '(on-chain, inline JSON)' : '(off-chain operator metadata)')}`;
}

// ── deploy (+ optionally serve) ──────────────────────────────────────────────
export async function cmdDeploy(flags: Flags, serveAfter: boolean) {
  // `--copies <N|open>` routes to the ERC-1155 edition twin (OneOfOneEdition) — the flagship
  // edition product: a priced open/limited edition of ONE work. Checked before anything else
  // touches `flags`, so the 721 lane (`cmdDeployBody`) below is reached ONLY when `--copies` is
  // absent, and is otherwise untouched by this feature — byte-identical to before editions shipped.
  if (flags.copies !== undefined) {
    if (serveAfter) {
      throw new Error(
        '`abx demo` has no --copies — demo is the zero-argument 721 1/1 walkthrough. Deploy an edition directly: ' +
          '`abx deploy --copies <n|open> [--image <path>] --name "…" --symbol …` (see `abx help deploy`).',
      );
    }
    return withJson(flags, async (emit) => cmdDeployOneOfOneEditionBody(flags, emit));
  }
  // `--json`: the deployed address is the value a program came for. Narration goes to stderr,
  // so `ADDR=$(abx deploy … --json | jq -r .address)` works without parsing a success banner.
  return withJson(flags, async (emit) => cmdDeployBody(flags, serveAfter, emit));
}

export async function cmdDeployBody(flags: Flags, serveAfter: boolean, emit: (p: Record<string, unknown>) => void) {
  beginPlanWarnings(); // see the collector's own module note, above the DIMENSIONS block
  refuseStrayFlags(flags, DEPLOY_FLAGS, 'deploy');
  warnSignWithoutFor(flags);
  const dimension = resolveDimension(flags.type ?? '1of1');
  // A multi-token collection is its OWN command; `abx deploy` is the single-token (1/1) path.
  // Redirect instead of silently deploying a 1/1 when someone reaches for `--type series`.
  if (dimension === 'series') {
    throw new Error(
      'A multi-token Series is a separate command — use `abx deploy-series --dir <media-dir> …` ' +
        '(not `abx deploy --type series`). Run `abx help deploy-series` for its flags.',
    );
  }
  const name = flags.name ?? 'ABX Self-Host Demo';
  const symbol = flags.symbol ?? 'ABXSH';
  // Validate against the CONTRACT's cap here, not just in `set-royalty`: a bare Number() accepted
  // 1500, printed "royalty 15%" in the confirmation readout, and then lost the whole deploy to a
  // RoyaltyTooHigh() revert — the expensive tx, and one the creator had already approved.
  const royaltyBps = flags['royalty-bps'] === undefined ? 500 : parseRoyaltyBps(String(flags['royalty-bps']));
  // Owner-set royalty ceiling (bps, up to 100%), reduce-only after deploy. Defaults to 10%,
  // auto-raised to fit a higher --royalty-bps so a plausible input never errors; --royalty-cap overrides.
  const maxRoyaltyBps = flags['royalty-cap'] === undefined
    ? Math.max(1000, royaltyBps)
    : parseRoyaltyBps(String(flags['royalty-cap']));
  if (royaltyBps > maxRoyaltyBps) {
    throw new Error(`--royalty-bps ${royaltyBps / 100}% exceeds --royalty-cap ${maxRoyaltyBps / 100}%; raise the cap or lower the royalty.`);
  }
  const burnable = flags.burnable === '' || flags.burnable === 'true';
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = flags['public-base-url'] ?? resolveBaseUrl(port);
  // Creator traits (real OpenSea attributes). Off-chain operator metadata by default (cheap,
  // editable later via `abx add --traits`); `--traits-onchain` inlines them on-chain (durable,
  // lockable) — mirrors the description model. On-chain wins if both ever set the same trait.
  const traits = parseDeployTraits(flags);

  console.log(
    serveAfter
      ? bold(`\n  ABX · your first token\n  ${dim("we'll put your work on a blockchain — then delete our copy and get all of it back")}`)
      : bold(`\n  ABX Self-Host Toolkit — deploy\n  ${dim('a project, served from chain alone')}`),
  );

  // Signing lane. `demo` used to hard-force the hot lane, which SILENTLY dropped `--sign`: with no
  // env key it died confusingly, and WITH one it signed from that key while the operator had asked
  // for their browser wallet — a signing choke point that ignored the lane it was handed. The demo
  // deploy is a single tx, so the wallet lane works here exactly as it does for `deploy`.
  const lane = laneFromFlags(flags);
  // The cold lane only PRINTS a tx; demo's whole point is to index + serve what it just deployed,
  // and there is nothing to index until someone broadcasts. Refuse the combo instead of doing
  // half the job — `abx deploy --unsigned` is the command for that lane.
  if (serveAfter && lane === 'unsigned') {
    throw new Error(
      '`abx demo --unsigned` can\'t work: the cold lane only prints a transaction, and the demo ' +
        'indexes + serves the contract it just deployed. Use `abx demo` (hot key) or `abx demo --sign` ' +
        '(browser wallet) — or `abx deploy --unsigned` if you only want the raw tx.',
    );
  }
  // Same shape for --dry-run: previewing sends nothing, so there is nothing to serve.
  if (serveAfter && isDryRun(flags)) {
    throw new Error(
      '`abx demo --dry-run` can\'t work: a dry run sends nothing, and the demo indexes + serves what ' +
        'it deployed. Use `abx deploy --dry-run` to preview a 1/1 deploy without sending.',
    );
  }
  // Port preflight BEFORE anything irreversible. The demo ends by serving, and `listen` used to be
  // the first thing to discover the port was taken — after the deploy tx had already been signed and
  // paid for, so a second `abx demo` (a very normal thing to try) spent gas and then died with a raw
  // Node EADDRINUSE stack trace. Check first, and name the fix.
  if (serveAfter) {
    const wanted = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
    if (await portInUse(wanted)) {
      throw new Error(
        `port ${wanted} is already in use — probably an \`abx demo\`/\`abx serve\` still running in another terminal.\n` +
          `  Nothing was deployed. Stop that one (Ctrl-C), or run this on another port: \`abx demo --port ${wanted + 1}\`.`,
      );
    }
  }
  // (demo keeps its own message: "Nothing was deployed" is the load-bearing part here, and it must
  // be true — this check runs before anything irreversible. assertPortFree covers serve/preview.)
  const dryRun = !serveAfter && isDryRun(flags); // preview only — no send, no custody, no factory deploy
  // A keyless preview needs `--for` (the address is a pure function of factory+salt+deployer). Check
  // it HERE, before the trust-anchor/content/plan steps print — hitting this after a wall of output
  // reads as "it half-worked", and a first-timer previewing with no key in .env always hits it.
  if (dryRun) assertPreviewDeployer(flags);
  const publicClient = makePublicClient({chainKey: CHAIN});
  // Verify the RPC really is CHAIN before any send (factory/renderer/staging/deploy). A dry run
  // sends nothing, but it DOES read the chain (predict address, resolve the factory/renderer), so
  // a wrong-network RPC must still be caught with the clear mismatch message rather than failing
  // opaquely inside predict; `allowUnreachable` keeps a genuinely offline dry-run previewable.
  await assertChainId(CHAIN, {allowUnreachable: dryRun});

  // --721c (opt-in ERC-721C): absent → zeroAddress, a plain ERC-721 exactly as before.
  const transferValidator = await resolveTransferValidatorFlag(flags, publicClient, dryRun);

  // `demo` is exempt: its whole job is a zero-argument first token.
  if (!serveAfter) assertRealIdentity(flags, {name, symbol, dryRun});

  // Funding preflight (real deploys): warn now if the signer is unfunded, not at the tx.
  if (!dryRun) {
    let signer = flags.for as Address | undefined;
    if (!signer && lane === 'send') {
      try { signer = makeWalletClient({chainKey: CHAIN}).account.address; } catch { /* no key yet — later steps handle it */ }
    }
    if (signer) await warnUnfunded(publicClient, signer);
  }

  // `deploy` surfaces the trust anchor as a step; the demo does NOT. It briefly opened on "only this
  // factory can make a token that IS an ABX token", which is simply false — anything that follows the
  // protocol's event spine is an ABX token, and the factory is one way to get there, not the
  // definition of the thing. Rather than restate it more carefully, the demo skips it: a first-timer
  // does not need a provenance lecture before they have made anything.
  if (!serveAfter) step('Trust anchor');
  let factory: Address;
  if (dryRun) {
    const existing = factoryAddress(flags.factory);
    if (!existing) {
      info('no canonical factory for this chain yet — a real deploy would deploy the trust anchor first.');
      console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
      return;
    }
    factory = existing as Address;
    if (!(await previewFactoryLive(publicClient, factory, 'factory'))) return;
    info(`would reuse canonical factory ${factory}`);
  } else {
    factory = await ensureFactory(flags.factory, !!flags['bootstrap-factory'], serveAfter);
  }

  // --onchain-uri: resolve tokenURI/contractURI fully on-chain via the canonical renderer
  // (the JSON is assembled from on-chain fields → no resolver needed, ever). The off-chain
  // URLs are still baked as a fallback if the renderer is later cleared.
  // --onchain-image: stage the --image bytes on-chain (chunk store, ownerless) and bake a
  // `reader` field into the deploy — so large on-chain content needs NO post-deploy tx. It
  // implies on-chain URI resolution (the renderer emits the reader-backed image).
  // A fully on-chain token self-resolves via the renderer; the stored off-chain pointer is
  // never read while a renderer is set. So bake a real URL only if one was explicitly given —
  // otherwise leave it EMPTY rather than baking a misleading localhost into the contract.
  const hasPublicUrl = !!(flags['public-base-url'] || process.env.ABX_PUBLIC_BASE_URL);
  const onchainImage = !!flags['onchain-image'];
  // `abx demo` defaults to FULLY ON-CHAIN. Its default content is a generative SVG, which the renderer
  // can inline — so the token self-resolves and, crucially, NO localhost gets baked into the
  // contract as the tokenURI base. The old default shipped a first-ever token that resolved for
  // nobody but its author (broken on every marketplace, dead the moment `abx serve` stops) and
  // taught that as the normal shape of an NFT. It also undercut the demo's own claim: with the content
  // on-chain, "rebuilt from the chain alone" now covers the IMAGE, not just the metadata.
  //
  // Opting back into off-chain custody is anything that says "I have somewhere to host": a real base
  // URL, an explicit --backend, or a RASTER --image. An SVG --image still goes on-chain — inlining is
  // exactly what the renderer supports (v1 is SVG-only), so there's no reason to send someone's own
  // vector content down the localhost path. Raster stays off-chain because forcing it on-chain would
  // silently inline a placeholder instead of their image.
  const demoImageInlineable = !flags.image || contentTypeFromPath(flags.image) === 'image/svg+xml';
  const demoDefaultsOnChain = serveAfter && demoImageInlineable && !flags.backend && !hasPublicUrl;
  const onChainUri = !!flags['onchain-uri'] || onchainImage || demoDefaultsOnChain;
  // On-chain traits when explicitly asked, or implied by --onchain-uri (the renderer can only
  // emit on-chain fields, so off-chain-only traits would be invisible there). Else off-chain.
  const traitsOnchain = traits.length > 0 && (!!flags['traits-onchain'] || onChainUri);
  let renderer: Address = zeroAddress;
  if (onChainUri) {
    step(serveAfter ? 'What will answer when someone asks about your token' : 'On-chain renderer');
    if (dryRun) {
      renderer = (rendererAddress(flags.renderer) as Address) ?? zeroAddress;
      info(renderer === zeroAddress ? 'would deploy the canonical renderer first' : `would use renderer ${renderer}`);
    } else {
      renderer = await ensureRenderer(flags.renderer);
    }
    // A first-timer has no idea what a "renderer" is, and the word suggests something that draws
    // pictures. What it actually does is assemble the JSON a marketplace asks for, on-chain, out of
    // the fields your contract holds — worth one plain sentence, since it's why no server is needed.
    if (serveAfter) {
      info(dim('a marketplace asks your contract a question; this shared contract composes the answer'));
      info(dim('already deployed, used by every ABX token, owned by no one — you are not paying to set it up'));
    }
  }

  step(serveAfter ? `Mint it · one transaction on ${CHAIN}` : `Deploy a ${DIMENSIONS[dimension].label} (--type ${dimension}) to ${CHAIN}`);
  // What the chain ends up holding is the single most useful thing to understand about an ABX token,
  // and it's invisible unless someone says it out loud. Two honest versions, because the answer is
  // genuinely different per lane. Demo only — `deploy` prints the same facts per-field.
  if (serveAfter && onChainUri) {
    console.log(`    Your work goes ${bold('INTO')} the contract. Not a link to it — the image itself.`);
    console.log(`    ${g('✦')} the chain will hold   ${dim('your work · your name on it · your royalty · you as owner')}`);
    console.log(`    ${g('✦')} you will need         ${dim('nothing else. no server, no IPFS pin, no monthly bill to forget')}`);
  } else if (serveAfter) {
    console.log(`    ${g('✦')} the chain will hold   ${dim('your name · your royalty · you as owner · a fingerprint of the work')}`);
    console.log(`    ${g('✦')} this computer holds   ${dim('the image bytes themselves')}`);
    info(dim('the chain proves the bytes are unaltered; it does not store them (that fingerprint is a keccak256 hash)'));
  }

  // Off-chain custody (no renderer) bakes the resolver URL straight into the on-chain
  // tokenURI/contractURI at deploy. A localhost / loopback URL there resolves for NO ONE —
  // not marketplaces, not wallets, not even your own browser unless `abx serve` is running —
  // so it is a broken NFT by construction. There is no "throwaway testnet" exception: we
  // refuse to bake it, full stop, and point at the two paths that actually work. (Not a
  // concern with --onchain-uri: the renderer is authoritative and resolves from chain.)
  // ABX_DEV_ALLOW_LOCALHOST_URI=1 is a DEV/TEST-ONLY escape (the e2e harness) — never a user path.
  if (!serveAfter && !onChainUri) {
    const loopback = loopbackBaseUrl(baseUrl);
    if (!hasPublicUrl || loopback) {
      const devAllow = process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1';
      const msg =
        `Off-chain metadata needs a PUBLIC resolver URL baked on-chain — ${hasPublicUrl ? baseUrl : 'localhost'} resolves for no one ` +
        `(not marketplaces, not wallets, not even your own browser unless \`abx serve\` is running). Pick a real path:\n` +
        `    • Fully on-chain, no host:  --onchain-image --compress fastlz     (best for small static content)\n` +
        `    • Hosted resolver:          --public-base-url https://your.domain (or set ABX_PUBLIC_BASE_URL)`;
      if (!devAllow) {
        if (dryRun) warn(`would REFUSE to deploy — ${msg}`);
        else throw new Error(msg);
      } else {
        warn(`DEV ONLY (ABX_DEV_ALLOW_LOCALHOST_URI): baking ${bold(baseUrl)} on-chain — resolves only on THIS machine; not a real NFT.`);
      }
    }
  }
  if (onChainUri && serveAfter) {
    // The demo's version of the same fact, in words a first-timer can act on. Naming what we are
    // NOT doing matters here: a localhost URL written into a contract is the single most common way
    // a first NFT ends up permanently broken, and the demo used to model exactly that.
    info(dim('nothing points at this computer — no http://localhost anywhere in your contract.'));
    info(dim('anyone can read your token from the chain, forever, with you offline.'));
  } else if (onChainUri) {
    info('tokenURI/contractURI resolve ON-CHAIN via the renderer — no resolver, no server, no localhost.');
    if (!hasPublicUrl) info('off-chain fallback pointer left empty (the renderer is authoritative); set --public-base-url to bake one anyway.');
  }
  // `--onchain-uri` puts the tokenURI JSON on-chain; it does NOT put the IMAGE on-chain. Without
  // `--onchain-image` the image is committed as a keccak256 anchor, which the on-chain renderer
  // cannot serve bytes for — so `tokenURI` returns a PLACEHOLDER image. Say that here, before the
  // spend (this runs in `--dry-run` too), because the success banner used to claim "fully on-chain,
  // no hosting needed" for exactly this config and a creator would believe they had permanence they
  // don't. The code lane's dry run already warns about this case; the 1/1 lane shipped it silently.
  if (onChainUri && !imageResolvesWithoutServer(flags, onchainImage)) {
    warn(
      `${bold('--onchain-uri puts the metadata JSON on-chain, not the image.')} With '${backendResolution(storageOverrides(flags)).backend}' custody the image is only ` +
        `a keccak256 anchor, so ${bold('tokenURI')} will serve a PLACEHOLDER — nothing can fetch the bytes.`,
    );
    info(`two ways to get a real image with no server: ${bold('--backend arweave')} (or ipfs/cloud) uploads it and bakes the URL on-chain, or ${bold('--onchain-image --compress fastlz')} puts the bytes themselves on-chain (best under ~24KB).`);
  } else if (onChainUri && !imageEndsUpOnChain(flags, onchainImage)) {
    // Resolves, durably, with no server — but the IMAGE is not on-chain, and that distinction is
    // exactly what a creator asking for permanence is buying. Say which one they are getting.
    info(
      `${bold('image off-chain, JSON on-chain')} — the image uploads to ${bold(backendResolution(storageOverrides(flags)).backend)} and its URL is baked into the on-chain metadata. ` +
        `No server to run; permanence is the backend's (Arweave is pay-once-forever, IPFS lasts as long as it stays pinned). For the image itself on-chain, use ${bold('--onchain-image')}.`,
    );
  }
  // IPFS/Arweave custody serves the image from the gateway URL. A LOCAL gateway produces an image
  // URL only this machine can load — the image equivalent of the localhost-tokenURI footgun above.
  if (!onChainUri && !onchainImage) {
    const sr = backendResolution(storageOverrides(flags));
    info(`storage: ${sr.backend} ${dim(`(${sr.source === 'flag' ? '--backend' : sr.source === 'env' ? 'env' : 'default'})`)} — byte custody for the image`);
    const gwWarn = localGatewayWarning(flags);
    if (gwWarn) warn(gwWarn);
  }

  // Stage on-chain content ONCE (it's deployer-independent — the chunk-store manifest
  // doesn't depend on the clone address) and bake it as a `reader` field below. Ownerless
  // staging tx(s) via the env key; the deploy then references the manifest. Skipped on a
  // dry run (no bytes written) — we note that a real deploy would stage it.
  let bakedImage: OnChainFieldInput | undefined;
  if (onchainImage) {
    if (!flags.image) throw new Error('--onchain-image needs --image <path> (the bytes to put on-chain)');
    // On-chain staging is a SEQUENCE (chunk write(s) → the deploy that references the manifest)
    // where each tx's receipt feeds the next, so it can't be signed offline in one run.
    if (lane === 'unsigned') {
      throw new Error(
        'Staging an on-chain image (--onchain-image) needs interactive signing — each chunk tx feeds ' +
          "the next, so it can't run on the cold lane (--unsigned). Use the hot lane (a funded key) or --sign (browser wallet).",
      );
    }
    step('Stage on-chain image');
    if (dryRun) {
      info(await previewImageStaging(flags.image, parseCompress(flags.compress)));
    } else if (lane === 'send') {
      // hot lane: the env key stages now (deployer-independent — the manifest doesn't depend
      // on the clone address), then the deploy below bakes in the reader field.
      const {field, note} = await stageImageField(flags.image, parseCompress(flags.compress), envStagingSender());
      bakedImage = field;
      info(note);
    } else {
      // wallet lane: the staging tx(s) are signed by the connecting wallet, so they're deferred
      // into the sign session below (one connect, then approve each step) and baked there.
      info('image will be staged on-chain in your wallet (one connect, then approve each step), then baked into the deploy.');
    }
  }

  // Wallet-signature count for THIS deploy — the same chunk math that sizes the wallet-lane
  // session `total` below, computed once so the preview/confirm text and the real session can
  // never disagree. Counts TX signatures only: a storage upload signed by a connected wallet
  // (Arweave via --storage-signer eth) is a message signature, not a transaction, and is already
  // named separately (see the `remoteEthUpload` narration) — it does not add to this count.
  // Also captures the plan object's `custody.image` file metadata: the SAME
  // bytes read here for the tx-count math, hashed/typed locally (no chain read) — never re-derived
  // at the emit site below.
  let planImageFile: DeployPlanImageFile | null = null;
  const approvals = onchainImage
    ? (() => {
        const bytes = readFileSync(resolvePath(flags.image as string));
        const compress = parseCompress(flags.compress);
        const contentPlan = computeContentPlan(bytes, compress);
        planImageFile = {
          bytes: bytes.length,
          stagedBytes: contentPlan.stagedBytes,
          mimeType: contentTypeFromPath(resolvePath(flags.image as string)),
          contentHash: hashContent(bytes),
        };
        return (contentPlan.plan.mode === 'single' ? 1 : contentPlan.plan.txCount) + 1; // staging tx(s) + the deploy tx
      })()
    : 1;

  // Mint-on-deploy is the default; --no-mint defers it so you can stand up + warm
  // the resolver at the (known) address first, then `abx mint`. The demo always mints.
  const noMint = !serveAfter && (flags['no-mint'] === 'true' || flags['no-mint'] === '');
  const explicitSalt = parseSaltFlag(flags.salt);

  // Wallet-lane Arweave uploads paid by the connecting wallet's Turbo credits (`--storage-signer eth`
  // + `--sign`). When set (after connect), buildForDeployer routes uploads through it.
  let uploadRemoteEth: RemoteEthUpload | undefined;
  const remoteEthUpload =
    lane === 'sign' &&
    !onchainImage &&
    storageSignerChoice(storageOverrides(flags)) === 'eth' &&
    isTurboArweave(storageOptions(storageOverrides(flags)));

  // Build the init params for a given deployer. The clone address is deterministic
  // in (factory, salt) — independent of the signer — so the on-chain URIs are baked
  // to point at this node before the tx is signed. owner + royalty receiver are the
  // deployer; mintTo is the deployer (or 0 when --no-mint). A per-deployer salt
  // (`saltFor`) reserves the address to that signer (front-run-proof) unless an
  // explicit --salt is given. With the wallet lane the signer is unknown until they
  // connect, so this runs per-signer.
  const buildForDeployer = async (deployer: Address) => {
    assertLaneCanSign(flags); // no upload before we know this run can be signed — see `assertLaneCanSign`
    const salt = explicitSalt ?? saltFor(deployer);
    const clone = await predictClone(publicClient, {factory, salt});
    // A baked on-chain image (--onchain-image) replaces prepareContent's image field —
    // the bytes already live on-chain behind the reader, nothing to custody or hash. On a
    // dry run staging is skipped (bakedImage undefined), so don't fall through to the inline
    // path — that would mislabel a reader deploy as INLINE. Note the reader path instead.
    const {tokenFields, contentNote} = bakedImage
      ? {tokenFields: [bakedImage], contentNote: 'content: image staged ON-CHAIN via reader (self-resolving, no custody)'}
      : onchainImage
        ? {tokenFields: [] as OnChainFieldInput[], contentNote: 'content: image would be staged ON-CHAIN via reader (chunk store) — dry run skips the staging write'}
        : await prepareContent(flags.image, clone, storageOverrides(flags), !dryRun, onChainUri, uploadRemoteEth, deployer, flags);
    // Put the description ON-CHAIN (inline) when asked, or always under --onchain-uri
    // (the on-chain renderer can only emit on-chain fields, so an off-chain-only
    // description would simply be omitted). On-chain wins at resolve either way.
    if (flags.description && (onChainUri || flags['description-onchain'])) {
      tokenFields.push({field: encodeTag(F.description), representation: encodeTag(R.inline), value: toHex(flags.description)});
    }
    // Creator traits on-chain (inline JSON) when --traits-onchain / --onchain-uri; off-chain
    // traits ride in the registration instead (added after deploy, below).
    if (traitsOnchain) tokenFields.push(attributesInlineField(traits));
    // Off-chain resolution bakes only the resolver BASE (incl. the route prefix); the
    // contract derives each pointer on-chain as {base}/{chainId}/{address}/{tokenId}. So we
    // never bake an address or tokenId into a string — the contract owns the grammar.
    const params = {
      owner: deployer,
      mintTo: noMint ? zeroAddress : deployer,
      name,
      symbol,
      tokenURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/t`,
      tokenURIRenderer: renderer,
      contractURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/c`,
      contractURIRenderer: renderer,
      royaltyReceiver: deployer,
      royaltyBps,
      maxRoyaltyBps,
      burnable,
      transferValidator,
      tokenFields,
      // authorship + rights (creator / license / …) are collection-scope on-chain fields.
      contractFields: [...authorshipContractFields(flags), ...gatewayContractFields(flags)],
    };
    return {clone, params, salt, contentNote};
  };

  let clone: Address;
  let blockNumber: bigint;
  // The eventual owner/signer — set in whichever lane branch below learns it, so the SENT plan
  // object (further down) can report `roles` without re-deriving anything. `undefined` only while
  // no branch has run yet; every path that reaches the sent `emit()` has set it by then.
  let deployerAddr: Address | undefined;

  if (dryRun) {
    let deployer: Address;
    if (flags.for) deployer = flags.for as Address;
    else {
      try {
        deployer = makeWalletClient({chainKey: CHAIN}).account.address;
      } catch {
        throw new Error(
          'dry run needs a deployer address to compute the deterministic deploy address — pass --for 0x.. ' +
            '(a preview signs nothing, so no key is needed). For the REAL deploy with no key in .env, use the ' +
            'wallet lane: --sign --for 0x.. (you approve in your own wallet).',
        );
      }
    }
    const {clone: predicted, params, salt, contentNote} = await buildForDeployer(deployer);
    info(`deployer ${deployer}`);
    await warnUnfunded(publicClient, deployer); // advisory: fund this before the real deploy
    // The address is a pure function of (factory, salt), and without --salt this salt was just
    // freshly randomly reserved (saltFor mixes in entropy) — a plain re-run gets a DIFFERENT one, so
    // the address below is real for THIS preview but not reproducible by habit. Rather than print an
    // address that quietly stops being true, print it ONLY when --salt pinned it (below, unchanged);
    // otherwise the salt itself is the thing to act on — see the block after the readout.
    if (explicitSalt) info(`deterministic address: ${predicted}`);
    info(`name    "${name}"${flags.name ? '' : dim('  (default — pass --name)')}`);
    info(`symbol  ${symbol}${flags.symbol ? '' : dim('  (default — pass --symbol)')}`);
    info(describeDeployField('description', flags.description, onChainUri || !!flags['description-onchain']));
    authorshipReadout(flags).forEach((line) => info(line));
    info(describeTraits(traits, traitsOnchain));
    info(`royalty ${royaltyBps / 100}% → ${deployer}${flags['royalty-bps'] ? '' : dim('  (default 5%)')}`);
    info(`royalty cap ${maxRoyaltyBps / 100}%${flags['royalty-cap'] !== undefined ? '' : maxRoyaltyBps > 1000 ? dim('  (auto-raised to fit the royalty)') : dim('  (default 10%)')} ${dim('— reduce-only ceiling; lower later with `abx set-royalty-cap`')}`);
    info(`burnable ${burnable ? `yes ${dim('— holders may burn their own token')}` : `no ${dim('(no token can be destroyed)')}`}`);
    info(contentNote);
    info(`tokenURI base   ${params.tokenURIBase || dim('(empty — resolves on-chain via the renderer)')}`);
    // Same reasoning as above: this line derives token #0's URL from `predicted`, so it's only an
    // honest thing to print when that address is actually pinned.
    if (params.tokenURIBase && explicitSalt) {
      info(dim(`  ↳ token #0 resolves to ${params.tokenURIBase}/${resolveChain(CHAIN).id}/${predicted.toLowerCase()}/0 (derived on-chain)`));
    }
    info(`contractURI base ${params.contractURIBase || dim('(empty — resolves on-chain via the renderer)')}`);
    info(noMint ? 'mint: deferred (--no-mint)' : `mint: token #0 → ${deployer} at deploy`);
    info(`approvals   ${approvals} wallet approval(s)`); // TX signatures only; storage uploads are named separately above
    if (!explicitSalt) {
      // Enforce, don't warn: with no predicted address to anchor on, print the one thing that
      // DOES stay true: the salt itself, pinned via --salt (or `abx predict`) reproduces this exact
      // address on the real deploy.
      console.log(`\n  ${bold('salt')}  ${g(salt)}`);
      info(`address: pinned by salt — re-run with ${bold(`--salt ${salt}`)} (same address), or ${bold(`abx predict --salt ${salt} --for ${deployer}`)}.`);
      info(`reproduce this exact preview (salt included): ${bold(deployCommandLine(flags, salt))}`);
    }
    // The whole point of the readout: it is the contract. The real deploy writes EXACTLY these
    // values — nothing is added, inferred, or substituted between here and the on-chain tx.
    info(dim('the values above are exactly what a real deploy writes — nothing else is added.'));
    console.log(`\n  ${g('dry run')} ${dim('— nothing sent, no bytes stored. Re-run without --dry-run to deploy.')}\n`);
    // A dry run DOES know the address when --salt pinned it (a pure function of factory+salt); without
    // --salt it's null — reporting the freshly-reserved one would be a real-looking value a script
    // could act on that the actual deploy will not land at. `saltPinned` still says why.
    emit(jsonSafe({
      command: 'deploy', dryRun: true, sent: false, address: explicitSalt ? predicted : null, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, salt, saltPinned: !!explicitSalt, name, symbol,
      // The structured plan — built from the SAME locals the readout above just
      // printed; nothing here is re-derived or newly computed. `deployer` is a real wallet address
      // regardless of salt pinning (only the PREDICTED CONTRACT address carries that caveat, and
      // this plan doesn't repeat it — see `address`, above), so roles are safe to report unconditionally.
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: '1of1' satisfies DeployPlanFamily,
        lane,
        transactions: {approvals, legs: onchainImage ? ['onchain-image-staging', 'deploy'] : null},
        // The 1/1 lane's InitParams has no minter/primaryPayee field at all — `null` here means
        // "no concept on this lane", not "unset".
        roles: {signer: deployer, owner: deployer, royaltyReceiver: deployer, primaryPayee: null, minter: null},
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          imageOnChain: onchainImage,
          backend: !onChainUri && !onchainImage ? backendResolution(storageOverrides(flags)).backend : null,
          // `''` (on-chain lane, no explicit --public-base-url) is reported as `null` here — the
          // human line already spells out WHY (renderer-authoritative); a JSON consumer just needs
          // "nothing baked", not an empty string to interpret.
          tokenUriBase: params.tokenURIBase || null,
          contractUriBase: params.contractURIBase || null,
          renderer: onChainUri ? renderer : null,
          image: planImageFile,
        },
        mint: {deferred: noMint, count: noMint ? 0 : 1, amountPerId: null, recipient: noMint ? null : deployer},
        estimate: {ethApprox: null, gasApprox: null}, // the 1/1 lane computes no cost estimate
        warnings: planWarnings.slice(),
        surfaces: null, // the code lanes' per-surface disposition has no equivalent here
        dependencies: null, // the 1/1 lane has no dependency-registry concept
        resume: null,
      } satisfies DeployPlan,
    }));
    return;
  }

  // opt-in --confirm: a final y/N before the real send (no-op without --confirm; never blocks scripts)
  await confirmSend(
    `About to deploy 1/1 "${name}" (${symbol})${flags.image ? ' with your image' : ' (generative demo content)'}; mint: ${noMint ? 'deferred' : 'token #0 at deploy'}; approvals: ${approvals} wallet approval(s); owner+royalty: your wallet @ ${royaltyBps / 100}%.` +
      (transferValidator !== zeroAddress ? ` ERC-721C: enrolled at deploy, permanently (validator ${transferValidator}).` : ''),
    flags,
  );

  if (lane === 'send') {
    // hot lane: the env key is the deployer, known up front.
    const {wallet, account} = makeWalletClient({chainKey: CHAIN});
    deployerAddr = account.address;
    const {clone: predicted, params, salt, contentNote} = await buildForDeployer(account.address);
    info(`deterministic address: ${predicted}`);
    info(describeDeployField('description', flags.description, onChainUri || !!flags['description-onchain']));
    authorshipReadout(flags).forEach((line) => info(line));
    info(describeTraits(traits, traitsOnchain));
    info(contentNote);
    info(`committing tokenURI base   ${params.tokenURIBase || dim('(empty — on-chain renderer)')}`);
    info(`committing contractURI base ${params.contractURIBase || dim('(empty — on-chain renderer)')}`);
    info(noMint ? 'mint: deferred — no token minted at deploy (mint later with `abx mint`)' : `mint: token #0 → ${account.address} at deploy`);
    const send = makeHotSender({wallet, account, publicClient});
    const r = await deployOneOfOne(send, publicClient, {factory, params, salt});
    clone = predicted;
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
    info(`on-chain content commitment: keccak256 of the served image`);
  } else if (lane === 'sign' && onchainImage) {
    // wallet lane + on-chain staging: ONE sign session signs every chunk write AND the deploy.
    // The connecting wallet pays for (and is the deployer of) all of it — staging can't precede
    // the connect here, so it happens inside the session, then the deploy bakes in the manifest.
    // --onchain-image implies on-chain resolution, so NOTHING points at baseUrl — saying it did was
    // a flat contradiction of the line above it (and reintroduced the localhost the lane exists to avoid).
    info('a wallet will become the owner; the token resolves from chain — no URI base is baked in.');
    const session = await openWalletSession({
      chainKey: CHAIN,
      // The wallet that connects BECOMES the owner/mintTo. Pin it to the address this deploy
      // was prepared/previewed for (--for) so a different connected wallet can't silently
      // become the owner — the page + server both refuse a mismatched signer.
      expectedSigner: flags.for as Address | undefined,
      total: approvals, // the same staging-tx math the preview's `approvals` line reports
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    let r: {txHash: Hex; blockNumber: bigint};
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      // Stage on-chain through the session (sets bakedImage, which buildForDeployer reads below).
      const {field, note} = await stageImageField(flags.image as string, parseCompress(flags.compress), sessionStagingSender(session));
      bakedImage = field;
      info(note);
      const {clone: predicted, params, salt, contentNote} = await buildForDeployer(signer);
      info(contentNote);
      info(noMint ? 'mint: deferred — mint later with `abx mint`' : `mint: token #0 → ${signer} at deploy`);
      const sent = await session.send(prepareDeployOneOfOne({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted}));
      r = {txHash: sent.txHash, blockNumber: sent.receipt.blockNumber};
      clone = predicted;
    } finally {
      session.close();
    }
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else if (lane === 'sign' && remoteEthUpload) {
    // wallet lane + Arweave uploads paid by the CONNECTING wallet's Turbo credits (--storage-signer
    // eth + --sign). ONE session signs each upload's data-item (personal_sign, no gas) AND the deploy
    // tx — the wallet's ETH identity holds the credits, so no managed key is funded.
    info(`your wallet will sign the Arweave upload(s) — paid from its Turbo credits — AND the deploy; URIs point at ${baseUrl}`);
    const session = await openWalletSession({
      chainKey: CHAIN,
      expectedSigner: flags.for as Address | undefined,
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    let r: {txHash: Hex; blockNumber: bigint};
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      // Route Turbo uploads' signatures to this session before building content (which uploads).
      uploadRemoteEth = {address: signer, signMessage: (m: Uint8Array) => session.signMessage(m, 'Sign Arweave upload (paid from your Turbo credits)')};
      const {clone: predicted, params, salt, contentNote} = await buildForDeployer(signer);
      info(contentNote);
      info(noMint ? 'mint: deferred — mint later with `abx mint`' : `mint: token #0 → ${signer} at deploy`);
      const sent = await session.send(prepareDeployOneOfOne({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted}));
      r = {txHash: sent.txHash, blockNumber: sent.receipt.blockNumber};
      clone = predicted;
    } finally {
      session.close();
    }
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else {
    // wallet lane (off-chain custody OR on-chain URI) or cold lane: a single deploy tx, no staging.
    // Only claim a URI base when one is actually written — on the on-chain lane this line used to
    // announce `http://localhost:8787` two lines after promising no localhost anywhere.
    info(
      onChainUri
        ? 'a wallet will become the owner; the token resolves from chain — no URI base is baked in.'
        : `a wallet will become the owner; URIs point at ${baseUrl}`,
    );
    const result = await signTx(
      async (signer) => {
        deployerAddr = signer;
        const {clone: predicted, params, salt} = await buildForDeployer(signer);
        return prepareDeployOneOfOne({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted});
      },
      {lane, chainKey: CHAIN, yes: !!flags.yes, expectedSigner: flags.for as Address | undefined, port: flags.port ? Number(flags.port) : undefined, signUrlFile: flags['sign-url-file']},
    );
    if (!result) {
      console.log(`\n${dim(`  unsigned — broadcast it, then: abx add <clone> --factory ${factory} --from-block <deployBlock>`)}\n`);
      return;
    }
    clone = result.prepared.fields.clone as Address;
    blockNumber = result.blockNumber;
    ok(`deployed ${clone}`);
  }
  // Emitted the moment the address is known, and again below once minting is settled — so a crash in
  // the indexing steps that follow still yields the address of a contract that really does exist.
  emit(jsonSafe({
    command: 'deploy', address: clone, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, deployBlock: blockNumber, name, symbol,
    plan: {
      schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
      family: '1of1' satisfies DeployPlanFamily,
      lane,
      transactions: {approvals, legs: onchainImage ? ['onchain-image-staging', 'deploy'] : null},
      roles: {signer: deployerAddr ?? null, owner: deployerAddr ?? null, royaltyReceiver: deployerAddr ?? null, primaryPayee: null, minter: null},
      royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
      custody: {
        onChainUri,
        imageOnChain: onchainImage,
        backend: !onChainUri && !onchainImage ? backendResolution(storageOverrides(flags)).backend : null,
        // Recomputed from the same top-level locals `buildForDeployer`'s `params` used (no branch
        // carries `params` out to this scope) — never a new decision, the identical ternary.
        tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
        contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
        renderer: onChainUri ? renderer : null,
        image: planImageFile,
      },
      mint: {deferred: noMint, count: noMint ? 0 : 1, amountPerId: null, recipient: noMint ? null : deployerAddr ?? null},
      estimate: {ethApprox: null, gasApprox: null},
      warnings: planWarnings.slice(),
      surfaces: null,
      dependencies: null,
      resume: null,
    } satisfies DeployPlan,
  }));

  step(serveAfter ? 'What the chain knows now' : 'Index it — replay the event spine from chain');
  const indexer = localIndexer();
  // Off-chain traits ride in the registration (on-chain ones are already in the contract fields).
  const offChainTraits = !traitsOnchain && traits.length ? JSON.stringify(traits) : undefined;
  const baseReg = {
    address: clone,
    chainKey: CHAIN,
    fromBlock: blockNumber.toString(),
    factory,
    label: name,
    description: flags.description,
    externalUrl: flags['external-url'],
    attributes: offChainTraits,
  };
  indexer.register(baseReg);
  // Only the demo path (`abx demo`) reaches `walkthroughReadBack` below, and only its off-chain-
  // custody branch reads `token.tokenURI` off `state` — the on-chain-URI branch there does its own
  // independent `readContract`, so skip the ask when `onChainUri` too. A real `abx deploy` never
  // asks for it (SDK default: off).
  const {state, elapsedMs} = await reindexAfterDeploy(indexer, clone, {readUriDocuments: serveAfter && !onChainUri});
  if (serveAfter) {
    if (state.eventCount > 0) ok(`read ${bold(String(state.eventCount))} events straight off ${CHAIN} in ${elapsedMs}ms — no API key, no company's server`);
    // "verified real" overstated it in the same way the removed trust-anchor step did — factory
    // provenance is a fact about how this contract was made, not a verdict on whether a token counts
    // as ABX. Report the fact.
    info(`it says: "${state.name}" · owned by ${state.owner} · ${state.isCanonical ? g('made by the canonical factory') : dim('not factory-made')}`);
    info(dim(`optional features switched on: ${state.extensions.map((e) => e.name.replace(/^abx\.extension\./, '')).join(' · ') || 'none'}`));
    walkthroughSpine(state);
  } else {
    if (state.eventCount > 0) ok(`reconstructed ${state.eventCount} events in ${elapsedMs}ms — no provider involved`);
    info(`name "${state.name}" · owner ${state.owner} · canonical: ${canonicalLabel(state.isCanonical)}`);
    info(`extensions: ${state.extensions.map((e) => e.name).join(', ') || 'none'}`);
  }

  // For off-chain custody (image committed as keccak256), resolve the durable locator (ipfs://…)
  // from this machine's content index and store it on the registration — so the LOCAL resolver
  // points `image` at IPFS, and `abx add --remote` can ship it to a hosted one (the localhost-image fix).
  const contentLocators = !onChainUri && !onchainImage
    ? await collectContentLocators(state, resolveBackend(storageOptions(storageOverrides(flags))))
    : {};
  if (Object.keys(contentLocators).length) {
    indexer.register({...baseReg, contentLocators: JSON.stringify(contentLocators)});
    info(`content locator: image → ${Object.values(contentLocators)[0]} ${dim('(durable; points off this node)')}`);
  }

  if (!serveAfter) {
    if (onChainUri) {
      // Fully on-chain → it self-resolves. Prove it from the chain, no server/localhost.
      // BUT only claim "fully on-chain" when the IMAGE is on-chain too. With `--onchain-uri` alone
      // the image is a keccak256 anchor the renderer can't serve, so tokenURI yields a placeholder —
      // and this banner previously said "no server or hosting needed" over exactly that, which is a
      // promise of permanence the token does not have. Truthful, per-config wording instead.
      if (imageEndsUpOnChain(flags, onchainImage)) {
        console.log(`\n${g('Done — fully on-chain.')} ${dim('The token self-resolves; no server or hosting needed.')}`);
      } else if (imageResolvesWithoutServer(flags, onchainImage)) {
        const bk = backendResolution(storageOverrides(flags)).backend;
        console.log(`\n${g('Done — metadata on-chain, image on ' + bk + '.')} ${dim('No server to run: the on-chain JSON points straight at the image.')}`);
        console.log(`  ${dim(`the image is addressed by URL rather than stored on-chain — its permanence is ${bk}'s (Arweave: paid once, kept forever · IPFS: kept while pinned).`)}`);
      } else {
        console.log(`\n${g('Done — metadata on-chain.')} ${dim('tokenURI/contractURI resolve from the chain with no server.')}`);
        console.log(`  ${c.orange}The IMAGE is not on-chain${c.reset} ${dim('— it is a keccak256 anchor, so tokenURI serves a placeholder image.')}`);
        console.log(`  ${dim(`prove it: ${bold(`abx tokenuri ${clone}`)} reports the image field's provenance. To fix it, redeploy with ${bold('--backend arweave')} (URL baked on-chain) or ${bold('--onchain-image')} (bytes on-chain).`)}`);
      }
      console.log(`  ${bold(`abx tokenuri ${clone}`)}  ${dim('# read tokenURI(0) straight from the contract + decode the JSON')}`);
      if (noMint) console.log(`  ${bold(`abx mint ${clone}`)}  ${dim('# issue token #0')}`);
      console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces to index it')}`);
      console.log(dim(`  (once you've confirmed it resolves, ${bold('abx lock-uri')} + ${bold('lock-field')} freeze it forever — see below)\n`));
      return;
    }
    // Off-chain resolution bakes `baseUrl` into the on-chain tokenURI. If that base is a
    // REMOTE host, the contract was indexed into THIS machine's local store — the remote
    // resolver is a separate store and won't serve it until told. That gap is the #1
    // "works for me / unknown project for everyone" footgun, so make the step explicit.
    const isRemoteBase = !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(baseUrl);
    if (noMint) {
      console.log(`\n${g('Deployed — not yet minted.')} The careful path keeps marketplaces warm:`);
      if (isRemoteBase) {
        console.log(`  ${bold(`abx add ${clone} --remote`)}  ${dim(`# REGISTER with the hosted resolver at ${baseUrl} (a local deploy does NOT)`)}`);
      } else {
        console.log(`  ${bold('abx serve')}                      ${dim('# stand up the resolver at the address above (LOCAL)')}`);
      }
      console.log(`  ${bold(`abx verify ${clone}`)}  ${dim('# confirm served content matches the chain')}`);
      console.log(`  ${bold(`abx mint ${clone}`)}  ${dim('# issue token #0 once metadata is live')}`);
      console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces to index it')}\n`);
    } else if (isRemoteBase) {
      console.log(`\n${g('Done — but the hosted resolver must be told about it.')} ${dim(`tokenURI points at ${baseUrl}, a REMOTE store.`)}`);
      console.log(`  ${bold(`abx add ${clone} --remote`)}  ${dim('# register + index on the hosted resolver (this local deploy only indexed HERE)')}`);
      console.log(`  ${bold(`abx refresh ${clone}`)}        ${dim('# then nudge marketplaces to index it')}\n`);
    } else {
      console.log(`\n${g('Done.')} ${bold(`abx verify ${clone}`)} ${dim('to confirm integrity · ')}${bold('abx serve')}${dim(' to host LOCALLY · ')}${bold(`abx refresh ${clone}`)}${dim(' to warm marketplaces')}\n`);
    }
    return;
  }

  // The demo's teaching sections — see the walkthrough helpers. `deploy` skips them: someone
  // shipping real work doesn't need their projection deleted to make a point.
  if (serveAfter) await walkthroughRebuild(indexer, clone, state);

  // Start the server BEFORE the read-back step (which fetches the served metadata over HTTP), but
  // print the serve banner after it — otherwise the "Serve" step header lands with nothing under it
  // while the read-back prints below, which reads like the step failed.
  const {url} = await startTokenApiServer({indexer, port, baseUrl, storage: resolveBackend(storageOptions())});
  if (serveAfter) await walkthroughReadBack(state, url, onChainUri);
  // On the on-chain lane this server is a convenience, not infrastructure — say so, or standing one
  // up as the finale re-teaches the dependency the whole run just disproved.
  step(onChainUri ? 'Go look at it' : 'Serve the token API + dashboard');
  if (onChainUri) info(dim('a local viewer, purely for your eyes — your token does not need it. Ctrl-C whenever; the token stays up.'));
  printServing(url, clone);
  keepAlive();
}

// ── deploy --copies: OneOfOneEdition (the flagship ERC-1155 product) ─────────────────────────────
// Copies of ONE work — a priced open/limited edition. The edition twin of `cmdDeployBody`,
// reusing every standard-agnostic helper it does (content custody, traits, authorship fields, the
// `--721c`/`--1155c`-shared validator resolution, salt prediction, signing lanes) but written as its
// own function rather than threaded into `cmdDeployBody` with `if (copies)` branches throughout —
// so the 721 lane, above, stays provably byte-identical whether or not editions exist.
//
// `--onchain-image` (chunk-store staging) works in the hot and wallet lanes. The cold/unsigned lane
// is refused because each staged chunk transaction feeds the next; it cannot produce one independent
// offline bundle. Every other custody/signing combination the 1/1 lane supports works identically.
// (`DEPLOY_EDITION_FLAGS` — the allowlist this function's `refuseStrayFlags` checks against — is
// declared further down, alongside `DEPLOY_FLAGS`/`DEPLOY_SERIES_FLAGS`/`DEPLOY_CODE_FLAGS`: it
// spreads `DEPLOY_FLAGS`, so it must come AFTER that declaration at module scope, same reason
// `DEPLOY_SERIES_EDITION_FLAGS` sits next to it rather than beside `cmdDeployEditionImageBody`.)

export async function cmdDeployOneOfOneEditionBody(flags: Flags, emit: (p: Record<string, unknown>) => void): Promise<void> {
  beginPlanWarnings();
  refuseStrayFlags(flags, DEPLOY_EDITION_FLAGS, 'deploy');
  warnSignWithoutFor(flags);
  // `--type` is the 721 lane's OWN dimension seam (cmdDeployBody redirects `--type series` to
  // `deploy-series`) — it never even reaches this function for that redirect, since --copies routes
  // here before --type is ever inspected. Refuse the confusing combination explicitly rather than
  // silently ignore it (a creator combining them almost certainly means the multi-work edition —
  // `deploy-series --copies`, not this 1/1-edition lane).
  if (flags.type !== undefined && resolveDimension(flags.type) === 'series') {
    throw new Error(
      "--type series + --copies: this is the 1/1-edition lane (one work, copies of it) — for N works each with copies, " +
        'use `abx deploy-series --copies <n|open> --dir <folder>` instead. Drop --type here.',
    );
  }
  const editionSize = parseCopies(flags.copies);
  const name = flags.name ?? 'ABX Edition';
  const symbol = flags.symbol ?? 'ABXE';
  const royaltyBps = flags['royalty-bps'] === undefined ? 500 : parseRoyaltyBps(String(flags['royalty-bps']));
  // Owner-set royalty ceiling (bps, up to 100%), reduce-only after deploy. Defaults to 10%,
  // auto-raised to fit a higher --royalty-bps so a plausible input never errors; --royalty-cap overrides.
  const maxRoyaltyBps = flags['royalty-cap'] === undefined
    ? Math.max(1000, royaltyBps)
    : parseRoyaltyBps(String(flags['royalty-cap']));
  if (royaltyBps > maxRoyaltyBps) {
    throw new Error(`--royalty-bps ${royaltyBps / 100}% exceeds --royalty-cap ${maxRoyaltyBps / 100}%; raise the cap or lower the royalty.`);
  }
  const burnable = flags.burnable === '' || flags.burnable === 'true';
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = flags['public-base-url'] ?? resolveBaseUrl(port);
  const traits = parseDeployTraits(flags);

  console.log(
    bold(
      `\n  ABX Self-Host Toolkit — deploy edition\n  ${dim(
        editionSize === 0n
          ? 'OneOfOneEdition (ERC-1155) — an OPEN edition of one work, served from chain alone'
          : `OneOfOneEdition (ERC-1155) — ${editionSize} cop${editionSize === 1n ? 'y' : 'ies'} of one work, served from chain alone`,
      )}`,
    ),
  );
  if (editionSize === 1n) info(copiesOneNote('deploy'));

  const lane = laneFromFlags(flags);
  const dryRun = isDryRun(flags);
  const onchainImage = !!flags['onchain-image'];
  // Pure flag-combo validation — checked BEFORE any chain read (predict/factory/renderer all touch
  // the network), same reasoning every other "this combo can never work" refusal in this file uses.
  // Staging is a SEQUENCE (chunk write(s) → the deploy that references the manifest) where each tx's
  // receipt feeds the next, so it cannot be signed offline in one run — the cold lane is refused on
  // every lineage, 721 and edition alike. The wallet lane CAN do it (one session signs the chunk
  // writes and the deploy); this edition path was hot-lane-only purely because it lacked that
  // session branch, which it now has.
  if (onchainImage && lane === 'unsigned') {
    throw new Error(
      'Staging an on-chain image (--onchain-image) needs interactive signing — each chunk tx feeds ' +
        "the next, so it can't run on the cold lane (--unsigned). Use the hot lane (a funded key) or --sign (browser wallet).",
    );
  }
  if (dryRun) assertPreviewDeployer(flags);
  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertChainId(CHAIN, {allowUnreachable: dryRun});

  // --721c reuses the SAME flag + value grammar to enroll ERC-1155C instead — see the locked
  // decision in the parity plan (P0): editions ship 1155C at launch with the 721C UX, unchanged.
  const transferValidator = await resolveTransferValidatorFlag(flags, publicClient, dryRun, '1155C');
  assertRealIdentity(flags, {name, symbol, dryRun});

  if (!dryRun) {
    let signer = flags.for as Address | undefined;
    if (!signer && lane === 'send') {
      try {
        signer = makeWalletClient({chainKey: CHAIN}).account.address;
      } catch {
        /* no key yet — later steps handle it */
      }
    }
    if (signer) await warnUnfunded(publicClient, signer);
  }

  step('Trust anchor');
  let factory: Address;
  if (dryRun) {
    const existing = oneOfOneEditionFactoryAddress(flags.factory);
    if (!existing) {
      info('no canonical 1/1-edition factory for this chain yet — a real deploy would deploy the trust anchor first.');
      console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
      return;
    }
    factory = existing;
    if (!(await previewFactoryLive(publicClient, factory, '1/1-edition factory'))) return;
    info(`would reuse canonical 1/1-edition factory ${factory}`);
  } else {
    factory = await ensureOneOfOneEditionFactory(flags.factory, !!flags['bootstrap-factory']);
  }

  const hasPublicUrl = !!(flags['public-base-url'] || process.env.ABX_PUBLIC_BASE_URL);
  const onChainUri = !!flags['onchain-uri'] || onchainImage;
  const traitsOnchain = traits.length > 0 && (!!flags['traits-onchain'] || onChainUri);
  let renderer: Address = zeroAddress;
  if (onChainUri) {
    step('On-chain renderer');
    if (dryRun) {
      renderer = (rendererAddress(flags.renderer) as Address) ?? zeroAddress;
      info(renderer === zeroAddress ? 'would deploy the canonical renderer first' : `would use renderer ${renderer}`);
    } else {
      renderer = await ensureRenderer(flags.renderer);
    }
  }

  if (!onChainUri) {
    const loopback = loopbackBaseUrl(baseUrl);
    if (!hasPublicUrl || loopback) {
      const devAllow = process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1';
      const msg =
        `Off-chain metadata needs a PUBLIC resolver URL baked on-chain — ${hasPublicUrl ? baseUrl : 'localhost'} resolves for no one. ` +
        `Pick a real path:\n    • Fully on-chain (SVG content): --onchain-uri\n    • Fully on-chain (any media):   --onchain-image --compress fastlz\n    • Hosted resolver:              --public-base-url https://your.domain`;
      if (!devAllow) {
        if (dryRun) warn(`would REFUSE to deploy — ${msg}`);
        else throw new Error(msg);
      } else {
        warn(`DEV ONLY (ABX_DEV_ALLOW_LOCALHOST_URI): baking ${bold(baseUrl)} on-chain — resolves only on THIS machine.`);
      }
    }
  }
  if (onChainUri && !imageResolvesWithoutServer(flags, onchainImage)) {
    warn(
      `${bold('--onchain-uri puts the metadata JSON on-chain, not the image.')} With '${backendResolution(storageOverrides(flags)).backend}' custody the image is only ` +
        `a keccak256 anchor, so ${bold('uri(0)')} will serve a PLACEHOLDER. Two ways to a real image with no server: ${bold('--backend arweave')} (or ipfs/cloud) bakes the URL on-chain, or ${bold('--onchain-image --compress fastlz')} puts the bytes themselves on-chain.`,
    );
  }

  step(`Deploy an edition of "${name}" to ${CHAIN}`);
  let bakedImage: OnChainFieldInput | undefined;
  // On the WALLET lane staging cannot happen here — it has to run inside the sign session, after the
  // connect, so the connecting wallet pays for and owns every chunk write. `stageNow` is the hot-lane
  // (and dry-run) path; the session branch below calls the same helper with a session-backed sender.
  const stageOnChainImage = async (sender: Parameters<typeof stageImageField>[2]): Promise<void> => {
    const {field, note} = await stageImageField(flags.image as string, parseCompress(flags.compress), sender);
    bakedImage = field;
    info(note);
  };
  if (onchainImage) {
    if (!flags.image) throw new Error('--onchain-image needs --image <path> (the bytes to put on-chain)');
    step('Stage on-chain image');
    if (dryRun) info(await previewImageStaging(flags.image, parseCompress(flags.compress)));
    else if (lane === 'send') await stageOnChainImage(envStagingSender());
    // lane === 'sign' → staged inside the wallet session further down.
  }

  const explicitSalt = parseSaltFlag(flags.salt);
  const noMint = flags['no-mint'] !== undefined;
  if (noMint && flags['mint-amount'] !== undefined) {
    throw new Error('--no-mint and --mint-amount disagree — drop one. (--no-mint defers ALL minting at deploy; --mint-amount sets how many copies mint at deploy.)');
  }
  const mintAmount = noMint ? 0n : flags['mint-amount'] !== undefined ? parseNonNegativeIntFlag(flags['mint-amount'] as string, 'mint-amount') : 1n;
  const minter = (flags.minter as Address) ?? zeroAddress;
  const primaryPayee = (flags['primary-payee'] as Address) ?? zeroAddress;
  const paused = flags.unpaused === undefined;

  // Same wallet-signature math as the 721 twin (see `cmdDeployBody`): staging tx(s) + the deploy tx.
  // The edition paths shipped without this and without the readout line below, so `--copies` previews
  // silently dropped the approval count the skill promises "every preview" prints — leaving an agent
  // with nothing to tell the creator about how many wallet prompts to expect.
  // Also captures `custody.image` file metadata — see the 1/1 twin's identical
  // local for why it's computed here rather than re-derived at the emit site.
  let planImageFile: DeployPlanImageFile | null = null;
  const approvals = onchainImage
    ? (() => {
        const bytes = readFileSync(resolvePath(flags.image as string));
        const compress = parseCompress(flags.compress);
        const contentPlan = computeContentPlan(bytes, compress);
        planImageFile = {
          bytes: bytes.length,
          stagedBytes: contentPlan.stagedBytes,
          mimeType: contentTypeFromPath(resolvePath(flags.image as string)),
          contentHash: hashContent(bytes),
        };
        return (contentPlan.plan.mode === 'single' ? 1 : contentPlan.plan.txCount) + 1;
      })()
    : 1;

  if (onChainUri) {
    info(`uri()/contractURI() resolve ON-CHAIN via the renderer — no resolver, no server, no localhost.`);
    if (!hasPublicUrl) info('off-chain fallback pointer left empty (the renderer is authoritative); set --public-base-url to bake one anyway.');
  }

  const buildForDeployer = async (deployer: Address) => {
    assertLaneCanSign(flags); // no upload before we know this run can be signed — see `assertLaneCanSign`
    const salt = explicitSalt ?? saltFor(deployer);
    const clone = await predictClone(publicClient, {factory, salt});
    const {tokenFields, contentNote} = bakedImage
      ? {tokenFields: [bakedImage], contentNote: 'content: image staged ON-CHAIN via reader (self-resolving, no custody)'}
      : onchainImage
        ? {tokenFields: [] as OnChainFieldInput[], contentNote: 'content: image would be staged ON-CHAIN via reader (chunk store) — dry run skips the staging write'}
        : await prepareContent(flags.image, clone, storageOverrides(flags), !dryRun, onChainUri, undefined, undefined, flags);
    if (flags.description && (onChainUri || flags['description-onchain'])) {
      tokenFields.push({field: encodeTag(F.description), representation: encodeTag(R.inline), value: toHex(flags.description)});
    }
    if (traitsOnchain) tokenFields.push(attributesInlineField(traits));
    const params: OneOfOneEditionInitParams = {
      owner: deployer,
      mintTo: mintAmount > 0n ? deployer : zeroAddress,
      mintAmount,
      name,
      symbol,
      tokenURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/t`,
      tokenURIRenderer: renderer,
      contractURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/c`,
      contractURIRenderer: renderer,
      royaltyReceiver: deployer,
      royaltyBps,
      maxRoyaltyBps,
      burnable,
      transferValidator,
      editionSize,
      primaryPayee,
      minter,
      paused,
      tokenFields,
      contractFields: [...authorshipContractFields(flags), ...gatewayContractFields(flags)],
    };
    return {clone, params, salt, contentNote};
  };

  let clone: Address;
  let blockNumber: bigint;
  // See the 1/1 lane's identical local for why this is hoisted (feeds the sent plan's `roles`).
  let deployerAddr: Address | undefined;

  if (dryRun) {
    let deployer: Address;
    if (flags.for) deployer = flags.for as Address;
    else {
      try {
        deployer = makeWalletClient({chainKey: CHAIN}).account.address;
      } catch {
        throw new Error(
          'dry run needs a deployer address to compute the deterministic deploy address — pass --for 0x.. ' +
            '(a preview signs nothing, so no key is needed). For the REAL deploy with no key in .env, use the ' +
            'wallet lane: --sign --for 0x.. (you approve in your own wallet).',
        );
      }
    }
    const {clone: predicted, params, salt, contentNote} = await buildForDeployer(deployer);
    info(`deployer ${deployer}`);
    await warnUnfunded(publicClient, deployer);
    if (explicitSalt) info(`deterministic address: ${predicted}`);
    info(`name    "${name}"${flags.name ? '' : dim('  (default — pass --name)')}`);
    info(`symbol  ${symbol}${flags.symbol ? '' : dim('  (default — pass --symbol)')}`);
    info(`copies  ${editionSize === 0n ? 'open (uncapped)' : editionSize.toString()}`);
    info(describeDeployField('description', flags.description, onChainUri || !!flags['description-onchain']));
    authorshipReadout(flags).forEach((line) => info(line));
    info(describeTraits(traits, traitsOnchain));
    info(`royalty ${royaltyBps / 100}% → ${deployer}${flags['royalty-bps'] ? '' : dim('  (default 5%)')}`);
    info(`royalty cap ${maxRoyaltyBps / 100}%${flags['royalty-cap'] !== undefined ? '' : maxRoyaltyBps > 1000 ? dim('  (auto-raised to fit the royalty)') : dim('  (default 10%)')} ${dim('— reduce-only ceiling; lower later with `abx set-royalty-cap`')}`);
    info(`burnable ${burnable ? `yes ${dim('— holders may burn their own token')}` : `no ${dim('(no token can be destroyed)')}`}`);
    info(contentNote);
    info(`tokenURI base   ${params.tokenURIBase || dim('(empty — resolves on-chain via the renderer)')}`);
    info(`contractURI base ${params.contractURIBase || dim('(empty — resolves on-chain via the renderer)')}`);
    info(mintAmount > 0n ? `mint: ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} of #0 → ${deployer} at deploy` : 'mint: deferred (--no-mint, or --mint-amount 0)');
    if (minter !== zeroAddress) info(`minter  ${minter}`);
    if (primaryPayee !== zeroAddress) info(`primary payee  ${primaryPayee}`);
    info(`paused  ${paused}${flags.unpaused ? '' : dim('  (default — pass --unpaused to open at deploy)')}`);
    info(`approvals   ${approvals} wallet approval(s)`); // parity with the 721 twin — TX signatures only
    if (!explicitSalt) {
      console.log(`\n  ${bold('salt')}  ${g(salt)}`);
      info(`address: pinned by salt — re-run with ${bold(`--salt ${salt}`)} (same address), or ${bold(`abx predict --salt ${salt} --for ${deployer} --copies ${flags.copies}`)}.`);
    }
    info(dim('the values above are exactly what a real deploy writes — nothing else is added.'));
    console.log(`\n  ${g('dry run')} ${dim('— nothing sent, no bytes stored. Re-run without --dry-run to deploy.')}\n`);
    emit(jsonSafe({
      command: 'deploy', kind: '1of1-edition', copies: editionSize.toString(), dryRun: true, sent: false, address: explicitSalt ? predicted : null, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, salt, saltPinned: !!explicitSalt, name, symbol,
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: '1of1-edition' satisfies DeployPlanFamily,
        lane,
        transactions: {approvals, legs: onchainImage ? ['onchain-image-staging', 'deploy'] : null},
        roles: {
          signer: deployer, owner: deployer, royaltyReceiver: deployer,
          primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
          minter: minter !== zeroAddress ? minter : null,
        },
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          imageOnChain: onchainImage,
          backend: !onChainUri && !onchainImage ? backendResolution(storageOverrides(flags)).backend : null,
          tokenUriBase: params.tokenURIBase || null,
          contractUriBase: params.contractURIBase || null,
          renderer: onChainUri ? renderer : null,
          image: planImageFile,
        },
        mint: {deferred: mintAmount === 0n, count: mintAmount > 0n ? 1 : 0, amountPerId: mintAmount.toString(), recipient: mintAmount > 0n ? deployer : null},
        estimate: {ethApprox: null, gasApprox: null},
        warnings: planWarnings.slice(),
        surfaces: null,
        dependencies: null,
        resume: null,
      } satisfies DeployPlan,
    }));
    return;
  }

  await confirmSend(
    `About to deploy an edition of "${name}" (${symbol}) — ${editionSize === 0n ? 'open' : editionSize.toString()} copies${flags.image ? ' with your image' : ' (generative demo content)'}; mint: ${mintAmount > 0n ? `${mintAmount} at deploy` : 'deferred'}; approvals: ${approvals} wallet approval(s); owner+royalty: your wallet @ ${royaltyBps / 100}%.` +
      (transferValidator !== zeroAddress ? ` ERC-1155C: enrolled at deploy, permanently (validator ${transferValidator}).` : ''),
    flags,
  );

  if (lane === 'send') {
    const {wallet, account} = makeWalletClient({chainKey: CHAIN});
    deployerAddr = account.address;
    const {clone: predicted, params, salt, contentNote} = await buildForDeployer(account.address);
    info(`deterministic address: ${predicted}`);
    info(describeDeployField('description', flags.description, onChainUri || !!flags['description-onchain']));
    authorshipReadout(flags).forEach((line) => info(line));
    info(describeTraits(traits, traitsOnchain));
    info(contentNote);
    info(mintAmount > 0n ? `mint: ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} of #0 → ${account.address} at deploy` : 'mint: deferred — mint later with `abx mint`');
    const send = makeHotSender({wallet, account, publicClient});
    const r = await deployOneOfOneEdition(send, publicClient, {factory, params, salt});
    clone = predicted;
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else if (lane === 'sign' && onchainImage) {
    // Wallet lane + on-chain staging: ONE sign session signs every chunk write AND the deploy, so the
    // connecting wallet pays for and owns all of it. Staging can't precede the connect, so it runs
    // inside the session and the deploy then bakes in the resulting manifest field.
    // `--onchain-image` implies on-chain resolution, so nothing points at baseUrl — mirrors the 721 1/1.
    info('a wallet will become the owner; the edition resolves from chain — no URI base is baked in.');
    const session = await openWalletSession({
      chainKey: CHAIN,
      expectedSigner: flags.for as Address | undefined,
      total: approvals, // the SAME staging-tx math the preview's `approvals` line reports
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    let r: {txHash: Hex; blockNumber: bigint};
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      await stageOnChainImage(sessionStagingSender(session)); // sets bakedImage, read by buildForDeployer
      const {clone: predicted, params, salt, contentNote} = await buildForDeployer(signer);
      info(contentNote);
      info(mintAmount > 0n ? `mint: ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} of #0 → ${signer} at deploy` : 'mint: deferred — mint later with `abx mint`');
      const sent = await session.send(prepareDeployOneOfOneEdition({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted}));
      r = {txHash: sent.txHash, blockNumber: sent.receipt.blockNumber};
      clone = predicted;
    } finally {
      session.close();
    }
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else {
    // wallet lane without staging, or the cold lane: a single deploy tx.
    info(onChainUri ? 'a wallet will become the owner; the token resolves from chain — no URI base is baked in.' : `a wallet will become the owner; URIs point at ${baseUrl}`);
    const result = await signTx(
      async (signer) => {
        deployerAddr = signer;
        const {clone: predicted, params, salt} = await buildForDeployer(signer);
        return prepareDeployOneOfOneEdition({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted});
      },
      {lane, chainKey: CHAIN, yes: !!flags.yes, expectedSigner: flags.for as Address | undefined, port: flags.port ? Number(flags.port) : undefined, signUrlFile: flags['sign-url-file']},
    );
    if (!result) {
      console.log(`\n${dim(`  unsigned — broadcast it, then: abx add <clone> --factory ${factory} --from-block <deployBlock>`)}\n`);
      return;
    }
    clone = result.prepared.fields.clone as Address;
    blockNumber = result.blockNumber;
    ok(`deployed ${clone}`);
  }
  emit(jsonSafe({
    command: 'deploy', kind: '1of1-edition', copies: editionSize.toString(), address: clone, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, deployBlock: blockNumber, name, symbol,
    plan: {
      schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
      family: '1of1-edition' satisfies DeployPlanFamily,
      lane,
      transactions: {approvals, legs: onchainImage ? ['onchain-image-staging', 'deploy'] : null},
      roles: {
        signer: deployerAddr ?? null, owner: deployerAddr ?? null, royaltyReceiver: deployerAddr ?? null,
        primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
        minter: minter !== zeroAddress ? minter : null,
      },
      royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
      custody: {
        onChainUri,
        imageOnChain: onchainImage,
        backend: !onChainUri && !onchainImage ? backendResolution(storageOverrides(flags)).backend : null,
        tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
        contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
        renderer: onChainUri ? renderer : null,
        image: planImageFile,
      },
      mint: {deferred: mintAmount === 0n, count: mintAmount > 0n ? 1 : 0, amountPerId: mintAmount.toString(), recipient: mintAmount > 0n ? deployerAddr ?? null : null},
      estimate: {ethApprox: null, gasApprox: null},
      warnings: planWarnings.slice(),
      surfaces: null,
      dependencies: null,
      resume: null,
    } satisfies DeployPlan,
  }));

  step('Index it — replay the event spine from chain');
  const indexer = localIndexer();
  const offChainTraits = !traitsOnchain && traits.length ? JSON.stringify(traits) : undefined;
  const baseReg = {
    address: clone,
    chainKey: CHAIN,
    fromBlock: blockNumber.toString(),
    factory,
    label: name,
    description: flags.description,
    externalUrl: flags['external-url'],
    attributes: offChainTraits,
  };
  indexer.register(baseReg);
  const {state, elapsedMs} = await reindexAfterDeploy(indexer, clone);
  if (state.eventCount > 0) ok(`reconstructed ${state.eventCount} events in ${elapsedMs}ms — no provider involved`);
  info(`name "${state.name}" · owner ${state.owner} · canonical: ${canonicalLabel(state.isCanonical)}`);

  const contentLocators = !onChainUri && !onchainImage ? await collectContentLocators(state, resolveBackend(storageOptions(storageOverrides(flags)))) : {};
  if (Object.keys(contentLocators).length) {
    indexer.register({...baseReg, contentLocators: JSON.stringify(contentLocators)});
    info(`content locator: image → ${Object.values(contentLocators)[0]} ${dim('(durable; points off this node)')}`);
  }

  if (onChainUri) {
    if (imageEndsUpOnChain(flags, onchainImage)) {
      console.log(`\n${g('Done — fully on-chain.')} ${dim('The edition self-resolves; no server or hosting needed.')}`);
    } else {
      console.log(`\n${g('Done — metadata on-chain.')} ${dim('uri(0) resolves from the chain with no server.')}`);
    }
    console.log(`  ${bold(`abx tokenuri ${clone}`)}  ${dim('# read uri(0) straight from the contract + decode the JSON')}`);
  } else {
    console.log(`\n${g('Done.')} ${bold(`abx verify ${clone}`)} ${dim('to confirm integrity · ')}${bold('abx serve')}${dim(' to host LOCALLY')}`);
  }
  if (mintAmount === 0n) console.log(`  ${bold(`abx mint ${clone} --amount <n>`)}  ${dim('# issue the first copies of #0')}`);
  console.log(`  ${bold(`abx minter configure ${clone} --token-id 0 --price <eth> --allocation <n>`)}  ${dim('# set up the priced sale on the shared edition minter')}`);
  console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces to index it')}\n`);
}

// ── deploy-series ─────────────────────────────────────────────────────────────
// Point at a directory of media and deploy a multi-token Series. Each file becomes a
// token (`0..N-1`, natural-sorted) — a token's metadata is its token id, and tokens mint
// strictly in order. Content is hosted exactly like a 1/1, per token — three placements:
//   • off-chain custody (default): keccak-committed, bytes served by the resolver.
//   • `--onchain-uri`: inline each token's SVG on-chain (tiny content; SVG only).
//   • `--onchain-image [--compress fastlz]`: stage each token's bytes (raster or SVG) into the
//     shared chunk store and bake a per-token `reader` field — multi-chunk on-chain content,
//     self-resolving via the renderer. Implies on-chain URI resolution.
// Mint timing: `--mint-all` / `--mint-count N` / default deferred (deploy → warm → mint).
// `--minter` delegates minting; `--primary-payee` declares sale proceeds. Content is
// deployer-independent (hashes / inline bytes / chunk manifests don't depend on the clone
// address), so it's prepared once; --onchain-image staging runs on the hot or wallet lane
// (the cold lane can't stage interactively — same as the 1/1).
export const tokenFieldOf = (tokenId: number, f: OnChainFieldInput): SeriesTokenFieldInput => ({
  tokenId,
  field: f.field,
  representation: f.representation,
  value: f.value,
});

export async function cmdDeploySeries(flags: Flags) {
  // `--copies <N|open>` routes to EditionImage — N ids from the folder × copies each. See the
  // module note on `cmdDeployOneOfOneEditionBody` for why this is a separate function rather than
  // `if (copies)` branches threaded through `cmdDeploySeriesBody` (byte-identical 721 lane).
  if (flags.copies !== undefined) return withJson(flags, async (emit) => cmdDeployEditionImageBody(flags, emit));
  return withJson(flags, async (emit) => cmdDeploySeriesBody(flags, emit));
}

export async function cmdDeploySeriesBody(flags: Flags, emit: (p: Record<string, unknown>) => void) {
  beginPlanWarnings();
  refuseStrayFlags(flags, DEPLOY_SERIES_FLAGS, 'deploy-series');
  warnSignWithoutFor(flags);
  const name = flags.name ?? 'ABX Series';
  const symbol = flags.symbol ?? 'ABXS';
  const royaltyBps = flags['royalty-bps'] === undefined ? 500 : parseRoyaltyBps(String(flags['royalty-bps']));
  // Owner-set royalty ceiling (bps, up to 100%), reduce-only after deploy. Defaults to 10%,
  // auto-raised to fit a higher --royalty-bps so a plausible input never errors; --royalty-cap overrides.
  const maxRoyaltyBps = flags['royalty-cap'] === undefined
    ? Math.max(1000, royaltyBps)
    : parseRoyaltyBps(String(flags['royalty-cap']));
  if (royaltyBps > maxRoyaltyBps) {
    throw new Error(`--royalty-bps ${royaltyBps / 100}% exceeds --royalty-cap ${maxRoyaltyBps / 100}%; raise the cap or lower the royalty.`);
  }
  const burnable = flags.burnable === '' || flags.burnable === 'true';
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = flags['public-base-url'] ?? resolveBaseUrl(port);

  console.log(bold(`\n  ABX Self-Host Toolkit — deploy series\n  ${dim('a multi-token drop, served from chain alone')}`));

  if (!flags.dir) {
    throw new Error(
      'abx deploy-series --dir <media-dir> [--count N] [--mint-all | --mint-count N | --no-mint] ' +
        '[--onchain-image [--compress fastlz] | --onchain-uri --backend ipfs|arweave|cloud (image off-chain, JSON on-chain; cloud needs --public-base) | --onchain-uri (inline SVG) | --public-base-url https://… (hosted resolver)] ' +
        '[--minter 0x..] [--primary-payee 0x..] [--unpaused] [--721c recommended|0x..] --name "Title" --symbol SYM',
    );
  }
  const dirPath = resolvePath(flags.dir);
  const files = readdirSync(dirPath)
    .filter((f) => !f.startsWith('.') && statSync(joinPath(dirPath, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, {numeric: true})); // img1,img2,…,img10
  if (files.length === 0) throw new Error(`no media files in ${dirPath}`);
  const count = flags.count ? Number(flags.count) : files.length;
  if (!Number.isInteger(count) || count <= 0) throw new Error('--count must be a positive integer');
  if (count > files.length) throw new Error(`--count ${count} exceeds the ${files.length} media file(s) in ${dirPath}`);
  const slots = files.slice(0, count);

  const dryRun = isDryRun(flags);
  if (dryRun) assertPreviewDeployer(flags); // fail fast, before the preview does any work (see cmdDeploy)
  assertRealIdentity(flags, {name, symbol, dryRun});
  const lane = laneFromFlags(flags);
  const publicClient = makePublicClient({chainKey: CHAIN});
  // Catch a wrong-network RPC with the clear mismatch message even on dry-run (which still reads
  // the chain to predict the address); tolerate an unreachable RPC so an offline preview still works.
  await assertChainId(CHAIN, {allowUnreachable: dryRun});

  // --721c (opt-in ERC-721C): absent → zeroAddress, a plain ERC-721 exactly as before.
  const transferValidator = await resolveTransferValidatorFlag(flags, publicClient, dryRun);

  // (identity guard already ran above, via the shared assertRealIdentity — before any RPC)

  // Mint timing: mint-all → the whole series; mint-count N → the first N; else deferred.
  const mintCount = flags['mint-all'] !== undefined ? count : flags['mint-count'] ? Number(flags['mint-count']) : 0;
  if (mintCount > count) throw new Error(`--mint-count ${mintCount} exceeds the series size ${count}`);
  // --onchain-image stages each slot's bytes in the chunk store (reader field); it implies
  // on-chain URI resolution (the renderer emits the reader-backed image). --onchain-uri alone
  // inlines SVG. Either way the URIs self-resolve on-chain.
  const onchainImage = !!flags['onchain-image'];
  const onChainUri = !!flags['onchain-uri'] || onchainImage;
  const compress = parseCompress(flags.compress);
  // Staging is a SEQUENCE (chunk write(s) → the deploy that references each manifest) where each
  // receipt feeds the next, so it can't be signed offline in one pass — reject the cold lane
  // up front (same rule as the 1/1's --onchain-image).
  if (onchainImage && lane === 'unsigned') {
    throw new Error(
      'Staging on-chain images (--onchain-image) needs interactive signing — each chunk tx feeds ' +
        "the next, so it can't run on the cold lane (--unsigned). Use the hot lane (a funded key) or --sign (browser wallet).",
    );
  }
  // Whole-collection WRITE-cost guard: a set of many small files can still sum to an expensive
  // on-chain deploy, so flag the total once, up front. This is a cost signal only — the READ gate is
  // per token (`guardOnChainSize`, fired per file during staging/preview), because each token's
  // `tokenURI` assembles only its own content, so a 300-file collection of 5KB pieces reads fine.
  if (onchainImage) {
    const totalBytes = slots.reduce((n, s) => n + statSync(joinPath(dirPath, s)).size, 0);
    if (totalBytes > ONCHAIN_PROJECT_SOFT_LIMIT) {
      warn(
        `on-chain collection total is ${Math.round(totalBytes / 1024)}KB across ${slots.length} file(s) — on-chain costs ~200 gas/byte to WRITE, so this is expensive, not cheaper. ` +
          `Past ~${Math.round(ONCHAIN_PROJECT_SOFT_LIMIT / 1024)}KB total, prefer off-chain: --backend arweave (pay-once, permanent) or a hosted resolver + IPFS. ` +
          `(Per-token readability is judged per file, not on this total.)`,
      );
    }
  }
  const minter = (flags.minter as Address) ?? zeroAddress;
  // Default paused=true (safe: public/minter mint closed until the owner opens it); --unpaused
  // deploys open. Owner reserves still mint at deploy regardless (initialize bypasses the gate).
  const paused = flags.unpaused === undefined;
  const primaryPayee = (flags['primary-payee'] as Address) ?? zeroAddress;
  const explicitSalt = parseSaltFlag(flags.salt);
  const hasPublicUrl = !!(flags['public-base-url'] || process.env.ABX_PUBLIC_BASE_URL);

  step('Trust anchor');
  let factory: Address;
  if (dryRun) {
    const existing = seriesFactoryAddress(flags.factory);
    if (!existing) {
      info('no canonical Series factory for this chain yet — a real deploy would deploy the trust anchor first.');
      console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
      return;
    }
    factory = existing as Address;
    if (!(await previewFactoryLive(publicClient, factory, 'Series factory'))) return;
    info(`would reuse canonical Series factory ${factory}`);
  } else {
    factory = await ensureSeriesFactory(flags.factory, !!flags['bootstrap-factory']);
  }

  let renderer: Address = zeroAddress;
  if (onChainUri) {
    step('On-chain renderer');
    renderer = dryRun ? ((rendererAddress(flags.renderer) as Address) ?? zeroAddress) : await ensureRenderer(flags.renderer);
    // Say WHICH renderer, like the 1/1 lane does. Both series lanes printed the step header with
    // nothing under it, while the skill's confirm-readout template implies an address is quotable
    // there — so an agent relaying the readout had a blank line to explain.
    info(renderer === zeroAddress ? 'would deploy the canonical renderer first' : `${dryRun ? 'would use' : 'using'} renderer ${renderer}`);
  }

  // Off-chain custody bakes the resolver URL on-chain — a localhost URL resolves for no one.
  // (Not a concern with --onchain-uri: the renderer is authoritative and resolves from chain.)
  if (!onChainUri) {
    const loopback = loopbackBaseUrl(baseUrl);
    if (!hasPublicUrl || loopback) {
      const devAllow = process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1';
      const msg =
        `Off-chain metadata needs a PUBLIC resolver URL baked on-chain — ${hasPublicUrl ? baseUrl : 'localhost'} resolves for no one. ` +
        `Pick a real path:\n    • Fully on-chain (SVG content): --onchain-uri\n    • Fully on-chain (any media):   --onchain-image --compress fastlz\n    • Hosted resolver:              --public-base-url https://your.domain`;
      if (!devAllow) {
        if (dryRun) warn(`would REFUSE to deploy — ${msg}`);
        else throw new Error(msg);
      } else {
        warn(`DEV ONLY (ABX_DEV_ALLOW_LOCALHOST_URI): baking ${bold(baseUrl)} on-chain — resolves only on THIS machine.`);
      }
    }
  }

  step(`Prepare ${count} token(s) from ${basename(dirPath)}/`);
  const overrides = storageOverrides(flags);
  const opts = storageOptions(overrides);
  const backendId = overrides.backend ?? process.env.ABX_STORAGE_BACKEND ?? 'fs';
  // Image custody × URI resolution (see reference/hosting.md):
  //  - --onchain-image                    → chunk store (on-chain bytes), JSON on-chain
  //  - --onchain-uri + a durable backend  → image OFF-CHAIN (ipfs/arweave), JSON on-chain via the
  //    (ipfs/arweave)                        renderer: ONE collection-scope image field when files share
  //                                          an extension (O(1) directory), else per-token `url` (O(N))
  //  - --onchain-uri alone                → inline SVG on-chain
  //  - neither                            → off-chain custody (keccak), served by a hosted resolver
  // Backends that expose a PUBLIC direct URL (so the on-chain renderer can point at them): ipfs +
  // arweave (content-addressed, permanent) and cloud/S3 (needs a public base / CDN; centralized).
  const directUrlBackend = backendId === 'ipfs' || backendId === 'arweave' || backendId === 'cloud';
  const offchainImageOnchainJson = onChainUri && !onchainImage && directUrlBackend;
  const backend = (offchainImageOnchainJson || !onChainUri) && !dryRun ? resolveBackend(opts) : undefined;
  const tokenPaths = slots.map((s, i) => ({tokenId: i, name: s, path: joinPath(dirPath, s)}));
  // Say WHICH backend holds the bytes, exactly as the 1/1 lane does. Both Series lanes resolved a
  // backend and never named it, so a creator asking for "images on IPFS" had no way to confirm from
  // the preview that their collection would actually pin there — the flag was accepted in silence.
  if (!onchainImage && (offchainImageOnchainJson || !onChainUri)) {
    const sr = backendResolution(overrides);
    info(`storage: ${sr.backend} ${dim(`(${sr.source === 'flag' ? '--backend' : sr.source === 'env' ? 'env' : 'default'})`)} — byte custody for the image(s)`);
    const gwWarn = localGatewayWarning(flags);
    if (gwWarn) warn(gwWarn);
  }
  // Wallet-signature count for THIS deploy — the same per-token chunk math that sizes the
  // wallet-lane session `total` below, computed once so preview/confirm text and the real
  // session can never disagree. TX signatures only — see the 1/1's `approvals` for the same note
  // on why an Arweave message signature doesn't add to this count.
  const approvals = onchainImage
    ? tokenPaths.reduce((n, {path}) => {
        const plan = computeContentPlan(readFileSync(path), compress).plan;
        return n + (plan.mode === 'single' ? 1 : plan.txCount);
      }, 0) + 1 // + the deploy tx
    : 1;
  // Wallet-lane Arweave uploads paid by the connecting wallet's Turbo credits (`--storage-signer eth`
  // + `--sign`). The identity + uploads are deferred to the sign session (after connect), so skip the
  // early managed-key creation + funds guard and the up-front buildFields; the session branch runs them.
  const remoteEthUpload = lane === 'sign' && !onchainImage && !!backend && storageSignerChoice(overrides) === 'eth' && isTurboArweave(opts);
  if (backend && !remoteEthUpload) {
    assertLaneCanSign(flags); // no upload before we know this run can be signed — see `assertLaneCanSign`
    ensureArweaveIdentityForUpload(opts); // Turbo identity, created on first upload
    // The deployer wallet (--for, else the .env key's address) — checked for existing Turbo credits
    // if the managed key is short, so we recommend `--storage-signer eth` before any top-up.
    let guardWallet = flags.for as string | undefined;
    if (!guardWallet) try { guardWallet = makeWalletClient({chainKey: CHAIN}).account.address; } catch { /* no key — skip */ }
    await assertTurboFundsForUpload(opts, tokenPaths.map(({path}) => statSync(path).size), guardWallet); // stop before deploy if short
  }

  // Fields are deployer-independent (content hashes / inline bytes / chunk manifests / directory
  // locators don't depend on the clone address), so they're built once. `tokenFields` are per-token;
  // `contractFields` carry the collection-scope image (the O(1) directory template). `stage` is
  // required only for --onchain-image (chunk-store writes) and runs per-lane below.
  let tokenFields: SeriesTokenFieldInput[] = [];
  let contractFields: OnChainFieldInput[] = [];
  // Per-token marketplace traits (--attributes). Lane-aware, mirroring the 1/1: traits go ON-CHAIN
  // (inline tokenFields) when the token resolves on-chain (or --traits-onchain), else OFF-CHAIN
  // operator metadata (per-token, resolver-served + editable) — so a Series has the 1/1's parity.
  const seriesTraits = parseSeriesTraits(
    flags.attributes ? readFileSync(resolvePath(process.cwd(), flags.attributes as string), 'utf8') : undefined,
    slots,
  );
  const seriesTraitsOnchain = seriesTraits.size > 0 && (!!flags['traits-onchain'] || onChainUri);
  // Off-chain lane: serialize `{ "<tokenId>": attrs }` for the registration (the resolver stitches it).
  const offChainTokenTraits =
    seriesTraits.size && !seriesTraitsOnchain
      ? JSON.stringify(Object.fromEntries([...seriesTraits].map(([id, a]) => [String(id), a])))
      : undefined;
  const buildImageFields = async (stage?: SendTx): Promise<void> => {
    // --onchain-image: stage every token's bytes into ONE shared chunk store, each a `reader` field.
    if (onchainImage) {
      const {fields} = await stageImageFieldsBatch(tokenPaths.map((s) => s.path), compress, stage!, flags['chunk-store']);
      tokenFields = tokenPaths.map(({tokenId}, i) => tokenFieldOf(tokenId, fields[i]));
      return;
    }
    // --onchain-uri + durable backend: image lives off-chain (ipfs/arweave); JSON renders on-chain.
    if (offchainImageOnchainJson) {
      const exts = tokenPaths.map(({path}) => extname(path).toLowerCase());
      const uniform = exts[0] !== '' && exts.every((e) => e === exts[0]);
      if (dryRun || !backend) {
        if (uniform) {
          contractFields = [imageLocatorField(backendId, `<${backendId}-dir>/{id}${exts[0]}`, true)];
          info(`would upload ${tokenPaths.length} file(s) as ONE ${backendId} directory → collection image <${backendId}-dir>/{id}${exts[0]} (O(1); ${describeLocatorField(backendId)})`);
          // Name the SERVING prefix in the plan too. Without it a preview says "the gateway is the
          // collection's preference" and never says what that preference resolves to, so a reader
          // fills the blank with the upload gateway they just typed — the same confusion the live
          // narration used to cause outright.
          if (backendId === 'ipfs' || backendId === 'arweave') {
            const {prefix, chosen} = servingGateway(backendId, flags);
            info(`served from ${bold(prefix)} ${dim(chosen ? '(your --' + backendId + '-gateway, written on-chain)' : `(public default — nothing written; repoint any time with ${bold('abx set-gateway')})`)}`);
          }
        } else {
          tokenFields = tokenPaths.map(({tokenId}) => tokenFieldOf(tokenId, imageLocatorField(backendId, `<${backendId}-url-${tokenId}>`)));
          info(`would upload ${tokenPaths.length} file(s) to ${backendId} → per-token url image fields (mixed extensions, O(N))`);
        }
        return;
      }
      if (uniform && backend.putDirectory) {
        // O(1) directory-base: upload the folder renamed to {id}{ext}; ONE collection-scope image
        // field. `{id}` substitutes at read on every locator representation, `ipfs`/`arweave` included.
        const entries = tokenPaths.map(({tokenId, path}) => ({name: `${tokenId}${exts[0]}`, bytes: new Uint8Array(readFileSync(path)), contentType: contentTypeFromPath(path)}));
        const {base} = await backend.putDirectory(entries);
        const template = `${base}/{id}${exts[0]}`;
        contractFields = [imageLocatorField(backendId, template, true)];
        info(`uploaded ${entries.length} file(s) as one ${backendId} directory`);
        const servedTemplate = servedImageUrl(backendId, template, flags);
        info(`collection image: ${servedTemplate.url}  ${dim(`— one field covers every token (O(1); ${describeLocatorField(backendId)})`)}`);
        if (servedTemplate.note) info(dim(`  ${servedTemplate.note}`));
      } else {
        // mixed extensions (or no directory support): per-token url fields (O(N)).
        for (const {tokenId, name: fname, path} of tokenPaths) {
          const bytes = new Uint8Array(readFileSync(path));
          const hash = hashContent(bytes);
          await backend.put(hash, {bytes, contentType: contentTypeFromPath(path)});
          const locator = (await backend.locator?.(hash)) ?? '';
          if (!locator) throw new Error(`backend ${backendId} returned no public locator for token ${tokenId} — a durable backend (ipfs/arweave) is required for --onchain-uri image hosting`);
          tokenFields.push(tokenFieldOf(tokenId, imageLocatorField(backendId, locator)));
          info(`token ${tokenId} ← ${fname} → ${servedImageUrl(backendId, locator, flags).url}`);
        }
        info(`mixed file extensions → per-token image fields (O(N)); a uniform extension enables the O(1) directory template`);
      }
      return;
    }
    // --onchain-uri alone (inline SVG) or off-chain custody (keccak, hosted resolver).
    for (const {tokenId, name: fname, path} of tokenPaths) {
      const bytes = new Uint8Array(readFileSync(path));
      const contentType = contentTypeFromPath(path);
      if (onChainUri) {
        const text = Buffer.from(bytes).toString('utf8');
        if (!looksLikeSvg(text)) {
          throw new Error(
            `--onchain-uri inlines SVG only; token ${tokenId} "${fname}" is ${contentType}. ` +
              `Use --onchain-image (on-chain bytes), or --backend ipfs|arweave (image off-chain, JSON on-chain), or drop --onchain-uri to host off-chain.`,
          );
        }
        tokenFields.push(tokenFieldOf(tokenId, imageInlineField(text)));
      } else {
        const hash = hashContent(bytes);
        if (backend) await backend.put(hash, {bytes, contentType});
        tokenFields.push(tokenFieldOf(tokenId, imageKeccakField(hash)));
      }
      info(`token ${tokenId} ← ${fname} ${dim(`(${bytes.length}B ${contentType})`)}`);
    }
  };
  // Build the image fields (per lane), THEN append per-token attributes fields — so traits ride the
  // same deploy in every custody lane. (A huge series should instead set these post-deploy via
  // set-field under a gas budget; deploy-time inline suits the small/medium collections deploy-series targets.)
  const buildFields = async (stage?: SendTx): Promise<void> => {
    await buildImageFields(stage);
    // On-chain lane only: inline per-token attributes ride the deploy. (Off-chain traits go to the
    // registration via offChainTokenTraits — see the baseReg below — so nothing rides the tx.)
    if (seriesTraitsOnchain) {
      for (const [tokenId, attrs] of seriesTraits) tokenFields.push(tokenFieldOf(tokenId, attributesInlineField(attrs)));
    }
  };

  // --onchain-image staging is deferred to the lane branch (hot: env key up front; wallet: inside
  // the sign session). Every other mode is lane-independent, so build it now.
  // opt-in --confirm: a final y/N before ANY upload or send (no-op without --confirm; never blocks scripts)
  if (!dryRun) {
    const custody = onchainImage
      ? 'image on-chain (chunk store)'
      : offchainImageOnchainJson
        ? `image off-chain on ${backendId} + on-chain renderer`
        : onChainUri
          ? 'inline SVG on-chain'
          : `off-chain custody → ${baseUrl}`;
    await confirmSend(
      `About to deploy Series "${name}" (${symbol}) — ${count} token(s); ${custody}; mint: ${mintCount > 0 ? `${mintCount} at deploy` : 'deferred'}; approvals: ${approvals} wallet approval(s); owner+royalty: your wallet @ ${royaltyBps / 100}%.` +
        (transferValidator !== zeroAddress ? ` ERC-721C: enrolled at deploy, permanently (validator ${transferValidator}).` : ''),
      flags,
    );
  }
  if (!onchainImage && !remoteEthUpload) await buildFields();

  // Assemble the init params for a given deployer (owner/royalty/mintTo = deployer). The clone
  // address is deterministic in (factory, salt) — so URIs are baked before the tx is signed.
  const buildForDeployer = async (deployer: Address) => {
    assertLaneCanSign(flags); // no upload before we know this run can be signed — see `assertLaneCanSign`
    const salt = explicitSalt ?? saltFor(deployer);
    const clone = await predictClone(publicClient, {factory, salt});
    const params: SeriesInitParams = {
      owner: deployer,
      name,
      symbol,
      tokenURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/t`,
      tokenURIRenderer: renderer,
      contractURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/c`,
      contractURIRenderer: renderer,
      royaltyReceiver: deployer,
      royaltyBps,
      maxRoyaltyBps,
      burnable,
      transferValidator,
      maxInvocations: count,
      primaryPayee,
      minter,
      paused,
      mintTo: mintCount > 0 ? deployer : zeroAddress,
      mintCount,
      tokenFields,
      // image contract fields (the O(1) collection-scope image) + authorship/rights (creator / license / …).
      contractFields: [...contractFields, ...authorshipContractFields(flags), ...gatewayContractFields(flags)],
    };
    return {clone, params, salt};
  };

  step(`Deploy a ${count}-token Series to ${CHAIN}`);
  if (dryRun) {
    let deployer: Address;
    if (flags.for) deployer = flags.for as Address;
    else {
      try {
        deployer = makeWalletClient({chainKey: CHAIN}).account.address;
      } catch {
        throw new Error(
          'dry run needs a deployer address to compute the deterministic deploy address — pass --for 0x.. ' +
            '(a preview signs nothing, so no key is needed). For the REAL deploy with no key in .env, use the ' +
            'wallet lane: --sign --for 0x.. (you approve in your own wallet).',
        );
      }
    }
    const {clone: predicted, params, salt} = await buildForDeployer(deployer);
    info(`deployer ${deployer}`);
    // Without --salt this salt was just freshly randomly reserved; a plain re-run gets a
    // DIFFERENT one, so only print the address when --salt pinned it (see the block after the
    // readout for the no-salt case).
    if (explicitSalt) info(`deterministic address: ${predicted}`);
    info(`name "${name}" · symbol ${symbol} · size ${count} · royalty ${royaltyBps / 100}% · cap ${maxRoyaltyBps / 100}%${burnable ? ' · burnable' : ''}`);
    authorshipReadout(flags).forEach((line) => info(line));
    info(`mint: ${mintCount > 0 ? `${mintCount} token(s) in order → ${deployer} at deploy` : 'deferred (mint later / external minter)'}`);
    if (minter !== zeroAddress) info(`authorized minter: ${minter}`);
    if (primaryPayee !== zeroAddress) info(`primary payee: ${primaryPayee}`);
    info(paused ? 'paused: yes — public/minter mint closed until `abx unpause` (owner reserves still mint)' : 'paused: no — mint open at deploy');
    info(
      onchainImage
        ? 'resolution: ON-CHAIN via the renderer (chunked reader per token — image bytes on-chain)'
        : offchainImageOnchainJson
          // Say which SHAPE landed, not a fixed representation name: since v11 a content-addressed
          // backend writes an `ipfs`/`arweave` field, not `url`/`url-template`.
          ? `resolution: ON-CHAIN via the renderer; image OFF-CHAIN on ${backendId} (${contractFields.length ? 'one collection-scope image field, O(1)' : 'per-token image fields, O(N)'})`
          : onChainUri
            ? 'resolution: ON-CHAIN via the renderer (inline SVG per token)'
            : `resolution: off-chain, base ${params.tokenURIBase}`,
    );
    info(
      onchainImage
        ? `transactions: on-chain image staging (≥1 tx per file, per-token detail below) + 1 deploy${mintCount ? ' (mints the reserve)' : ''}`
        : `transactions: 1 — the deploy${mintCount ? ' (mints the reserve at deploy)' : ''}${offchainImageOnchainJson ? ` · your ${count} image(s) upload to ${backendId} FIRST, with NO wallet signature (an upload is not a tx)` : ''}`,
    );
    if (flags.attributes) {
      info(
        seriesTraits.size
          ? `traits: per-token ${seriesTraitsOnchain ? 'ON-CHAIN (inline, rides the deploy)' : 'off-chain (operator metadata — resolver-served + editable later via `abx add --attributes`)'} for ${seriesTraits.size}/${count} token(s) (from --attributes)`
          : `⚠ traits: --attributes matched NO token — keys must be a token-id index, a filename, or a token-id string (see \`abx help deploy-series\`)`,
      );
    }
    if (onchainImage) {
      for (const {tokenId, name: fname, path} of tokenPaths) {
        info(`token ${tokenId} ← ${fname}: ${await previewImageStaging(path, compress)}`);
      }
    }
    info(`approvals   ${approvals} wallet approval(s)`); // TX signatures only
    // storage readiness — what a REAL deploy needs (Arweave credits / Pinata JWT / cloud public base)
    if (offchainImageOnchainJson || (!onChainUri && !onchainImage)) {
      await noteStorageReadiness(opts, tokenPaths.map(({path}) => statSync(path).size));
    }
    // Enforce, don't warn: without --salt there is no predicted address to reproduce (see
    // above), so print the salt itself, prominently, plus how to pin it.
    if (!explicitSalt) {
      console.log(`\n  ${bold('salt')}  ${g(salt)}`);
      info(`address: pinned by salt — re-run with ${bold(`--salt ${salt}`)} (same address), or ${bold(`abx predict --dir ${flags.dir} --salt ${salt} --for ${deployer}`)}.`);
      info(`reproduce this exact preview (salt included): ${bold(deploySeriesCommandLine(flags, salt))}`);
    }
    console.log(`\n  ${g('dry run')} ${dim('— nothing sent, no bytes stored.')}\n`);
    // Without --salt, `address` would be a freshly-reserved value a real deploy will NOT land at —
    // report null rather than a real-looking value a script could wrongly act on.
    emit(jsonSafe({
      command: 'deploy-series', dryRun: true, sent: false, address: explicitSalt ? predicted : null, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, salt, saltPinned: !!explicitSalt, name, symbol,
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: 'series' satisfies DeployPlanFamily,
        lane,
        // A staged on-chain collection is many chunk-write txs, one per file — that per-token detail
        // is printed above (`previewImageStaging`), not re-derived here; `legs` just names the shape.
        transactions: {approvals, legs: onchainImage ? ['onchain-image-staging (per token)', 'deploy'] : null},
        roles: {
          signer: deployer, owner: deployer, royaltyReceiver: deployer,
          primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
          minter: minter !== zeroAddress ? minter : null,
        },
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          imageOnChain: onchainImage,
          backend: offchainImageOnchainJson || !onChainUri ? backendId : null,
          tokenUriBase: params.tokenURIBase || null,
          contractUriBase: params.contractURIBase || null,
          renderer: onChainUri ? renderer : null,
          // Series stages ONE FILE PER TOKEN under --onchain-image — no single-file shape fits (see
          // this field's own doc comment) — so this stays null even when `imageOnChain` is true.
          image: null,
        },
        mint: {deferred: mintCount === 0, count: mintCount, amountPerId: null, recipient: mintCount > 0 ? deployer : null},
        estimate: {ethApprox: null, gasApprox: null},
        warnings: planWarnings.slice(),
        surfaces: null,
        dependencies: null,
        resume: null,
      } satisfies DeployPlan,
    }));
    return;
  }

  let clone: Address;
  let blockNumber: bigint;
  // See the 1/1 lane's identical local for why this is hoisted (feeds the sent plan's `roles`).
  let deployerAddr: Address | undefined;
  if (lane === 'send') {
    // hot lane: the env key stages every token up front (deployer-independent), then deploys.
    const {wallet, account} = makeWalletClient({chainKey: CHAIN});
    deployerAddr = account.address;
    if (onchainImage) await buildFields(envStagingSender());
    const {clone: predicted, params, salt} = await buildForDeployer(account.address);
    info(`deterministic address: ${predicted}`);
    info(`mint: ${mintCount > 0 ? `${mintCount} token(s) → ${account.address} at deploy` : 'deferred'}`);
    const send = makeHotSender({wallet, account, publicClient});
    const r = await deploySeries(send, publicClient, {factory, params, salt});
    clone = predicted;
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else if (lane === 'sign' && onchainImage) {
    // wallet lane + on-chain staging: ONE session signs every chunk write across all tokens AND
    // the deploy. The connecting wallet pays for (and owns) it; staging can't precede the connect
    // here, so it runs inside the session, then the deploy bakes in every token's manifest.
    info(`a wallet will become the owner; it will approve ${approvals - 1} staging tx(s) + the deploy in one session.`);
    const session = await openWalletSession({
      chainKey: CHAIN,
      expectedSigner: flags.for as Address | undefined,
      total: approvals, // the same staging-tx math the preview's `approvals` line reports
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      if (onchainImage) await buildFields(sessionStagingSender(session));
      const {clone: predicted, params, salt} = await buildForDeployer(signer);
      const sent = await session.send(prepareDeploySeries({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted}));
      clone = predicted;
      blockNumber = sent.receipt.blockNumber;
    } finally {
      session.close();
    }
    ok(`deployed ${clone}`);
  } else if (lane === 'sign' && remoteEthUpload) {
    // wallet lane + Arweave uploads paid by the CONNECTING wallet's Turbo credits: ONE session signs
    // each token's upload data-item (personal_sign, no gas) AND the deploy tx. Uploads are deferred to
    // here so they route through the connected wallet (its ETH identity holds the credits).
    info(`your wallet will sign ${tokenPaths.length} Arweave upload(s) — paid from its Turbo credits — plus the deploy, in one session.`);
    const session = await openWalletSession({
      chainKey: CHAIN,
      expectedSigner: flags.for as Address | undefined,
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      // Route Turbo uploads through the wallet (mutate the SAME opts.arweave the backend captured).
      if (opts.arweave) opts.arweave.remoteEth = {address: signer, signMessage: (m: Uint8Array) => session.signMessage(m, 'Sign Arweave upload (paid from your Turbo credits)')};
      await buildFields();
      const {clone: predicted, params, salt} = await buildForDeployer(signer);
      const sent = await session.send(prepareDeploySeries({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted}));
      clone = predicted;
      blockNumber = sent.receipt.blockNumber;
    } finally {
      session.close();
    }
    ok(`deployed ${clone}`);
  } else {
    // wallet lane (off-chain / inline) or cold lane: a single deploy tx, no staging sequence —
    // tokenFields is already built. Same correction as the 1/1 lane: only claim a URI base when one
    // is actually written, or an --onchain-uri Series announces a localhost it never bakes.
    info(
      onChainUri
        ? 'a wallet will become the owner; tokens resolve from chain — no URI base is baked in.'
        : `a wallet will become the owner; URIs point at ${baseUrl}`,
    );
    const result = await signTx(
      async (signer) => {
        deployerAddr = signer;
        const {clone: predicted, params, salt} = await buildForDeployer(signer);
        return prepareDeploySeries({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted});
      },
      {lane, chainKey: CHAIN, yes: !!flags.yes, expectedSigner: flags.for as Address | undefined, port: flags.port ? Number(flags.port) : undefined, signUrlFile: flags['sign-url-file']},
    );
    if (!result) {
      console.log(`\n${dim(`  unsigned — broadcast it, then: abx add <clone> --factory ${factory} --from-block <deployBlock>`)}\n`);
      return;
    }
    clone = result.prepared.fields.clone as Address;
    blockNumber = result.blockNumber;
    ok(`deployed ${clone}`);
  }
  // The permanent decisions, on the path that actually sent them — the plan line above is
  // dry-run-only, so a creator going straight to --send never saw their royalty rate (5% to the
  // deploying wallet by default) until they thought to read `abx state`.
  info(
    `permanent: size ${count} · royalty ${royaltyBps / 100}%${flags['royalty-bps'] === undefined ? ' ⚠ default' : ''} → the deploying wallet` +
      ` · cap ${maxRoyaltyBps / 100}%${burnable ? ' · burnable' : ''}` +
      dim('  (rate is changeable with `abx set-royalty`; the CAP only ever goes down)'),
  );
  emit(jsonSafe({
    command: 'deploy-series', address: clone, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, deployBlock: blockNumber, name, symbol,
    plan: {
      schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
      family: 'series' satisfies DeployPlanFamily,
      lane,
      transactions: {approvals, legs: onchainImage ? ['onchain-image-staging (per token)', 'deploy'] : null},
      roles: {
        signer: deployerAddr ?? null, owner: deployerAddr ?? null, royaltyReceiver: deployerAddr ?? null,
        primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
        minter: minter !== zeroAddress ? minter : null,
      },
      royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
      custody: {
        onChainUri,
        imageOnChain: onchainImage,
        backend: offchainImageOnchainJson || !onChainUri ? backendId : null,
        tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
        contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
        renderer: onChainUri ? renderer : null,
        image: null, // per-token staging — see the dry-run emit's identical comment
      },
      mint: {deferred: mintCount === 0, count: mintCount, amountPerId: null, recipient: mintCount > 0 ? deployerAddr ?? null : null},
      estimate: {ethApprox: null, gasApprox: null},
      warnings: planWarnings.slice(),
      surfaces: null,
      dependencies: null,
      resume: null,
    } satisfies DeployPlan,
  }));

  step('Index it — replay the event spine from chain');
  const indexer = localIndexer();
  const baseReg = {
    address: clone,
    chainKey: CHAIN,
    fromBlock: blockNumber.toString(),
    factory,
    label: name,
    description: flags.description,
    externalUrl: flags['external-url'],
    // Off-chain per-token traits (resolver-served + editable). On-chain traits already rode the deploy
    // (tokenFields); undefined here when they did, or when there are none.
    tokenAttributes: offChainTokenTraits,
  };
  indexer.register(baseReg);
  const {state, elapsedMs} = await reindexAfterDeploy(indexer, clone);
  if (state.eventCount > 0) ok(`reconstructed ${state.eventCount} events in ${elapsedMs}ms — ${state.tokens.length} token(s), max ${state.maxInvocations}`);
  info(`extensions: ${state.extensions.map((e) => e.name).join(', ') || 'none'}`);

  // Off-chain custody: bridge each token's keccak → durable locator so the resolver (local and,
  // via `abx add --remote`, a hosted one) points images off this node.
  if (!onChainUri) {
    const contentLocators = await collectContentLocators(state, resolveBackend(opts));
    if (Object.keys(contentLocators).length) {
      indexer.register({...baseReg, contentLocators: JSON.stringify(contentLocators)});
      info(`content locators: ${Object.keys(contentLocators).length} token image(s) bridged off-node`);
    }
  }

  // Fixed supply: `--mint-all` (mintCount == count) leaves nothing for anyone else to mint, so the
  // collection is COMPLETE — suppress the `mint`/`unpause` next-steps (unpausing an exhausted supply
  // does nothing; suggesting it reads as "unfinished" and misleads).
  const fullyMinted = mintCount >= count;
  const completeNote = `  ${dim(`All ${count} token(s) minted — collection complete (fixed supply; nothing left to mint, no unpause needed).`)}`;

  if (onChainUri) {
    console.log(`\n${g('Done — fully on-chain.')} ${dim('Every token self-resolves; no server needed.')}`);
    console.log(`  ${bold(`abx tokenuri ${clone}`)}  ${dim('# read tokenURI(0) straight from the contract')}`);
    if (fullyMinted) {
      console.log(completeNote);
    } else {
      console.log(`  ${bold(`abx mint ${clone}`)}  ${dim('# mint the next token in order (or --count N)')}`);
      if (paused) console.log(`  ${bold(`abx unpause ${clone}`)}  ${dim('# open the mint to your minter/public (owner can mint while paused)')}`);
    }
    console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces')}\n`);
    return;
  }
  const isRemoteBase = !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(baseUrl);
  console.log(`\n${g('Series deployed.')} ${mintCount > 0 ? '' : dim('(deferred mint — warm the resolver, then mint)')}`);
  if (isRemoteBase) console.log(`  ${bold(`abx add ${clone} --remote`)}  ${dim('# register with the hosted resolver (a local deploy does NOT)')}`);
  else console.log(`  ${bold('abx serve')}  ${dim('# stand up the resolver locally')}`);
  if (fullyMinted) {
    console.log(completeNote);
  } else {
    console.log(`  ${bold(`abx mint ${clone}`)} ${dim('· mint the next token in order (or --count N)')}`);
    if (paused) console.log(`  ${bold(`abx unpause ${clone}`)}  ${dim('# open the mint to your minter/public (owner can mint while paused)')}`);
  }
  console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces once metadata is live')}\n`);
}

// ── deploy-series --copies: EditionImage ──────────────────────────────────────────────────────────
// N distinct works (one per file, like a Series) × copies each. The edition twin of
// `cmdDeploySeriesBody`, kept as its OWN function for the same reason `cmdDeployOneOfOneEditionBody`
// is (byte-identical 721 lane — see that function's module note).
//
// Custody matches the 721 Series lane: off-chain per-file uploads, O(1) uniform-extension directory
// templates under `--onchain-uri`, inline SVG, hosted resolution, and `--onchain-image` chunk staging.
// The last uses hot or wallet signing; cold/unsigned staging is refused because each chunk feeds the
// next transaction.
// (`DEPLOY_SERIES_EDITION_FLAGS` is declared further down, beside `DEPLOY_EDITION_FLAGS` — see that
// const's own note on why.)

export async function cmdDeployEditionImageBody(flags: Flags, emit: (p: Record<string, unknown>) => void): Promise<void> {
  beginPlanWarnings();
  refuseStrayFlags(flags, DEPLOY_SERIES_EDITION_FLAGS, 'deploy-series');
  warnSignWithoutFor(flags);
  const editionSize = parseCopies(flags.copies);
  const name = flags.name ?? 'ABX Edition Series';
  const symbol = flags.symbol ?? 'ABXES';
  const royaltyBps = flags['royalty-bps'] === undefined ? 500 : parseRoyaltyBps(String(flags['royalty-bps']));
  // Owner-set royalty ceiling (bps, up to 100%), reduce-only after deploy. Defaults to 10%,
  // auto-raised to fit a higher --royalty-bps so a plausible input never errors; --royalty-cap overrides.
  const maxRoyaltyBps = flags['royalty-cap'] === undefined
    ? Math.max(1000, royaltyBps)
    : parseRoyaltyBps(String(flags['royalty-cap']));
  if (royaltyBps > maxRoyaltyBps) {
    throw new Error(`--royalty-bps ${royaltyBps / 100}% exceeds --royalty-cap ${maxRoyaltyBps / 100}%; raise the cap or lower the royalty.`);
  }
  const burnable = flags.burnable === '' || flags.burnable === 'true';
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = flags['public-base-url'] ?? resolveBaseUrl(port);

  console.log(
    bold(
      `\n  ABX Self-Host Toolkit — deploy edition series\n  ${dim(
        editionSize === 0n
          ? 'EditionImage (ERC-1155) — N ids from the folder, each an OPEN edition'
          : `EditionImage (ERC-1155) — N ids from the folder × ${editionSize} cop${editionSize === 1n ? 'y' : 'ies'} each`,
      )}`,
    ),
  );
  if (editionSize === 1n) info(copiesOneNote('deploy-series'));

  if (!flags.dir) {
    throw new Error(
      'abx deploy-series --copies <n|open> --dir <media-dir> [--count N] [--mint-all | --mint-count N | --no-mint] [--mint-amount N] ' +
        '[--onchain-uri (inline SVG) | --backend ipfs|arweave|cloud (off-chain, hosted resolver) | --public-base-url https://…] ' +
        '[--minter 0x..] [--primary-payee 0x..] [--unpaused] [--721c recommended|0x..] --name "Title" --symbol SYM',
    );
  }
  const dirPath = resolvePath(flags.dir);
  const files = readdirSync(dirPath)
    .filter((f) => !f.startsWith('.') && statSync(joinPath(dirPath, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  if (files.length === 0) throw new Error(`no media files in ${dirPath}`);
  const count = flags.count ? Number(flags.count) : files.length;
  if (!Number.isInteger(count) || count <= 0) throw new Error('--count must be a positive integer');
  if (count > files.length) throw new Error(`--count ${count} exceeds the ${files.length} media file(s) in ${dirPath}`);
  const slots = files.slice(0, count);

  const dryRun = isDryRun(flags);
  if (dryRun) assertPreviewDeployer(flags);
  assertRealIdentity(flags, {name, symbol, dryRun});
  const lane = laneFromFlags(flags);
  const onchainImage = !!flags['onchain-image'];
  const compress = parseCompress(flags.compress);
  // Staging is a SEQUENCE (chunk writes → the deploy that references each manifest) where every tx's
  // receipt feeds the next, so it can't be signed offline in one run. Refused on the cold lane for the
  // same reason on every lineage, 721 and edition alike; hot + wallet both work.
  if (onchainImage && lane === 'unsigned') {
    throw new Error(
      'Staging on-chain images (--onchain-image) needs interactive signing — each chunk tx feeds ' +
        "the next, so it can't run on the cold lane (--unsigned). Use the hot lane (a funded key) or --sign (browser wallet).",
    );
  }
  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertChainId(CHAIN, {allowUnreachable: dryRun});

  const transferValidator = await resolveTransferValidatorFlag(flags, publicClient, dryRun, '1155C');

  // Mint timing: `mintCount` ids premint (SAME meaning as the 721 lane's --mint-all/--mint-count —
  // how many DISTINCT ids), `mintAmount` is the NEW knob: copies of EACH premint id.
  const mintCount = flags['mint-all'] !== undefined ? count : flags['mint-count'] ? Number(flags['mint-count']) : 0;
  if (mintCount > count) throw new Error(`--mint-count ${mintCount} exceeds the series size ${count}`);
  if (flags['no-mint'] !== undefined && (flags['mint-all'] !== undefined || flags['mint-count'] !== undefined)) {
    throw new Error('--no-mint contradicts --mint-all/--mint-count — drop one.');
  }
  const effectiveMintCount = flags['no-mint'] !== undefined ? 0 : mintCount;
  const mintAmount = effectiveMintCount > 0 ? (flags['mint-amount'] !== undefined ? parseNonNegativeIntFlag(flags['mint-amount'] as string, 'mint-amount') : 1n) : 0n;
  if (effectiveMintCount > 0 && mintAmount === 0n) {
    throw new Error('--mint-amount 0 with ids being pre-minted at deploy makes no sense — pass a positive --mint-amount, or drop --mint-all/--mint-count to defer minting entirely.');
  }

  // `--onchain-image` IMPLIES on-chain resolution — bytes on-chain behind a renderer that has no
  // reason to defer to a server. Every sibling lane already reads it that way (the 1/1, the
  // 1/1-edition, the 721 Series); this one didn't, which was harmless only while `--onchain-image`
  // was refused here. Now that it's wired, omitting it would demand a `--public-base-url` for a drop
  // whose bytes are already on-chain — incoherent, and it would bake a resolver URL nobody needs.
  const onChainUri = !!flags['onchain-uri'] || onchainImage;
  const minter = (flags.minter as Address) ?? zeroAddress;
  const paused = flags.unpaused === undefined;
  const primaryPayee = (flags['primary-payee'] as Address) ?? zeroAddress;
  const explicitSalt = parseSaltFlag(flags.salt);
  const hasPublicUrl = !!(flags['public-base-url'] || process.env.ABX_PUBLIC_BASE_URL);

  step('Trust anchor');
  let factory: Address;
  if (dryRun) {
    const existing = editionFactoryAddress(flags.factory);
    if (!existing) {
      info('no canonical edition factory for this chain yet — a real deploy would deploy the trust anchor first.');
      console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
      return;
    }
    factory = existing;
    if (!(await previewFactoryLive(publicClient, factory, 'edition factory'))) return;
    info(`would reuse canonical edition factory ${factory}`);
  } else {
    factory = await ensureEditionFactory(flags.factory, !!flags['bootstrap-factory']);
  }

  let renderer: Address = zeroAddress;
  if (onChainUri) {
    step('On-chain renderer');
    renderer = dryRun ? ((rendererAddress(flags.renderer) as Address) ?? zeroAddress) : await ensureRenderer(flags.renderer);
    // Say WHICH renderer, like the 1/1 lane does. Both series lanes printed the step header with
    // nothing under it, while the skill's confirm-readout template implies an address is quotable
    // there — so an agent relaying the readout had a blank line to explain.
    info(renderer === zeroAddress ? 'would deploy the canonical renderer first' : `${dryRun ? 'would use' : 'using'} renderer ${renderer}`);
  }

  if (!onChainUri) {
    const loopback = loopbackBaseUrl(baseUrl);
    if (!hasPublicUrl || loopback) {
      const devAllow = process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1';
      const msg =
        `Off-chain metadata needs a PUBLIC resolver URL baked on-chain — ${hasPublicUrl ? baseUrl : 'localhost'} resolves for no one. ` +
        `Pick a real path:\n    • Fully on-chain (SVG content): --onchain-uri\n    • Hosted resolver:              --public-base-url https://your.domain`;
      if (!devAllow) {
        if (dryRun) warn(`would REFUSE to deploy — ${msg}`);
        else throw new Error(msg);
      } else {
        warn(`DEV ONLY (ABX_DEV_ALLOW_LOCALHOST_URI): baking ${bold(baseUrl)} on-chain — resolves only on THIS machine.`);
      }
    }
  }

  step(`Prepare ${count} id(s) from ${basename(dirPath)}/`);
  const overrides = storageOverrides(flags);
  const opts = storageOptions(overrides);
  const backendId = overrides.backend ?? process.env.ABX_STORAGE_BACKEND ?? 'fs';
  // Pattern 2 — image off-chain on a durable backend, JSON rendered on-chain, NOTHING to run. Ported
  // from the 721 Series twin, which has had it all along; `EditionImage` shipped without it, so a
  // multi-work raster edition otherwise has no server-free option.
  // Nothing on-chain needed changing: `EditionImageInitParams` already takes `contractFields`, and the
  // renderer's `url-template` substitutes `{id}` from whatever id it is called with — `uri(id)` on a
  // 1155 reaches it exactly as `tokenURI(id)` does on a 721.
  const directUrlBackend = backendId === 'ipfs' || backendId === 'arweave' || backendId === 'cloud';
  const offchainImageOnchainJson = onChainUri && !onchainImage && directUrlBackend;
  const backend = (offchainImageOnchainJson || (!onChainUri && !onchainImage)) && !dryRun ? resolveBackend(opts) : undefined;
  const tokenPaths = slots.map((s, i) => ({tokenId: i, name: s, path: joinPath(dirPath, s)}));
  // The render-gas gate on the dry run. Unlike the 721 Series twin this lane has no per-id
  // `previewImageStaging` line to hang it off, so without this an oversized edition would only be
  // refused once `buildFields` reached the first real staging call — i.e. after the chunk store was
  // already deployed. Same per-id predicate either way (`guardOnChainSize` runs again during staging).
  if (onchainImage && dryRun) {
    for (const {name, path} of tokenPaths) await guardOnChainSize(statSync(path).size, name);
  }
  // Say WHICH backend holds the bytes, exactly as the 1/1 lane does. Both Series lanes resolved a
  // backend and never named it, so a creator asking for "images on IPFS" had no way to confirm from
  // the preview that their collection would actually pin there — the flag was accepted in silence.
  if (!onchainImage && (offchainImageOnchainJson || !onChainUri)) {
    const sr = backendResolution(overrides);
    info(`storage: ${sr.backend} ${dim(`(${sr.source === 'flag' ? '--backend' : sr.source === 'env' ? 'env' : 'default'})`)} — byte custody for the image(s)`);
    const gwWarn = localGatewayWarning(flags);
    if (gwWarn) warn(gwWarn);
  }

  const seriesTraits = parseSeriesTraits(
    flags.attributes ? readFileSync(resolvePath(process.cwd(), flags.attributes as string), 'utf8') : undefined,
    slots,
  );
  const seriesTraitsOnchain = seriesTraits.size > 0 && (!!flags['traits-onchain'] || onChainUri);
  const offChainTokenTraits =
    seriesTraits.size && !seriesTraitsOnchain
      ? JSON.stringify(Object.fromEntries([...seriesTraits].map(([id, a]) => [String(id), a])))
      : undefined;

  // Wallet-signature count for THIS deploy — parity with the 721 Series twin, which prints it and
  // whose count the skill promises "every preview" shows. Same per-id chunk math as that twin, so the
  // preview, the confirm text, and the wallet session's `total` can never disagree.
  const approvals = onchainImage
    ? tokenPaths.reduce((n, {path}) => {
        const plan = computeContentPlan(readFileSync(path), compress).plan;
        return n + (plan.mode === 'single' ? 1 : plan.txCount);
      }, 0) + 1 // + the deploy tx
    : 1;

  const tokenFields: EditionTokenFieldInput[] = [];
  // Collection-scope fields the image lane may add (the O(1) directory image). Kept separate from the
  // authorship fields and CONCATENATED at the params site — never assigned over them, or an
  // `--creator`/`--license` value would silently vanish whenever pattern 2 is in play.
  let imageContractFields: OnChainFieldInput[] = [];
  const buildFields = async (stage?: Parameters<typeof stageImageFieldsBatch>[2]): Promise<void> => {
    // Pattern 1: the bytes themselves on-chain, staged into the shared chunk store per id, each id's
    // field pointing at its manifest. Ported from the 721 Series twin — the edition lane refused this
    // outright before the edition parity work, though nothing on-chain prevented it.
    if (onchainImage) {
      const {fields} = await stageImageFieldsBatch(tokenPaths.map((s) => s.path), compress, stage!, flags['chunk-store']);
      tokenPaths.forEach(({tokenId}, i) => tokenFields.push(tokenFieldOf(tokenId, fields[i])));
      if (seriesTraitsOnchain) for (const [tokenId, attrs] of seriesTraits) tokenFields.push(tokenFieldOf(tokenId, attributesInlineField(attrs)));
      info(`uri()/contractURI() resolve ON-CHAIN via the renderer — the image BYTES are on-chain too, nothing off-chain at all.`);
      return;
    }
    // Pattern 2: one durable upload per id, then a locator on-chain instead of the bytes.
    if (offchainImageOnchainJson) {
      const exts = tokenPaths.map(({path}) => extname(path).toLowerCase());
      const uniform = exts[0] !== '' && exts.every((e) => e === exts[0]);
      if (dryRun || !backend) {
        if (uniform) {
          imageContractFields = [imageLocatorField(backendId, `<${backendId}-dir>/{id}${exts[0]}`, true)];
          info(`would upload ${tokenPaths.length} file(s) as ONE ${backendId} directory → collection image <${backendId}-dir>/{id}${exts[0]} (O(1); ${describeLocatorField(backendId)})`);
          // Name the SERVING prefix in the plan too. Without it a preview says "the gateway is the
          // collection's preference" and never says what that preference resolves to, so a reader
          // fills the blank with the upload gateway they just typed — the same confusion the live
          // narration used to cause outright.
          if (backendId === 'ipfs' || backendId === 'arweave') {
            const {prefix, chosen} = servingGateway(backendId, flags);
            info(`served from ${bold(prefix)} ${dim(chosen ? '(your --' + backendId + '-gateway, written on-chain)' : `(public default — nothing written; repoint any time with ${bold('abx set-gateway')})`)}`);
          }
        } else {
          for (const {tokenId} of tokenPaths) tokenFields.push(tokenFieldOf(tokenId, imageLocatorField(backendId, `<${backendId}-url-${tokenId}>`)));
          info(`would upload ${tokenPaths.length} file(s) to ${backendId} → per-id image fields (mixed extensions, O(N); ${describeLocatorField(backendId)})`);
        }
      } else if (uniform && backend.putDirectory) {
        // O(1) directory-base: upload the folder renamed to {id}{ext}; ONE collection url-template.
        const entries = tokenPaths.map(({tokenId, path}) => ({name: `${tokenId}${exts[0]}`, bytes: new Uint8Array(readFileSync(path)), contentType: contentTypeFromPath(path)}));
        const {base} = await backend.putDirectory(entries);
        const template = `${base}/{id}${exts[0]}`;
        imageContractFields = [imageLocatorField(backendId, template, true)];
        info(`uploaded ${entries.length} file(s) as one ${backendId} directory`);
        info(`collection image: ${template}  ${dim(`— one field covers every id (O(1); ${describeLocatorField(backendId)})`)}`);
      } else {
        // mixed extensions (or no directory support): per-id url fields (O(N)).
        for (const {tokenId, name: fname, path} of tokenPaths) {
          const bytes = new Uint8Array(readFileSync(path));
          const hash = hashContent(bytes);
          await backend.put(hash, {bytes, contentType: contentTypeFromPath(path)});
          const locator = (await backend.locator?.(hash)) ?? '';
          if (!locator) throw new Error(`backend ${backendId} returned no public locator for id ${tokenId} — a durable backend (ipfs/arweave/cloud) is required for --onchain-uri image hosting`);
          tokenFields.push(tokenFieldOf(tokenId, imageLocatorField(backendId, locator)));
          info(`id ${tokenId} ← ${fname} → ${locator}`);
        }
        info(`mixed file extensions → per-id image fields (O(N)); a uniform extension enables the O(1) directory template`);
      }
      if (seriesTraitsOnchain) for (const [tokenId, attrs] of seriesTraits) tokenFields.push(tokenFieldOf(tokenId, attributesInlineField(attrs)));
      info(`uri()/contractURI() resolve ON-CHAIN via the renderer — the image bytes live on ${backendId}, so there is still no server to run.`);
      return;
    }
    for (const {tokenId, name: fname, path} of tokenPaths) {
      const bytes = new Uint8Array(readFileSync(path));
      const contentType = contentTypeFromPath(path);
      if (onChainUri) {
        const text = Buffer.from(bytes).toString('utf8');
        if (!looksLikeSvg(text)) {
          // Name the real alternatives, the way the 721 twin's version of this refusal does. The
          // `--backend` route is the first suggestion
          // because it IS available on this lane (see `offchainImageOnchainJson` above).
          throw new Error(
            `--onchain-uri inlines SVG only; id ${tokenId} "${fname}" is ${contentType}. For raster content in ONE edition contract:\n` +
              `    • No server, images off-chain:  add --backend arweave (or ipfs/cloud) — the image URL is baked into the on-chain JSON\n` +
              `    • Host the metadata yourself:   drop --onchain-uri and pass --public-base-url https://your.domain\n` +
              `    • Keep it SVG:                  supply SVG content and --onchain-uri inlines every id on-chain\n` +
              `    • Bytes fully on-chain:         --onchain-image --compress fastlz (hot or --sign lane; --unsigned is refused)`,
          );
        }
        tokenFields.push(tokenFieldOf(tokenId, imageInlineField(text)));
      } else {
        const hash = hashContent(bytes);
        if (backend) await backend.put(hash, {bytes, contentType});
        tokenFields.push(tokenFieldOf(tokenId, imageKeccakField(hash)));
      }
      info(`id ${tokenId} ← ${fname} ${dim(`(${bytes.length}B ${contentType})`)}`);
    }
    if (seriesTraitsOnchain) for (const [tokenId, attrs] of seriesTraits) tokenFields.push(tokenFieldOf(tokenId, attributesInlineField(attrs)));
    // AFTER the per-id content actually validated — stating "resolves ON-CHAIN, no server" and then
    // refusing the very content that was passed reads as the tool contradicting itself.
    if (onChainUri) {
      info(`uri()/contractURI() resolve ON-CHAIN via the renderer — no resolver, no server, no localhost.`);
      if (!hasPublicUrl) info('off-chain fallback pointer left empty (the renderer is authoritative); set --public-base-url to bake one anyway.');
    }
  };

  if (!dryRun) {
    const custody = onChainUri ? 'inline SVG on-chain' : `off-chain custody (${backendId})`;
    await confirmSend(
      `About to deploy an edition series "${name}" (${symbol}) — ${count} id(s) × ${editionSize === 0n ? 'open' : editionSize.toString()} cop${editionSize === 1n ? 'y' : 'ies'} each; ${custody}; ` +
        `mint: ${effectiveMintCount > 0 ? `${effectiveMintCount} id(s) × ${mintAmount} at deploy` : 'deferred'}; approvals: ${approvals} wallet approval(s); owner+royalty: your wallet @ ${royaltyBps / 100}%.` +
        (transferValidator !== zeroAddress ? ` ERC-1155C: enrolled at deploy, permanently (validator ${transferValidator}).` : ''),
      flags,
    );
  }
  // `--onchain-image` defers field-building to a lane branch below: the hot lane stages with the env
  // key, the wallet lane inside its sign session. Every other custody mode can build up front.
  if (!onchainImage) await buildFields();

  const buildForDeployer = async (deployer: Address) => {
    assertLaneCanSign(flags); // no upload before we know this run can be signed — see `assertLaneCanSign`
    const salt = explicitSalt ?? saltFor(deployer);
    const clone = await predictClone(publicClient, {factory, salt});
    const params: EditionImageInitParams = {
      owner: deployer,
      name,
      symbol,
      tokenURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/t`,
      tokenURIRenderer: renderer,
      contractURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/c`,
      contractURIRenderer: renderer,
      royaltyReceiver: deployer,
      royaltyBps,
      maxRoyaltyBps,
      burnable,
      transferValidator,
      maxInvocations: count,
      editionSize,
      primaryPayee,
      minter,
      paused,
      mintTo: effectiveMintCount > 0 ? deployer : zeroAddress,
      mintCount: effectiveMintCount,
      mintAmount,
      tokenFields,
      // Concatenate — the image lane's collection-scope url-template rides ALONGSIDE the authorship
      // fields. Assigning either over the other would silently drop the creator's --creator/--license.
      contractFields: [...authorshipContractFields(flags), ...gatewayContractFields(flags), ...imageContractFields],
    };
    return {clone, params, salt};
  };

  let clone: Address;
  let blockNumber: bigint;
  // See the 1/1 lane's identical local for why this is hoisted (feeds the sent plan's `roles`).
  let deployerAddr: Address | undefined;

  if (dryRun) {
    let deployer: Address;
    if (flags.for) deployer = flags.for as Address;
    else {
      try {
        deployer = makeWalletClient({chainKey: CHAIN}).account.address;
      } catch {
        throw new Error('dry run needs a deployer address to compute the deterministic deploy address — pass --for 0x.. (a preview signs nothing).');
      }
    }
    const {clone: predicted, params, salt} = await buildForDeployer(deployer);
    info(`deployer ${deployer}`);
    await warnUnfunded(publicClient, deployer);
    if (explicitSalt) info(`deterministic address: ${predicted}`);
    info(`name    "${name}"${flags.name ? '' : dim('  (default — pass --name)')}`);
    info(`symbol  ${symbol}${flags.symbol ? '' : dim('  (default — pass --symbol)')}`);
    info(`ids     ${count} (id-space cap)`);
    info(`copies  ${editionSize === 0n ? 'open (uncapped) per id' : `${editionSize} per id`}`);
    info(`royalty ${royaltyBps / 100}% → ${deployer}${flags['royalty-bps'] ? '' : dim('  (default 5%)')}`);
    info(`royalty cap ${maxRoyaltyBps / 100}%${flags['royalty-cap'] !== undefined ? '' : maxRoyaltyBps > 1000 ? dim('  (auto-raised to fit the royalty)') : dim('  (default 10%)')} ${dim('— reduce-only ceiling; lower later with `abx set-royalty-cap`')}`);
    info(`burnable ${burnable ? `yes ${dim('— holders may burn their own token')}` : `no ${dim('(no token can be destroyed)')}`}`);
    info(`tokenURI base   ${params.tokenURIBase || dim('(empty — resolves on-chain via the renderer)')}`);
    info(`mint: ${effectiveMintCount > 0 ? `${effectiveMintCount} id(s) × ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} → ${deployer} at deploy` : 'deferred'}`);
    if (minter !== zeroAddress) info(`minter  ${minter}`);
    if (primaryPayee !== zeroAddress) info(`primary payee  ${primaryPayee}`);
    // `paused` gates whether the public can mint at all — the 1/1-edition twin prints it and an
    // edition sale is the point of the lane, so it belongs in the readout, not just in the params.
    info(`paused  ${paused}${flags.unpaused ? '' : dim('  (default — pass --unpaused to open at deploy)')}`);
    info(`approvals   ${approvals} wallet approval(s)`); // parity with the 721 Series twin
    if (!explicitSalt) {
      console.log(`\n  ${bold('salt')}  ${g(salt)}`);
      info(`address: pinned by salt — re-run with ${bold(`--salt ${salt}`)} (same address).`);
    }
    console.log(`\n  ${g('dry run')} ${dim('— nothing sent, no bytes stored. Re-run without --dry-run to deploy.')}\n`);
    emit(jsonSafe({
      command: 'deploy-series', kind: 'edition', copies: editionSize.toString(), ids: count, dryRun: true, sent: false, address: explicitSalt ? predicted : null, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, salt, saltPinned: !!explicitSalt, name, symbol,
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: 'series-edition' satisfies DeployPlanFamily,
        lane,
        transactions: {approvals, legs: onchainImage ? ['onchain-image-staging (per id)', 'deploy'] : null},
        roles: {
          signer: deployer, owner: deployer, royaltyReceiver: deployer,
          primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
          minter: minter !== zeroAddress ? minter : null,
        },
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          imageOnChain: onchainImage,
          backend: !onchainImage && (offchainImageOnchainJson || !onChainUri) ? backendId : null,
          tokenUriBase: params.tokenURIBase || null,
          contractUriBase: params.contractURIBase || null,
          renderer: onChainUri ? renderer : null,
          // Series-edition stages ONE FILE PER id under --onchain-image — no single-file shape fits
          // (see this field's own doc comment) — so this stays null even when `imageOnChain` is true.
          image: null,
        },
        mint: {
          deferred: effectiveMintCount === 0,
          count: effectiveMintCount,
          amountPerId: mintAmount.toString(),
          recipient: effectiveMintCount > 0 ? deployer : null,
        },
        estimate: {ethApprox: null, gasApprox: null},
        warnings: planWarnings.slice(),
        surfaces: null,
        dependencies: null,
        resume: null,
      } satisfies DeployPlan,
    }));
    return;
  }

  if (lane === 'send') {
    const {wallet, account} = makeWalletClient({chainKey: CHAIN});
    deployerAddr = account.address;
    // hot lane: the env key stages every id up front (deployer-independent), then deploys.
    if (onchainImage) await buildFields(envStagingSender());
    const {clone: predicted, params, salt} = await buildForDeployer(account.address);
    info(`deterministic address: ${predicted}`);
    info(`mint: ${effectiveMintCount > 0 ? `${effectiveMintCount} id(s) × ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} → ${account.address} at deploy` : 'deferred'}`);
    const send = makeHotSender({wallet, account, publicClient});
    const r = await deployEditionImage(send, publicClient, {factory, params, salt});
    clone = predicted;
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else if (lane === 'sign' && onchainImage) {
    // Wallet lane + on-chain staging: ONE session signs every chunk write across all ids AND the
    // deploy. The connecting wallet pays for (and owns) it; staging can't precede the connect, so it
    // runs inside the session and the deploy then bakes in every id's manifest.
    info(`a wallet will become the owner; it will approve ${approvals - 1} staging tx(s) + the deploy in one session.`);
    const session = await openWalletSession({
      chainKey: CHAIN,
      expectedSigner: flags.for as Address | undefined,
      total: approvals, // the SAME staging-tx math the preview's `approvals` line reports
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    let r: {txHash: Hex; blockNumber: bigint};
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      await buildFields(sessionStagingSender(session));
      const {clone: predicted, params, salt} = await buildForDeployer(signer);
      info(`mint: ${effectiveMintCount > 0 ? `${effectiveMintCount} id(s) × ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} → ${signer} at deploy` : 'deferred'}`);
      const sent = await session.send(prepareDeployEditionImage({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted}));
      r = {txHash: sent.txHash, blockNumber: sent.receipt.blockNumber};
      clone = predicted;
    } finally {
      session.close();
    }
    blockNumber = r.blockNumber;
    ok(`deployed ${clone}`);
    info(`tx ${explorerBase()}/tx/${r.txHash}  (block ${blockNumber})`);
  } else {
    info(onChainUri ? 'a wallet will become the owner; the tokens resolve from chain — no URI base is baked in.' : `a wallet will become the owner; URIs point at ${baseUrl}`);
    const result = await signTx(
      async (signer) => {
        deployerAddr = signer;
        const {clone: predicted, params, salt} = await buildForDeployer(signer);
        return prepareDeployEditionImage({factory, params, salt, chainId: resolveChain(CHAIN).id, clone: predicted});
      },
      {lane, chainKey: CHAIN, yes: !!flags.yes, expectedSigner: flags.for as Address | undefined, port: flags.port ? Number(flags.port) : undefined, signUrlFile: flags['sign-url-file']},
    );
    if (!result) {
      console.log(`\n${dim(`  unsigned — broadcast it, then: abx add <clone> --factory ${factory} --from-block <deployBlock>`)}\n`);
      return;
    }
    clone = result.prepared.fields.clone as Address;
    blockNumber = result.blockNumber;
    ok(`deployed ${clone}`);
  }
  emit(jsonSafe({
    command: 'deploy-series', kind: 'edition', copies: editionSize.toString(), ids: count, address: clone, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, deployBlock: blockNumber, name, symbol,
    plan: {
      schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
      family: 'series-edition' satisfies DeployPlanFamily,
      lane,
      transactions: {approvals, legs: onchainImage ? ['onchain-image-staging (per id)', 'deploy'] : null},
      roles: {
        signer: deployerAddr ?? null, owner: deployerAddr ?? null, royaltyReceiver: deployerAddr ?? null,
        primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
        minter: minter !== zeroAddress ? minter : null,
      },
      royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
      custody: {
        onChainUri,
        imageOnChain: onchainImage,
        backend: !onchainImage && (offchainImageOnchainJson || !onChainUri) ? backendId : null,
        tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
        contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
        renderer: onChainUri ? renderer : null,
        image: null, // per-id staging — see the dry-run emit's identical comment
      },
      mint: {
        deferred: effectiveMintCount === 0,
        count: effectiveMintCount,
        amountPerId: mintAmount.toString(),
        recipient: effectiveMintCount > 0 ? deployerAddr ?? null : null,
      },
      estimate: {ethApprox: null, gasApprox: null},
      warnings: planWarnings.slice(),
      surfaces: null,
      dependencies: null,
      resume: null,
    } satisfies DeployPlan,
  }));

  step('Index it — replay the event spine from chain');
  const indexer = localIndexer();
  const offChainTraits = !seriesTraitsOnchain && offChainTokenTraits ? offChainTokenTraits : undefined;
  const baseReg = {
    address: clone,
    chainKey: CHAIN,
    fromBlock: blockNumber.toString(),
    factory,
    label: name,
    description: flags.description,
    externalUrl: flags['external-url'],
    tokenAttributes: offChainTraits,
  };
  indexer.register(baseReg);
  const {state, elapsedMs} = await reindexAfterDeploy(indexer, clone);
  if (state.eventCount > 0) ok(`reconstructed ${state.eventCount} events in ${elapsedMs}ms — no provider involved`);
  info(`name "${state.name}" · owner ${state.owner} · canonical: ${canonicalLabel(state.isCanonical)}`);

  const contentLocators = !onChainUri ? await collectContentLocators(state, resolveBackend(storageOptions(storageOverrides(flags)))) : {};
  if (Object.keys(contentLocators).length) {
    indexer.register({...baseReg, contentLocators: JSON.stringify(contentLocators)});
  }

  const isRemoteBase = !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(baseUrl);
  if (onChainUri) {
    console.log(`\n${g('Done — fully on-chain.')} ${dim('Every id self-resolves; no server needed.')}`);
    console.log(`  ${bold(`abx tokenuri ${clone} --token 0`)}  ${dim('# read uri(0) straight from the contract')}`);
  } else {
    console.log(`\n${g('Edition series deployed.')} ${effectiveMintCount > 0 ? '' : dim('(deferred mint — warm the resolver, then mint)')}`);
    if (isRemoteBase) console.log(`  ${bold(`abx add ${clone} --remote`)}  ${dim('# register with the hosted resolver')}`);
    else console.log(`  ${bold('abx serve')}  ${dim('# stand up the resolver locally')}`);
  }
  console.log(`  ${bold(`abx mint ${clone} --token-id <id> --amount <n>`)}  ${dim('# mint more copies of an id')}`);
  console.log(`  ${bold(`abx minter configure ${clone} --token-id <id> --price <eth> --allocation <n>`)}  ${dim('# set up a priced sale for one id')}`);
  console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces once metadata is live')}\n`);
}

// ── deploy-code ──────────────────────────────────────────────────────────────
/**
 * `abx deploy-code` — deploy a code project ({SeriesCode}) end to end, hot lane:
 * the canonical factory + seed source from the manifest, fat initialize (the `code`
 * field rides it in directory mode), then ONE post-deploy multicall for the script
 * chunks (template mode) + any PostParam schemas, optional reserve mints, and local
 * register + index.
 *
 * Modes (exactly one):
 *   --script <file>    template mode — the program stored on-chain in chunks
 *   --code-dir <dir>   directory mode — the build uploaded via the storage backend
 *                      (`putDirectory`; ipfs/arweave), its root as the `code` field
 *
 * Schemas: --schema key:Type:Auth[,key:Type:Auth…] (e.g. palette:HexColor:TokenOwner).
 * Seeds: the canonical pseudorandom seed source by default; --no-seed opts out.
 */

/**
 * The one honest sentence about the canonical seed, printed beside the `seed source` line in the
 * deploy plan — the moment a creator is choosing it, not an appendix. `AbxSeedSource` is
 * pseudorandom from on-chain values: replayable after the mint (what makes generative output
 * verifiable) and computable *during* it, so a buyer can decline an outcome for the price of gas.
 * That rules out anything lottery-like; the escape hatch is a per-project address, so we name it —
 * and now name it as the FLAG it is (`--seed-source 0x…`), not as an env var, because the flag is
 * probed and the whole point of naming an escape hatch is that a creator can actually reach it.
 */
const seedHonestyNote =
  '  pseudorandom — replayable after the mint, computable DURING it (a buyer can decline an outcome).\n' +
  '      Right for diversifying output; NOT strong enough for a raffle or prize draw — for that, pass\n' +
  '      --seed-source 0x… pointing at your own IAbxSeedSource over commit-reveal or a VRF oracle\n' +
  '      (a per-project swap, not a fork). Change it later with `abx set-seed-source`.';

/**
 * The `seed source` line of a deploy plan, for both code lanes. Three states, three different
 * sentences — the honesty note describes `AbxSeedSource`'s OWN properties, so printing it beside a
 * stranger's contract would be us vouching for randomness we have never seen.
 */
function printSeedSourcePlan(seedSource: Address, chainId: number): void {
  if (seedSource === zeroAddress) {
    info('seed source: none (--no-seed / not configured)');
    return;
  }
  if (seedSource.toLowerCase() === canonicalSeedSource(chainId).toLowerCase()) {
    info(`seed source: ${seedSource} ${dim('(canonical AbxSeedSource)')}`);
    info(seedHonestyNote);
    return;
  }
  info(`seed source: ${seedSource} ${dim('— CUSTOM (yours, not the canonical AbxSeedSource)')}`);
  info(
    '  probed: it answers seed(uint256,address) with 32 bytes. Its randomness properties are YOURS to\n' +
      '      state to buyers — ABX makes no claim about them, and the honesty note above does not apply.',
  );
}
// ── the demo walkthrough: teaching sections, demo-only ────────────────────────
//
// `abx demo` is a TEACHING command, not a shortcut — the docs point a first-time reader here to
// learn what the toolkit does on their behalf. Its old form asserted the interesting claims
// ("reconstructed 9 events — no provider involved") without ever showing them, which made it a
// smoke test wearing a demo's clothes. These sections demonstrate instead: print the spine the
// chain now holds, throw the local projection away and rebuild it, then read the token back the way
// a marketplace would. They run only for `demo` (never `deploy`), and never pause — an agent or CI
// run has to behave identically.

/**
 * The deterministic part of a projection: everything that is a pure function of the chain.
 * Deliberately EXCLUDES `reconstructedAt`, `rpcUrl` and `toBlock` — a timestamp, the endpoint that
 * happened to answer, and the head at scan time all legitimately differ between two replays, so
 * folding them in would make the rebuild proof fail for reasons that aren't about correctness.
 */
export function projectionFingerprint(s: ProjectState): string {
  const canonical = {
    address: s.address.toLowerCase(),
    name: s.name,
    symbol: s.symbol,
    owner: s.owner?.toLowerCase() ?? null,
    isCanonical: s.isCanonical,
    deployBlock: s.deployBlock,
    eventCount: s.eventCount,
    royalty: s.royalty ? {bps: s.royalty.bps, receiver: s.royalty.receiver.toLowerCase()} : null,
    extensions: s.extensions.map((e) => e.name).sort(),
    collectionFields: s.collectionFields.map((f) => `${f.field}=${f.value}`).sort(),
    tokens: s.tokens.map((t) => ({id: t.tokenId, lifecycle: t.lifecycle, owner: t.owner?.toLowerCase() ?? null})),
    events: s.events.map((e) => `${e.blockNumber}:${e.logIndex}:${e.name}`),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Print the reconstructed spine — the point being that this list IS the database. Rendered inside
 * the index step (no header of its own: "Index it — replay the event spine" immediately followed by
 * a separate "The event spine" step read as a stutter).
 */
export function walkthroughSpine(state: ProjectState): void {
  if (state.events.length === 0) {
    warn('no events to show (the index came back empty — see the recovery hint above).');
    return;
  }
  const width = Math.max(...state.events.map((e) => e.name.length));
  state.events.forEach((e, i) => {
    // ERC vs ABX register: standard ERC-721 events a marketplace already understands, versus ABX's
    // own. Worth surfacing — it's why an ABX token indexes fine on tools that know nothing about ABX.
    const reg = e.register === 2 ? p('ABX') : dim('ERC');
    console.log(`    ${dim(`#${String(i + 1).padStart(2)}`)} ${reg} ${e.name.padEnd(width)}  ${dim(e.what)}`);
  });
  console.log(
    `    ${dim('→')} those ${bold(String(state.events.length))} lines ${bold('are')} the database. ` +
      dim('There is no other copy that counts — not ours, not anyone\'s.'),
  );
  console.log(
    `      ${p('ABX')} ${dim('= ABX\'s own events')}   ${dim('ERC')} ${dim('= bog-standard ERC-721/7572, which is why wallets and marketplaces that have never heard of ABX still show your token.')}`,
  );
}

/**
 * [4] The claim, demonstrated: delete the local projection and rebuild it from the chain.
 *
 * This is the one step that can't be faked by good output — it drops the projection for real
 * (registration kept), confirms it's gone, replays from the deploy block, and compares a
 * fingerprint of everything chain-derived. If ABX's premise is wrong, this step fails loudly.
 */
export async function walkthroughRebuild(indexer: SelfHostIndexer, address: Address, before: ProjectState): Promise<void> {
  step('The moment of truth · delete it all');
  const fpBefore = projectionFingerprint(before);
  indexer.dropProjection(address);
  const gone = indexer.getProject(address) === null;
  console.log(`    ${dim('wiping this computer\'s copy …')}          ${gone ? g('gone. nothing left locally.') : `${c.orange}⚠ still present${c.reset}`}`);
  const {state: after, elapsedMs} = await indexer.reindex(address, {full: true});
  const fpAfter = projectionFingerprint(after);
  console.log(
    `    ${dim(`asking ${CHAIN} to tell us everything again …`)}   ` +
      `${g(`${after.eventCount} events, ${elapsedMs}ms`)}`,
  );
  if (fpBefore === fpAfter) {
    ok(bold('byte-for-byte identical.'));
    info('Your token just survived losing every local file. No backup, no API key, no company —');
    info(`the chain remembered. ${dim('That is the whole point of ABX.')}`);
    info(dim(`checked by hashing every chain-derived field, not by eyeballing it: sha256 ${fpAfter.slice(0, 12)}…`));
  } else {
    warn('the rebuilt state does NOT match what we just had — that is a real bug, please report it.');
    info(`before ${fpBefore.slice(0, 16)}… · after ${fpAfter.slice(0, 16)}…`);
  }
}

/**
 * [5] Read the token back the way a marketplace would.
 *
 * Which is genuinely a different act per lane, so it reads from the real source in each case rather
 * than always going through the local server:
 *   • fully on-chain → call `tokenURI(0)` on the contract. That IS what a marketplace does, and on
 *     this lane the whole answer (content included) comes back from the chain with nothing else running.
 *   • off-chain custody → fetch the resolver, because that's what the baked URI points at.
 * Reading the on-chain lane over HTTP would have quietly implied the local server was load-bearing
 * when it isn't — the opposite of the lesson.
 */
export async function walkthroughReadBack(state: ProjectState, baseUrl: string, onChainUri: boolean): Promise<void> {
  step('Read it back the way a marketplace would');
  const token = state.tokens[0];
  if (token?.lifecycle !== 'live') {
    info(token?.lifecycle === 'burned' ? 'token #0 was burned — nothing to read back.' : 'no minted token to read yet.');
    return;
  }
  if (onChainUri) {
    info(dim(`calling tokenURI(0) on your contract — the same call OpenSea makes …`));
    try {
      const uri = (await makePublicClient({chainKey: CHAIN}).readContract({
        address: state.address as Address,
        abi: oneOfOneImageAbi,
        functionName: 'tokenURI',
        args: [0n],
      })) as string;
      const json = decodeOnChainJson(uri);
      if (json) {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const img = typeof parsed.image === 'string' ? parsed.image : '';
        console.log(`    ${g('✓')} came back with: ${bold(String(parsed.name ?? '(no name)'))}`);
        console.log(`      ${dim(`image: ${img.slice(0, 48)}${img.length > 48 ? '…' : ''}`)}`);
        // The punchline of the whole lane: a data: URI means the work travelled IN the answer.
        if (img.startsWith('data:')) info(`${g('the work itself came back in that answer')} ${dim('— no link to follow, nothing to go missing')}`);
      } else {
        console.log(`    ${dim(uri.slice(0, 160))}${uri.length > 160 ? dim('…') : ''}`);
      }
      info(dim('nothing was running to answer that. no server of ours, no server of yours.'));
    } catch (e) {
      info(dim(`could not read tokenURI from the chain: ${(e as Error).message}`));
    }
    console.log(`    ${dim('read it yourself any time:')} ${bold(`abx tokenuri ${state.address}`)}`);
    return;
  }
  info(`tokenURI(0) ${dim('on chain →')} ${token.tokenURI ?? dim('(none)')}`);
  // Off-chain custody: the CHAIN holds a keccak256 commitment to the image and a URI base; this NODE
  // holds the bytes. That split is the thing worth understanding, so name it rather than implying the
  // JSON came from the chain.
  info(dim('the chain stored a URI base + a keccak256 commitment; this node serves the bytes.'));
  try {
    const res = await fetch(`${baseUrl}/t/${resolveChain(CHAIN).id}/${state.address}/0`);
    const json = (await res.json()) as Record<string, unknown>;
    const shown = {name: json.name, image: json.image};
    console.log(`    ${dim(JSON.stringify(shown))}`);
    if (Array.isArray(json.abx_provenance)) {
      info(dim(`every field is tagged with where it came from (abx_provenance: ${json.abx_provenance.length} entries)`));
    }
  } catch (e) {
    info(dim(`could not read the served metadata: ${(e as Error).message}`));
  }
  console.log(`    ${dim('prove the bytes match the chain:')} ${bold(`abx verify ${state.address}`)}`);
}

/** Every flag `deploy-code` recognizes — so an unsupported/typo'd one warns instead of silently
 *  no-opping. Keep in lockstep with the flags read below + the storageOverrides/lane helpers. */
export const DEPLOY_CODE_FLAGS = new Set([
  // content + collection identity
  'script', 'code-dir', 'name', 'symbol', 'description', 'external-url', 'description-onchain',
  ...AUTHORSHIP_DEPLOY_FIELDS.map(([flag]) => flag), // creator · display-notes · creator-links · license
  'image-base', 'attributes-renderer', 'image-renderer',
  // supply + mint + economics
  'max', 'mint-count', 'mint-all', 'no-mint', 'unpaused', 'minter', 'primary-payee', 'royalty-bps', 'royalty-cap', 'burnable', '721c',
  // params + dependencies
  'schema', 'no-seed', 'seed-source', 'no-delegation', 'dep', 'dep-registry',
  // serving lane
  'public-base-url', 'onchain-uri', 'generator', 'renderer', 'port',
  // storage (directory mode) — mirrors storageOverrides()
  'backend', 'endpoint', 'bucket', 'region', 'prefix', 'public-base', 'gateway', 'mode', 'api-url', 'upload-url', 'provider', 'storage-signer',
  // signing lane + safety + trust anchor ('send' = the default lane, stated explicitly; see SHARED_DEPLOY_FLAGS)
  'send', 'sign', 'unsigned', 'for', 'salt', 'factory', 'bootstrap-factory', 'sign-url-file',
  // preview / confirm
  'dry-run', 'confirm', 'yes',
  'json', // the deployed address as data, narration to stderr
  'resume', // finish an existing contract whose setup transaction never landed (no deploy)
  // Meaningful ONLY on `--resume` against an EditionCode target (per-id copies for the premint
  // shortfall) — kept in the allowlist (not stray) so a misuse elsewhere gets this function's own
  // pointed refusal instead of the generic "unrecognized flag". See the --resume block.
  'mint-amount',
]);

// Storage + signing + preview flags shared by every deploy path (mirrors storageOverrides() + the lanes).
export const SHARED_DEPLOY_FLAGS = [
  'backend', 'endpoint', 'bucket', 'region', 'prefix', 'public-base', 'gateway', 'mode', 'api-url', 'upload-url', 'provider', 'storage-signer',
  // The collection's PREFERRED SERVING gateways, written on chain (`abx_gateway_ipfs` /
  // `abx_gateway_arweave`) and repointable forever with `abx set-gateway`. Distinct from `--gateway`,
  // which is where the CLI uploads and probes; `--gateway` seeds these for the backend in use, and
  // these override it when the two should differ. Every deploy path takes them.
  'ipfs-gateway', 'arweave-gateway',
  // `--send` is the DEFAULT lane, and it is accepted explicitly because every deploy's own help
  // advertises it by name ("signing: --send hot/env key · --sign wallet page · --unsigned print tx").
  // It was the one of the three the parser rejected, so a reader who typed what the help showed got
  // `unrecognized flag(s): --send` from the guard whose whole job is catching flags that would be
  // ignored — the guard firing on the tool's own documentation. Explicit is also better than bare for
  // a script or an agent: the lane that signs and sends is worth stating out loud.
  'send',
  'sign', 'unsigned', 'for', 'sign-url-file', 'dry-run', 'confirm', 'yes', 'salt', 'factory', 'bootstrap-factory', 'port', 'renderer', 'public-base-url',
  '721c', // opt-in ERC-721C enrollment (recommended | 0x…) — every deploy path takes it
  'json', // the deployed address as data, narration to stderr — every deploy path takes it
];
// A 1/1 `abx deploy` accepts these (see `abx help deploy`). Anything else warns (typo'd/unsupported).
export const DEPLOY_FLAGS = new Set<string>([
  'image', 'name', 'symbol', 'type', 'description', 'description-onchain', 'external-url', 'traits', 'traits-onchain', 'attributes',
  'onchain-uri', 'onchain-image', 'compress', 'royalty-bps', 'royalty-cap', 'burnable', 'no-mint',
  ...AUTHORSHIP_DEPLOY_FIELDS.map(([flag]) => flag),
  ...SHARED_DEPLOY_FLAGS,
]);
// `abx deploy-series` accepts these (see `abx help deploy-series`).
export const DEPLOY_SERIES_FLAGS = new Set<string>([
  'dir', 'count', 'name', 'symbol', 'description', 'external-url', 'royalty-bps', 'royalty-cap', 'burnable', 'attributes', 'traits-onchain',
  'no-mint', 'mint-all', 'mint-count', 'unpaused', 'minter', 'primary-payee',
  'onchain-uri', 'onchain-image', 'compress', 'chunk-store',
  ...AUTHORSHIP_DEPLOY_FIELDS.map(([flag]) => flag),
  ...SHARED_DEPLOY_FLAGS,
]);

// The two edition allowlists that SPREAD an existing 721 allowlist (`DEPLOY_FLAGS`/
// `DEPLOY_SERIES_FLAGS`) — declared here, AFTER both, so the spread isn't a module-scope
// use-before-declaration (a plain function-body reference to a later `const` is fine; a spread
// inside another top-level `const`'s OWN initializer is evaluated immediately, in declaration
// order, so it isn't). `cmdDeployOneOfOneEditionBody`/`cmdDeployEditionImageBody` reference these
// by name from higher up in the file — safe, since neither is CALLED until well after the whole
// module has finished evaluating.
export const DEPLOY_EDITION_FLAGS = new Set<string>([...DEPLOY_FLAGS, 'copies', 'mint-amount', 'minter', 'primary-payee', 'unpaused']);
export const DEPLOY_SERIES_EDITION_FLAGS = new Set<string>([...DEPLOY_SERIES_FLAGS, 'copies', 'mint-amount']);

// ── code-setup gas-bounded transaction splitting ───────────────────────────────────────────────────
// A code project's post-deploy setup (script chunks + PostParam schemas + dependency declarations +
// on-chain-URI legs + reserve mints) used to ride ONE atomic multicall. A 60KB script (3 chunks)
// produced a setup transaction wanting 17,307,586 gas against the ~16,777,216 (2^24)
// `eth_estimateGas` ceiling (`MEASURED_ESTIMATE_GAS_ALLOWANCE`) — NOT the block gas limit (Sepolia's
// is 30M+) — and failed with a useless "gas limit too high", leaving a verifiably half-configured
// contract on chain.
//
// The fix below splits the setup into gas-bounded transactions, ORDERED: every script-chunk batch,
// then every config (schema/dependency/on-chain-URI) batch, then every mint batch — NEVER mixed.
// Script-chunk writes and config setters are IDEMPOTENT (an interrupted setup is finished by
// `--resume`, which diffs on-chain state and resends only what's missing — see resume.ts), so an
// interruption at ANY split point is safe. The one non-idempotent leg is the mint, which is exactly
// why it rides last, in its own batch(es), after every byte a live token could need is already
// on-chain. The invariant this protects is "no live token exists without its content wired," not "all
// setup is one transaction" (which is what broke at the ceiling — ordering survives interruption;
// atomicity fails wholesale at the ceiling).
//
// The common case (a setup that already fits one transaction) is UNCHANGED: every leg still rides ONE
// combined multicall, exactly as before this split existed.

/** One leg of a code-project setup multicall — enough to (a) estimate its own gas conservatively,
 *  (b) label an indivisible-leg refusal, and (c) let a batch rebuild `prepareCodeSetup`'s own
 *  labeling args after a leg group gets split. `calls` carries more than one entry only for a leg
 *  that must always land in the SAME transaction as its siblings (the dependency group, the
 *  on-chain-URI group) — see resume.ts's `planCoreLegs` for why those two ride as one atomic unit
 *  apiece; every other leg (a script chunk, a param schema, a reserve mint) is exactly one call. */
export interface SetupLeg {
  calls: Hex[];
  gas: number;
  label: string;
  kind: 'chunk' | 'schema' | 'deps' | 'uri' | 'mint';
  chunkBytes?: number[];
  schemaKey?: string;
}

export const chunkSetupLeg = (index: number, hex: Hex, data: Hex): SetupLeg => {
  const bytes = (hex.length - 2) / 2;
  return {calls: [data], gas: estimateChunkGasForBytes(bytes), label: `script chunk [${index}] (${bytes} bytes)`, kind: 'chunk', chunkBytes: [bytes]};
};
export const schemaSetupLeg = (key: string, data: Hex): SetupLeg => ({
  calls: [data], gas: SETUP_LEG_GAS.schema, label: `param schema '${key}'`, kind: 'schema', schemaKey: key,
});
export const depsSetupLeg = (calls: Hex[]): SetupLeg => ({
  calls, gas: calls.length * SETUP_LEG_GAS.dependency, label: `${calls.length} dependency declaration(s)`, kind: 'deps',
});
export const uriSetupLeg = (calls: Hex[]): SetupLeg => ({
  calls, gas: calls.length * SETUP_LEG_GAS.onchainUri, label: 'on-chain URI wiring', kind: 'uri',
});
export const mintSetupLeg = (data: Hex): SetupLeg => ({calls: [data], gas: SETUP_LEG_GAS.mint, label: 'reserve mint', kind: 'mint'});

/** `SetupLegsCore` (resume.ts's id-agnostic four leg groups, shared by both 721 and EditionCode) →
 *  the gas-batching shape above — schemas individually (resume diffs them per-key too), deps and
 *  on-chain-URI as one atomic leg apiece (resume diffs them as one group too — see resume.ts's
 *  `planCoreLegs`). Mints are NOT included here: their shape differs by lane (721 whole-total vs
 *  EditionCode per-id vs a `--resume` shortfall) — every caller builds its own mint legs. */
export function coreSetupLegs(legs: SetupLegsCore): {chunks: SetupLeg[]; config: SetupLeg[]} {
  return {
    chunks: legs.chunks.map((c) => chunkSetupLeg(c.index, c.hex, c.data)),
    config: [
      ...legs.schemas.map((s) => schemaSetupLeg(s.key, s.data)),
      ...(legs.deps.calls.length ? [depsSetupLeg(legs.deps.calls)] : []),
      ...(legs.uri.calls.length ? [uriSetupLeg(legs.uri.calls)] : []),
    ],
  };
}

/**
 * Split three ordered leg groups into gas-bounded batches — chunks, then config, then mints, NEVER
 * mixed (see the module note above). Refuses BEFORE building anything if a single leg's own gas
 * estimate alone exceeds the binding `eth_estimateGas` ceiling: batching only helps when the problem
 * is too MANY legs, not one leg too big, and that case must never reach a raw "gas limit too high".
 * Deterministic in the legs' `.gas` values alone (never their `.calls`), so calling this once early
 * (to size `approvals`, before an owner is even known) and again later with the real calldata
 * produces the IDENTICAL batch shape both times — no drift between what's previewed and what's sent.
 */
export function planCodeSetupBatches(groups: {chunks: SetupLeg[]; config: SetupLeg[]; mints: SetupLeg[]}): SetupLeg[][] {
  const all = [...groups.chunks, ...groups.config, ...groups.mints];
  if (all.length === 0) return [];
  const oversized = all.find((leg) => leg.gas > MEASURED_ESTIMATE_GAS_ALLOWANCE);
  if (oversized) {
    throw new Error(
      `setup leg — ${oversized.label} — needs ~${oversized.gas.toLocaleString()} gas on its own, which exceeds the ` +
        `~${MEASURED_ESTIMATE_GAS_ALLOWANCE.toLocaleString()} eth_estimateGas ceiling every transaction is bound by ` +
        `(that RPC allowance is the binding constraint — not the higher block gas limit). No amount of batching can ` +
        `make ONE leg fit a transaction by itself — shrink it before deploying (a smaller chunk size, fewer items in ` +
        `this leg), then re-run.`,
    );
  }
  const total = all.reduce((g, l) => g + l.gas, 0);
  if (total <= DEFAULT_TX_GAS_BUDGET) return [all]; // fits one tx — unchanged common-case behavior
  return [...packCallsByGas(groups.chunks), ...packCallsByGas(groups.config), ...packCallsByGas(groups.mints)].filter(
    (b) => b.length > 0,
  );
}

/** Turn ordered setup-leg batches into the actual `prepareCodeSetup` transactions — rebuilding each
 *  batch's chunk/schema/dependency/on-chain-URI labeling from its OWN legs, since a batch born from
 *  the split may carry only part of a group (see {@link planCodeSetupBatches}). */
export function codeSetupTxsFromBatches(batches: SetupLeg[][], args: {contract: Address; chainId: number; deps: string[]}): PreparedTx[] {
  return batches.map((batch) =>
    prepareCodeSetup({
      contract: args.contract,
      chainId: args.chainId,
      calls: batch.flatMap((l) => l.calls),
      chunkCount: batch.filter((l) => l.kind === 'chunk').length,
      chunkBytes: batch.filter((l) => l.kind === 'chunk').flatMap((l) => l.chunkBytes ?? []),
      schemaKeys: batch.filter((l) => l.kind === 'schema').map((l) => l.schemaKey as string),
      deps: batch.some((l) => l.kind === 'deps') ? args.deps : [],
      onchainUri: batch.some((l) => l.kind === 'uri'),
    }),
  );
}

export async function cmdDeployCode(flags: Flags) {
  // `--resume` targets an EXISTING contract — its standard (721 or edition) was fixed at THAT
  // contract's own deploy, so `--copies` (a creation-time choice) is nonsensical alongside it.
  // Refused HERE, before either body runs, so the message is specific rather than either body's
  // own (unrelated) stray-flag refusal: `cmdDeployEditionCodeBody` doesn't recognize --resume at
  // all yet, and `cmdDeployCodeBody` would otherwise reject bare --copies as an unrecognized flag.
  if (flags.resume !== undefined && flags.copies !== undefined) {
    throw new Error(
      '--resume cannot be combined with --copies: the target already exists (and its standard was fixed at ITS OWN ' +
        'deploy); --copies only chooses a standard at CREATION time. Drop --copies — `abx deploy-code --resume <address> …` ' +
        'reads what the target already is.',
    );
  }
  // `--copies <N|open>` routes to EditionCode. See the module note on `cmdDeployOneOfOneEditionBody`
  // for why this is a separate function rather than `if (copies)` branches (byte-identical 721 lane).
  if (flags.copies !== undefined) return withJson(flags, async (emit) => cmdDeployEditionCodeBody(flags, emit));
  return withJson(flags, async (emit) => cmdDeployCodeBody(flags, emit));
}

export async function cmdDeployCodeBody(flags: Flags, emit: (p: Record<string, unknown>) => void) {
  beginPlanWarnings();
  const usage =
    'abx deploy-code (--script <file> | --code-dir <dir>) --name "Title" --symbol SYM ' +
    '(--public-base-url https://your.resolver.domain | --onchain-uri) ' +
    '[--description "<s>"] [--external-url <url>] [--image-base <url> | --image-renderer 0x..] [--attributes-renderer 0x..] ' +
    '[--max N] [--mint-count N | --mint-all] [--schema key:Type:Auth,…] [--no-seed | --seed-source 0x..] ' +
    '[--dep <name@version|0x..>[,…]] [--dep-registry 0x..] ' +
    '[--unpaused] [--minter 0x..] [--primary-payee 0x..] [--royalty-bps N] [--721c recommended|0x..] [--backend ipfs|arweave] [--dry-run] [--confirm] [--bootstrap-factory]';
  const scriptPath = flags.script as string | undefined;
  const codeDir = flags['code-dir'] as string | undefined;
  const hasProgram = !!(scriptPath || codeDir); // a JS program (script or built dir)
  // Renderer-only (in-chain SVG) lane: NO program — the `image`/`attributes` are Solidity field
  // renderers, so there's nothing to chunk. Allowed only when at least one field renderer is given
  // (else it's just a misconfigured code deploy). Both program modes together is still an error.
  const rendererOnly = !hasProgram && !!(flags['image-renderer'] || flags['attributes-renderer']);
  if (scriptPath && codeDir) throw new Error(usage);
  if (!hasProgram && !rendererOnly) {
    throw new Error(
      `${usage}\n  (or, for a FULLY on-chain Solidity render with no program: --image-renderer 0x.. [--attributes-renderer 0x..] --onchain-uri)`,
    );
  }
  // Surface unsupported/typo'd flags BEFORE any work — a silent no-op on a write-adjacent value
  // (e.g. --description landing nowhere) is the worst failure mode. Non-fatal (see unknownFlags).
  // Shared path so the "did you mean --max / price is post-deploy" hints fire here too.
  refuseStrayFlags(flags, DEPLOY_CODE_FLAGS, 'deploy-code');
  warnSignWithoutFor(flags);
  // --mint-amount only means anything on a --resume against an EXISTING EditionCode target (a per-id
  // premint shortfall needs an amount; a fresh 721 deploy has no such field, and a 721 resume's mint
  // leg is a single whole-contract shortfall with no amount either). Checked HERE, before the dry-run
  // preview branch below returns early for a fresh deploy — a --resume against an actual EditionCode
  // (where the flag DOES apply) gets the more specific 721-vs-edition guard further down instead.
  if (flags['mint-amount'] !== undefined && flags.resume === undefined) {
    throw new Error(
      '--mint-amount only applies to `abx deploy-code --resume <address>` against an EXISTING EditionCode contract — ' +
        'a fresh 721 deploy (this command, without --copies) has no per-id mint amount. For a NEW edition deploy, use ' +
        '`abx deploy-code --copies <n|open> --mint-amount <n>`.',
    );
  }

  const dryRun = isDryRun(flags);
  const name = flags.name ?? 'ABX Code';
  const symbol = flags.symbol ?? 'ABXC';
  assertRealIdentity(flags, {name, symbol, dryRun});
  const maxProvided = flags.max !== undefined;
  const max = Number(flags.max ?? 16);
  if (!Number.isInteger(max) || max <= 0) throw new Error('--max must be a positive integer');
  const royaltyProvided = flags['royalty-bps'] !== undefined;
  // Mint is DEFERRED by default (no reserve mints at deploy). `--no-mint` is the explicit form of
  // that default (the skill + reproduce line reference it) and wins over --mint-all/--mint-count.
  const mintCount = flags['no-mint'] !== undefined ? 0 : flags['mint-all'] !== undefined ? max : Number(flags['mint-count'] ?? 0);
  if (mintCount > max) throw new Error(`--mint-count ${mintCount} exceeds --max ${max}`);
  const paused = flags.unpaused === undefined;
  const royaltyBps = flags['royalty-bps'] === undefined ? 500 : parseRoyaltyBps(String(flags['royalty-bps']));
  // Owner-set royalty ceiling (bps, up to 100%), reduce-only after deploy. Defaults to 10%,
  // auto-raised to fit a higher --royalty-bps so a plausible input never errors; --royalty-cap overrides.
  const maxRoyaltyBps = flags['royalty-cap'] === undefined
    ? Math.max(1000, royaltyBps)
    : parseRoyaltyBps(String(flags['royalty-cap']));
  if (royaltyBps > maxRoyaltyBps) {
    throw new Error(`--royalty-bps ${royaltyBps / 100}% exceeds --royalty-cap ${maxRoyaltyBps / 100}%; raise the cap or lower the royalty.`);
  }
  const burnable = flags.burnable === '' || flags.burnable === 'true';
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = (flags['public-base-url'] ?? resolveBaseUrl(port)).replace(/\/$/, '');
  const hasPublicUrl = !!(flags['public-base-url'] || process.env.ABX_PUBLIC_BASE_URL);

  // --onchain-uri: the chain-complete lane. tokenURI resolves ON-CHAIN via the canonical
  // metadata renderer, and the collection's `animation_url` is COMPUTED on-chain by the
  // canonical generator (template branch: the full HTML document; directory branch: a
  // parameterized gateway URL). No resolver base is baked, so no resolver is required —
  // though local register+index still happens below (a resolver remains the kinder serving
  // path, and the effect runner still owns the thumbnail).
  const onChainUri = !!flags['onchain-uri'];

  console.log(bold(`\n  ABX Self-Host Toolkit — deploy code project\n  ${dim('a program is the content; output is a function of its params')}`));

  // Without --onchain-uri a code project ALWAYS resolves its metadata (`tokenURI`) and its live
  // view (`/a/…`, where the resolver injects the seed + current PostParams) through a resolver.
  // The deploy bakes the resolver's PUBLIC base on-chain, and a localhost / loopback base
  // resolves for NO ONE. Refuse it, same as deploy/deploy-series. Checked FIRST — a pure config
  // error, before any RPC. ABX_DEV_ALLOW_LOCALHOST_URI=1 is the DEV/TEST-ONLY escape
  // (e2e/sandbox). (Not a concern with --onchain-uri: the renderer + generator are
  // authoritative and resolve from chain — no resolver base is baked.)
  if (!onChainUri && (!hasPublicUrl || loopbackBaseUrl(baseUrl))) {
    const devAllow = process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1';
    const msg =
      `A code project resolves its metadata + live view through your resolver, so this deploy bakes that resolver's PUBLIC URL on-chain — ${hasPublicUrl ? baseUrl : 'localhost'} resolves for no one ` +
      `(not marketplaces, not wallets). Pick a real path:\n` +
      `    • Fully on-chain, no server:  --onchain-uri   (tokenURI via the on-chain renderer; the generator computes the live view)\n` +
      `    • Hosted resolver:            abx deploy-resolver --provider fly --domain meta.you.xyz, then --public-base-url https://meta.you.xyz (or set ABX_PUBLIC_BASE_URL)`;
    if (!devAllow) {
      if (dryRun) warn(`would REFUSE to deploy — ${msg}`);
      else throw new Error(msg);
    } else {
      warn(`DEV ONLY (ABX_DEV_ALLOW_LOCALHOST_URI): baking ${bold(baseUrl)} on-chain — resolves only on THIS machine; not a real NFT.`);
    }
  }

  const publicClient = makePublicClient({chainKey: CHAIN});
  // Catch a wrong-network RPC with the clear mismatch message even on dry-run (which reads the
  // chain to resolve the factory/renderer and predict the address); tolerate an offline preview.
  await assertChainId(CHAIN, {allowUnreachable: dryRun});
  const chainId = dryRun ? resolveChain(CHAIN).id : ((await publicClient.getChainId()) as number);

  // --721c (opt-in ERC-721C): absent → zeroAddress, a plain ERC-721 exactly as before.
  const transferValidator = await resolveTransferValidatorFlag(flags, publicClient, dryRun);

  step('Trust anchor');
  let factory: Address;
  if (dryRun) {
    const existing = resolveSeriesCodeFactory(chainId, flags.factory as string | undefined);
    if (!existing) {
      info('no canonical SeriesCode factory for this chain yet — a real deploy would deploy the trust anchor first (or --bootstrap-factory).');
      console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
      return;
    }
    factory = existing as Address;
    info(`would reuse canonical SeriesCode factory ${factory}`);
  } else {
    factory = await ensureSeriesCodeFactory(publicClient, flags.factory as string | undefined, !!flags['bootstrap-factory']);
  }
  const seedSource = await resolveSeedSourceFlag(flags, publicClient, dryRun, chainId);

  // --onchain-uri: resolve the two canonical singletons the lane points at. The generator is
  // per-chain infrastructure (constructor-wired to the dependency registry, the abx.js/gunzip
  // runtime pointers, and default gateways), so it is NEVER auto-deployed — a chain without one
  // stops with guidance, same policy as the trust anchor. The metadata renderer reuses the 1/1
  // lane's ensureRenderer (deploys only if missing or a stale spec version).
  let generator: Address = zeroAddress;
  let metadataRenderer: Address = zeroAddress;
  if (onChainUri) {
    step('On-chain URI');
    // The generator computes `animation_url` from a PROGRAM (the on-chain HTML doc / directory
    // gateway URL). A renderer-only drop has no program → no animation_url, so it needs NO
    // generator (and must NOT bake an animation leg at a zero generator — that would revert every
    // tokenURI, since the metadata renderer staticcalls the field renderer). Only the metadata
    // renderer (which makes tokenURI resolve on-chain) is required in both cases.
    if (hasProgram) {
      const knownGenerator = resolveGenerator(chainId, flags.generator as string | undefined);
      if (!knownGenerator) {
        throw new Error(
          `--onchain-uri needs the canonical AbxGenerator for '${CHAIN}', and none is configured.\n` +
            `  A canonical generator may already exist — check with the ABX community / update @artblocks/abx-sdk ` +
            `(the shipped manifest: packages/sdk/src/deployments.ts), or set ABX_GENERATOR=0x… / --generator 0x… if you know the address.\n` +
            `  (The generator is constructor-wired per chain — registry, runtime pointers, gateways — so this deploy never mints one.)`,
        );
      }
      generator = knownGenerator;
      if (!dryRun) {
        const generatorCode = await publicClient.getCode({address: generator});
        if (!generatorCode || generatorCode === '0x') {
          throw new Error(`the configured generator ${generator} has no code on '${CHAIN}' — check ABX_GENERATOR / --generator / the RPC endpoint.`);
        }
      }
      info(dryRun ? `would point the collection animation_url at the canonical generator ${generator} (computed on-chain)` : `animation_url computes ON-CHAIN via the canonical generator ${generator}`);
    } else {
      info('renderer-only (no program) — no animation_url; tokenURI = name + on-chain image/attributes from your Solidity renderer(s)');
    }
    if (dryRun) {
      metadataRenderer = (rendererAddress(flags.renderer) as Address | null) ?? zeroAddress;
      info(
        metadataRenderer === zeroAddress
          ? 'would deploy the canonical metadata renderer first, then set tokenURIRenderer/contractURIRenderer to it'
          : `would resolve tokenURI/contractURI ON-CHAIN via the renderer ${metadataRenderer}`,
      );
    } else {
      metadataRenderer = await ensureRenderer(flags.renderer);
      info(`tokenURI/contractURI resolve ON-CHAIN via the renderer ${metadataRenderer} — no resolver in the token's graph.`);
    }
    if (!hasPublicUrl) info('off-chain fallback pointer left empty (the renderer is authoritative); set --public-base-url to bake one anyway.');
  }

  // schemas: key:Type:Auth (comma-separated), Type carrying optional Select options / Range bounds
  // (Select[A|B|C], Uint256Range[0..100], …) → key, enum indices, bytes32 min/max, selectOptions.
  const schemas = parseSchemaSpecs(flags.schema as string | undefined);
  // Say it where the decision is made, not in a doc the creator may never open: on an edition, a
  // holder-writable param is SHARED by every holder of that id. See `editionSchemaAdvisory`.
  if (flags.copies !== undefined) {
    const advisory = editionSchemaAdvisory(schemas);
    if (advisory) warn(advisory);
  }

  // Dependencies: ordered `--dep` refs (repeatable / comma-separable) — index 0 = the runtime,
  // by convention. `name@version` ⇒ Resolution.Registry (resolved through the soft registry
  // pointer); `0x…` ⇒ Resolution.OnChain (a raw data contract, no registry involved). The legs
  // ride the SAME setup multicall as chunks/schemas/mints, in every signing lane.
  const deps = parseDepFlag(flags.dep);
  const hasRegistryDeps = deps.some((d) => d.resolution === DEP_RESOLUTION.registry);
  // The pointer is SOFT and non-validating (never blocks a deploy): --dep-registry wins, else
  // the chain's known AB Dependency Registry, else warn + skip the leg.
  const depPointer = hasRegistryDeps
    ? resolveDepRegistryPointer(flags['dep-registry'] as string | undefined, chainId)
    : {registry: null as Address | null, source: 'none' as const};
  const depRegistry = depPointer.registry;
  let depChecks: DepCheck[] = []; // the P1 selection-time report — feeds the chain-complete expectation under --onchain-uri
  if (deps.length) {
    step('Dependencies');
    deps.forEach((d, i) =>
      info(
        `[${i}] ${bold(d.display)} ${dim(d.resolution === DEP_RESOLUTION.registry ? '(registry name@version)' : '(on-chain data contract — read directly)')}${i === 0 ? dim(' · index 0 = the runtime') : ''}`,
      ),
    );
    if (hasRegistryDeps) {
      if (depRegistry) {
        info(`registry pointer → ${depRegistry} ${dim(depPointer.source === 'flag' ? '(--dep-registry)' : "(the chain's AB Dependency Registry — soft, non-validating)")}`);
        // Selection-time check — best-effort eth_call per Registry dep; the deploy proceeds
        // whatever it finds (the owner may intend a custom registry; offline just skips).
        const {checks, rpcOk} = await checkRegistryDeps(publicClient, depRegistry, deps);
        depChecks = checks;
        for (const chk of checks) {
          if (chk.status === 'found') {
            ok(
              chk.details.availableOnChain
                ? `${chk.dep} — on registry; ON-CHAIN bytes available (${chk.details.scriptCount} chunk(s)) — chain-complete capable`
                : `${chk.dep} — on registry; served from CDN ${chk.details.preferredCDN || '(none listed)'} ${dim('— the normal production path, not a degradation')}`,
            );
          } else if (chk.status === 'not-found') {
            warn(`${bold(chk.dep)} NOT FOUND on registry ${depRegistry} — the resolver won't resolve it from there. Deploy proceeds (you may intend a custom registry / a pending addition); double-check the exact name@version spelling.`);
          }
        }
        if (!rpcOk) info('registry check skipped (RPC unreachable) — the deploy does not depend on it.');
      } else {
        warn('no dependency registry known for this chain — skipping the setDependencyRegistry leg (the pointer is SOFT; the resolver falls back to its built-in CDN map). Pass --dep-registry 0x… or run `abx set-dependency-registry` later.');
      }
    }
  }

  // Content: directory mode uploads the build (its root locator → the `code` collection field);
  // template mode chunks the script for on-chain storage. The directory UPLOAD is deferred until
  // after the --confirm gate (and skipped entirely on --dry-run) so a preview never pins bytes.
  step('Content');
  const contractFields: {field: Hex; representation: Hex; value: Hex}[] = [];
  let scriptChunks: Hex[] = [];
  let scriptAnalysis: ReturnType<typeof analyzeScript> | null = null; // template mode only — directory builds can't be statically analyzed
  let dirUpload: null | {backend: StorageBackend; entries: {name: string; bytes: Uint8Array; contentType: string}[]; sizes: number[]} = null;
  let contentSummary: string;
  const schemaSummary = schemas.length
    ? schemas.map((s) => describeSchema(s)).join(', ')
    : 'none';
  if (codeDir) {
    const dirPath = resolvePath(codeDir);
    const files = readdirSync(dirPath).filter((f) => !f.startsWith('.') && statSync(joinPath(dirPath, f)).isFile());
    if (!files.includes('index.html')) throw new Error(`${dirPath} has no index.html — the directory entry, by convention`);
    const backend = resolveBackend(storageOptions(storageOverrides(flags)));
    if (!backend.putDirectory) throw new Error(`storage backend '${backend.id}' has no directory upload — use --backend ipfs (pinata) or arweave`);
    const entries = files.map((f) => ({name: f, bytes: new Uint8Array(readFileSync(joinPath(dirPath, f))), contentType: contentTypeFromPath(joinPath(dirPath, f))}));
    dirUpload = {backend, entries, sizes: entries.map((e) => e.bytes.length)};
    contentSummary = `${entries.length} file(s) → ${backend.id} directory (code field)`;
    info(`${entries.length} file(s) from ${basename(dirPath)}/ → ${backend.id} directory (code field)`);
    info(dim('the live view 302s through the gateway — it must serve HTML (the shared Pinata public gateway does not; use a dedicated gateway or arweave).'));
  } else if (scriptPath) {
    const source = readFileSync(resolvePath(scriptPath), 'utf8');
    scriptChunks = planOnChainScript(source);
    const bytes = new TextEncoder().encode(source).length;
    contentSummary = `script ${bytes} bytes → ${scriptChunks.length} on-chain chunk(s)`;
    ok(contentSummary);
    scriptAnalysis = analyzeScript(source, deps.map((d) => d.display)); // traits + PostParam reads + doc size → the Surfaces disposition below
  } else {
    // Renderer-only (in-chain SVG): no program to chunk — the image/attributes are Solidity field
    // renderers. Nothing rides SSTORE2; the whole work is computed on-chain per view.
    contentSummary = 'no program — image + traits computed on-chain by Solidity field renderers';
    ok(contentSummary);
  }

  // Collection identity that lands ON-CHAIN in the deploy tx's init params (rides `contractFields`,
  // the same slot directory mode uses for `code` — no extra multicall leg). A code project has no
  // resolver-served metadata table of its own, so `--description`/`--external-url` MUST be written
  // as on-chain collection fields or they'd be silently dropped (they were, pre-fix). Under
  // --onchain-uri the metadata renderer stitches them into tokenURI from chain; on the resolver
  // lane the resolver reads the same on-chain fields. Inline + on-chain is the greenfield default
  // for this tiny, durable data (mirrors the 1/1 lane's F.description write).
  const identityFields: string[] = [];
  // Field-renderer code-presence, captured from the verify probes below so the Surfaces block
  // (which the skill tells the agent to trust) reflects a codeless renderer — not just the Content
  // section. null = not applicable / RPC unknown; true = code present; false = no code (would refuse).
  let imageRendererCodePresent: boolean | null = null;
  let attributesRendererCodePresent: boolean | null = null;
  if (flags.description) {
    contractFields.push({field: encodeTag(F.description), representation: encodeTag(R.inline), value: toHex(String(flags.description))});
    identityFields.push('description');
  }
  if (flags['external-url']) {
    contractFields.push({field: encodeTag(F.externalUrl), representation: encodeTag(R.inline), value: toHex(String(flags['external-url']))});
    identityFields.push('external_url');
  }
  // authorship + rights — same on-chain inline collection-field slot (creator / license / …).
  contractFields.push(...authorshipContractFields(flags), ...gatewayContractFields(flags));
  for (const [flag, field] of AUTHORSHIP_DEPLOY_FIELDS) if (flags[flag]) identityFields.push(field);
  // --image-renderer: bake the on-chain `image` field to a `renderer` representation — the SVG is
  // COMPUTED on-chain by a Solidity IAbxFieldRenderer (e.g. a SeedSvgRenderer fork) from the token's
  // seed + params. THE in-chain-renderer lane: the marketplace still lives in tokenURI itself — no bucket,
  // no effect runner, no resolver. Mutually exclusive with --image-base (both set `image`). Verified
  // like --attributes-renderer: a real deploy REFUSES a codeless address; dry-run probes best-effort.
  if (flags['image-renderer']) {
    if (flags['image-base']) {
      throw new Error('--image-renderer and --image-base both set the `image` field — pick ONE: an ON-CHAIN Solidity render (--image-renderer, no infra) OR an off-chain bucket URL (--image-base).');
    }
    const addr = String(flags['image-renderer']);
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('--image-renderer must be a 0x address (an IAbxFieldRenderer returning image/svg+xml on-chain, e.g. a SeedSvgRenderer fork).');
    if (dryRun) {
      let codePresent: boolean | null = null;
      try { const c = await publicClient.getCode({address: addr as Address}); codePresent = !!c && c !== '0x'; } catch { codePresent = null; }
      imageRendererCodePresent = codePresent;
      if (codePresent === false) {
        warn(`--image-renderer ${bold(addr)} has NO code on '${CHAIN}' — that is NOT a deployed renderer. A real deploy REFUSES it. Deploy a Solidity image renderer (fork SeedSvgRenderer.sol) first.`);
      } else {
        info(`collection image → on-chain field-renderer ${bold(addr)} ${dim(codePresent ? '(SVG computed on-chain; code present ✓)' : '(SVG computed on-chain — a real deploy VERIFIES this is a deployed renderer and refuses if not)')}`);
      }
    } else {
      const code = await publicClient.getCode({address: addr as Address});
      if (!code || code === '0x') throw new Error(`--image-renderer ${addr} has no code on '${CHAIN}' — it must be a DEPLOYED IAbxFieldRenderer (e.g. a SeedSvgRenderer fork), not a placeholder address. Deploy the renderer first.`);
      imageRendererCodePresent = true;
      info(`collection image → on-chain field-renderer ${bold(addr)} ${dim('(SVG computed on-chain, embedded as a data URI in tokenURI; code present ✓)')}`);
    }
    contractFields.push({field: encodeTag(F.image), representation: encodeTag(R.renderer), value: encodeFieldRenderer(addr as Address)});
    identityFields.push('image');
  }
  // --image-base: bake the on-chain `image` as a url-template (`{base}/{id}.png`) — the marketplace
  // thumbnail lives OFF-CHAIN at a stable per-token URL the chain names, and the effect runner
  // overwrites each key as tokens mint/update (no metadata resolver, no chain rewrite on re-render).
  // Prefer a mutable, path-addressed host (S3/R2/CDN); NOT ipfs/arweave (content-addressed → the
  // URL changes with the bytes). See the effect runner's deterministic-image lane.
  if (flags['image-base']) {
    const base = String(flags['image-base']);
    // --image-base needs a mutable, path-addressed URL (the effect runner overwrites
    // the SAME key in place) — a content-addressed gateway URL (ipfs/arweave) can't back a *fixed*
    // per-token address, no matter what THIS deploy's own --backend/ABX_STORAGE_BACKEND happens to
    // be (that config is unrelated — it's where THIS deploy's own uploads go, not where the effect
    // runner later writes stills). One shared validator (packages/storage/content-plan.ts) decides
    // this, so the real-run refusal here and the dry-run `render/storage` row below can never
    // disagree about which combos are bad.
    const imageBaseCombo = validateRenderStorageCombo({imageBaseUrl: base});
    if (!imageBaseCombo.ok) {
      if (dryRun) warn(`would REFUSE — ${imageBaseCombo.reason}`);
      else throw new Error(imageBaseCombo.reason);
    }
    // NEVER bake a localhost/loopback image host on-chain — the token's `image` would resolve for no
    // one (same rule as the resolver base). This is the marketplace still's PERMANENT address.
    if (loopbackBaseUrl(base)) {
      const m = `--image-base ${base} is localhost/loopback — the on-chain image URL would resolve for no marketplace. Use a PUBLIC bucket (S3/R2/CDN) you control.`;
      if (dryRun) warn(`would REFUSE — ${m}`);
      else throw new Error(m);
    }
    // The exact trap a real agent hit: it baked the S3 *API endpoint* (auth-only) as --image-base.
    // `*.r2.cloudflarestorage.com` is R2's signed API — NEVER publicly readable → marketplaces 403.
    // `s3[.-]…amazonaws.com` is the S3 API host too (public only if you front it with a public bucket
    // policy / CloudFront). --image-base must be the PUBLIC READ base; the API endpoint goes in
    // ABX_S3_ENDPOINT (uploads). Refuse the R2 API form (never public); warn on the S3 API form.
    if (/\.r2\.cloudflarestorage\.com/i.test(base)) {
      const m = `--image-base ${base} is R2's S3 API endpoint (auth-only) — marketplaces get 403, it is NEVER public. Put THIS URL in ${bold('ABX_S3_ENDPOINT')} (uploads), and pass --image-base your bucket's PUBLIC read URL — enable an ${bold('r2.dev')} public URL (\`https://pub-<hash>.r2.dev\`) or a custom domain in the R2 dashboard.`;
      if (dryRun) warn(`would REFUSE — ${m}`);
      else throw new Error(m);
    } else if (/(^|\/\/)s3[.-][^/]*amazonaws\.com/i.test(base) || /\.s3[.-][^/]*amazonaws\.com/i.test(base)) {
      warn(`--image-base ${base} looks like the S3 API host — marketplaces can read it ONLY if the bucket has public-read (or you front it with CloudFront/a domain). If it's not public, use that URL in ${bold('ABX_S3_ENDPOINT')} and pass a public URL here instead.`);
    }
    const imageTemplate = base.includes('{id}') ? base : `${base.replace(/\/+$/, '')}/{id}.png`;
    contractFields.push({field: encodeTag(F.image), representation: encodeTag(R.urlTemplate), value: toHex(imageTemplate)});
    identityFields.push('image');
    info(`collection image → on-chain url-template ${bold(imageTemplate)} ${dim('(off-chain thumbnail at a deterministic per-token URL; the effect runner overwrites each key)')}`);
    // Name the EXACT upload vars the runner needs (an agent guessed R2_* names that abx never reads,
    // breaking the upload). --image-base is the public READ base; these are the write side.
    info(`  ${dim('the runner uploads stills here via')} ${bold('ABX_S3_ENDPOINT · ABX_S3_BUCKET · ABX_S3_ACCESS_KEY_ID · ABX_S3_SECRET_ACCESS_KEY')} ${dim('(set ABX_S3_PUBLIC_BASE to this same --image-base; `abx storage show` checks them; details → reference/hosting.md)')}`);
    const s3Base = process.env.ABX_S3_PUBLIC_BASE?.replace(/\/+$/, '');
    if (s3Base && !imageTemplate.startsWith(`${s3Base}/`)) {
      warn(`--image-base isn't under ABX_S3_PUBLIC_BASE (${s3Base}) — the runner keys its deterministic publish off that base, so it won't auto-upload here unless they share an origin.`);
    }
  }
  // --attributes-renderer: bake the on-chain `attributes` field to a `renderer` representation
  // (abi.encode(address)) — traits COMPUTED on-chain in tokenURI by an IAbxFieldRenderer (e.g. a
  // SeedTraitsRenderer fork). Fully on-chain traits, no resolver. See site/content/docs/protocol/renderers.mdx.
  if (flags['attributes-renderer']) {
    const addr = String(flags['attributes-renderer']);
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('--attributes-renderer must be a 0x address (an IAbxFieldRenderer that computes the attributes JSON on-chain, e.g. a SeedTraitsRenderer fork).');
    // On-chain traits are NOT a free flag: this address must be a DEPLOYED Solidity renderer (a
    // SeedTraitsRenderer fork), never a placeholder. A real session put a GUESSED address here and
    // presented "traits on-chain" in a confirm readout — so verify code is actually present. Real
    // deploy REFUSES an empty address (like the localhost guard); dry-run probes best-effort (like
    // the gas estimate) and, either way, marks the line as pending verification, never settled.
    if (dryRun) {
      let codePresent: boolean | null = null;
      try { const c = await publicClient.getCode({address: addr as Address}); codePresent = !!c && c !== '0x'; } catch { codePresent = null; }
      attributesRendererCodePresent = codePresent;
      if (codePresent === false) {
        warn(`--attributes-renderer ${bold(addr)} has NO code on '${CHAIN}' — that is NOT a deployed renderer. A real deploy REFUSES it. Deploy a Solidity attributes-renderer (fork SeedTraitsRenderer.sol) first, or drop the flag and serve traits via a resolver / omit them.`);
      } else {
        info(`collection attributes → on-chain field-renderer ${bold(addr)} ${dim(codePresent ? '(traits computed on-chain; code present ✓ — a real deploy re-verifies it is a deployed renderer)' : '(traits computed on-chain — a real deploy VERIFIES this is a deployed renderer and refuses if not; do not present traits as on-chain until verified)')}`);
      }
    } else {
      const code = await publicClient.getCode({address: addr as Address});
      if (!code || code === '0x') throw new Error(`--attributes-renderer ${addr} has no code on '${CHAIN}' — it must be a DEPLOYED IAbxFieldRenderer (e.g. a SeedTraitsRenderer fork), not a placeholder address. Deploy the renderer first, or drop the flag (serve traits via a resolver with --public-base-url, or omit marketplace traits — the tokenURI + animation stay fully on-chain).`);
      attributesRendererCodePresent = true;
      info(`collection attributes → on-chain field-renderer ${bold(addr)} ${dim('(traits computed on-chain, embedded verbatim in tokenURI; code present ✓)')}`);
    }
    contractFields.push({field: encodeTag(F.attributes), representation: encodeTag(R.renderer), value: encodeFieldRenderer(addr as Address)});
    identityFields.push('attributes');
  }
  if (identityFields.length) info(`collection ${identityFields.join(' + ')} → on-chain field(s) (ride the deploy tx)`);
  // Renderer behavior is the creator's to guarantee — the CLI can only confirm the address has code,
  // not that render() behaves (simulating it is hard + uncertain; competent Solidity devs forge-test).
  // Surface the invariant that actually bricks a drop so the agent reviews the render function first.
  if (flags['image-renderer'] || flags['attributes-renderer']) {
    warn(
      `${bold('renderer check — yours to verify')} (the CLI confirms code at the address, NOT that render() behaves): an IAbxFieldRenderer must ` +
        `${bold('NEVER revert')} for any token/param state incl. the collection surface (tokenId = type(uint256).max) — a revert bricks the WHOLE tokenURI (no try/catch) — ` +
        `and must return the right content-type (image → ${bold('image/svg+xml')} · attributes → a JSON array). Review the render function + forge-test it before shipping. Invariants: reference/code.md.`,
    );
  }

  // ── Surfaces disposition — resolve EVERY product dimension explicitly, up front ──────────────
  // A code project has four surfaces that each land somewhere (or nowhere). A real session shipped
  // "fully on-chain, no server!" and discovered — one at a time, after deploy — that it carried no
  // thumbnail DESTINATION, no traits, and had dropped the palette PostParam. These are all DEPLOY-TIME
  // decisions (an on-chain field with no pointer can't be backfilled to localhost). Compute each here
  // so the dry-run + confirm can lay them out as one block, and the agent can't miss one.
  const resolverInGraph = !onChainUri || hasPublicUrl; // a resolver is in the token's graph
  const hasAttributesRenderer = !!flags['attributes-renderer'];
  const hasImageBase = !!flags['image-base'];
  const hasImageRenderer = !!flags['image-renderer'];

  // THUMBNAIL DESTINATION — the killer. The on-chain `image` is a placeholder UNLESS it's computed
  // on-chain (--image-renderer, an in-chain SVG — nothing off-chain at all), OR --image-base (a public
  // bucket the chain names), OR a resolver serves it. With none, `abx render` writes to a local store
  // the tokenURI never points at → orphaned; marketplaces show the placeholder forever.
  const imageBaseLoopback = hasImageBase && loopbackBaseUrl(String(flags['image-base']));
  // A renderer whose address has NO code is a broken surface too — surface it HERE (the block the
  // skill says to trust), not only in the Content section.
  const imageRendererCodeless = hasImageRenderer && imageRendererCodePresent === false;
  const imageOrphaned = imageBaseLoopback || imageRendererCodeless || (!hasImageRenderer && !hasImageBase && !resolverInGraph);
  const imageDisposition = imageRendererCodeless
    ? `⚠ --image-renderer has NO code on-chain — a real deploy REFUSES it; deploy the Solidity renderer first (fork SeedSvgRenderer.sol)`
    : hasImageRenderer
      ? `ON-CHAIN — computed by your Solidity image renderer (an in-chain SVG, embedded in tokenURI; no bucket, no runner ✓)`
      : imageBaseLoopback
        ? `⚠ --image-base is localhost/loopback — the on-chain image resolves for NO marketplace. Use a PUBLIC bucket (S3/R2/CDN)`
        : hasImageBase
          ? `on-chain url-template → your bucket (renders upload there; marketplace-visible ✓)`
          : resolverInGraph
            ? `served by the resolver (/image; renders publish to it ✓)`
            : `⚠ NO PUBLIC DESTINATION — the collection-wide image is a placeholder. \`abx render\` to a local store is ORPHANED (marketplaces never see it). A collection-wide default needs --image-renderer, --image-base, or a resolver NOW; per token, \`abx set-field --field image\` (raw SVG bytes, not a data-URI) still writes after mint`;

  // TRAITS — on-chain renderer / off-chain resolver / omitted / codeless-renderer.
  const attributesRendererCodeless = hasAttributesRenderer && attributesRendererCodePresent === false;
  const traitsOmitted = !hasAttributesRenderer && !resolverInGraph && !!scriptAnalysis?.traits.present;
  const traitsBroken = traitsOmitted || attributesRendererCodeless;
  const traitsDisposition = attributesRendererCodeless
    ? '⚠ --attributes-renderer has NO code on-chain — a real deploy REFUSES it; deploy the Solidity renderer first (fork SeedTraitsRenderer.sol)'
    : hasAttributesRenderer
      ? 'on-chain via --attributes-renderer (verified at deploy)'
      : resolverInGraph
        ? "off-chain — the resolver serves the script's JS-derived traits"
        : scriptAnalysis?.traits.present
          ? `⚠ OMITTED — the script reports ${scriptAnalysis.traits.keys.length} trait(s) (${scriptAnalysis.traits.keys.join(', ')}) but this lane has NO resolver and NO --attributes-renderer, so they will NOT appear in marketplace metadata`
          : scriptAnalysis
            ? 'none (the script reports no traits)'
            : 'unknown (directory build — not statically analyzed)';

  // POSTPARAMS — the script reads collector inputs (e.g. `td.palette`) that MUST be declared in
  // --schema or they're silently dropped at render (default value used). A real session identified
  // the palette param, then deployed without it.
  const declaredSchemaKeys = new Set(schemas.map((s) => s.key));
  const undeclaredParams = (scriptAnalysis?.paramHints ?? []).filter((k) => !declaredSchemaKeys.has(k));
  const paramsDisposition = scriptAnalysis
    ? undeclaredParams.length
      ? `⚠ the script READS ${undeclaredParams.join(', ')} but ${undeclaredParams.length === 1 ? "it isn't" : "they aren't"} in --schema → dropped at render (default used) UNLESS an augment hook supplies ${undeclaredParams.length === 1 ? 'it' : 'them'}. Add --schema ${undeclaredParams.map((k) => `${k}:<Type>:<Auth>`).join(',')} only for collector/creator inputs (a palette collectors set = HexColor:TokenOwner); ignore this for keys your augment hook derives`
      : schemas.length
        ? `${schemas.length} declared: ${schemaSummary}`
        : 'none (the script reads no collector params)'
    : schemas.length
      ? `${schemas.length} declared: ${schemaSummary}`
      : (hasImageRenderer || hasAttributesRenderer)
        // Renderer-only lane: the CLI can't introspect an opaque Solidity renderer to know which
        // PostParams it reads (unlike the JS lane's static paramHints), so nudge — the palette-miss.
        ? `⚠ none declared — if your Solidity renderer reads ANY collector PostParam, declare EACH with ${bold('--schema <key>:Type:Auth')} (matching the key your renderer reads — e.g. ${bold('palette:HexColor:TokenOwner')}) or that input is FIXED at the renderer's default forever and collectors can't set it (the CLI can't detect the key — a Solidity renderer is opaque, so this is on you to declare)`
        : 'none declared';
  // Hoisted here (rather than beside its one printed use, in the Surfaces block below) so BOTH the
  // dry-run's Surfaces block and the plan object's `surfaces.postParams.ok` (populated at every one
  // of this lane's emit sites, dry-run/sent/resume alike) read the exact same verdict.
  const paramsNudge = !scriptAnalysis && !schemas.length && (hasImageRenderer || hasAttributesRenderer);

  // TOKENURI PUBLIC-READ GAS — a large --onchain-uri document assembles on-chain per call; an
  // unauthenticated public read (Etherscan "Read Contract" with no wallet connected) can hit a client
  // gas cap and appear to REVERT. Expected, not a bug — a real session mis-diagnosed it as indexing lag.
  //
  // Same threshold as the staged-bytes gate (`ONCHAIN_READ_WARN_BYTES`), since it is the same measured
  // cost: `tokenURI` string-building runs ~360-405k gas per KB of assembled document (superlinear — the
  // rate climbs with size). This one only WARNS
  // where the staged-bytes path refuses, and deliberately so: `estBytes` is an ESTIMATE (a dependency
  // of unknown size is undercounted — see `unknownDepSizes`), and a registry-hosted library like p5 is
  // legitimately ~200KB on its own, so the honest move is to name the cost and point at the piecewise
  // getters rather than to block a shipped lane on a heuristic.
  const tokenUriGasRisk = onChainUri && !codeDir && (scriptAnalysis?.doc.estBytes ?? 0) >= ONCHAIN_READ_WARN_BYTES;

  // --onchain-uri legs (ride the setup multicall, before the mints): the animation_url field
  // pointing at the generator, and the two URI renderers. The param surface needs NO leg — the
  // generator enumerates it from the token on-chain (`contractParamKeys`/`tokenParamKeys`, kept in
  // step by the write paths themselves), so there is nothing for a deploy to declare and nothing to
  // drift. (The retired `params.keys` CSV convention is gone; a legacy project keeps its old generator.)
  // THE FOLD: on the renderer-only in-chain lane (no program), the on-chain-URI wiring (tokenURI/
  // contractURI renderers) + the reserve mint move INTO the deploy tx's init params — the token is
  // fully configured at deploy (the renderers already exist on-chain), so the setup multicall is
  // needed ONLY for a PostParam schema (and is skipped entirely when there's none → a 1-tx drop).
  // The script/dir lane is UNCHANGED: its chunks always need the multicall, and its mint must ride
  // AFTER the chunks (a mint-before-chunks token would be transiently unresolvable), so its
  // URI-renderers + animation + mint stay in the multicall exactly as before.
  const foldIntoInit = onChainUri && !hasProgram;
  // The URI-renderer/animation legs only ride the multicall for a PROGRAM (renderer-only has no
  // generator and folds the renderers into init).
  const onchainUriLegs = onChainUri && hasProgram ? onchainUriSetupCalls({generator, metadataRenderer}) : null;
  const setupMintCount = foldIntoInit ? 0 : mintCount; // folded mints ride init, not the multicall
  // Hoisted once so the confirm text, the dry-run's `transactions:`
  // line, and the wallet-lane sign session's `total` (further down) all read the SAME number —
  // previously each re-derived it, and the confirm text's own formula silently disagreed with this
  // one whenever a dependency leg rode the multicall alongside a renderer-only (`foldIntoInit`) fold.
  const depLegs = deps.length + (depRegistry ? 1 : 0);
  const setupLen = scriptChunks.length + schemas.length + depLegs + (onchainUriLegs?.length ?? 0) + setupMintCount;
  // The setup legs, GROUPED. The normal deploy flattens them; `--resume` diffs them against chain
  // state and sends only what is missing (see resume.ts). One builder for both, so a resume can never
  // drift from what a fresh deploy would have written — a second implementation of this sequence is
  // the failure mode a repair verb most easily introduces. Moved up here (it used to sit right before
  // `preparedFor`, far below) so `approvals`/`planSetupLegs`/the dry-run's tx-count line can all size
  // themselves off the SAME gas-bounded batch plan `preparedFor` actually sends — see
  // `planCodeSetupBatches`'s own doc for why calling it here with a placeholder owner and again below
  // with the real one can never disagree (it's a pure function of each leg's `.gas`, never its
  // `.calls`, and owner only ever appears in a mint call's calldata, never its gas).
  const setupLegGroups = (owner: Address): SetupLegs => ({
    chunks: scriptChunks.map((chunk, i) => ({
      index: i,
      hex: chunk,
      data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'setScriptChunk', args: [BigInt(i), chunk]}),
    })),
    schemas: schemas.map(({key, paramType, auth, authAddress, lockAfter, min, max, selectOptions}) => ({
      key,
      data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'setParamSchema', args: [encodeTag(key), paramType, auth, authAddress, lockAfter, min, max, selectOptions]}),
    })),
    deps: {count: deps.length, registry: depRegistry ?? null, calls: dependencySetupCalls(deps, depRegistry)},
    // program lane only: animation_url field · the URI renderers (before the mints)
    uri: {calls: onchainUriLegs ?? [], animationField: onchainUriLegs?.length ? F.animationUrl : null},
    // The INTENDED TOTAL, not a count to add — a resume mints the shortfall. `mintCount` covers both
    // lanes: folded-into-init (renderer-only) and setup-carried, since either way it is what the
    // creator asked for.
    mints: {intendedTotal: mintCount, data: encodeFunctionData({abi: seriesCodeAbi, functionName: 'mint', args: [owner]})},
  });
  // Gas-bounded setup-transaction batches for a FRESH deploy — chunks, then config, then mints, never
  // mixed (see `planCodeSetupBatches`). `owner` is irrelevant to the batch SHAPE (only a mint call's
  // calldata embeds it, never its gas), so `zeroAddress` here is a placeholder that's never sent —
  // it exists purely so `approvals`/`planSetupLegs` (and the dry-run prose) can report the REAL
  // transaction count before a deployer is even known, with zero risk of drifting from what
  // `preparedFor` below actually builds and sends.
  const freshDeployBatches = planCodeSetupBatches({
    ...coreSetupLegs(setupLegGroups(zeroAddress)),
    mints: Array.from({length: setupMintCount}, () => mintSetupLeg('0x' as Hex)),
  });
  const approvals = 1 + freshDeployBatches.length; // deploy tx + however many gas-bounded setup batches
  // Ordered legs riding the setup (if any), for the plan object's `transactions.legs` — GROUP names,
  // not a literal per-transaction count (a group can span more than one batch — see deploy-plan.ts's
  // own doc comment on `legs`). The SAME booleans `setupLen`/`setupBits` (the dry-run's own
  // `transactions:` line, below) already use, so this can't drift from the tx(es) the wallet actually
  // signs. Always ends with `'deploy'` when non-null — the setup batch(es) (if any) ride AHEAD of the
  // deploy tx, never instead of it.
  const planSetupLegs = setupLen > 0
    ? [
        scriptChunks.length ? 'chunks' : null,
        schemas.length ? 'param-schemas' : null,
        depLegs ? 'dependencies' : null,
        onchainUriLegs ? 'onchain-uri' : null,
        setupMintCount ? 'mints' : null,
        'deploy',
      ].filter((leg): leg is string => leg !== null)
    : null;

  // opt-in --confirm: one y/N before ANY upload or send (no-op without --confirm; never blocks scripts).
  if (!dryRun) {
    const renderHome = process.env.ABX_STORAGE_BACKEND || 'fs'; // empty string counts as unset (=fs)
    await confirmSend(
      `About to deploy code project "${name}" (${symbol}) — ${contentSummary}; ` +
        (identityFields.length ? `${identityFields.join(' + ')} on-chain; ` : '') +
        (onChainUri
          ? `tokenURI ON-CHAIN via renderer ${metadataRenderer}${hasProgram ? ` (generator ${generator})` : ' (renderer-only — image + traits from your Solidity renderers, no animation)'}; `
          : `resolver base ${baseUrl}; `) +
        `dependencies: ${deps.length ? deps.map((d) => d.display).join(', ') + (depRegistry ? ` (registry ${depRegistry})` : '') : 'none'}; ` +
        `mint: ${mintCount > 0 ? `${mintCount} at deploy${foldIntoInit ? ' (in the deploy tx)' : ''}` : 'deferred'}; ` +
        `tx count: ${foldIntoInit ? (schemas.length ? '2 (deploy + enable your params)' : '1 (everything in the deploy tx)') : '2 (deploy + setup)'}; ` +
        `approvals: ${approvals} wallet approval(s); ` +
        `owner+royalty: ${flags.for ? `pinned to ${String(flags.for)}` : flags.sign !== undefined ? '⚠ the wallet you connect (NOT pinned — pass --for to enforce)' : 'your wallet'} @ ${royaltyBps / 100}%.` +
        (transferValidator !== zeroAddress ? ` ERC-721C: enrolled at deploy, permanently (validator ${transferValidator}).` : '') + `\n` +
        `  Surfaces — thumbnail: ${imageDisposition}. traits: ${traitsDisposition}. postparams: ${paramsDisposition}.` +
        ((imageOrphaned || traitsBroken || undeclaredParams.length)
          ? `\n  ⚠ One or more surfaces resolve to NOTHING marketplaces can see. Settle them now: fixing one after deploy is an owner-signed re-point + re-render, on a collection that showed a placeholder in between. Re-run --dry-run after fixing, or pass --yes to ship as-is.`
          : ''),
      flags,
    );
  }

  // --dry-run: emit the full plan (the on-chain values the skill formats into its confirm table),
  // then stop — no upload, no factory/seed deploy, no send.
  //
  // `--resume` skips this preview entirely and previews its OWN plan further down. Without the guard,
  // `--resume 0xLive --dry-run` printed a fresh-deploy plan complete with a newly-reserved salt and a
  // different predicted address — a preview of the exact thing the flag exists not to do.
  if (dryRun && flags.resume === undefined) {
    // The deployer is needed ONLY to derive the CREATE2 salt → the deterministic address (and the
    // pinned-salt re-run line). Everything else in the plan — content, deps, chain-complete
    // expectation, tx count, cost — is deployer-independent, so a wallet-less creator (the common
    // "before I set up a key" preview) still gets the full readout. Missing deployer ⇒ null, and
    // the address-dependent lines degrade to a clear placeholder instead of refusing the preview.
    let deployer: Address | null = null;
    if (flags.for) deployer = flags.for as Address;
    else {
      try { deployer = makeWalletClient({chainKey: CHAIN}).account.address; }
      catch { deployer = null; }
    }
    const explicitSalt = parseSaltFlag(flags.salt);
    const salt = deployer ? (explicitSalt ?? saltFor(deployer)) : null;
    const predicted = salt
      ? ((await publicClient.readContract({address: factory, abi: seriesCodeFactoryAbi, functionName: 'predictDeterministicAddress', args: [salt]})) as Address)
      : null;
    // Enforce, don't warn: without --salt, `salt` above was just freshly randomly reserved
    // (saltFor mixes in entropy), so `predicted` is real for THIS preview but not reproducible by a
    // plain re-run. Only show it when --salt actually pinned it; every display site below reads
    // `shownAddr`, never `predicted` directly.
    const shownAddr = explicitSalt ? predicted : null;
    step(`Deploy plan — a ${max}-token code project to ${CHAIN}`);
    if (deployer) info(`deployer ${deployer}`);
    else info(`deployer: ${dim('not set')} — pass ${bold('--for 0x..')} (or set a signing key) to preview the exact deterministic address; the plan below is otherwise deployer-independent.`);
    if (shownAddr) info(`deterministic address: ${shownAddr}`);
    info(`name "${name}" · symbol ${symbol} · max ${max}${maxProvided ? '' : ' ⚠ default — set --max N'} · royalty ${royaltyBps / 100}%${royaltyProvided ? '' : ' ⚠ default — set --royalty-bps N'} · cap ${maxRoyaltyBps / 100}%${burnable ? ' · burnable' : ''}`);
    if (!flags.description) warn(`no --description — the on-chain metadata ships with no description (the one creators most often forget). Add --description "…" or deploy bare.`);
    info(`content: ${contentSummary}`);
    printSeedSourcePlan(seedSource, chainId);
    info(`PostParam schema(s): ${schemaSummary}`);
    info(
      `dependencies: ${deps.length ? deps.map((d, i) => `[${i}] ${d.display}`).join(' · ') + ` — ${deps.length} setDependency leg(s)` : 'none'}` +
        (depRegistry ? ` + setDependencyRegistry → ${depRegistry}` : hasRegistryDeps ? ' (no registry pointer — see the warning above)' : ''),
    );
    info(`mint: ${mintCount > 0 ? `${mintCount} token(s) in order → ${deployer ?? 'your wallet'} at deploy` : 'deferred (mint later / external minter)'}`);
    info(paused ? 'paused: yes — public/minter mint closed until `abx unpause` (owner reserves still mint)' : 'paused: no — mint open at deploy');
    if (onChainUri) {
      info(
        `resolution: ON-CHAIN — tokenURI/contractURI via the metadata renderer ${metadataRenderer === zeroAddress ? '(deployed at run time)' : metadataRenderer}` +
          (hasProgram
            ? `; animation_url computed by the generator ${generator} (${codeDir ? 'directory branch — a parameterized gateway URL' : 'template branch — the full HTML document, inline'})`
            : `; no animation_url (renderer-only — image + attributes computed on-chain by your Solidity renderer(s))`),
      );
      if (hasProgram) {
        info(
          `  on-chain URI legs (ride the setup multicall): collection animation_url field (renderer rep → ${generator}) · ` +
            `setTokenURIRenderer · setContractURIRenderer ${dim('(the param surface enumerates on-chain — no leg, nothing to maintain)')}`,
        );
      } else {
        info(`  on-chain URI wiring rides the ${bold('deploy tx')} itself (tokenURI/contractURI renderers${mintCount > 0 ? ' + the reserve mint' : ''} in init) — no separate setup tx for it.`);
      }
      if (hasProgram && !codeDir) {
        const expectation = expectedChainComplete(deps, depChecks);
        info(
          `  chain-complete expectation: ${expectation.expected === true ? g('yes') : expectation.expected === false ? 'no' : 'unknown'} — ${expectation.detail}` +
            ` ${dim('(abx verify reads onChainStatus from chain after deploy)')}`,
        );
      } else if (!hasProgram) {
        info(`  ${g('fully on-chain')} — the whole tokenURI (name + image SVG + traits) is computed on-chain; zero dependency outside the EVM ${dim('(abx verify confirms from chain)')}`);
      } else {
        info(`  directory branch: no-server, not chain-complete — liveness rides the gateway (public default; ${bold('abx set-gateway')} repoints it), and the params ride the URL (8KB budget — abx verify reports urlOverBudget).`);
      }
      // A resolver is a "kinder serving path" ONLY when there's a live view / off-chain still to
      // serve — i.e. a program. The in-chain renderer-only lane has neither, so don't imply you
      // should run one (both haiku agents read this as "you need a resolver" — you don't).
      if (hasProgram) info(`  local register+index still happens — a resolver remains the kinder serving path (live view at a real URL, thumbnail publishing).`);
      else info(`  ${dim('nothing to run — image + traits are on-chain; a resolver is neither needed nor a benefit here.')}`);
      if (tokenUriGasRisk) {
        const docKb = Math.round((scriptAnalysis?.doc.estBytes ?? 0) / 1024);
        info(`  ${dim('public-read note:')} this ~${docKb}KB doc assembles on-chain per call — ${bold(`~${Math.round(tokenUriGasEstimate(scriptAnalysis?.doc.estBytes ?? 0) / 1_000_000)}M gas per tokenURI`)} at the measured ~360-405k gas/KB (climbing with size). An ${bold('unauthenticated read on Etherscan')} ("Read Contract", no wallet connected) may hit its gas cap and appear to ${bold('REVERT')} — ${dim('EXPECTED, not a broken token and NOT an indexing issue. Verify with `abx tokenuri`, or connect a wallet / use a high-gas RPC. Do not run `abx index --full` to "fix" it.')}`);
        info(`  ${dim('these are OFF-CHAIN view reads by design:')} past a node\'s cap, a client assembles from the generator\'s piecewise getters instead of one call — ${dim('`document`, `tokenDataJson`, `dependencyTag`, `abxJs`, `gunzipScript`, `registryScriptChunk`. No contract can call tokenURI inside a transaction at this size; nothing on-chain depends on it.')}`);
      }
    } else {
      info(`resolution: OFF-CHAIN via your resolver — tokenURI base ${baseUrl}/t · live view ${baseUrl}/a/${chainId}/${shownAddr ?? '<address>'}/{id}`);
    }
    const setupBits = [
      scriptChunks.length ? 'chunks' : '',
      schemas.length ? 'param schemas' : '',
      depLegs ? 'deps' : '',
      onchainUriLegs ? 'on-chain-uri' : '',
      setupMintCount ? 'mints' : '',
    ].filter(Boolean).join('/');
    info(
      `transactions: ${approvals} (deploy${foldIntoInit ? ' — on-chain-uri wiring + mint fold into it' : ''}` +
        (freshDeployBatches.length > 0
          ? ` + ${freshDeployBatches.length} setup ${freshDeployBatches.length === 1 ? 'transaction' : 'transactions (gas-bounded)'}: ${setupBits}`
          : '') +
        ')' +
        (foldIntoInit && freshDeployBatches.length === 0 ? ` ${dim('— single transaction, fully self-contained')}` : ''),
    );
    info(`approvals   ${approvals} wallet approval(s)`); // TX signatures only; the same number the tx-count line above implies
    // Best-effort cost guidance (owner: a bonus in dry-run, never a blocker — silently skip if the
    // RPC can't price gas; see cli-ux-decisions). On-chain byte storage dominates a template drop,
    // so apply the skill's own ~200 gas/byte heuristic to the stored bytes + coarse per-op costs,
    // priced at the live gas price. Clearly hedged — it's an order-of-magnitude figure, not a quote.
    // `planEstimate` carries the SAME figures into the plan object below — `null` (not computed)
    // when the RPC can't price gas, exactly mirroring the human line's own silent skip.
    let planEstimate: {ethApprox: string; gasApprox: string} | null = null;
    try {
      const chunkBytes = scriptChunks.reduce((n, c) => n + (c.length - 2) / 2, 0);
      const fieldBytes = contractFields.reduce((n, f) => n + (f.value.length - 2) / 2, 0);
      const storedBytes = Math.round(chunkBytes + fieldBytes);
      const roughGas =
        250_000n + // clone + init (also writes the collection fields)
        BigInt(scriptChunks.length) * 34_000n + // per-chunk SSTORE2 CREATE overhead
        BigInt(storedBytes) * 216n + // ~200 gas/byte code deposit + ~16 gas/byte calldata
        BigInt(schemas.length) * 45_000n +
        BigInt(depLegs) * 55_000n +
        BigInt(onchainUriLegs?.length ?? 0) * 60_000n +
        BigInt(mintCount) * 65_000n;
      const gasPrice = await publicClient.getGasPrice();
      const eth = Number(roughGas * gasPrice) / 1e18;
      const ethStr = eth >= 0.00001 ? eth.toFixed(5) : '<0.00001';
      info(
        `est. on-chain cost: ${dim('~')}${ethStr} ETH ` +
          dim(`(very rough — ~${Number(roughGas).toLocaleString()} gas @ ${(Number(gasPrice) / 1e9).toFixed(2)} gwei; excludes off-chain storage${codeDir ? ', the dominant cost for a directory drop' : ''})`),
      );
      planEstimate = {ethApprox: ethStr, gasApprox: roughGas.toString()};
    } catch { /* gas pricing unavailable — cost guidance is a bonus, skip silently */ }

    // ── Surfaces — every marketplace-facing dimension, resolved NOW (none is backfillable) ──────
    const renderHome = process.env.ABX_STORAGE_BACKEND || 'fs'; // empty string counts as unset (=fs)
    // A surface is BROKEN only when it resolves to nothing a marketplace can see. A dropped param is
    // NOT that: the token still renders, the param just takes its default. Folding it in here made
    // the block contradict itself two lines apart — "thumbnail: ON-CHAIN ✓ / traits: on-chain ✓"
    // followed by "one or more surfaces resolve to NOTHING", re-recommending the very flags that
    // were already set. The alarm now covers only the surfaces it can honestly speak for, and names
    // only the remedies for what is actually broken.
    const anySurfaceBroken = imageOrphaned || traitsBroken;
    step('Surfaces — what marketplaces will see (settle them NOW; fixing one later is an owner-signed re-point + re-render)');
    (imageOrphaned ? warn : info)(`thumbnail: ${imageDisposition}`);
    // Render-mode / render-home guidance is for the RENDERED-still lanes only. The in-chain
    // Solidity image (--image-renderer) has no off-chain still — nothing to render, host, or refresh.
    // Hoisted: the `render/storage` row further down needs the same fact, so that a managed provider
    // (which owns rendering) never trips the fs warning there either.
    let renderAttached = false;
    if (!imageOrphaned && !hasImageRenderer) {
      if (!hasPublicUrl) info(`  ${dim('render mode (a still is never on-chain):')} ${bold('service')} (auto-render every mint/param change — a live/for-sale drop) · ${bold('once')} (fixed supply) · ${bold('none')} (placeholder). ${dim('freshness: no resolver ⇒ no chain-watcher ⇒ MANUAL/backfill (`abx render` after mints + each param change; the on-chain animation updates live, the bucket still does NOT). Continuous/live stills ⇒ run a resolver.')}`);
      // A managed provider whose descriptor says `render.attached` owns rendering — local
      // ABX_STORAGE_BACKEND is irrelevant, and warning "placeholder forever" is a lie.
      if (
        hasPublicUrl &&
        (!loopbackBaseUrl(baseUrl) || process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1')
      ) {
        try {
          const d = await new AbxServiceClient({baseUrl, timeoutMs: 2_500}).descriptor();
          renderAttached = !!d.render?.attached;
        } catch { /* advisory — a down/non-ABX URL must not fail the dry run */ }
      }
      if (renderAttached) {
        info(`  ${dim('render storage home:')} ${bold('managed by the resolver')} ${dim(`(${baseUrl}) — nothing local to configure`)}`);
      } else if (renderHome === 'fs') {
        // The fs render-home footgun bites the RESOLVER lane hardest (a hosted resolver can't read your
        // laptop disk → placeholder on OpenSea), so warn on BOTH lanes and name the concrete fix.
        warn(`  render storage home is ${bold('fs')} — LOCAL to this machine, so ${hasPublicUrl ? 'a hosted resolver' : 'a marketplace'} can't read the rendered stills → placeholder forever. FIX before you render: ${bold('set ABX_STORAGE_BACKEND=arweave|s3|ipfs')} in .env (a PUBLIC home the runner uploads to).`);
      } else {
        info(`  ${dim('render storage home:')} ${bold(renderHome)} ${dim('— a public home the runner uploads to ✓')}`);
      }
    }
    (traitsBroken ? warn : info)(`traits: ${traitsDisposition}`); // `paramsNudge` is hoisted above (with `paramsDisposition`) — shared with the plan object
    ((undeclaredParams.length || paramsNudge ? warn : info))(`postparams: ${paramsDisposition}`);
    if (anySurfaceBroken) {
      const remedies = [
        imageOrphaned && `thumbnail ⇒ ${bold('--image-renderer <Solidity SVG>')} / ${bold('--image-base <public bucket>')} / a resolver`,
        traitsBroken && `traits ⇒ ${bold('--attributes-renderer')} or a resolver`,
      ].filter(Boolean).join(' · ');
      const which = imageOrphaned && traitsBroken ? 'the thumbnail and traits surfaces resolve' : `the ${imageOrphaned ? 'thumbnail' : 'traits'} surface resolves`;
      warn(`${bold(`${which} to NOTHING a marketplace can see`)} — fix before deploy (a deploy-time decision you can't add later without a re-point tx): ${remedies}.`);
    }
    // A dropped param is its own, milder problem: the piece renders, that input just takes its
    // default. Kept separate from the broken-surface alarm above (see the note there).
    if (undeclaredParams.length) info(`  ${dim('dropped params render with their defaults — declare collector/creator inputs with')} ${bold('--schema <key>:<Type>:<Auth>')} ${dim('(skip this for keys an augment hook supplies)')}`);
    // The runner/verify line is for lanes that need an off-chain STILL. An on-chain image renderer has
    // no still to render, host, or refresh — whether or not there's also a program driving
    // animation_url — so pointing at a runner and a bucket backend there is simply wrong.
    if (hasImageRenderer) {
      info(
        `  ${g('nothing to render')} — the thumbnail is computed on-chain${hasProgram ? ' and the animation assembles on-chain from your script' : ''}; no runner, no bucket, no refresh. ` +
          `verify from chain: ${bold('abx tokenuri ' + (shownAddr ?? '<address>'))} ${dim('(decodes name + on-chain SVG + traits)')}`,
      );
    } else if (renderAttached) {
      info(
        `  ${dim('managed renderer:')} ${bold(baseUrl)} ${dim('owns the still + traits — no local runner, storage backend, or render command.')} ` +
          `verify: ${bold('abx verify ' + (shownAddr ?? '<address>') + ' --remote ' + baseUrl)}`,
      );
    } else {
      const remoteRender = !(onChainUri && hasImageBase);
      info(`  ${dim('stand up the runner:')} ${bold('abx deploy-effects --resolver-url ' + baseUrl)} · one-shot: ${bold('abx render ' + (shownAddr ?? '<address>') + (remoteRender ? ' --remote ' + baseUrl : ''))} · verify: ${bold('abx verify ' + (shownAddr ?? '<address>'))}`);
      // Rendering against a resolver you don't share a disk with means YOU hold the bytes and it
      // holds the URL — so say now which backend that needs, rather than letting the render fail.
      if (remoteRender && !resolveBackend(storageOptions(storageOverrides(flags))).locator) {
        info(`  ${dim('that render publishes a URL, so it needs a backend that can name one:')} ${bold('--backend cloud')} ${dim('(S3/R2 + public base) ·')} ${bold('ipfs')} ${dim('·')} ${bold('arweave')} ${dim('— or render co-located with the resolver (`abx effects` on its host).')}`);
      }
    }
    // The render×storage combo validator in packages/storage/content-plan.ts is the same
    // check that already refused a bad --image-base above (real run) — summarized as one row here,
    // so a preview never disagrees with what the real run just enforced (or, for the remote-publish
    // combo, with what `abx render --remote`/`abx effects` enforce later — deploy-code can't know FOR
    // CERTAIN whether a future render will be remote or co-located, so this best-effort signal
    // mirrors the nudge above rather than hard-refusing a legitimate co-located workflow).
    if (renderAttached) {
      info(`render/storage  ✓ managed by the resolver ${dim(`(${baseUrl}); local ABX_STORAGE_BACKEND is irrelevant`)}`);
    } else {
      const renderStorageBackendId = backendResolution(storageOverrides(flags)).backend;
      const renderStorageOpts = storageOptions(storageOverrides(flags));
      const renderStorageCombo = validateRenderStorageCombo({
        imageBaseUrl: hasImageBase ? String(flags['image-base']) : undefined,
        backendId: renderStorageBackendId,
        cloudHasPublicBase: renderStorageBackendId === 'cloud' ? !!renderStorageOpts.cloud?.publicBase : undefined,
        publishesToRemoteResolver: !hasImageRenderer && !(onChainUri && hasImageBase),
      });
      // `validateRenderStorageCombo` deliberately scopes itself to the --image-base URL SHAPE and the
      // remote-resolver lane, so it returns ok for `fs` + --image-base — while the render-home check a
      // few lines above correctly warns that an fs home means nothing ever uploads the still to that
      // bucket. Both lines described the same setup and only one said it was broken, and a creator
      // skimming for the checkmark reads ✓ as approval. The row now defers to that warning rather than
      // overriding it: same fact, one verdict.
      // This row is deliberately scoped to whether the --image-base TARGET is valid (a mutable bucket,
      // not a content-addressed gateway) and whether a remote resolver could fetch what we store — it
      // is NOT a verdict on the render home, which has its own warning above. Unqualified, though, a
      // bare `✓ fs + --image-base` sat a few lines under "render storage home is fs … placeholder
      // forever" and read as though it overruled it. Name what the ✓ covers, and point at the other
      // line when that one is unhappy, so one setup stops producing two verdicts.
      const fsHomeUnresolved = renderHome === 'fs' && !imageOrphaned && !hasImageRenderer;
      if (renderStorageCombo.ok) {
        const scope = hasImageBase ? '--image-base is a valid mutable target' : `${renderStorageBackendId} can serve what it stores`;
        info(
          `render/storage  ✓ ${scope}` +
            (fsHomeUnresolved ? dim(` — but the render home is still ${bold('fs')}; see the warning above, this ✓ does not cover it`) : ''),
        );
      } else warn(`render/storage  ✗ ${renderStorageCombo.reason}`);
    }
    if (dirUpload) await noteStorageReadiness(storageOptions(storageOverrides(flags)), dirUpload.sizes);
    if (deployer && !explicitSalt) {
      // Enforce, don't warn: no predicted address was shown above (see `shownAddr`), so print
      // the one thing that DOES stay true: the salt itself, pinned via --salt (or `abx predict`)
      // reproduces this exact address on the real deploy. `salt` is non-null here — it's only ever
      // null when `deployer` is (see its ternary above), which this branch already checked.
      const pinnedSalt = salt as Hex;
      const predictContent = flags.script ? `--script ${flags.script}` : flags['code-dir'] ? `--code-dir ${flags['code-dir']}` : flags['image-renderer'] ? `--image-renderer ${flags['image-renderer']}` : '';
      console.log(`\n  ${bold('salt')}  ${g(pinnedSalt)}`);
      info(`address: pinned by salt — re-run with ${bold(`--salt ${pinnedSalt}`)} (same address), or ${bold(`abx predict ${predictContent ? `${predictContent} ` : ''}--salt ${pinnedSalt} --for ${deployer}`)}.`);
      info(`reproduce this exact preview (salt included): ${bold(deployCodeCommandLine(flags, pinnedSalt))}`);
    } else if (!deployer) {
      info(`pass ${bold('--for 0x..')} to see the exact deterministic address + a pinned-salt re-run command.`);
    }
    console.log(`\n  ${g('dry run')} ${dim('— nothing sent, no bytes stored. Re-run without --dry-run to deploy.')}\n`);
    // `address` is null without --salt pinning it or in the wallet lane with no --for (the
    // signer decides the salt, so no address exists yet) — reporting null is the honest answer;
    // inventing one would be a wrong reservation.
    emit(jsonSafe({
      command: 'deploy-code', dryRun: true, sent: false, address: shownAddr, chain: CHAIN, chainId: resolveChain(CHAIN).id, factory, salt: salt ?? null, saltPinned: !!explicitSalt, name, symbol, onChainUri,
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: 'code' satisfies DeployPlanFamily,
        // `lane` (the hoisted const) isn't declared until AFTER this early-return block — reading it
        // here would hit its temporal dead zone. `laneFromFlags` is pure (flags only), so call it
        // directly; the sent-side emit, below `const lane = …`, uses the hoisted binding instead.
        lane: laneFromFlags(flags),
        transactions: {approvals, legs: planSetupLegs},
        roles: {
          signer: deployer, owner: deployer, royaltyReceiver: deployer,
          primaryPayee: (flags['primary-payee'] as Address | undefined) ?? null,
          minter: (flags.minter as Address | undefined) ?? null,
        },
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          // The code lane's image is one of several independently-disposed surfaces, not a single
          // boolean — see `surfaces.thumbnail` below.
          imageOnChain: null,
          backend: dirUpload ? dirUpload.backend.id : null,
          tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
          contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
          renderer: onChainUri ? metadataRenderer : null,
          // This lane has no single `--image` file — see `surfaces.thumbnail` below instead.
          image: null,
        },
        mint: {deferred: mintCount === 0, count: mintCount, amountPerId: null, recipient: mintCount > 0 ? deployer : null},
        estimate: planEstimate ?? {ethApprox: null, gasApprox: null},
        warnings: planWarnings.slice(),
        surfaces: {
          thumbnail: {ok: !imageOrphaned, detail: stripAnsiForPlan(imageDisposition)},
          traits: {ok: !traitsBroken, detail: stripAnsiForPlan(traitsDisposition)},
          postParams: {ok: !(undeclaredParams.length > 0 || paramsNudge), detail: stripAnsiForPlan(paramsDisposition)},
        },
        dependencies: {count: deps.length, registry: depRegistry ?? null},
        resume: null,
      } satisfies DeployPlan,
    }));
    return;
  }

  // Real deploy: perform the deferred directory upload now (past the confirm gate).
  if (dirUpload) {
    const {base} = await dirUpload.backend.putDirectory!(dirUpload.entries);
    // Store the BARE locator (CID / arweave txid), never a full gateway URL — the resolver applies
    // the gateway at serve time per `representation`. Storing `https://arweave.net/<txid>` with
    // representation `arweave` double-prefixed the live view to a broken URL.
    const ipfsCid = base.match(/\/ipfs\/([^/]+)/)?.[1];
    const arTxid = base.match(/arweave\.net\/([^/?#]+)/i)?.[1];
    const rep = ipfsCid ? 'ipfs' : dirUpload.backend.id === 'arweave' ? 'arweave' : 'url';
    const value = ipfsCid ?? (rep === 'arweave' ? (arTxid ?? base) : base);
    contractFields.push({field: encodeTag('code'), representation: encodeTag(rep), value: toHex(value)});
    ok(`uploaded ${dirUpload.entries.length} file(s) → code field (${rep}): ${value}`);
  }

  step('Deploy');
  const lane = laneFromFlags(flags);
  // --onchain-uri with no explicit public URL: leave the off-chain pointer EMPTY rather than
  // baking a misleading localhost (the renderer is authoritative while set) — the same rule as
  // the 1/1's on-chain lane. The renderers themselves are set as setup-multicall legs, so the
  // on-chain lane flips on atomically WITH the content/params it resolves from.
  const initParamsFor = (owner: Address) => ({
    owner,
    name,
    symbol,
    tokenURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/t`,
    // Renderer-only fold: the metadata renderer (what makes tokenURI resolve on-chain) rides the
    // deploy tx. The script/dir lane still sets it via the multicall (0 here), because its content
    // isn't on-chain until that same multicall — flipping the renderer on before the chunks land
    // would leave a transient window of broken tokenURIs.
    tokenURIRenderer: foldIntoInit ? metadataRenderer : zeroAddress,
    contractURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/c`,
    contractURIRenderer: foldIntoInit ? metadataRenderer : zeroAddress,
    royaltyReceiver: owner,
    royaltyBps,
    maxRoyaltyBps,
    burnable,
    transferValidator,
    maxInvocations: BigInt(max),
    primaryPayee: (flags['primary-payee'] as Address) ?? zeroAddress,
    minter: (flags.minter as Address) ?? zeroAddress,
    paused,
    seedSource,
    disableTokenOwnerDelegation: flags['no-delegation'] !== undefined,
    // Reserve mints fold into init ONLY for renderer-only (the token is fully configured at deploy).
    mintTo: foldIntoInit && mintCount > 0 ? owner : zeroAddress,
    mintCount: foldIntoInit ? BigInt(mintCount) : 0n,
    tokenFields: [],
    contractFields,
  });
  // `setupLegGroups` (the shared, resume-compatible builder) and the fresh-deploy batch shape
  // (`freshDeployBatches`) are hoisted above — see the comment there for why. Build the REAL
  // transactions for the actual signer from the SAME batch shape (identical `.gas` sequence ⇒
  // identical split — see `planCodeSetupBatches`'s doc), this time with real mint calldata.
  const cid = resolveChain(CHAIN).id;
  const preparedFor = async (owner: Address) => {
    const salt = parseSaltFlag(flags.salt) ?? saltFor(owner);
    const clone = (await publicClient.readContract({address: factory, abi: seriesCodeFactoryAbi, functionName: 'predictDeterministicAddress', args: [salt]})) as Address;
    const g = setupLegGroups(owner);
    const batches = planCodeSetupBatches({
      ...coreSetupLegs(g),
      mints: Array.from({length: setupMintCount}, () => mintSetupLeg(g.mints.data)),
    });
    const setupTxs = codeSetupTxsFromBatches(batches, {contract: clone, chainId: cid, deps: deps.map((d) => d.display)});
    const txs = [prepareDeploySeriesCode({factory, params: initParamsFor(owner), salt, chainId: cid, clone}), ...setupTxs];
    return {clone, txs};
  };

  // ── --resume: finish an EXISTING contract, deploy nothing ──────────────────────────────────
  // A code deploy is two transactions. When the second fails you own a live-but-unusable contract and
  // the salt reserved for its address is spent, so the dry run's pinned-salt reproduce command can
  // never be run again. The contract is recoverable, not lost — a tester proved that by resending the
  // setup by hand with `cast`. This is that, as a verb: read what is missing, send only that.
  const resumeAddr = flags.resume as string | undefined;
  if (resumeAddr !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(resumeAddr)) {
      throw new Error(`--resume wants the address of the contract to finish; '${resumeAddr}' isn't a 0x address.`);
    }
    const target = resumeAddr as Address;
    const code = await publicClient.getCode({address: target}).catch(() => undefined);
    if (!code || code === '0x') {
      throw new Error(
        `--resume ${target}: no contract at that address on ${CHAIN} (asked ${redactRpcUrl(resolveRpcUrl(CHAIN))}). ` +
          `There is nothing to finish — if the DEPLOY tx is what failed, run a normal deploy instead. ` +
          `If you JUST deployed, give the tx a block or two to mine.`,
      );
    }
    // Deploy-time-only flags are refused rather than ignored: --salt/--721c/--bootstrap-factory all
    // describe how a contract is CREATED, and this creates nothing. 721C especially — enrollment is
    // permanent and deploy-time-only, so accepting the flag here would imply it can be added later.
    // (--copies + --resume is refused earlier, at cmdDeployCode's dispatch — before this function
    // even runs — so `flags.copies` is guaranteed undefined here; see that guard's own comment.)
    for (const [flag, why] of [
      ['salt', 'the address already exists, so no salt is used'],
      ['721c', 'ERC-721C enrollment is deploy-time-only and PERMANENT — it cannot be added to an existing collection'],
      ['bootstrap-factory', 'no factory is involved: nothing is being created'],
      ['mint-all', 'use --mint-count <n> on a resume; --mint-all is resolved against the cap at deploy time'],
    ] as const) {
      if (flags[flag] !== undefined) throw new Error(`--resume cannot be combined with --${flag}: ${why}.`);
    }
    // 721 SeriesCode vs EditionCode: same setup shape (script chunks, schemas, deps, on-chain URI
    // legs), different mint shape — a 721 mints ONE sequential token against a whole-contract
    // `totalSupply()`; an edition mints AMOUNT copies of a specific id against that id's own
    // `totalSupply(id)` (there is no whole-contract total on an edition — see tokens.ts's
    // `TokenListing.totalSupply` doc). `resume.ts` models both (`planResume`/`planEditionResume`,
    // sharing the four non-mint legs via `planCoreLegs`); this is the one place that decides which.
    const isEdition = await isEditionContract(publicClient, target);
    if (!isEdition && flags['mint-amount'] !== undefined) {
      throw new Error(
        `--resume ${target}: this is a 721 SeriesCode contract, so --mint-amount has nothing to address — its mint leg ` +
          `is a single whole-contract shortfall with no per-id amount. Drop --mint-amount (use --mint-count).`,
      );
    }
    const abi = isEdition ? editionCodeAbi : seriesCodeAbi;
    const owner = await publicClient
      .readContract({address: target, abi, functionName: 'owner'})
      .catch(() => undefined) as Address | undefined;
    if (!owner) throw new Error(`--resume ${target}: could not read owner() — is this an ABX SeriesCode/EditionCode contract?`);

    step('Resume — read what is missing, send only that');
    info(`target ${bold(target)} ${dim(`· owner ${owner}${isEdition ? ' · EditionCode (ERC-1155)' : ''}`)}`);
    // Every read is a view on the target; the intended legs come from the SAME builder a fresh deploy
    // uses, so what gets sent is by construction what the deploy would have written. Only the four
    // non-mint groups are used on the edition branch below — `legs.mints` is the 721 shape and is
    // rebuilt per-id there instead (see resume.ts's class doc for why the split).
    const legs = setupLegGroups(owner);
    // The contract is `T | null` (the planner distinguishes "read failed" from a legitimately-falsy
    // result); tryReadContract's is `T | undefined` — adapt at the boundary.
    const readAt = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T | null> => {
      const result = await tryReadContract<T>(publicClient, {address: target, abi, functionName, args});
      return result === undefined ? null : result;
    };
    const nonZero = (a: Address | null): Address | null => (a && a !== zeroAddress ? a : null);
    // The four id-agnostic reads, shared verbatim by both standards (see resume.ts's `ResumeReaderCore`).
    const coreReads = {
      scriptChunkCount: async () => Number((await readAt<bigint>('scriptChunkCount')) ?? 0n),
      scriptChunk: (index: number) => readAt<Hex>('scriptChunk', [BigInt(index)]),
      schemaExists: async (key: string) => {
        const r = await readAt<readonly [boolean, ...unknown[]]>('paramSchema', [encodeTag(key)]);
        return !!r?.[0];
      },
      dependencyCount: async () => Number((await readAt<bigint>('dependencyCount')) ?? 0n),
      dependencyRegistry: async () => nonZero(await readAt<Address>('dependencyRegistry')),
      tokenURIRenderer: async () => nonZero(await readAt<Address>('tokenURIRenderer')),
      contractURIRenderer: async () => nonZero(await readAt<Address>('contractURIRenderer')),
      contractFieldSet: async (field: string) => {
        const r = await readAt<readonly [Hex, Hex]>('contractField', [encodeTag(field)]);
        return !!r && r[0] !== `0x${'0'.repeat(64)}`;
      },
    };
    const plan = isEdition
      ? await (async () => {
          // `--mint-count`/`--mint-amount` are the SAME flags a fresh `--copies` deploy reads (see
          // cmdDeployEditionCodeBody) — so re-running the original command with `--copies` swapped
          // for `--resume <address>` reproduces the identical intended mint plan: ids 0..mintCount-1,
          // each an intended TOTAL of mintAmount copies.
          const mintAmount = flags['mint-amount'] !== undefined ? parseNonNegativeIntFlag(String(flags['mint-amount']), 'mint-amount') : 1n;
          if (mintCount > 0 && mintAmount === 0n) {
            throw new Error('--mint-amount 0 with ids being pre-minted makes no sense — pass a positive --mint-amount, or drop --mint-count/--no-mint it entirely.');
          }
          const editionLegs: EditionSetupLegs = {
            chunks: legs.chunks,
            schemas: legs.schemas,
            deps: legs.deps,
            uri: legs.uri,
            mints: Array.from({length: mintCount}, (_, id) => ({
              id: BigInt(id),
              intendedAmount: mintAmount,
              dataForAmount: (amount: bigint) =>
                encodeFunctionData({abi: oneOfOneEditionAbi, functionName: 'mint', args: [owner, BigInt(id), amount]}),
            })),
          };
          const reader: EditionResumeReader = {
            ...coreReads,
            totalSupplyForId: async (id) => Number((await readAt<bigint>('totalSupply', [id])) ?? 0n),
          };
          return planEditionResume(reader, editionLegs);
        })()
      : await planResume({...coreReads, totalSupply: async () => Number((await readAt<bigint>('totalSupply')) ?? 0n)}, legs);
    for (const line of plan.done) ok(line);
    for (const line of plan.todo) info(`will send — ${line}`);
    // A resume plan object (below) reports its OWN family/roles/custody, deliberately lighter than a
    // fresh deploy's: royalty, mint, and byte custody are InitParams fields fixed at the ORIGINAL
    // deploy — a resume only ever finishes MISSING setup legs, so those fields are explicit `null`
    // (see deploy-plan.ts's own doc comments) rather than restating what this invocation's flags say,
    // which a resume does not actually write.
    // ANNOTATED, not inferred: this object is spread into four `satisfies DeployPlan` emits below, and
    // an un-annotated literal WIDENS its own properties (`schemaVersion` 1 -> number, `family`
    // 'code'|'code-edition' -> string), so every one of those spreads would fail to satisfy the plan.
    // The Omit names exactly the three keys each call site supplies for itself.
    const resumePlanBase: Omit<DeployPlan, 'transactions' | 'estimate' | 'resume'> = {
      schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
      family: isEdition ? 'code-edition' : 'code',
      lane,
      roles: {signer: owner, owner, royaltyReceiver: null, primaryPayee: null, minter: null},
      royalty: null,
      // renderer/image: null — both are InitParams facts fixed at the ORIGINAL deploy (like
      // royalty/mint above); a resume doesn't re-read or re-decide either here.
      custody: {onChainUri, imageOnChain: null, backend: null, tokenUriBase: null, contractUriBase: null, renderer: null, image: null},
      mint: null,
      warnings: planWarnings.slice(),
      // Still reflects what THIS invocation's flags say about every marketplace-facing surface —
      // computed once, unconditionally, at the top of the function (see `imageDisposition` et al.),
      // so it's available whether this run turns out to be a fresh deploy or a `--resume`.
      surfaces: {
        thumbnail: {ok: !imageOrphaned, detail: stripAnsiForPlan(imageDisposition)},
        traits: {ok: !traitsBroken, detail: stripAnsiForPlan(traitsDisposition)},
        postParams: {ok: !(undeclaredParams.length > 0 || paramsNudge), detail: stripAnsiForPlan(paramsDisposition)},
      },
      dependencies: {count: deps.length, registry: depRegistry ?? null},
    };
    if (!plan.calls.length) {
      ok(`nothing missing — this contract's setup is already complete. ${dim('Confirm with `abx verify ' + target + '`.')}`);
      emit(jsonSafe({
        command: 'deploy-code', kind: isEdition ? 'edition-code' : 'code', resumed: target, chain: CHAIN, chainId: resolveChain(CHAIN).id, sent: false, complete: true, sentLegs: 0,
        plan: {
          ...resumePlanBase,
          transactions: {approvals: 0, legs: null},
          estimate: {ethApprox: null, gasApprox: null},
          resume: {target, sentLegs: 0, complete: true},
        } satisfies DeployPlan,
      }));
      console.log('');
      return;
    }
    // Reconstruct `plan.calls` (one flat, ORDERED array) back into the four leg groups it was built
    // from — chunks, schemas, deps, uri, in that exact order (resume.ts's `planCoreLegs` guarantees
    // it; see its module doc) — using the counts `plan.sending` already reports, so this can't drift
    // from what the diff actually decided to send. Mints (whatever is left) are appended by
    // `planResume`/`planEditionResume` AFTER these four, also guaranteed by resume.ts.
    let resumeCallPtr = 0;
    const takeResumeCalls = (n: number): Hex[] => {
      const slice = plan.calls.slice(resumeCallPtr, resumeCallPtr + n);
      resumeCallPtr += n;
      return slice;
    };
    const missingChunkCalls = takeResumeCalls(plan.sending.chunkIndices.length);
    const missingSchemaCalls = takeResumeCalls(plan.sending.schemaKeys.length);
    const missingDepsCalls = takeResumeCalls(plan.sending.deps ? legs.deps.calls.length : 0);
    const missingUriCalls = takeResumeCalls(plan.sending.uri ? legs.uri.calls.length : 0);
    const missingMintCalls = takeResumeCalls(plan.sending.mints);
    // Same gas-bounded batching a fresh deploy uses (`planCodeSetupBatches`) — a `--resume` whose
    // setup never landed AT ALL is missing exactly as much as a fresh deploy would have sent, so it
    // needs the identical split to clear the same `eth_estimateGas` ceiling.
    const resumeBatches = planCodeSetupBatches({
      chunks: missingChunkCalls.map((data, i) => {
        const bytes = plan.sending.chunkBytes[i];
        return {calls: [data], gas: estimateChunkGasForBytes(bytes), label: `script chunk [${plan.sending.chunkIndices[i]}] (${bytes} bytes)`, kind: 'chunk', chunkBytes: [bytes]} satisfies SetupLeg;
      }),
      config: [
        ...missingSchemaCalls.map((data, i) => schemaSetupLeg(plan.sending.schemaKeys[i], data)),
        ...(missingDepsCalls.length ? [depsSetupLeg(missingDepsCalls)] : []),
        ...(missingUriCalls.length ? [uriSetupLeg(missingUriCalls)] : []),
      ],
      mints: missingMintCalls.map(mintSetupLeg),
    });
    const setupTxs = codeSetupTxsFromBatches(resumeBatches, {
      contract: target,
      chainId: resolveChain(CHAIN).id,
      deps: plan.sending.deps ? deps.map((d) => d.display) : [],
    });
    // `transactions.legs` names WHICH groups ride the setup, from the same `plan.sending` flags that
    // build the batches above (never re-derived) — GROUP names, not a literal per-transaction count
    // (see deploy-plan.ts's own doc comment on `legs`; a `--resume` may now send more than one setup
    // transaction, same as a fresh deploy).
    const resumeLegs = [
      plan.sending.chunkIndices.length ? 'chunks' : null,
      plan.sending.schemaKeys.length ? 'param-schemas' : null,
      plan.sending.deps ? 'dependencies' : null,
      plan.sending.uri ? 'onchain-uri' : null,
    ].filter((leg): leg is string => leg !== null);
    // Routed through the shared risk gate — the same choke point ownerops.ts's `runWrite` uses for
    // every owner-op: --dry-run preview / --confirm prompt / lane selection / signing, all one way.
    // This used to be its own hand-rolled copy of that exact shape (a dry-run print then confirmSend
    // then signTx, duplicated from ownerops.ts's `runWrite`); a deploy-family write is a write like
    // any other, so it takes the identical gate (the preview also gains the `to`/`owner` lines
    // `runWrite`'s preview always printed) — called once per gas-bounded batch, in order.
    if (isDryRun(flags)) {
      emit(jsonSafe({
        command: 'deploy-code', kind: isEdition ? 'edition-code' : 'code', resumed: target, chain: CHAIN, chainId: resolveChain(CHAIN).id, dryRun: true, sent: false, complete: false, sentLegs: plan.calls.length,
        plan: {
          ...resumePlanBase,
          transactions: {approvals: setupTxs.length, legs: resumeLegs},
          estimate: {ethApprox: null, gasApprox: null},
          resume: {target, sentLegs: plan.calls.length, complete: false},
        } satisfies DeployPlan,
      }));
    }
    let lastResult: SignResult | null = null;
    for (const tx of setupTxs) {
      const result = await gatedSend(() => tx, flags, {chainKey: CHAIN, expectedSigner: owner});
      if (result) {
        ok(`${tx.summary}`);
        lastResult = result;
      }
    }
    if (isDryRun(flags)) return;
    if (!lastResult) {
      // The cold ('unsigned') lane: every batch printed its own unsigned tx above (in order — they
      // target the SAME already-existing contract, so unlike a fresh deploy's deploy→setup dependency
      // there's no reason to withhold the later ones). Nothing was broadcast, so there is no block to
      // scan from and no indexing to do yet.
      console.log(
        `\n${dim(`  unsigned — broadcast ${setupTxs.length > 1 ? 'these, in order,' : 'it'} then re-run \`abx verify ${target}\` to confirm the setup completed.`)}\n`,
      );
      emit(jsonSafe({
        command: 'deploy-code', kind: isEdition ? 'edition-code' : 'code', resumed: target, chain: CHAIN, chainId: resolveChain(CHAIN).id, sent: false, complete: false, sentLegs: plan.calls.length,
        plan: {
          ...resumePlanBase,
          transactions: {approvals: setupTxs.length, legs: resumeLegs},
          estimate: {ethApprox: null, gasApprox: null},
          resume: {target, sentLegs: plan.calls.length, complete: false},
        } satisfies DeployPlan,
      }));
      return;
    }
    // Locals, not the outer clone/deployBlock: this branch never falls through to the deploy path, and
    // the authoritative scan floor is still the clone's CREATION block (getCode search), not this
    // repair tx's block — flooring the resolver above the deploy would hide the `code` field again.
    const resumedFloor = (await discoverDeployBlock(publicClient, target)) ?? lastResult.blockNumber;
    emit(
      jsonSafe({
        command: 'deploy-code',
        kind: isEdition ? 'edition-code' : 'code',
        resumed: target,
        address: target,
        chain: CHAIN,
        chainId: resolveChain(CHAIN).id,
        deployBlock: resumedFloor,
        sent: true,
        complete: true,
        sentLegs: plan.calls.length,
        txHash: lastResult.txHash,
        plan: {
          ...resumePlanBase,
          transactions: {approvals: setupTxs.length, legs: resumeLegs},
          estimate: {ethApprox: null, gasApprox: null},
          resume: {target, sentLegs: plan.calls.length, complete: true},
        } satisfies DeployPlan,
      }),
    );
    step('Index');
    // The factory HINT registerAndIndexLocally passes through to detectCanonicalFactory is taken as
    // an UNVERIFIED override when present (see anchors.ts) — so it must name the RIGHT factory family
    // for this target. `factory` (outer scope) is the 721 SeriesCode factory this function resolved at
    // its own "Trust anchor" step; an EditionCode target needs its own factory's address instead (a
    // read-only manifest lookup — never bootstraps one, unlike a real edition deploy).
    await registerAndIndexLocally(target, {
      'from-block': resumedFloor.toString(),
      factory: isEdition ? editionCodeFactoryAddress(flags.factory as string | undefined) : factory,
      label: name,
    } as Flags);
    console.log(
      `\n  ${g('\u2713 setup finished')} \u2014 ${dim('confirm it resolves:')} ${bold(`abx verify ${target}`)}` +
        `${onChainUri ? dim('  (chain-complete + the on-chain tokenURI)') : ''}\n`,
    );
    return;
  }

  let clone: Address;
  let deployBlock: bigint;
  // See the 1/1 lane's identical local for why this is hoisted (feeds the sent plan's `roles`). The
  // 'unsigned' branch below returns before the sent `emit()`, so it never needs to set this.
  let deployerAddr: Address | undefined;
  if (lane === 'unsigned') {
    // cold lane: deterministic deploy makes the whole sequence pre-computable — the clone
    // address is a pure function of (factory, salt), so setup + mints target it up front.
    const signer = flags.for as Address | undefined;
    if (!signer) throw new Error('--unsigned needs --for <signer> — the salt guard and ownership are keyed to the signing address');
    const {clone: predicted, txs} = await preparedFor(signer);
    for (const tx of txs) {
      await signTx(() => tx, {lane, chainKey: CHAIN, yes: !!flags.yes, expectedSigner: signer});
    }
    console.log(`\n${dim(`  unsigned — broadcast in order, then: abx add ${predicted} --factory ${factory} --from-block <deployBlock>`)}\n`);
    return;
  }
  if (lane === 'sign') {
    // wallet lane: one session approves the deploy + the setup multicall (+ mints ride the
    // multicall — msg.sender is preserved, so owner-auth holds). Use `total: approvals` instead of
    // a bare `2`, because `preparedFor` sends just one deploy transaction whenever
    // setupLen is 0 (no chunks/schemas/deps/on-chain-uri legs/setup-carried mints); the sign page
    // would have shown "Transaction 1 of 2" and then silently never asked for a second. `approvals`
    // is computed with the exact same `setupLen` math `preparedFor`'s own tx-count uses, so it can't
    // drift from what this session actually sends.
    const session = await openWalletSession({chainKey: CHAIN, expectedSigner: flags.for as Address | undefined, total: approvals, port: flags.port ? Number(flags.port) : undefined, signUrlFile: flags['sign-url-file']});
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      const {clone: predicted, txs} = await preparedFor(signer);
      // The scan floor is the clone-CREATION block (txs[0]) — NOT the last tx. A wallet session can
      // span blocks (deploy at N, setup+mint at N+2), and the `code` field is written in the deploy
      // tx's init params; recording the last (mint) block floored the resolver ABOVE it, so it never
      // indexed the code field → "not a code project" on an otherwise-correct deploy.
      let first: bigint | undefined;
      for (const tx of txs) {
        const sent = await session.send(tx);
        if (first === undefined) first = sent.receipt.blockNumber;
      }
      clone = predicted;
      deployBlock = first ?? 0n;
    } finally {
      session.close();
    }
  } else {
    // hot lane: the env key signs the WHOLE sequence (deploy, then the setup multicall that
    // targets the clone the deploy just created) through one `makeHotSender` — nonce pinned once,
    // gas re-checked per tx against a target a prior tx in this run may just have created. See
    // `signHotSequence` (signer.ts) / `makeHotSender` (sdk execute.ts) for the read-after-write-lag
    // reasoning this used to be a hand-rolled loop for.
    const {account} = makeWalletClient({chainKey: CHAIN});
    deployerAddr = account.address;
    const {clone: predicted, txs} = await preparedFor(account.address);
    const results = await signHotSequence(txs, {chainKey: CHAIN, yes: !!flags.yes});
    clone = predicted;
    deployBlock = results[0]?.blockNumber ?? 0n;
  }
  // Authoritative floor: a receipt block can be wrong (a wallet session that spans blocks) or stale
  // (a re-run against a pre-existing deterministic clone reports THIS run's block, not the original —
  // exactly the retry case). discoverDeployBlock reads the clone's real creation block from chain
  // (getCode binary search) — the same helper `add` uses when no floor is known. It's the scan floor
  // that lets the resolver see the `code` field, so trust chain over the receipt.
  const discovered = await discoverDeployBlock(publicClient, clone);
  if (discovered !== null) deployBlock = discovered;
  ok(`SeriesCode live: ${clone} ${dim(`(from block ${deployBlock})`)}`);
  // Every PERMANENT deploy decision, said out loud on the path that actually sent one. These lines
  // existed only under --dry-run, so a creator who went straight to --send learned their supply cap
  // and their royalty rate afterwards, from `abx state` — the royalty in particular, because 5% to
  // the deployer is a real economic default nobody asked for on a testnet demo. Reported from the
  // field on alpha.29. Same markers as the dry-run's plan line, so the two read identically.
  info(
    `permanent: max ${max}${maxProvided ? '' : ' ⚠ default'} · royalty ${royaltyBps / 100}%${royaltyProvided ? '' : ' ⚠ default'} → the deploying wallet` +
      ` · cap ${maxRoyaltyBps / 100}%${burnable ? ' · burnable' : ''}` +
      dim(`  (rate is changeable with \`abx set-royalty\`; the CAP only ever goes down, and \`max\` only ever goes down)`),
  );
  // Emitted here rather than at the end: a code deploy is TWO transactions, and if the second (setup)
  // fails, the address of the live-but-incomplete contract is the single most valuable thing a caller
  // can be told — it is exactly the input `--resume <address>` takes to finish the job.
  emit(
    jsonSafe({
      command: 'deploy-code',
      address: clone,
      chain: CHAIN,
      chainId: resolveChain(CHAIN).id,
      factory,
      deployBlock,
      name,
      symbol,
      onChainUri,
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: 'code' satisfies DeployPlanFamily,
        lane,
        transactions: {approvals, legs: planSetupLegs},
        roles: {
          signer: deployerAddr ?? null, owner: deployerAddr ?? null, royaltyReceiver: deployerAddr ?? null,
          primaryPayee: (flags['primary-payee'] as Address | undefined) ?? null,
          minter: (flags.minter as Address | undefined) ?? null,
        },
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          imageOnChain: null, // see `surfaces.thumbnail`
          backend: dirUpload ? dirUpload.backend.id : null,
          tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
          contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
          renderer: onChainUri ? metadataRenderer : null,
          image: null, // see `surfaces.thumbnail`
        },
        mint: {deferred: mintCount === 0, count: mintCount, amountPerId: null, recipient: mintCount > 0 ? deployerAddr ?? null : null},
        // Unlike the dry run, the sent path computes no cost estimate (the gas-guidance try/catch is
        // dry-run-only — a real send just pays whatever `estimateGas` returns at signing time).
        estimate: {ethApprox: null, gasApprox: null},
        warnings: planWarnings.slice(),
        surfaces: {
          thumbnail: {ok: !imageOrphaned, detail: stripAnsiForPlan(imageDisposition)},
          traits: {ok: !traitsBroken, detail: stripAnsiForPlan(traitsDisposition)},
          postParams: {ok: !(undeclaredParams.length > 0 || paramsNudge), detail: stripAnsiForPlan(paramsDisposition)},
        },
        dependencies: {count: deps.length, registry: depRegistry ?? null},
        resume: null,
      } satisfies DeployPlan,
    }),
  );

  step('Index');
  await registerAndIndexLocally(clone, {'from-block': deployBlock.toString(), factory, label: name} as Flags);

  if (onChainUri) {
    step('On-chain URI');
    ok(`tokenURI/contractURI resolve ON-CHAIN via the renderer ${metadataRenderer} — any RPC returns the metadata, no server in the graph`);
    if (hasProgram) info(`animation_url computes on-chain via the generator ${generator} — it enumerates this token's params from chain, so there is no key list to maintain`);
    else info(`renderer-only — image + attributes computed on-chain by your Solidity renderer(s); no animation_url · ${g('fully on-chain')}, zero dependency outside the EVM`);
    if (hasProgram && !codeDir) {
      const expectation = expectedChainComplete(deps, depChecks);
      info(`chain-complete expectation: ${expectation.expected === true ? g('yes') : expectation.expected === false ? 'no' : 'unknown'} — ${expectation.detail}`);
    } else if (codeDir) {
      info(`directory branch: no-server, not chain-complete — liveness rides the gateway; params ride the URL (8KB budget).`);
    }
    console.log(`  ${bold(`abx verify ${clone}`)}  ${dim('# reads onChainStatus (branch · chain-complete · unresolved refs · URL budget) + decodes tokenURI from chain')}`);
  }

  // Even fully on-chain, a code project still wants the resolver + effect runner for the KINDER
  // serving path (a live view at a real URL, and the thumbnail — the still is ALWAYS rendered
  // off-chain by the runner; the on-chain lane has no image shortcut). Without --onchain-uri the
  // resolver is load-bearing: keep it up (metadata + live view) AND the effect runner (thumbnail
  // + traits). Spell out both, and whether the resolver is local (serve here) or hosted
  // (register with `add --remote`).
  // The in-chain Solidity lane (image computed on-chain, no program): NOTHING runs. Skip every
  // resolver/thumbnail/runner instruction — those are for JS/rendered lanes and only confuse here.
  const fullyInChain = hasImageRenderer && !hasProgram;
  if (fullyInChain) {
    console.log(`\n${g('Fully on-chain — nothing to run.')} ${dim('image + traits are computed on-chain by your Solidity renderer(s); the tokenURI resolves from any RPC forever — no resolver, no bucket, no effect runner.')}`);
    console.log(`\n  ${bold('Verify (from chain, zero servers):')} ${bold(`abx tokenuri ${clone}`)} ${dim('— decodes name + the on-chain SVG image + traits straight from the contract')}`);
    console.log(`  ${dim('(a param change re-addresses the on-chain image automatically — the renderer reads it live; there is no still to re-render.)')}\n`);
    return;
  }
  const isRemoteBase = !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(baseUrl);
  console.log(
    `\n${g('Code project deployed.')} ${dim(
      onChainUri
        ? 'tokenURI is on-chain; a resolver remains the kinder serving path (live view + thumbnail publishing):'
        : 'It resolves through your resolver — keep these running:',
    )}`,
  );
  if (isRemoteBase) console.log(`  ${bold(`abx add ${clone} --remote`)}  ${dim('# register with the hosted resolver (a local deploy does NOT) — serves metadata + the live view')}`);
  else console.log(`  ${bold('abx serve')}  ${dim('# stand up the resolver (metadata + live view); a real launch needs a PUBLIC resolver, not localhost')}`);
  if (hasImageRenderer) {
    // Image is on-chain (a Solidity renderer) but there's still a JS animation/live view here — so no
    // still to render, but the resolver still serves the live view.
    console.log(`\n  ${bold('Thumbnail')} ${dim('— computed ON-CHAIN by your Solidity image renderer; nothing to render or host.')}`);
  } else {
    // Rendering is a decision the creator should have made BEFORE deploy (the --dry-run readout + the
    // skill surface it up front); this is the reminder of how to ACT on the mode already chosen. The
    // still is rendered OFF-CHAIN — no runner ⇒ placeholder thumbnail.
    console.log(`\n  ${bold('Thumbnail')} ${dim('— rendered off-chain; act on the mode you chose (auto-render needs a runner):')}`);
    console.log(`    ${dim('• continuous auto-render')} ${dim('(recommended for a live/for-sale drop):')} ${bold('abx effects')} ${dim('runs it LOCALLY (in-process, background it) · ')}${bold(`abx deploy-effects --resolver-url ${baseUrl}`)} ${dim('scaffolds a HOSTED (fly/docker) runner')}`);
    console.log(`    ${dim('• one-shot')} ${dim('(fixed supply):')} ${bold(`abx render ${clone}${isRemoteBase ? ' --remote' : ''}`)} ${dim('after mint — re-run for later mints / param changes')}`);
    console.log(`    ${dim('• none:')} skip it — the live view still animates, but the marketplace thumbnail stays a placeholder SVG`);
    if (onChainUri && !hasPublicUrl) {
      console.log(`  ${c.orange}⚠${c.reset} ${dim('no resolver = no chain-watcher: thumbnails are')} ${bold('backfill/manual')}${dim(' — re-run `abx render` after mints AND after each PostParam change (the on-chain animation updates live; the still does not auto-refresh). Want continuous/live thumbnails? Stand up an off-chain resolver — it is the watcher that auto-notifies the runner.')}`);
    }
  }
  if (dirUpload?.backend.id === 'arweave') {
    console.log(`\n  ${c.orange}⚠${c.reset} ${bold('Arweave upload propagates with a delay.')} ${dim('Turbo settles the bundle over minutes (sometimes longer); until then the gateway 404s, so the live view and a render will fail. A render run now correctly reports the content is not servable yet and stores NOTHING (not a garbage 404 thumbnail) — this is expected. Re-run the render once the content is live (the effects service will pick it up on its next sweep).')}`);
  }
  console.log(`\n  ${bold('Verify after minting token 0:')} ${bold(`abx verify ${clone}`)} ${dim('— confirms the thumbnail is a real render, not the placeholder')}`);
  console.log(`  ${dim('live view:')} ${baseUrl}/a/${chainId}/${clone}/0   ${dim('· tokenURI:')} abx tokenuri ${clone}\n`);
}

// ── deploy-code --copies: EditionCode ─────────────────────────────────────────────────────────────
// A generative/code drop as copies — the full generative stack (on-chain script, PostParams, a
// mint-time seed), plus renderer-only and script+renderer projects. Kept as its own
// function for the same byte-identical-721-lane reason as the other two edition bodies.
//
// Current limits, each refused in code rather than silently ignored:
//   • `--code-dir` (directory-build code drops) — not ported; use `--script`.
//   • `--image-base` (deterministic off-chain thumbnails) — not ported because the effects runner
//     does not yet publish a still per edition id. Solidity image/attributes renderers DO work.
//   • `--no-delegation` — refused outright: EditionCode has no TokenOwner-leg delegation to opt out
//     of (its auth leg generalizes to "any holder", per the parity plan's ConfigurableParams note).
//   • `--resume` — refused (see the `isEditionContract` guard in `cmdDeployCodeBody`'s own --resume
//     handling): the SDK's resume.ts assumes the 721 mint/supply shape throughout.
// Dependencies, renderer-only projects, schemas, seed controls, mint timing, royalties, identity
// fields, and --721c→1155C work here too.
export const DEPLOY_CODE_EDITION_FLAGS = new Set<string>([
  'script', 'name', 'symbol', 'description', 'external-url', 'description-onchain',
  ...AUTHORSHIP_DEPLOY_FIELDS.map(([flag]) => flag),
  'max', 'mint-count', 'mint-all', 'no-mint', 'mint-amount', 'unpaused', 'minter', 'primary-payee', 'royalty-bps', 'royalty-cap', 'burnable', '721c',
  'schema', 'no-seed', 'seed-source',
  'public-base-url', 'onchain-uri', 'generator', 'renderer', 'port',
  'sign', 'unsigned', 'for', 'salt', 'factory', 'bootstrap-factory', 'sign-url-file',
  'dry-run', 'confirm', 'yes', 'json', 'copies',
  // storage (directory mode + --image-base's off-chain still) — mirrors storageOverrides(), same
  // allowlist entries as the 721 twin's DEPLOY_CODE_FLAGS.
  'code-dir', 'backend', 'endpoint', 'bucket', 'region', 'prefix', 'public-base', 'gateway', 'mode', 'api-url', 'upload-url', 'provider', 'storage-signer',
  'ipfs-gateway', 'arweave-gateway',
  // NOT scope cuts: --image-renderer/--attributes-renderer (on-chain field renderers) and
  // --image-base (an off-chain deterministic-per-id still) are all fully wired on EditionCode —
  // `abx help deploy-code` documents them as working. --dep/--dep-registry likewise: EditionCode
  // inherits the same Dependencies extension, and the legs ride the same setup multicall.
  'image-renderer', 'attributes-renderer', 'image-base', 'dep', 'dep-registry',
  // v1-scope-cut flag: kept in the ALLOWLIST (not stray) so it reaches this function's own pointed
  // refusal below, rather than the generic "unrecognized flag" `refuseStrayFlags` would give it
  // otherwise — a real but less helpful refusal (it doesn't say WHY, or the way out).
  // (`resume` is NOT here: --resume + --copies is refused earlier, at cmdDeployCode's dispatch —
  // this function never runs with flags.resume set, so listing it here would just be dead.)
  'no-delegation',
]);

export async function cmdDeployEditionCodeBody(flags: Flags, emit: (p: Record<string, unknown>) => void): Promise<void> {
  beginPlanWarnings();
  const usage =
    'abx deploy-code --copies <n|open> (--script <file> | --code-dir <dir>) --name "Title" --symbol SYM (--public-base-url https://your.resolver.domain | --onchain-uri) ' +
    '[--description "<s>"] [--external-url <url>] [--max N] [--mint-count N | --mint-all] [--mint-amount N] ' +
    '[--schema key:Type:Auth,…] [--no-seed | --seed-source 0x..] [--unpaused] [--minter 0x..] [--primary-payee 0x..] [--royalty-bps N] [--721c recommended|0x..]';
  refuseStrayFlags(flags, DEPLOY_CODE_EDITION_FLAGS, 'deploy-code');
  warnSignWithoutFor(flags);
  const editionSize = parseCopies(flags.copies);

  const scriptPath = flags.script as string | undefined;
  const codeDir = flags['code-dir'] as string | undefined;
  if (scriptPath && codeDir) throw new Error(usage);
  // The in-chain Solidity renderer lane, same as the 721 twin: EditionCode composes the same
  // OnChainMetadata extension and the same URI-renderer slots, so `image`/`attributes` at a
  // `renderer` representation resolve through the canonical metadata renderer with no server in the
  // graph. Proven end-to-end in contracts/test/EditionOnChainRender.t.sol.
  const imageRendererFlag = flags['image-renderer'] ? String(flags['image-renderer']) : undefined;
  const attributesRendererFlag = flags['attributes-renderer'] ? String(flags['attributes-renderer']) : undefined;
  // --image-renderer and --image-base both set the `image` field — pick ONE, same rule as the 721
  // twin. Checked before either is resolved so the refusal is immediate rather than after a renderer
  // code-presence probe.
  if (imageRendererFlag && flags['image-base']) {
    throw new Error('--image-renderer and --image-base both set the `image` field — pick ONE: an ON-CHAIN Solidity render (--image-renderer, no infra) OR an off-chain bucket URL (--image-base).');
  }
  // A JS program either way (template chunks or a hosted build) — same "hasProgram" test as the 721
  // twin (see its own `const hasProgram = !!(scriptPath || codeDir);`), so every downstream
  // conditional gated on it (generator resolution, animation_url, the on-chain-URI legs) already
  // does the right thing for a directory build without a SEPARATE flag to thread through.
  const hasProgram = !!(scriptPath || codeDir);
  const hasFieldRenderers = !!(imageRendererFlag || attributesRendererFlag);
  if (!hasProgram && !hasFieldRenderers) {
    throw new Error(
      `${usage}\n  (or, for a FULLY on-chain Solidity render with no program: --copies <n|open> --image-renderer 0x.. ` +
        `[--attributes-renderer 0x..] --onchain-uri)`,
    );
  }
  // Not a scope cut — semantically refused: EditionCode has no TokenOwner-leg delegation to opt
  // out of. Its Params auth leg generalizes to "any holder" (balanceOf(sender, id) > 0) instead of
  // the 721 delegate.xyz leg --no-delegation exists to disable (see EditionCodeInitParams's own
  // doc comment — it has no `disableTokenOwnerDelegation` field at all).
  if (flags['no-delegation'] !== undefined) {
    throw new Error(
      '--no-delegation has nothing to disable on an EditionCode: its Params auth leg generalizes to "any holder" ' +
        '(balanceOf(sender, id) > 0) instead of the 721 TokenOwner leg\'s delegate.xyz resolution --no-delegation opts out ' +
        'of. Drop the flag.',
    );
  }

  const dryRun = isDryRun(flags);
  const name = flags.name ?? 'ABX Edition Code';
  const symbol = flags.symbol ?? 'ABXEC';
  assertRealIdentity(flags, {name, symbol, dryRun});
  const max = Number(flags.max ?? 16);
  if (!Number.isInteger(max) || max <= 0) throw new Error('--max must be a positive integer');
  if (flags['no-mint'] !== undefined && (flags['mint-all'] !== undefined || flags['mint-count'] !== undefined)) {
    throw new Error('--no-mint contradicts --mint-all/--mint-count — drop one.');
  }
  const mintCount = flags['no-mint'] !== undefined ? 0 : flags['mint-all'] !== undefined ? max : Number(flags['mint-count'] ?? 0);
  if (mintCount > max) throw new Error(`--mint-count ${mintCount} exceeds --max ${max}`);
  const mintAmount = mintCount > 0 ? (flags['mint-amount'] !== undefined ? parseNonNegativeIntFlag(flags['mint-amount'] as string, 'mint-amount') : 1n) : 0n;
  if (mintCount > 0 && mintAmount === 0n) {
    throw new Error('--mint-amount 0 with ids being pre-minted at deploy makes no sense — pass a positive --mint-amount, or drop --mint-all/--mint-count to defer minting entirely.');
  }
  const paused = flags.unpaused === undefined;
  const royaltyBps = flags['royalty-bps'] === undefined ? 500 : parseRoyaltyBps(String(flags['royalty-bps']));
  // Owner-set royalty ceiling (bps, up to 100%), reduce-only after deploy. Defaults to 10%,
  // auto-raised to fit a higher --royalty-bps so a plausible input never errors; --royalty-cap overrides.
  const maxRoyaltyBps = flags['royalty-cap'] === undefined
    ? Math.max(1000, royaltyBps)
    : parseRoyaltyBps(String(flags['royalty-cap']));
  if (royaltyBps > maxRoyaltyBps) {
    throw new Error(`--royalty-bps ${royaltyBps / 100}% exceeds --royalty-cap ${maxRoyaltyBps / 100}%; raise the cap or lower the royalty.`);
  }
  const burnable = flags.burnable === '' || flags.burnable === 'true';
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  const baseUrl = (flags['public-base-url'] ?? resolveBaseUrl(port)).replace(/\/$/, '');
  const hasPublicUrl = !!(flags['public-base-url'] || process.env.ABX_PUBLIC_BASE_URL);
  const onChainUri = !!flags['onchain-uri'];

  console.log(
    bold(
      `\n  ABX Self-Host Toolkit — deploy edition code project\n  ${dim(
        editionSize === 0n
          ? 'EditionCode (ERC-1155) — a program is the content; each id an OPEN edition'
          : `EditionCode (ERC-1155) — a program is the content; ${editionSize} cop${editionSize === 1n ? 'y' : 'ies'} of each id`,
      )}`,
    ),
  );
  if (editionSize === 1n) info(copiesOneNote('deploy-code'));

  if (!onChainUri && (!hasPublicUrl || loopbackBaseUrl(baseUrl))) {
    const devAllow = process.env.ABX_DEV_ALLOW_LOCALHOST_URI === '1';
    const msg =
      `A code project resolves its metadata + live view through your resolver, so this deploy bakes that resolver's PUBLIC URL on-chain — ${hasPublicUrl ? baseUrl : 'localhost'} resolves for no one. ` +
      `Pick a real path:\n    • Fully on-chain, no server:  --onchain-uri\n    • Hosted resolver:            abx deploy-resolver --provider fly --domain meta.you.xyz, then --public-base-url https://meta.you.xyz`;
    if (!devAllow) {
      if (dryRun) warn(`would REFUSE to deploy — ${msg}`);
      else throw new Error(msg);
    } else {
      warn(`DEV ONLY (ABX_DEV_ALLOW_LOCALHOST_URI): baking ${bold(baseUrl)} on-chain — resolves only on THIS machine; not a real NFT.`);
    }
  }

  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertChainId(CHAIN, {allowUnreachable: dryRun});
  const chainId = dryRun ? resolveChain(CHAIN).id : ((await publicClient.getChainId()) as number);

  const transferValidator = await resolveTransferValidatorFlag(flags, publicClient, dryRun, '1155C');

  step('Trust anchor');
  let factory: Address;
  if (dryRun) {
    const existing = editionCodeFactoryAddress(flags.factory);
    if (!existing) {
      info('no canonical EditionCode factory for this chain yet — a real deploy would deploy the trust anchor first (or --bootstrap-factory).');
      console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
      return;
    }
    factory = existing;
    info(`would reuse canonical EditionCode factory ${factory}`);
  } else {
    factory = await ensureEditionCodeFactory(publicClient, flags.factory as string | undefined, !!flags['bootstrap-factory']);
  }
  const seedSource = await resolveSeedSourceFlag(flags, publicClient, dryRun, chainId);

  let generator: Address = zeroAddress;
  let metadataRenderer: Address = zeroAddress;
  if (onChainUri) {
    step('On-chain URI');
    // A renderer-only edition has no program, so no animation_url and no generator. Resolving one
    // anyway and baking the leg would point the metadata renderer at a document with no script —
    // and `onchainUriSetupCalls` treats a zero generator as exactly this signal, omitting the leg.
    if (hasProgram) {
      const knownGenerator = resolveGenerator(chainId, flags.generator as string | undefined);
      if (!knownGenerator) {
        throw new Error(
          `--onchain-uri needs the canonical AbxGenerator for '${CHAIN}', and none is configured. Set ABX_GENERATOR / --generator, ` +
            `or check the shipped manifest (packages/sdk/src/deployments.ts).`,
        );
      }
      generator = knownGenerator;
      if (!dryRun) {
        const generatorCode = await publicClient.getCode({address: generator});
        if (!generatorCode || generatorCode === '0x') throw new Error(`the configured generator ${generator} has no code on '${CHAIN}' — check ABX_GENERATOR / --generator / the RPC endpoint.`);
      }
      info(dryRun ? `would point animation_url at the canonical generator ${generator} (computed on-chain)` : `animation_url computes ON-CHAIN via the canonical generator ${generator}`);
    } else {
      info('renderer-only — no program, so no animation_url; the Solidity renderer(s) ARE the work');
    }
    metadataRenderer = dryRun ? ((rendererAddress(flags.renderer) as Address | null) ?? zeroAddress) : await ensureRenderer(flags.renderer);
    info(
      metadataRenderer === zeroAddress
        ? 'would deploy the canonical metadata renderer first, then set the URI renderers to it in the setup multicall'
        : `uri()/contractURI() resolve ON-CHAIN via the renderer ${metadataRenderer} — no resolver in the token's graph.`,
    );
    if (!hasPublicUrl) info('off-chain fallback pointer left empty (the renderer is authoritative); set --public-base-url to bake one anyway.');
  }

  const schemas = parseSchemaSpecs(flags.schema as string | undefined);
  // Say it where the decision is made, not in a doc the creator may never open: on an edition, a
  // holder-writable param is SHARED by every holder of that id. See `editionSchemaAdvisory`.
  if (flags.copies !== undefined) {
    const advisory = editionSchemaAdvisory(schemas);
    if (advisory) warn(advisory);
  }

  // Dependencies — same shape as the 721 SeriesCode twin (see its block for the full reasoning).
  // `EditionCode` already inherits the `Dependencies` extension and calls `_initDependencies()`, and
  // the legs are the same `setDependency`/`setDependencyRegistry` calls on the same ABI, so this was
  // never a contract gap: only the CLI refused it. It matters because "an edition of my p5
  // sketch, with p5 coming from the chain" is a thing creators ask for directly, and the refusal sent
  // them to the 721 lane (unique tokens) or to shipping a sketch whose library never loads.
  const deps = parseDepFlag(flags.dep);
  const hasRegistryDeps = deps.some((d) => d.resolution === DEP_RESOLUTION.registry);
  const depPointer = hasRegistryDeps
    ? resolveDepRegistryPointer(flags['dep-registry'] as string | undefined, chainId)
    : {registry: null as Address | null, source: 'none' as const};
  const depRegistry = depPointer.registry;
  if (deps.length) {
    step('Dependencies');
    deps.forEach((d, i) =>
      info(
        `[${i}] ${bold(d.display)} ${dim(d.resolution === DEP_RESOLUTION.registry ? '(registry name@version)' : '(on-chain data contract — read directly)')}${i === 0 ? dim(' · index 0 = the runtime') : ''}`,
      ),
    );
    if (hasRegistryDeps) {
      if (depRegistry) {
        info(`registry pointer → ${depRegistry} ${dim(depPointer.source === 'flag' ? '(--dep-registry)' : "(the chain's AB Dependency Registry — soft, non-validating)")}`);
        const {checks, rpcOk} = await checkRegistryDeps(publicClient, depRegistry, deps);
        for (const chk of checks) {
          if (chk.status === 'found') {
            ok(
              chk.details.availableOnChain
                ? `${chk.dep} — on registry; ON-CHAIN bytes available (${chk.details.scriptCount} chunk(s)) — chain-complete capable`
                : `${chk.dep} — on registry; served from CDN ${chk.details.preferredCDN || '(none listed)'} ${dim('— the normal production path, not a degradation')}`,
            );
          } else if (chk.status === 'not-found') {
            warn(`${bold(chk.dep)} NOT FOUND on registry ${depRegistry} — the resolver won't resolve it from there. Deploy proceeds (you may intend a custom registry / a pending addition); double-check the exact name@version spelling.`);
          }
        }
        if (!rpcOk) info('registry check skipped (RPC unreachable) — the deploy does not depend on it.');
      } else {
        warn('no dependency registry known for this chain — skipping the setDependencyRegistry leg (the pointer is SOFT; the resolver falls back to its built-in CDN map). Pass --dep-registry 0x… or run `abx set-dependency-registry` later.');
      }
    }
  }

  // Content: directory mode uploads the build (its root locator → the `code` collection field);
  // template mode chunks the script for on-chain storage. The directory UPLOAD is deferred until
  // after the --confirm gate (and skipped entirely on --dry-run) so a preview never pins bytes —
  // same shape as the 721 twin's identical block (see its own comment for the full reasoning).
  step('Content');
  let scriptChunks: Hex[] = [];
  let dirUpload: null | {backend: StorageBackend; entries: {name: string; bytes: Uint8Array; contentType: string}[]; sizes: number[]} = null;
  let contentSummary: string;
  if (codeDir) {
    const dirPath = resolvePath(codeDir);
    const files = readdirSync(dirPath).filter((f) => !f.startsWith('.') && statSync(joinPath(dirPath, f)).isFile());
    if (!files.includes('index.html')) throw new Error(`${dirPath} has no index.html — the directory entry, by convention`);
    const backend = resolveBackend(storageOptions(storageOverrides(flags)));
    if (!backend.putDirectory) throw new Error(`storage backend '${backend.id}' has no directory upload — use --backend ipfs (pinata) or arweave`);
    const entries = files.map((f) => ({name: f, bytes: new Uint8Array(readFileSync(joinPath(dirPath, f))), contentType: contentTypeFromPath(joinPath(dirPath, f))}));
    dirUpload = {backend, entries, sizes: entries.map((e) => e.bytes.length)};
    contentSummary = `${entries.length} file(s) → ${backend.id} directory (code field)`;
    info(`${entries.length} file(s) from ${basename(dirPath)}/ → ${backend.id} directory (code field)`);
    info(dim('the live view 302s through the gateway — it must serve HTML (the shared Pinata public gateway does not; use a dedicated gateway or arweave).'));
  } else if (scriptPath) {
    const source = readFileSync(resolvePath(scriptPath), 'utf8');
    scriptChunks = planOnChainScript(source);
    contentSummary = `script ${Buffer.byteLength(source, 'utf8')} bytes → ${scriptChunks.length} on-chain chunk(s)`;
    ok(contentSummary);
  } else {
    // Renderer-only: the Solidity contract IS the content. Nothing is stored on this token.
    contentSummary = `renderer-only — ${[imageRendererFlag && 'image', attributesRendererFlag && 'attributes'].filter(Boolean).join(' + ')} computed in Solidity; no program stored`;
    ok(contentSummary);
  }

  const contractFields: {field: Hex; representation: Hex; value: Hex}[] = [];
  if (flags.description) contractFields.push({field: encodeTag(F.description), representation: encodeTag(R.inline), value: toHex(String(flags.description))});
  if (flags['external-url']) contractFields.push({field: encodeTag(F.externalUrl), representation: encodeTag(R.inline), value: toHex(String(flags['external-url']))});
  contractFields.push(...authorshipContractFields(flags), ...gatewayContractFields(flags));

  // The two `renderer`-representation fields. Same guard as the 721 lane: a real deploy REFUSES a
  // codeless address (pointing a field at one reverts every uri() in the collection); a dry run
  // probes best-effort so a preview without an RPC still works.
  for (const [flagName, fieldKey, what] of [
    ['image-renderer', F.image, 'an IAbxFieldRenderer returning image/svg+xml on-chain'],
    ['attributes-renderer', F.attributes, 'an IAbxFieldRenderer returning an application/json traits array'],
  ] as const) {
    const raw = flagName === 'image-renderer' ? imageRendererFlag : attributesRendererFlag;
    if (!raw) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`--${flagName} must be a 0x address (${what}, e.g. a SeedSvgRenderer fork).`);
    const addr = getAddress(raw) as Address;
    if (dryRun) {
      let present: boolean | null = null;
      try { const c = await publicClient.getCode({address: addr}); present = !!c && c !== '0x'; } catch { present = null; }
      if (present === false) warn(`--${flagName} ${bold(addr)} has NO code on '${CHAIN}' — that is NOT a deployed renderer. A real deploy REFUSES it.`);
      else info(`collection ${fieldKey} → on-chain field-renderer ${bold(addr)} ${dim(present ? '(computed on-chain; code present ✓)' : '(computed on-chain — a real deploy VERIFIES this is deployed and refuses if not)')}`);
    } else {
      const code = await publicClient.getCode({address: addr});
      if (!code || code === '0x') throw new Error(`--${flagName} ${addr} has no code on '${CHAIN}' — it must be a DEPLOYED IAbxFieldRenderer (${what}), not a placeholder. Scaffold the Solidity workspace first (\`abx scaffold solidity\`).`);
      info(`collection ${fieldKey} → on-chain field-renderer ${bold(addr)} ${dim('(computed on-chain, embedded in uri(); code present ✓)')}`);
    }
    contractFields.push({field: encodeTag(fieldKey), representation: encodeTag(R.renderer), value: encodeFieldRenderer(addr)});
  }
  if (hasFieldRenderers && !onChainUri) {
    warn('--image-renderer/--attributes-renderer compute fields ON-CHAIN, but without --onchain-uri the URI renderers are never wired, so uri() still resolves through your resolver and nothing reads them. Add --onchain-uri.');
  }

  // --image-base: bake the on-chain `image` as a url-template (`{base}/{id}.png`) — same field write
  // as the 721 twin's identical block (see its own comment for the full reasoning), one id space
  // finer: `{id}` substitutes the EditionCode id, not a sequential 721 token number, and the effect
  // runner's render sweep already excludes an id with no live copies (harness.ts) — an id with no
  // mint-time seed drawn yet has nothing to render FROM, the same reason a burned 721 token is
  // excluded. There is no per-copy addressing: every copy of an id shares one image, same as every
  // other field on an id.
  if (flags['image-base']) {
    const base = String(flags['image-base']);
    // --image-base needs a mutable, path-addressed URL (the effect runner overwrites the SAME key in
    // place) — a content-addressed gateway URL (ipfs/arweave) can't back a FIXED per-id address, no
    // matter what THIS deploy's own --backend happens to be. One shared validator decides this
    // (packages/storage/content-plan.ts), so this can never disagree with the 721 lane's own refusal.
    const imageBaseCombo = validateRenderStorageCombo({imageBaseUrl: base});
    if (!imageBaseCombo.ok) {
      if (dryRun) warn(`would REFUSE — ${imageBaseCombo.reason}`);
      else throw new Error(imageBaseCombo.reason);
    }
    // NEVER bake a localhost/loopback image host on-chain — the token's `image` would resolve for no
    // one. This is the marketplace still's PERMANENT address.
    if (loopbackBaseUrl(base)) {
      const m = `--image-base ${base} is localhost/loopback — the on-chain image URL would resolve for no marketplace. Use a PUBLIC bucket (S3/R2/CDN) you control.`;
      if (dryRun) warn(`would REFUSE — ${m}`);
      else throw new Error(m);
    }
    // The exact trap a real agent hit on the 721 lane: it baked the S3 API endpoint (auth-only) as
    // --image-base. Refuse the R2 API form (never public); warn on the S3 API form.
    if (/\.r2\.cloudflarestorage\.com/i.test(base)) {
      const m = `--image-base ${base} is R2's S3 API endpoint (auth-only) — marketplaces get 403, it is NEVER public. Put THIS URL in ${bold('ABX_S3_ENDPOINT')} (uploads), and pass --image-base your bucket's PUBLIC read URL — enable an ${bold('r2.dev')} public URL (\`https://pub-<hash>.r2.dev\`) or a custom domain in the R2 dashboard.`;
      if (dryRun) warn(`would REFUSE — ${m}`);
      else throw new Error(m);
    } else if (/(^|\/\/)s3[.-][^/]*amazonaws\.com/i.test(base) || /\.s3[.-][^/]*amazonaws\.com/i.test(base)) {
      warn(`--image-base ${base} looks like the S3 API host — marketplaces can read it ONLY if the bucket has public-read (or you front it with CloudFront/a domain). If it's not public, use that URL in ${bold('ABX_S3_ENDPOINT')} and pass a public URL here instead.`);
    }
    const imageTemplate = base.includes('{id}') ? base : `${base.replace(/\/+$/, '')}/{id}.png`;
    contractFields.push({field: encodeTag(F.image), representation: encodeTag(R.urlTemplate), value: toHex(imageTemplate)});
    info(`collection image → on-chain url-template ${bold(imageTemplate)} ${dim('(off-chain thumbnail at a deterministic per-id URL; the effect runner overwrites each key once a copy is minted)')}`);
    info(`  ${dim('the runner uploads stills here via')} ${bold('ABX_S3_ENDPOINT · ABX_S3_BUCKET · ABX_S3_ACCESS_KEY_ID · ABX_S3_SECRET_ACCESS_KEY')} ${dim('(set ABX_S3_PUBLIC_BASE to this same --image-base; `abx storage show` checks them; details → reference/hosting.md)')}`);
    const s3Base = process.env.ABX_S3_PUBLIC_BASE?.replace(/\/+$/, '');
    if (s3Base && !imageTemplate.startsWith(`${s3Base}/`)) {
      warn(`--image-base isn't under ABX_S3_PUBLIC_BASE (${s3Base}) — the runner keys its deterministic publish off that base, so it won't auto-upload here unless they share an origin.`);
    }
  }

  const onchainUriLegs = onChainUri ? onchainUriSetupCalls({generator, metadataRenderer}) : [];

  step('Deploy');
  const lane = laneFromFlags(flags);
  const minter = (flags.minter as Address) ?? zeroAddress;
  const primaryPayee = (flags['primary-payee'] as Address) ?? zeroAddress;
  const explicitSalt = parseSaltFlag(flags.salt);

  // Normally TWO transactions (deploy + one gas-bounded setup batch) — this leaner lane skips the
  // 721 code lane's "fold reserve mints + renderers into init" micro-optimization (only reachable
  // there for a renderer-only, no-program drop, which this function refuses anyway — every
  // edition-code deploy has a program). A setup large enough to miss the `eth_estimateGas` ceiling
  // (a big script) splits into MORE than one setup transaction — see `planCodeSetupBatches`.
  const initParamsFor = (owner: Address): EditionCodeInitParams => ({
    owner,
    name,
    symbol,
    tokenURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/t`,
    tokenURIRenderer: zeroAddress,
    contractURIBase: onChainUri && !hasPublicUrl ? '' : `${baseUrl}/c`,
    contractURIRenderer: zeroAddress,
    royaltyReceiver: owner,
    royaltyBps,
    maxRoyaltyBps,
    burnable,
    transferValidator,
    maxInvocations: BigInt(max),
    editionSize,
    primaryPayee,
    minter,
    paused,
    seedSource,
    mintTo: zeroAddress,
    mintCount: 0n,
    mintAmount: 0n,
    tokenFields: [],
    contractFields,
  });
  // Gas-bounded setup-transaction legs — script chunks, schemas, deps, on-chain-URI wiring are all
  // OWNER-INDEPENDENT (only a mint call's calldata embeds the owner+id+amount; its gas is a flat
  // constant regardless), so they're built once, up front, and reused both to size
  // `approvals`/`planSetupLegs` now and to build the real transactions in `preparedFor` below —
  // identical `.gas` sequence ⇒ identical split (see `planCodeSetupBatches`'s own doc for why that
  // can never drift).
  const chunkLegs: SetupLeg[] = scriptChunks.map((chunk, i) =>
    chunkSetupLeg(i, chunk, encodeFunctionData({abi: seriesCodeAbi, functionName: 'setScriptChunk', args: [BigInt(i), chunk]})),
  );
  const depCallsForEdition = dependencySetupCalls(deps, depRegistry);
  const configLegs: SetupLeg[] = [
    ...schemas.map((s) =>
      schemaSetupLeg(
        s.key,
        encodeFunctionData({abi: seriesCodeAbi, functionName: 'setParamSchema', args: [encodeTag(s.key), s.paramType, s.auth, s.authAddress, s.lockAfter, s.min, s.max, s.selectOptions]}),
      ),
    ),
    ...(depCallsForEdition.length ? [depsSetupLeg(depCallsForEdition)] : []),
    ...(onchainUriLegs.length ? [uriSetupLeg(onchainUriLegs)] : []),
  ];
  // Reserve mints: one `mint(to, id, amount)` per premint id — the edition twin of the 721 lane's N
  // identical `mint(owner)` calls, one id finer (a specific amount of copies, not just "one").
  const mintLegsFor = (owner: Address): SetupLeg[] =>
    Array.from({length: mintCount}, (_, id) =>
      mintSetupLeg(encodeFunctionData({abi: oneOfOneEditionAbi, functionName: 'mint', args: [owner, BigInt(id), mintAmount]})),
    );
  // `owner` is irrelevant to the batch SHAPE (see the comment above), so `zeroAddress` here is a
  // placeholder used purely to size `approvals` before a deployer is known — never sent.
  const editionSetupBatches = planCodeSetupBatches({chunks: chunkLegs, config: configLegs, mints: mintLegsFor(zeroAddress)});
  const preparedFor = async (owner: Address): Promise<{clone: Address; txs: PreparedTx[]}> => {
    const salt = explicitSalt ?? saltFor(owner);
    const clone = await predictClone(publicClient, {factory, salt});
    const setupTxs = codeSetupTxsFromBatches(
      planCodeSetupBatches({chunks: chunkLegs, config: configLegs, mints: mintLegsFor(owner)}),
      {contract: clone, chainId, deps: deps.map((d) => d.display)},
    );
    const txs = [prepareDeployEditionCode({factory, params: initParamsFor(owner), salt, chainId, clone}), ...setupTxs];
    return {clone, txs};
  };
  // deps ride the same setup batch as chunks/schemas/mints when everything fits one transaction, so
  // they don't add an approval on their own — but they must be COUNTED in the "is there a setup
  // transaction at all" test, or a deps-only project (a script with no schemas and no premints) would
  // report 1 approval and send 2 transactions.
  const depLegCount = depCallsForEdition.length;
  const approvals = 1 + editionSetupBatches.length; // deploy tx + however many gas-bounded setup batches
  // Ordered legs riding the setup (if any) — GROUP names, not a literal per-transaction count (see
  // deploy-plan.ts's own doc comment on `legs`); same booleans `approvals` above is built from, so the
  // plan object's `transactions.legs` can never drift from the tx(es) the wallet actually signs.
  // Always ends with `'deploy'` when non-null.
  const planSetupLegs = approvals > 1
    ? [
        scriptChunks.length ? 'chunks' : null,
        schemas.length ? 'param-schemas' : null,
        depLegCount ? 'dependencies' : null,
        onchainUriLegs.length ? 'onchain-uri' : null,
        mintCount ? 'mints' : null,
        'deploy',
      ].filter((leg): leg is string => leg !== null)
    : null;

  if (!dryRun) {
    await confirmSend(
      // Second site of the same missing binding as the plan line above — and the worse one: this is
      // the REAL deploy path, so `deploy-code --copies` threw at the confirmation prompt, after the
      // wallet and factory work was already done.
      `About to deploy an edition code project "${name}" (${symbol}) — ${contentSummary}; ` +
        `up to ${max} id(s) × ${editionSize === 0n ? 'open' : editionSize.toString()} cop${editionSize === 1n ? 'y' : 'ies'} each; ` +
        `${onChainUri ? `uri() ON-CHAIN via the renderer${generator === zeroAddress ? ' (no program, no animation_url)' : ` (generator ${generator})`}` : `resolver base ${baseUrl}`}; ` +
        `mint: ${mintCount > 0 ? `${mintCount} id(s) × ${mintAmount} at deploy` : 'deferred'}; approvals: ${approvals} wallet approval(s); owner+royalty: your wallet @ ${royaltyBps / 100}%.` +
        (transferValidator !== zeroAddress ? ` ERC-1155C: enrolled at deploy, permanently (validator ${transferValidator}).` : ''),
      flags,
    );
  }

  if (dryRun) {
    let deployer: Address | null = null;
    if (flags.for) deployer = flags.for as Address;
    else {
      try {
        deployer = makeWalletClient({chainKey: CHAIN}).account.address;
      } catch {
        deployer = null;
      }
    }
    const salt = deployer ? (explicitSalt ?? saltFor(deployer)) : null;
    const predicted = salt ? await predictClone(publicClient, {factory, salt}) : null;
    const shownAddr = explicitSalt ? predicted : null;
    step(`Deploy plan — up to ${max} id(s), ${editionSize === 0n ? 'open' : editionSize.toString()} cop${editionSize === 1n ? 'y' : 'ies'} each, to ${CHAIN}`);
    if (deployer) info(`deployer ${deployer}`);
    else info(`deployer: ${dim('not set')} — pass ${bold('--for 0x..')} to preview the exact deterministic address.`);
    if (shownAddr) info(`deterministic address: ${shownAddr}`);
    info(`name "${name}" · symbol ${symbol} · max ${max} id(s) · royalty ${royaltyBps / 100}% · cap ${maxRoyaltyBps / 100}%${burnable ? ' · burnable' : ''}`);
    info(`content: ${contentSummary}`);
    printSeedSourcePlan(seedSource, chainId);
    info(`PostParam schema(s): ${schemas.length ? schemas.map((s) => describeSchema(s)).join(', ') : 'none'}`);
    info(`mint: ${mintCount > 0 ? `${mintCount} id(s) × ${mintAmount} cop${mintAmount === 1n ? 'y' : 'ies'} → ${deployer ?? 'your wallet'} at deploy` : 'deferred (mint later / external minter)'}`);
    info(
      `transactions: ${approvals} — deploy + ${editionSetupBatches.length} setup ${editionSetupBatches.length === 1 ? 'transaction' : 'transactions (gas-bounded)'} ` +
        `(${[scriptChunks.length ? 'script chunks' : null, schemas.length ? 'schemas' : null, onChainUri ? 'on-chain URI wiring' : null, mintCount > 0 ? 'reserve mints' : null].filter(Boolean).join(' + ') || 'nothing else'})`,
    );
    info(`approvals   ${approvals} wallet approval(s)`); // parity with the 721 code twin — it had this only in the --confirm sentence
    if (!explicitSalt && deployer) {
      console.log(`\n  ${bold('salt')}  ${g(salt!)}`);
      info(`address: pinned by salt — re-run with ${bold(`--salt ${salt}`)} (same address).`);
    }
    console.log(`\n  ${g('dry run')} ${dim('— nothing sent.')}\n`);
    emit(jsonSafe({
      command: 'deploy-code', kind: 'edition-code', copies: editionSize.toString(), dryRun: true, sent: false, address: shownAddr, chain: CHAIN, chainId, factory, name, symbol,
      plan: {
        schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
        family: 'code-edition' satisfies DeployPlanFamily,
        lane,
        transactions: {approvals, legs: planSetupLegs},
        roles: {
          signer: deployer, owner: deployer, royaltyReceiver: deployer,
          primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
          minter: minter !== zeroAddress ? minter : null,
        },
        royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
        custody: {
          onChainUri,
          imageOnChain: null, // this lane has no surfaces block (see deploy-plan.ts); a field-renderer image is still `hasFieldRenderers` in the prose, not tracked here
          backend: dirUpload ? dirUpload.backend.id : null,
          tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
          contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
          renderer: onChainUri ? metadataRenderer : null,
          image: null, // no single --image file on this lane (see custody.image's own doc comment)
        },
        mint: {
          deferred: mintCount === 0,
          count: mintCount,
          amountPerId: mintAmount.toString(),
          recipient: mintCount > 0 ? deployer : null,
        },
        estimate: {ethApprox: null, gasApprox: null}, // this lane computes no cost estimate
        warnings: planWarnings.slice(),
        surfaces: null, // only the fresh 721 code lane computes the per-surface disposition today
        dependencies: {count: deps.length, registry: depRegistry ?? null},
        resume: null,
      } satisfies DeployPlan,
    }));
    return;
  }

  // Real deploy: perform the deferred directory upload now (past the confirm gate). `contractFields`
  // is captured by reference in `initParamsFor` above — pushing to it here still lands in the CREATE
  // tx's init params, since that closure isn't actually CALLED until the signing lane below runs.
  if (dirUpload) {
    const {base} = await dirUpload.backend.putDirectory!(dirUpload.entries);
    // Store the BARE locator (CID / arweave txid), never a full gateway URL — the resolver applies
    // the gateway at serve time per `representation`.
    const ipfsCid = base.match(/\/ipfs\/([^/]+)/)?.[1];
    const arTxid = base.match(/arweave\.net\/([^/?#]+)/i)?.[1];
    const rep = ipfsCid ? 'ipfs' : dirUpload.backend.id === 'arweave' ? 'arweave' : 'url';
    const value = ipfsCid ?? (rep === 'arweave' ? (arTxid ?? base) : base);
    contractFields.push({field: encodeTag('code'), representation: encodeTag(rep), value: toHex(value)});
    ok(`uploaded ${dirUpload.entries.length} file(s) → code field (${rep}): ${value}`);
  }

  let clone: Address;
  let deployBlock: bigint;
  // See the 1/1 lane's identical local for why this is hoisted (feeds the sent plan's `roles`). The
  // 'unsigned' branch below returns before the sent `emit()`, so it never needs to set this.
  let deployerAddr: Address | undefined;
  if (lane === 'unsigned') {
    const signer = flags.for as Address | undefined;
    if (!signer) throw new Error('--unsigned needs --for <signer> — the salt guard and ownership are keyed to the signing address');
    const {clone: predicted, txs} = await preparedFor(signer);
    for (const tx of txs) await signTx(() => tx, {lane, chainKey: CHAIN, yes: !!flags.yes, expectedSigner: signer});
    console.log(`\n${dim(`  unsigned — broadcast in order, then: abx add ${predicted} --factory ${factory} --from-block <deployBlock>`)}\n`);
    return;
  }
  if (lane === 'sign') {
    const session = await openWalletSession({chainKey: CHAIN, expectedSigner: flags.for as Address | undefined, total: approvals, port: flags.port ? Number(flags.port) : undefined, signUrlFile: flags['sign-url-file']});
    try {
      const signer = await session.connect();
      deployerAddr = signer;
      const {clone: predicted, txs} = await preparedFor(signer);
      let first: bigint | undefined;
      for (const tx of txs) {
        const sent = await session.send(tx);
        if (first === undefined) first = sent.receipt.blockNumber;
      }
      clone = predicted;
      deployBlock = first ?? 0n;
    } finally {
      session.close();
    }
  } else {
    const {account} = makeWalletClient({chainKey: CHAIN});
    deployerAddr = account.address;
    const {clone: predicted, txs} = await preparedFor(account.address);
    const results = await signHotSequence(txs, {chainKey: CHAIN, yes: !!flags.yes});
    clone = predicted;
    deployBlock = results[0]?.blockNumber ?? 0n;
  }
  const discovered = await discoverDeployBlock(publicClient, clone);
  if (discovered !== null) deployBlock = discovered;
  ok(`EditionCode live: ${clone} ${dim(`(from block ${deployBlock})`)}`);
  // Same permanent-decisions readout the 721 code lane prints — the plan line above is dry-run-only.
  info(
    `permanent: max ${max} id(s) · royalty ${royaltyBps / 100}%${flags['royalty-bps'] === undefined ? ' ⚠ default' : ''} → the deploying wallet` +
      ` · cap ${maxRoyaltyBps / 100}%${burnable ? ' · burnable' : ''}` +
      dim('  (rate is changeable with `abx set-royalty`; the CAP only ever goes down)'),
  );
  emit(jsonSafe({
    command: 'deploy-code', kind: 'edition-code', copies: editionSize.toString(), address: clone, chain: CHAIN, chainId, factory, deployBlock, name, symbol, onChainUri,
    plan: {
      schemaVersion: DEPLOY_PLAN_SCHEMA_VERSION,
      family: 'code-edition' satisfies DeployPlanFamily,
      lane,
      transactions: {approvals, legs: planSetupLegs},
      roles: {
        signer: deployerAddr ?? null, owner: deployerAddr ?? null, royaltyReceiver: deployerAddr ?? null,
        primaryPayee: primaryPayee !== zeroAddress ? primaryPayee : null,
        minter: minter !== zeroAddress ? minter : null,
      },
      royalty: {bps: royaltyBps, capBps: maxRoyaltyBps, burnable},
      custody: {
        onChainUri,
        imageOnChain: null,
        backend: dirUpload ? dirUpload.backend.id : null,
        tokenUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/t`,
        contractUriBase: onChainUri && !hasPublicUrl ? null : `${baseUrl}/c`,
        renderer: onChainUri ? metadataRenderer : null,
        image: null,
      },
      mint: {
        deferred: mintCount === 0,
        count: mintCount,
        amountPerId: mintAmount.toString(),
        recipient: mintCount > 0 ? deployerAddr ?? null : null,
      },
      estimate: {ethApprox: null, gasApprox: null},
      warnings: planWarnings.slice(),
      surfaces: null,
      dependencies: {count: deps.length, registry: depRegistry ?? null},
      resume: null,
    } satisfies DeployPlan,
  }));

  step('Index');
  await registerAndIndexLocally(clone, {'from-block': deployBlock.toString(), factory, label: name} as Flags);

  if (onChainUri) {
    step('On-chain URI');
    ok(`uri()/contractURI() resolve ON-CHAIN via the renderer ${metadataRenderer} — any RPC returns the metadata, no server in the graph`);
    if (hasProgram) info(`animation_url computes on-chain via the generator ${generator} — it enumerates this token's params from chain, so there is no key list to maintain`);
    else info(`renderer-only — image + attributes computed on-chain by your Solidity renderer(s); no animation_url · ${g('fully on-chain')}, zero dependency outside the EVM${editionSize === 0n ? ' — and the edition stays OPEN, so anyone may keep minting copies' : ''}`);
    console.log(`  ${bold(`abx tokenuri ${clone} --token 0`)}  ${dim('# reads uri(0) + decodes the JSON straight from the contract')}`);
  }
  const isRemoteBase = !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(baseUrl);
  const rendererOnlyOnChain = onChainUri && !hasProgram;
  console.log(
    `\n${g('Edition code project deployed.')} ${dim(
      rendererOnlyOnChain
        ? 'Nothing to run: image, traits and uri() all resolve from the chain. There is no still to render and no resolver to keep alive.'
        : onChainUri
          ? 'tokenURI is on-chain; a resolver remains the kinder serving path (live view + thumbnail publishing):'
          : 'It resolves through your resolver — keep it running:',
    )}`,
  );
  if (!rendererOnlyOnChain) {
    if (isRemoteBase) console.log(`  ${bold(`abx add ${clone} --remote`)}  ${dim('# register with the hosted resolver')}`);
    else console.log(`  ${bold('abx serve')}  ${dim('# stand up the resolver locally')}`);
  }
  console.log(`  ${bold(`abx mint ${clone} --token-id <id> --amount <n>`)}  ${dim('# mint more copies of an id')}`);
  console.log(`  ${bold(`abx minter configure ${clone} --token-id <id> --price <eth> --allocation <n>`)}  ${dim('# set up a priced sale for one id')}`);
  console.log(`  ${bold(`abx refresh ${clone}`)}  ${dim('# nudge marketplaces once metadata is live')}\n`);
  // Same Arweave-propagation caveat as the 721 twin (see its own comment): the gateway 404s until
  // Turbo settles the bundle, so a render run right after deploy correctly finds nothing servable yet.
  if (dirUpload?.backend.id === 'arweave') {
    console.log(`\n  ${c.orange}⚠${c.reset} ${bold('Arweave upload propagates with a delay.')} ${dim('Turbo settles the bundle over minutes (sometimes longer); until then the gateway 404s, so the live view and a render will fail. A render run now correctly reports the content is not servable yet and stores NOTHING (not a garbage 404 thumbnail) — this is expected. Re-run the render once the content is live (the effects service will pick it up on its next sweep).')}`);
  }
}

/**
 * Resolve `--721c` into the InitParams `transferValidator`. Absent → `zeroAddress`: a plain
 * ERC-721 (or, on an edition deploy, a plain ERC-1155), byte-for-byte the pre-721C deploy — no
 * prompts, no output, no mention of 721C. `--721c` / `--721c recommended` → the per-chain
 * recommended validator (refused, naming the chains that have one, when the manifest has no
 * entry); `--721c 0x…` → checksum-validated AND pre-checked for code on this chain (the factory
 * would revert `InvalidTransferValidator()` — surface it before any upload/staging/gas). When
 * enrolling, prints the one plain statement of what enforcement means — once, adapted to the
 * chosen validator.
 *
 * `standard` picks only the WORDING (`ERC-721C` vs `ERC-1155C`) — the flag, the value grammar, and
 * the resolved validator address are identical either way (the SAME `InitParams.transferValidator`
 * opt-in per the parity plan's locked decision 3: 1155C ships with the same UX as 721C). Editions
 * pass `'1155C'`; every 721 call site keeps the default, so their output is unchanged.
 */
export async function resolveTransferValidatorFlag(
  flags: Flags,
  publicClient: PublicClient,
  dryRun: boolean,
  standard: '721C' | '1155C' = '721C',
): Promise<Address> {
  const raw = flags['721c'];
  if (raw === undefined) return zeroAddress;
  const chainId = resolveChain(CHAIN).id;
  const validator = parseTransferValidatorValue(raw, {chainId, chainLabel: CHAIN});
  // Usability precheck — for the recommended constant too (presence on THIS chain is the fact that
  // matters; a sandbox/private chain won't have it). This asks the same question the factory asks:
  // has code AND is not a permissive fallback that would enforce nothing (a Safe, an uninitialised
  // proxy, a 7702-delegated EOA all pass a bare has-code check and then wave every transfer
  // through). A dry run tolerates an unreachable RPC (it sends nothing); a real deploy refuses to
  // enroll blind.
  const probe = await probeTransferValidator(publicClient, validator);
  if (probe.verdict === 'unreachable') {
    if (!dryRun) throw new Error(`--721c: couldn't verify the validator at ${validator} (${probe.error ?? 'RPC did not answer'}) — refusing to enroll blind; retry when the RPC answers.`);
    info(dim(`--721c: RPC unreachable, so the validator check is deferred — a real deploy verifies ${validator} is a usable validator first.`));
  } else if (probe.verdict !== 'ok') {
    const rec = resolveRecommendedTransferValidator(chainId);
    const recHint = rec && rec !== validator ? ` (the known-good one: --721c recommended → ${rec})` : '';
    throw new Error(
      probe.verdict === 'no-code'
        ? `--721c: no contract code at ${validator} on ${CHAIN} — the deploy would revert InvalidTransferValidator(). ` +
            `A transfer validator must be a DEPLOYED contract on this chain${recHint}.`
        : `--721c: ${validator} has code on ${CHAIN}, but it is not a transfer validator — it answers ANY function call ` +
            `successfully (a Safe, an uninitialised proxy, or a 7702-delegated EOA does this), so every transfer would ` +
            `silently pass validation while ERC-165 and getTransferValidator() reported enforcement as ON. The factory ` +
            `refuses it too (InvalidTransferValidator()). Pass a real validator contract${recHint}, or drop --721c.`,
    );
  }
  // The one plain statement — printed once, only when enrolling. Never appears un-enrolled.
  info(
    validator === resolveRecommendedTransferValidator(chainId)
      ? `ERC-${standard}: only owner-initiated transfers and OpenSea-authorized sales will transfer; other marketplaces/operators are blocked. Manage with \`abx set-transfer-validator\`.`
      : `ERC-${standard}: every non-mint transfer is checked by validator ${validator} — its policy decides which operators may transfer. Manage with \`abx set-transfer-validator\`.`,
  );
  return validator;
}

/**
 * Resolve the three-way seed decision into the InitParams `seedSource`, for both code lanes:
 *
 *   - `--no-seed`               → `zeroAddress`. No mint-time seed at all.
 *   - nothing, or `canonical`   → the canonical `AbxSeedSource` via `ensureSeedSource` (manifest →
 *                                 self-heal to the deterministic address → CREATE2-deploy it). This
 *                                 is today's behaviour, byte-for-byte, and stays the default.
 *   - `--seed-source 0x…`       → the creator's own `IAbxSeedSource`, **probed first**.
 *
 * The flag exists because we tell creators, in the docs and in this command's own help, that the fix
 * for "the canonical seed isn't strong enough for my raffle" is to point `seedSource` at a
 * commit-reveal / VRF-backed source of their own. Until now the only route was an `ABX_SEED_SOURCE`
 * env var checked for nothing but code length, which made a first-class promise out of a
 * side entrance.
 *
 * **Everything that isn't the canonical singleton gets probed**, including an address that arrived
 * via `ABX_SEED_SOURCE` — so the env lane keeps working and stops being the unchecked one. The
 * comparison is against the deterministic canonical address rather than "did a flag say so", because
 * that is the actual question (is this our audited bytecode, or someone's contract we know nothing
 * about?). A dry run tolerates an unreachable RPC and says the check is deferred; a real deploy
 * refuses to bake a seed source it couldn't verify.
 *
 * The probe here runs with **no `from`**, unlike the owner op's (which calls as the token). That is
 * not an oversight: the clone's address is a function of the CREATE2 salt, which isn't reserved yet
 * at this point, so a source that gates on `msg.sender` could not have been told about this token in
 * the first place. A gated/commit-reveal source is a deploy-then-`abx set-seed-source` flow by
 * construction, and the `reverted` refusal says exactly that.
 */
export async function resolveSeedSourceFlag(
  flags: Flags,
  publicClient: PublicClient,
  dryRun: boolean,
  chainId: number,
): Promise<Address> {
  const raw = flags['seed-source'] as string | undefined;
  // `--resume` finishes an EXISTING contract, and the seed source is an InitParams field — fixed at
  // creation, never in the setup multicall this replays. So there is nothing here to resolve, probe,
  // or (worse) lazily DEPLOY. Not a refusal: `--resume`'s own contract is "pass the same content
  // flags", so the creator's original command legitimately still carries `--no-seed`/`--seed-source`.
  // Say plainly that it's read from chain, and name the verb that can actually change it.
  if (flags.resume !== undefined) {
    if (raw !== undefined || flags['no-seed'] !== undefined) {
      info(
        dim(
          `--resume: the seed source was fixed when ${flags.resume} was created, so ${raw !== undefined ? '--seed-source' : '--no-seed'} has nothing to write here ` +
            `(it isn't part of the setup transaction being replayed). Read it with \`abx state\`; change it with \`abx set-seed-source\`.`,
        ),
      );
    }
    return zeroAddress; // unused by the resume legs
  }
  if (flags['no-seed'] !== undefined) {
    // Two flags, one field. Refuse rather than pick a winner — a creator who passed both has a
    // belief about the outcome, and either answer betrays half of them.
    if (raw !== undefined) {
      throw new Error(
        '--no-seed and --seed-source contradict each other: one says "no mint-time seed at all", the other names where the seed comes from. Drop one.',
      );
    }
    return zeroAddress;
  }
  const canonical = canonicalSeedSource(chainId);
  const requested = raw === undefined ? canonical : parseSeedSourceValue(raw, {chainId});
  // The canonical singleton keeps its existing bootstrap path (deploy it if this chain lacks one).
  // Anything else must already exist — we never deploy a stranger's contract.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let seedSource: Address;
  if (same(requested, canonical)) {
    seedSource = dryRun ? ((resolveSeedSource(chainId) as Address | undefined) ?? zeroAddress) : await ensureSeedSource(publicClient);
  } else {
    seedSource = requested;
  }
  if (seedSource === zeroAddress || same(seedSource, canonical)) return seedSource;

  // Custom source (flag or ABX_SEED_SOURCE) — ask it the question the mint will ask.
  const probe = await probeSeedSource(publicClient, seedSource);
  if (probe.verdict === 'unreachable' && dryRun) {
    info(dim(`--seed-source: RPC unreachable, so the seed-source probe is deferred — a real deploy verifies ${seedSource} answers seed(uint256,address) with 32 bytes first.`));
    return seedSource;
  }
  if (probe.verdict !== 'ok') refuseUnusableSeedSource(probe, {flag: raw === undefined ? 'ABX_SEED_SOURCE' : '--seed-source', chainLabel: CHAIN});
  info(
    `seed source: CUSTOM ${seedSource} ${dim('— answers seed(uint256,address) with 32 bytes (probed). Its randomness properties are yours to state to buyers; ABX makes no claim about them.')}`,
  );
  return seedSource;
}
