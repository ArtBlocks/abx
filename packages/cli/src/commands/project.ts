/**
 * Project lifecycle commands: `predict` (pre-compute a deploy address), `add` (register + index a
 * project this node didn't deploy), `index` (re-index from chain), `verify` (re-hash served bytes
 * vs. the on-chain commitment), `state`/`status` (on-chain snapshot / indexed-project rollup), and
 * `forget` (drop the local registration; on-chain data is untouched).
 */
import {readFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';
import {
  verifyProvenance,
  AUTH_OPTIONS,
  type Address,
  CREATOR_TOKEN_INTERFACE_ID,
  type OpenSeaAttribute,
  type PublicClient,
  PARAM_TYPES,
  type RegisterProjectBody,
  type RemoteProjectStatus,
  hasOnChainUriLane,
  isCodeProject,
  isCurrentFactory,
  isCurrentOneOfOneEditionFactory,
  makePublicClient,
  makeWalletClient,
  normalizeAttributes,
  onChainUriReport,
  parseTraitPairs,
  predictClone,
  readParamHooks,
  readParamHooksLocked,
  readParamSchema,
  readParamSchemaKeys,
  readSetParamKeys,
  resolveChain,
  resolveSeriesCodeFactory,
  saltFor,
  saltGuard,
  sleep,
  readCollectionPolicy,
  rpcEnvVar,
  type TokenState,
  tryReadContract,
  encodeTag,
  METADATA_FIELD,
  METADATA_REPRESENTATION,
  fieldOf,
  isCurrentRenderer,
  isCurrentGenerator,
  type MetadataField,
} from '@artblocks/abx-sdk';
import {resolveBackend} from '@artblocks/abx-storage';
import {currentRenderArtifact, verifyProject} from '@artblocks/abx-token-api';
import {zeroAddress} from 'viem';
import {
  CHAIN,
  activeBackendId,
  factoryAddress,
  localIndexer,
  remoteLocators,
  seriesFactoryAddress,
  oneOfOneEditionFactoryAddress,
  editionFactoryAddress,
  editionCodeFactoryAddress,
  storageOptions,
} from '../config.js';
import {type Flags, isDryRun, parseBlockTagFlag, parseSaltFlag} from '../flags.js';
import {jsonSafe, withJson} from '../jsonout.js';
import {allowLargeScan, bold, c, detectCanonicalFactory, dim, g, info, ok, registerAndIndexLocally, resolveScanFloor, warn} from '../output.js';
import {parseCopies} from './deploy.js';
import {canonicalSeedSource} from '../ownerops.js';
import {detectTokenKind, describeKind, type TokenKindInfo} from '../kind.js';
import {isRpcReadFailure} from '../contract-read-error.js';
import {
  type RemoteTarget,
  canonicalLabel,
  describeRemoteError,
  indexErrorAction,
  remoteFlag,
  reportRemoteIndexing,
  requireRemoteToken,
  rollUp,
  serviceClient,
  statusLabel,
  statusLine,
  statusRow,
  tokenSourceLabel,
} from '../remote.js';
import {describeSchema} from '../schema.js';
import {looksPerTokenAttributes, parseSeriesTraitsById} from '../series-traits.js';

// ── predict ──────────────────────────────────────────────────────────────────
// Pre-compute a deploy address from a salt — so you can stand up the resolver and
// reserve a vanity/known address before signing. The address is a pure function of
// (factory, salt); the salt's leading 20 bytes are the front-run guard.
export async function cmdPredict(flags: Flags) {
  const publicClient = makePublicClient({chainKey: CHAIN});
  // Lane-aware: each deploy command uses a DIFFERENT factory, so the deterministic address differs.
  // Infer the lane from the content flags so `predict` matches what will actually be deployed —
  // otherwise a code/Series creator gets the 1/1 address (a real mismatch, not just a wrong echo).
  const chainId = resolveChain(CHAIN).id;
  const content =
    flags.script ? `--script ${flags.script}` :
    flags['code-dir'] ? `--code-dir ${flags['code-dir']}` :
    flags['image-renderer'] ? `--image-renderer ${flags['image-renderer']}` :
    flags.dir ? `--dir ${flags.dir}` :
    flags.image ? `--image ${flags.image}` : '';
  const baseCmd = (flags.script || flags['code-dir'] || flags['image-renderer'])
    ? 'deploy-code'
    : flags.dir
      ? 'deploy-series'
      : 'deploy';
  // `--copies <n|open>` switches which factory's address is predicted — the SAME flag that
  // switches which factory a real deploy uses (see commands/deploy.ts's `parseCopies`). Validated
  // here too (not just deferred to the real deploy) so a malformed value fails before printing an
  // address tied to it.
  const editionSize = flags.copies !== undefined ? parseCopies(flags.copies) : undefined;
  const isEdition = editionSize !== undefined;
  const lane = isEdition
    ? {
        cmd: baseCmd,
        factory:
          baseCmd === 'deploy-code'
            ? editionCodeFactoryAddress(flags.factory as string | undefined)
            : baseCmd === 'deploy-series'
              ? editionFactoryAddress(flags.factory as string | undefined)
              : oneOfOneEditionFactoryAddress(flags.factory as string | undefined),
      }
    : baseCmd === 'deploy-code'
      ? {cmd: 'deploy-code', factory: resolveSeriesCodeFactory(chainId, flags.factory as string | undefined)}
      : baseCmd === 'deploy-series'
        ? {cmd: 'deploy-series', factory: seriesFactoryAddress(flags.factory as string | undefined)}
        : {cmd: 'deploy', factory: factoryAddress(flags.factory)};
  const factory = lane.factory as Address | undefined;
  if (!factory) {
    throw new Error(
      `no canonical ${isEdition ? 'edition ' : ''}${lane.cmd} factory for '${CHAIN}' — run \`abx ${lane.cmd}${isEdition ? ` --copies ${flags.copies}` : ''}\` ` +
        `once to deploy the trust anchor, or pass --factory 0x.. (or the ABX_* env).`,
    );
  }
  // The current-factory guard is the 1/1 impl-version check (721 or its edition twin); the Series/
  // Series-edition/code/code-edition lanes verify their own factory at deploy time instead —
  // EditionCodeFactory mirrors SeriesCodeFactory's stance here (no version probe: a configured code
  // factory with code is always accepted, and one found at its CREATE2 address is bytecode-bound to
  // this build anyway, so there's nothing this check would catch that the real deploy doesn't
  // already). predictDeterministicAddress works on any factory ABI.
  if (lane.cmd === 'deploy') {
    const current = isEdition ? await isCurrentOneOfOneEditionFactory(publicClient, factory) : await isCurrentFactory(publicClient, factory);
    if (!current) {
      throw new Error(
        `factory ${factory} is an older/incompatible version. Run \`abx deploy${isEdition ? ` --copies ${flags.copies}` : ''}\` once to deploy the current ` +
          `trust anchor (ownerless + cheap), then predict again — or pass a current --factory.`,
      );
    }
  }

  let salt = parseSaltFlag(flags.salt);
  if (!salt) {
    // No explicit salt: reserve one to a deployer (front-run-proof). Default to the env key.
    let deployer = flags.for as Address | undefined;
    if (!deployer) deployer = makeWalletClient({chainKey: CHAIN}).account.address;
    salt = saltFor(deployer);
    info(`reserved a fresh salt to ${deployer} (front-run-proof) — pass --salt to fix/vanity it`);
  }

  const guard = saltGuard(salt);
  const clone = await predictClone(publicClient, {factory, salt});
  console.log(`\n  ${bold('predicted address')}  ${g(clone)} ${dim(`(${lane.cmd} lane${isEdition ? ', edition' : ''})`)}`);
  info(`salt   ${salt}`);
  info(guard === zeroAddress ? 'guard  permissionless — anyone may deploy this salt' : `guard  reserved to ${guard} (only this signer can deploy it)`);
  const copiesFlag = isEdition ? ` --copies ${editionSize === 0n ? 'open' : editionSize!.toString()}` : '';
  info(`deploy: ${bold(`abx ${lane.cmd}${content ? ` ${content}` : ''}${copiesFlag} --salt ${salt}`)}`);
  if (lane.cmd === 'deploy' && !isEdition) info(dim('(this is the 1/1 lane; a Series/code drop uses a different factory → a different address — pass --dir / --script to predict those, or use that command\'s --dry-run)'));
  console.log('');
}

// ── add ──────────────────────────────────────────────────────────────────────
// Register + index a project this node didn't deploy. LOCAL by default (this
// machine's store); `--remote [url]` instead tells a HOSTED resolver to index it —
// the bridge a local deploy can't make on its own (separate projection stores).
export async function cmdAdd(address: Address | undefined, flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx add <address> [--from-block N] [--factory 0x..] [--label "..."] [--remote [name|url]]\n');
    process.exitCode = 1;
    return;
  }
  // REFUSE `--dry-run` rather than ignoring it. `add` is a write (a local registration + index, and
  // with `--remote` a registration on someone else's service), and it has no preview mode — so
  // silently proceeding to DO the thing when the caller explicitly asked to preview is the one
  // outcome we must never produce. Name what's read-only instead.
  if (isDryRun(flags)) {
    throw new Error(
      '`abx add` has no --dry-run: it registers + indexes for real (and with --remote it registers on that service). ' +
        'Nothing here touches the chain, but it does write. To look before acting: `abx state <address>` (on-chain snapshot) ' +
        'or `abx status <address> [--remote <name>]` (what a node already has). Re-run without --dry-run when you mean it.',
    );
  }
  // `--attributes` is lane-aware here exactly as at deploy: a PER-TOKEN payload edits a Series'
  // per-token off-chain traits; a flat payload (+ `--traits`) edits the collection/1-of-1 `attributes`.
  // Ambiguity defaults to flat (see looksPerTokenAttributes), so a 1/1 add is never mis-read.
  const attrRaw = flags.attributes ? readFileSync(resolvePath(process.cwd(), String(flags.attributes)), 'utf8') : undefined;
  const perTokenEdit = attrRaw != null && looksPerTokenAttributes(attrRaw);
  const flagTraits: OpenSeaAttribute[] = [];
  if (attrRaw != null && !perTokenEdit) flagTraits.push(...normalizeAttributes(JSON.parse(attrRaw)));
  if (flags.traits) flagTraits.push(...parseTraitPairs(flags.traits));
  const editedTokenAttributes = perTokenEdit ? parseSeriesTraitsById(attrRaw) : undefined;
  const remote = remoteFlag(flags);
  if (remote) {
    requireRemoteToken(remote);
    // Bridge what a remote resolver can't derive itself: the off-chain traits and the durable
    // content locators (ipfs://…). Prefer flags; otherwise forward what the LOCAL deploy stored
    // (the local registration), and compute locators from this machine's content index if needed.
    const localReg = localIndexer().store.getRegistration(address);
    const attributes = flagTraits.length
      ? flagTraits
      : localReg?.attributes
        ? (normalizeAttributes(JSON.parse(localReg.attributes)) as RegisterProjectBody['attributes'])
        : undefined;
    // Bridge a Series' per-token off-chain traits to the remote resolver (the resolver has no other
    // way to derive them — they're operator metadata, not chain state). A fresh per-token `--attributes`
    // EDITS them; otherwise forward what the LOCAL deploy stored. Best-effort parse.
    let tokenAttributes: RegisterProjectBody['tokenAttributes'];
    if (editedTokenAttributes && Object.keys(editedTokenAttributes).length) {
      tokenAttributes = editedTokenAttributes as RegisterProjectBody['tokenAttributes'];
    } else if (localReg?.tokenAttributes) {
      try {
        const obj = JSON.parse(localReg.tokenAttributes) as Record<string, unknown>;
        const norm: NonNullable<RegisterProjectBody['tokenAttributes']> = {};
        for (const [id, v] of Object.entries(obj)) {
          const a = normalizeAttributes(v) as NonNullable<RegisterProjectBody['tokenAttributes']>[string];
          if (a.length) norm[id] = a;
        }
        if (Object.keys(norm).length) tokenAttributes = norm;
      } catch { /* skip a malformed local column */ }
    }
    const contentLocators = await remoteLocators(address, localReg?.contentLocators, flags);
    // Forward the deploy block, like every other field falls back to the local registration.
    // (Its ABSENCE here was the bug: a hosted resolver defaulted to genesis and scanned the whole
    // chain.) Re-sending the same floor stays incremental server-side, so a nudge ≠ a re-scan.
    const body: RegisterProjectBody = {
      chainId: resolveChain(CHAIN).id,
      address,
      fromBlock: await resolveScanFloor(address, localReg?.fromBlock, flags),
      factory: await detectCanonicalFactory(address, flags.factory as string | undefined, localReg?.factory),
      label: flags.label,
      description: flags.description ?? localReg?.description,
      externalUrl: flags['external-url'] ?? localReg?.externalUrl,
      attributes,
      tokenAttributes,
      contentLocators: Object.keys(contentLocators).length ? contentLocators : undefined,
      full: flags.full ? true : undefined,
    };
    info(`${bold('REMOTE')} → ${remote.url}  ${dim('(registering with the remote resolver — NOT this machine)')}`);
    if (body.contentLocators) info(`bridging image locator → ${Object.values(body.contentLocators)[0]} ${dim('(so the resolver points at IPFS, not its own localhost)')}`);
    let r;
    try {
      r = await serviceClient(remote).registerProject(body);
    } catch (err) {
      throw describeRemoteError(err, remote, 'remote add');
    }
    await reportRemoteIndexing(remote, body.chainId, address, r, flags, 'indexed');
    info(`it now serves ${remote.url}/t/${body.chainId}/${address.toLowerCase()}/0`);
    // "Indexed" is not "correct". This line proves the service replayed the chain and will answer at
    // that URL; it says nothing about whether the bytes it serves match the on-chain commitment.
    // Name the step that checks.
    info(`confirm what it actually serves (bytes vs. the on-chain hash): ${bold(`abx verify ${address} --remote ${remote.name?.toLowerCase() ?? remote.url}`)}`);
    // Say what this registration did NOT buy. A project whose `tokenURIRenderer` is set answers
    // `tokenURI` from the chain, so marketplaces and wallets read THAT document and never touch this
    // service — the register is still useful (indexing, the live view, managed rendering for a code
    // drop) but it changes nothing a collector sees. Without this line the readout is a list of
    // successes that reads like a win, and a creator who was told "put it on a hosted service so it
    // shows up properly" concludes their problem is solved when nothing about it moved.
    const onChainRenderer = await tryReadContract<Address>(makePublicClient({chainKey: CHAIN}), {
      address,
      abi: STATE_ABI,
      functionName: 'tokenURIRenderer',
    });
    if (onChainRenderer && onChainRenderer !== zeroAddress) {
      info(
        `${dim('note:')} this project resolves ${bold('tokenURI from the chain')} (renderer ${onChainRenderer}) — marketplaces read that, not this service. ` +
          `Registering still gives you indexing, the live view and managed rendering, but it does not change the metadata a collector sees.`,
      );
    }
    return;
  }
  // The local (non-`--remote`) path is shared with the deploy family's post-setup registration —
  // see registerAndIndexLocally's doc comment (output.ts).
  return registerAndIndexLocally(address, flags);
}

export async function cmdIndex(address: Address | undefined, flags: Flags) {
  const remote = remoteFlag(flags);
  if (remote) {
    if (!address || address.startsWith('--')) {
      console.error('usage: abx index <address> --remote [name|url]   (re-index one project on a remote resolver)\n');
      process.exitCode = 1;
      return;
    }
    requireRemoteToken(remote);
    info(`${bold('REMOTE')} → ${remote.url}  ${dim('(re-indexing on the remote resolver — the post-deploy nudge)')}`);
    const chainId = resolveChain(CHAIN).id;
    let r;
    try {
      r = await serviceClient(remote).registerProject({chainId, address, full: flags.full ? true : undefined});
    } catch (err) {
      throw describeRemoteError(err, remote, 'remote index');
    }
    await reportRemoteIndexing(remote, chainId, address, r, flags, 're-indexed');
    return;
  }
  allowLargeScan(flags);
  const full = !!flags.full; // force a full replay from the deploy block (durability proof)
  // Stop the scan at a REORG-SAFE boundary instead of the head. `latest` (the default) can include
  // blocks that a reorg later replaces, which would persist a watermark for history that no longer
  // exists; `safe`/`finalized` trade freshness for a boundary the chain won't take back. Resolved to
  // a concrete block number before scanning (see resolveBlockTag) — a stored watermark is always a
  // number, never a tag.
  const blockTag = parseBlockTagFlag(flags['to-block']);
  const indexer = localIndexer();
  const line = (state: {name: string | null; address: Address; eventCount: number}, elapsedMs: number, mode: string) =>
    ok(`${state.name ?? state.address}: ${state.eventCount} events in ${elapsedMs}ms ${dim(`(${mode})`)}`);
  if (address) {
    const {state, elapsedMs, mode} = await indexer.reindex(address, {full, blockTag});
    line(state, elapsedMs, mode);
    return;
  }
  const results = await indexer.reindexAll({full, blockTag});
  if (results.length === 0) {
    console.log(dim('No registered projects. Deploy one with `abx deploy`.'));
    return;
  }
  for (const {state, elapsedMs, mode} of results) line(state, elapsedMs, mode);
}

// ── verify ─────────────────────────────────────────────────────────────────--
// Re-hash a project's served bytes against its on-chain content commitment, from
// chain + custody alone — no running server. The CLI form of the `/verify` route,
// so an agent can confirm integrity right after deploy/mint without curling.
export async function cmdVerify(address: Address | undefined, flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx verify <address> [--json] [--remote <name|url>]\n');
    process.exitCode = 1;
    return;
  }
  allowLargeScan(flags);
  const remote = remoteFlag(flags);
  // `--json` matters most here of all the read commands: verify already exits non-zero on a byte
  // mismatch, so it is the one command a CI job would gate on. The payload's `ok` is the same
  // boolean the exit code carries; callers never need to parse prose.
  //
  // The remote lane used to route around `withJson` entirely (`return cmdVerifyRemote(address,
  // remote)`), so `abx verify <addr> --remote <r> --json` printed the same human prose as without
  // the flag and emitted NOTHING on stdout — the one lane of this command a CI job is most likely
  // to run (checking what a HOSTED resolver serves) had no machine-readable output at all. Both
  // lanes now go through the same `withJson` wrapper and emit the same payload shape.
  if (remote) return withJson(flags, async (emit) => cmdVerifyRemote(address, remote, emit));
  return withJson(flags, async (emit) => cmdVerifyBody(address, flags, emit));
}

// ── availability: a SIBLING verdict to `ok`, not a rename of it ─────────────────────────────────
// `ok`/`contentIntegrity` answer exactly one question — does what's served hash to the on-chain
// commitment — which is already true in practice and matches the
// exit-code rule below (`if (anyCheck && !allGood) process.exitCode = 1`), so it stays exactly
// that. But a missing render and an un-refetched locator don't move `ok` at all (by design: a
// creator who hasn't rendered yet has not corrupted anything), which left automation asking "is
// this project fully SERVABLE right now" with nothing to read except the human prose. This adds
// that field, computed from facts the callers already gathered — no new reads.
//
// Three states the acceptance criteria named explicitly, and that must stay visibly distinct
// rather than folding into one failure bit: a HASH MISMATCH (an integrity finding — `ok`/
// `contentIntegrity` own this, unchanged); a POINTER that cannot be recomputed locally (ipfs/
// arweave/url/url-template `image` fields — real commitments this command doesn't re-fetch, so
// "unconfirmed" here, never "broken"); and MISSING SERVED OUTPUT (a code project token with no
// render anywhere this check can see — genuinely unavailable, not a hash question at all).
export type AvailabilityStatus = 'available' | 'partial' | 'unavailable' | 'unknown';

export interface AvailabilityVerdict {
  status: AvailabilityStatus;
  note: string;
}

/**
 * Pure by design — every caller (`cmdVerifyBody`'s local lane and `cmdVerifyRemote`'s hosted lane)
 * feeds it facts it already gathered rather than each re-deriving its own verdict, so the two
 * lanes' JSON payloads read the same word for the same situation.
 *
 * `isCode` selects which signal decides the verdict: a code project's render presence
 * (`minted`/`present`), or — for everything else — whether a byte-check actually ran
 * (`anyCheck`) versus a locator this run could not independently re-hash (`unrecomputablePointers`).
 * The two signals are never combined into one number on purpose: "3 of 5 renders present" and "2
 * locator commitments unconfirmed" are different facts about different projects, and mixing them
 * would produce a verdict that answers neither question honestly.
 */
export function computeAvailability(opts: {
  isCode: boolean;
  minted: number;
  present: number;
  anyCheck: boolean;
  unrecomputablePointers: number;
}): AvailabilityVerdict {
  if (opts.isCode) {
    if (opts.minted === 0) return {status: 'unknown', note: 'no tokens minted yet — nothing to render'};
    if (opts.present === opts.minted) return {status: 'available', note: `${opts.present}/${opts.minted} minted token(s) have a real render`};
    if (opts.present === 0) return {status: 'unavailable', note: `0/${opts.minted} minted token(s) have a real render — every one is still a placeholder`};
    return {status: 'partial', note: `${opts.present}/${opts.minted} minted token(s) have a real render`};
  }
  if (opts.anyCheck) {
    return {status: 'available', note: 'served bytes were fetched and compared against the on-chain commitment (see `ok` for whether they matched)'};
  }
  if (opts.unrecomputablePointers > 0) {
    return {
      status: 'unknown',
      note: `${opts.unrecomputablePointers} locator commitment(s) (ipfs/arweave/url) exist but were not independently re-fetched by this command`,
    };
  }
  return {status: 'available', note: 'no content commitments on this project — nothing to serve'};
}

/** Locator representations `verifyProject` never emits a check for (only `keccak256`/`sha256`
 *  fields get one) — a real commitment this command cannot re-hash from the field alone: ipfs/
 *  arweave carry a content-addressed locator this run doesn't fetch, and url/url-template carry
 *  no hash at all. Reported as a `verified: null` entry, same tri-state slot a hash check uses,
 *  so a caller sees ONE consistent shape rather than silence for these tokens. */
const POINTER_REPRESENTATIONS = new Set<string>([
  METADATA_REPRESENTATION.ipfs,
  METADATA_REPRESENTATION.arweave,
  METADATA_REPRESENTATION.url,
  METADATA_REPRESENTATION.urlTemplate,
]);

/**
 * Does this token's `image` field carry a locator commitment `verifyProject` never produced a
 * check for? Exported and pure (a plain `fields` array in, a verdict out — no chain, no indexer)
 * so the three-way distinction is unit-testable directly, rather than only reachable through a
 * full `cmdVerifyBody` run against real chain state.
 *
 * Returns the representation name to report (`ipfs`/`arweave`/`url`/`url-template`) when the image
 * field is a bare locator, else `null` — including when there's no `image` field at all, which is
 * "no commitment", a different fact from "an unrecomputable one".
 */
export function pointerOnlyImageCheck(fields: MetadataField[]): string | null {
  const image = fieldOf(fields, METADATA_FIELD.image);
  if (image && POINTER_REPRESENTATIONS.has(image.representation)) return image.representation;
  return null;
}

export async function cmdVerifyBody(
  address: Address,
  flags: Flags,
  emit: (p: Record<string, unknown>) => void,
): Promise<void> {
  const indexer = localIndexer();
  let state = indexer.getProject(address);
  // FAIL FAST, before any scan. `abx verify`'s own help already admits it needs the project
  // registered on THIS node — this is that check enforced, not just documented. Without it, a
  // caller who follows the previous version of this message's advice literally (`abx add <addr>`
  // with no thought to whether the project is actually served by a REMOTE resolver instead) walks
  // straight into a full historical log scan on a public RPC — exactly what a cold-agent sweep hit
  // (repeated HTTP 429s, minutes wasted, reads like an outage). Naming `--remote <name>` here as a
  // real alternative is the fix: it steers a resolver-served project away from a needless local
  // backfill instead of just failing fast into the same trap one command later.
  if (indexer.store.getRegistration(address)) {
    ({state} = await indexer.reindex(address)); // freshest state from chain
  } else if (!state) {
    throw new Error(
      `${address} isn't registered on this node — verify checks a local projection, not the chain directly, and never scans until this check passes. ` +
        `Run \`abx add ${address}\` to index it here, or if a resolver already serves it, check that instead: \`abx verify ${address} --remote <name>\`.`,
    );
  }
  if (!state) throw new Error(`could not load state for ${address}`);

  // Accumulated as the checks run, re-emitted at each stage so a payload survives an early return.
  const verifyReport: Record<string, unknown> = {
    address,
    chain: CHAIN,
    name: state.name ?? null,
    canonical: state.isCanonical, // TRUE tri-state: true | false | null (couldn't check)
    owner: state.owner ?? null,
    contentChecks: [] as unknown[],
    contentIntegrity: 'no-commitments' as 'ok' | 'mismatch' | 'no-commitments',
    renders: null as unknown,
    onChainUri: null as unknown,
    // Fail closed for the same reason as the remote lane below: this object is emitted early and
    // printed in its FINAL state, so a run that dies partway must not leave `ok: true` standing.
    // The verdict is assigned unconditionally further down, before the second `emit`.
    ok: false,
    // A SIBLING of `ok`, not a rename — see `computeAvailability`'s doc comment for why the two
    // must never collapse into one bit. Filled in below, once the facts it's computed from exist.
    availability: null as unknown,
  };
  emit(verifyReport);

  console.log(bold(`\n  verify ${state.name ?? address}`));
  // isCanonical is a TRUE TRI-STATE (true | false | null) and collapsing it lost the only
  // distinction that matters: "the chain says this is NOT a clone of the configured factory" is a
  // trust finding; "we couldn't run the check" (no factory configured, or none deployed on this
  // chain) is an environment note. Keep those states visibly distinct.
  info(`canonical: ${canonicalLabel(state.isCanonical)} · owner ${state.owner ?? '—'}`);

  const storage = resolveBackend(storageOptions());
  const result = await verifyProject(state, storage);
  const tokens = (result as {tokens?: Array<{tokenId: string; checks: Array<{kind: string; verified: boolean | null}>}>}).tokens ?? [];
  let anyCheck = false;
  let allGood = true;
  // Locator commitments (ipfs/arweave/url/url-template `image` fields) `verifyProject` never
  // produces a check for — see `POINTER_REPRESENTATIONS`'s doc comment. Counted SEPARATELY from
  // `anyCheck`/`allGood` on purpose: a pointer this command didn't re-fetch is not an integrity
  // verdict either way, so it must never move `contentIntegrity`/`ok` — it feeds `availability`
  // instead, below.
  let unrecomputablePointers = 0;
  for (const t of tokens) {
    const tok = state.tokens.find((s) => s.tokenId === t.tokenId);
    const life =
      tok?.lifecycle === 'live'
        ? 'minted'
        : tok?.lifecycle === 'burned'
          ? 'BURNED'
          : tok?.lifecycle === 'no-live-copies'
            ? 'no live copies'
            : 'not yet minted';
    info(`token #${t.tokenId}: ${life}`);
    for (const ch of t.checks) {
      (verifyReport.contentChecks as unknown[]).push({
        tokenId: t.tokenId,
        lifecycle: tok?.lifecycle ?? 'unminted',
        kind: ch.kind,
        // tri-state again: true (re-hashed, matched) · false (MISMATCH) · null (pointer-only,
        // nothing local to recompute). Collapsing null into false would report a normal state as a
        // failure, which is the bug this command exists to not have.
        verified: ch.verified,
      });
      anyCheck = true;
      if (ch.verified === true) ok(`${ch.kind} matches on-chain commitment — content is authentic`);
      else if (ch.verified === false) { allGood = false; console.log(`    ${c.red}✗${c.reset} ${ch.kind} MISMATCH — served bytes don't match the commitment`); }
      else info(`${ch.kind} — pointer-only, not locally recomputable`);
    }
    // `verifyProject` only ever emits a check for a keccak256/sha256-committed `image` field, so a
    // token whose image is a bare LOCATOR (ipfs/arweave/url/url-template) gets `t.checks === []` —
    // indistinguishable, before this, from "no commitment at all". That was the real gap
    // named: a real, independently-lockable commitment silently read as nothing. Surface it as the
    // same tri-state slot a hash check uses (`verified: null`), so a caller sees one consistent
    // shape instead of two different kinds of silence.
    if (t.checks.length === 0 && tok) {
      const pointerKind = pointerOnlyImageCheck(tok.fields);
      if (pointerKind) {
        unrecomputablePointers++;
        (verifyReport.contentChecks as unknown[]).push({
          tokenId: t.tokenId,
          lifecycle: tok.lifecycle,
          kind: pointerKind,
          verified: null,
        });
        info(`${pointerKind} — pointer-only, not locally recomputable (no outbound fetch from this command)`);
      }
    }
  }
  if (!anyCheck && unrecomputablePointers === 0 && !isCodeProject(state)) info('no content commitments on this project');
  verifyReport.contentIntegrity = !anyCheck ? 'no-commitments' : allGood ? 'ok' : 'mismatch';
  verifyReport.ok = !anyCheck || allGood;
  emit(verifyReport);

  // Code projects have no on-chain `image` commitment (the still is rendered off-chain by the
  // effect runner), so the hash checks above are silent for them. Instead report what actually
  // matters after mint: does a REAL thumbnail exist yet, or is the marketplace image still the
  // placeholder? Same seam the /…/image route serves from (currentRenderArtifact @ current
  // inputsHash) — so this answers "did the render land?" with one command, right after token 0.
  let renderGap = false;
  // Hoisted above the `isCodeProject` branch: `availability` (computed right after it, whether or
  // not this project turns out to be a code project) needs the render counts that branch produces.
  let codeRenders: {minted: number; present: number} | null = null;
  if (isCodeProject(state)) {
    const client = makePublicClient({chainKey: CHAIN});
    const storageForRender = resolveBackend(storageOptions());
    const minted = state.tokens.filter((t) => t.lifecycle === 'live');
    if (minted.length === 0) info('no tokens minted yet — mint token #0, then re-run to check its thumbnail.');
    // Live-data posture — the augment hook IS the opt-in: no hook ⇒ zero live reads (pure indexed
    // params); hook set ⇒ the live view reads chain per view, and the STILL snapshots settled state
    // (live data never re-addresses the render — that's the settled/full split).
    info(
      state.paramHooks?.augmentHook
        ? `live data: augment hook ${state.paramHooks.augmentHook} — live view reads chain per view; stills snapshot settled state`
        : 'live data: none (settled params only — the live view makes zero extra chain reads)',
    );
    // Immutability of the WORK itself — the on-chain program (script chunks) and its library set.
    // This is the gap `lock-field`/`lock-uri` don't cover: those freeze metadata, but the owner can
    // still call `setScriptChunk`/`removeLastScriptChunk` until `lock-script` is sent. Report it so a
    // "locked" drop isn't quietly still-mutable in the one place that carries the work.
    verifyReport.script = state.script ? {locked: !!state.script.locked} : null;
    verifyReport.dependencies = state.dependencies
      ? {count: state.dependencies.list.length, locked: !!state.dependencies.locked}
      : null;
    emit(verifyReport);
    if (state.script) {
      if (state.script.locked) ok('script: locked — the program bytes are frozen permanently (setScriptChunk reverts)');
      else console.log(`    ${c.orange}⚠${c.reset} script: UNLOCKED — the owner can still change the program. Freeze the work with ${bold(`abx lock-script ${address}`)} ${dim("(lock-field/lock-uri don't cover the script)")}`);
    }
    if (state.dependencies && state.dependencies.list.length > 0) {
      if (state.dependencies.locked) ok('dependencies: locked — the library set is frozen');
      else info(`dependencies: unlocked — freeze the list + registry pointer with \`abx lock-dependencies ${address}\` (that pins WHICH library each ref means; a Registry ref's bytes still live in the registry)`);
    }
    // The other two param hooks (if wired) — surfaced here since this is where hooks show. Quiet when
    // unset (the common case). Manage all three with `abx set-param-hooks`.
    if (state.paramHooks?.configureHook || state.paramHooks?.transferHook) {
      const parts: string[] = [];
      if (state.paramHooks.configureHook) parts.push(`configure ${state.paramHooks.configureHook}`);
      if (state.paramHooks.transferHook) parts.push(`transfer ${state.paramHooks.transferHook}`);
      info(`param hooks: ${parts.join(' · ')} ${dim('(configure = write-time veto · transfer = a VETO over transfers AND mints; manage with `abx set-param-hooks`)')}`);
    }
    // The hook lock is reported for every project with the surface, set hooks or not: a frozen empty
    // trio is a real guarantee ("this project can never add a transfer veto"), and an unfrozen one is
    // a live power even when no hook is set today. Folded from `ParamHooksFrozen`.
    if (state.paramHooks) {
      verifyReport.paramHooks = {
        configureHook: state.paramHooks.configureHook,
        augmentHook: state.paramHooks.augmentHook,
        transferHook: state.paramHooks.transferHook,
        locked: state.paramHooks.locked,
      };
      if (state.paramHooks.locked) ok('param hooks: frozen — no hook address can change again (no transfer veto can ever be armed)');
      else if (state.paramHooks.transferHook) {
        console.log(`    ${c.orange}⚠${c.reset} param hooks: UNLOCKED, and a transfer hook is armed — it can block transfers and mints, and the owner can re-point it. Freeze the set with ${bold(`abx lock-param-hooks ${address}`)}`);
      } else {
        info(`param hooks: unlocked — no hook is set, but the owner can still add one (a transfer hook can block transfers/mints). Freeze with \`abx lock-param-hooks ${address}\``);
      }
    }
    // This checks THIS machine's store. A render PUBLISHED to a hosted resolver (locator bridge) lives
    // on that resolver, NOT here — so a "not found" below can be a false negative for a hosted drop.
    // `abx verify <addr> --remote <resolver>` probes what the resolver actually serves (the truthful check).
    if (minted.length) info(dim(`render check is against THIS node's store; for a HOSTED drop use \`abx verify ${address} --remote <resolver>\``));
    // ONE line per outcome, not per token. This printed the same full-sentence advisory 32 times on a
    // 32-token project (~4KB of identical text) and pushed the four lines that answer "did my deploy
    // work" off the top of the screen; at a 1000-token supply it is unreadable. The per-token detail
    // that survives is the token LIST, which is the only part that differs.
    const missing: string[] = [];
    let present = 0;
    for (const token of minted) {
      const {found} = await currentRenderArtifact(client, state, token, storageForRender, 'image');
      if (found) present++;
      else missing.push(String(token.tokenId));
    }
    verifyReport.renders = {
      minted: minted.length,
      present,
      missing, // token ids, so a caller can re-render exactly these
      // Named for what it IS: this node's store. A render PUBLISHED to a hosted resolver lives
      // there, not here, so `missing` is a false negative for a hosted drop — hence the scope.
      scope: "this node's store",
    };
    codeRenders = {minted: minted.length, present};
    emit(verifyReport);
    if (present) ok(`${present}/${minted.length} minted token(s): real render present (in this node's store)`);
    if (missing.length) {
      renderGap = true;
      const ids = missing.length > 12 ? `${missing.slice(0, 12).join(', ')}, …+${missing.length - 12} more` : missing.join(', ');
      console.log(`    ${c.orange}⚠${c.reset} ${missing.length}/${minted.length} token(s) have no render in THIS node's store ${dim(`(#${ids})`)}`);
      console.log(`      ${dim('published to a hosted resolver? check there:')} ${bold(`abx verify ${address} --remote <resolver>`)}`);
      console.log(`      ${dim('else render them:')} ${bold(`abx render ${address}`)} ${dim('(once) ·')} ${bold('abx effects')} ${dim('(continuous)')}`);
    }
  }

  // The availability verdict — computed here, after both the byte-integrity pass and the render
  // pass above have run, from facts they already gathered (no new reads). See `computeAvailability`.
  verifyReport.availability = jsonSafe(
    computeAvailability({
      isCode: isCodeProject(state),
      minted: codeRenders?.minted ?? 0,
      present: codeRenders?.present ?? 0,
      anyCheck,
      unrecomputablePointers,
    }),
  );
  emit(verifyReport);

  // The on-chain URI lane (a non-zero tokenURIRenderer, or an animation field pointing at the
  // generator): read the generator's honesty surface — onChainStatus (branch · chain-complete ·
  // unresolved refs · URL budget) — then decode tokenURI straight from the contract and report
  // what the animation_url actually is. All eth_calls; no server, no local store involved.
  if (hasOnChainUriLane(state)) {
    const client = makePublicClient({chainKey: CHAIN});
    // Is this actually a PROGRAM, or a static image that merely resolves on-chain? `hasOnChainUriLane`
    // is true whenever a tokenURI renderer is set — which it is for EVERY fully-on-chain project,
    // image or code. So an image drop ran the code-project checks and ended in two ⚠ ("generator
    // reports NO code", "no animation_url") that are the DESIGN for a static image, not a defect.
    // Static on-chain images should not receive code-project warnings for their intentional shape.
    const isCodeProject = state.contractType === 'code' || state.contractType === 'edition-code';
    try {
      const report = await onChainUriReport(client, state, flags.generator as string | undefined);
      const {status, probe} = report;
      // The factory-generation half of "is this pinned to a superseded deployment" already
      // ships (ANCHOR_GENERATIONS + verifyCanonical, in the `canonical`/`abxGeneration` line above);
      // this is the SINGLETON half — these two pointers were already read and printed here, just
      // never compared. Binary by design (see `isCurrentGenerator`'s doc): current / not-current,
      // never "superseded-but-known", because neither manifest keeps a prior address to recognize a
      // mismatch against. A `false` here is NOT a defect report — an older-but-working renderer or
      // generator still serves; it just isn't what a fresh deploy would get today.
      const generatorCurrent = isCurrentGenerator(state.chainId, report.generator);
      const rendererCurrent = state.tokenURIRenderer ? await isCurrentRenderer(client, state.tokenURIRenderer) : null;
      verifyReport.onChainUri = jsonSafe({
        generator: report.generator,
        generatorCurrent, // true | false | null (no canonical generator recorded for this chain)
        tokenURIRenderer: state.tokenURIRenderer ?? null,
        // null ⇒ no renderer set at all (nothing to compare) — distinct from `false` (set, but not
        // spec v11). See `isCurrentRenderer`: a read failure ALSO reports `false`, same as a stale
        // renderer — the underlying probe cannot tell those apart, so neither can this field.
        tokenURIRendererCurrent: rendererCurrent,
        branch: status.branchName,
        chainComplete: !!status.chainComplete,
        unresolvedRefs: [...status.unresolvedRefs],
        urlOverBudget: !!status.urlOverBudget,
        probe: probe
          ? {tokenId: probe.tokenId, onChainJson: !!probe.onChainJson, animation: probe.animation}
          : null,
      });
      emit(verifyReport);
      info(`on-chain URI lane: generator ${report.generator}${state.tokenURIRenderer ? ` · tokenURI renderer ${state.tokenURIRenderer}` : ' · tokenURIRenderer NOT set (animation field only — tokenURI still resolves off-chain)'}`);
      if (generatorCurrent === true) ok(`generator is the CURRENT canonical one for ${CHAIN}`);
      else if (generatorCurrent === false) {
        info(
          `generator is NOT the current canonical one for ${CHAIN} ${dim('(a prior deployment this project is pinned to, or a fully custom field renderer — it still works; repoint with')} ${bold(`abx set-field ${address} --field animation_url --representation renderer --value <generator> --collection`)}${dim(')')}`,
        );
      } // null: no canonical generator recorded for this chain at all — nothing to compare against, so say nothing rather than a false "NOT current".
      if (rendererCurrent === true) ok(`tokenURI renderer is CURRENT (spec v11)`);
      else if (rendererCurrent === false) {
        info(
          `tokenURI renderer is NOT current (spec v11) ${dim(`— an older renderer still serves fine; it just doesn't have v11's capabilities (see the renderer's changelog in deployments.ts). Repoint with`)} ${bold(`abx set-renderer ${address} --collection`)}${dim(' (and without --collection for the per-token pointer)')}`,
        );
      }
      if (status.branchName === 'template') {
        ok(`generator branch: template — the document assembles from the on-chain script chunks`);
        if (status.chainComplete) {
          ok('chain-complete — every dependency resolves to on-chain bytes; no server, gateway, or CDN in the graph');
          // chainComplete is a SERVING claim, not an immutability one. A `Registry` dependency is
          // fetched live from the registry contract on every read, so its bytes can change after
          // `lock-dependencies` froze the pointer — and this flag reported `true` on both sides of
          // a registry update. Say what it means rather than letting "complete" read as "finished".
          info(dim('  chain-complete describes WHERE the bytes come from, not that they are frozen: a Registry dependency is re-fetched from the registry on every read, so its bytes can change even with lock-dependencies set. Locks freeze this contract; they cannot freeze another one.'));
        }
        else info('not chain-complete — CDN-served or unresolved dependencies (CDN entries serve fine; on-chain bytes are the durability floor)');
        for (const ref of status.unresolvedRefs) {
          console.log(`    ${c.red}✗${c.reset} unresolved dependency ${bold(ref)} — the document carries an <!-- abx:unresolved --> marker; fix the ref or the registry pointer`);
        }
      } else if (status.branchName === 'directory') {
        ok('generator branch: directory — the code field emits a parameterized gateway URL');
        if (status.urlOverBudget) console.log(`    ${c.orange}⚠${c.reset} the emitted URL exceeds the 8KB budget — gateway front-ends may drop it; prefer template mode, trim the param surface, or carry big values as locator params`);
        else info('URL within the 8KB budget');
      } else if (isCodeProject) {
        console.log(`    ${c.orange}⚠${c.reset} generator reports NO code (neither script chunks nor a code field) — animation_url degrades to an <!-- abx:no-code --> marker`);
      } else {
        // A static image drop has no program by design — stating that is fine, warning about it is not.
        info('no program on this project — a static image drop, so the metadata carries no animation_url (expected, not a gap)');
      }
      if (!probe) {
        info('tokenURI probe skipped — no token minted yet (mint token #0, then re-run)');
      } else if (!probe.onChainJson) {
        console.log(`    ${c.red}✗${c.reset} ${probe.accessor}(${probe.tokenId}) is NOT an on-chain data:application/json;base64 URI — got "${probe.uriPrefix}…"`);
      } else {
        ok(`${probe.accessor}(${probe.tokenId}) resolves ON-CHAIN: data:application/json;base64 — decoded from the contract, no server`);
        const a = probe.animation;
        if (a.form === 'data-html') {
          if (a.marker) console.log(`    ${c.orange}⚠${c.reset} animation_url: data:text/html;base64 (${a.bytes} bytes decoded) but the document carries ${bold(a.marker)} — it degraded honestly instead of reverting`);
          else ok(`animation_url: data:text/html;base64 — ${a.bytes} bytes of HTML, decoded (the full document, inline)`);
        } else if (a.form === 'url') {
          ok(`animation_url: ${a.url} ${dim('(directory branch — the parameterized gateway URL, landed verbatim)')}`);
        } else if (a.form === 'data-other') {
          console.log(`    ${c.orange}⚠${c.reset} animation_url is a data: URI but not text/html — got "${a.prefix}…"`);
        } else if (isCodeProject) {
          console.log(`    ${c.orange}⚠${c.reset} no animation_url in the on-chain JSON — the generator field may be missing or unrenderable`);
        }
        // else: a static image has no animation_url and is not supposed to — say nothing.
      }
      // The READ-side envelope. Params enumerate on-chain, so the write side is unbounded — but
      // tokenURI and tokenData assemble EVERY enumerated param per call, and that is what grows.
      // ~64 keys is the documented design envelope; hard failure only nears at several hundred.
      // Advisory (never a ✗) — a big surface is a legitimate choice, it just isn't free.
      const set = await readSetParamKeys(client, state.address, probe ? BigInt(probe.tokenId) : undefined);
      if (set) {
        const total = new Set([...set.contract, ...set.token]).size;
        if (total > 64) {
          console.log(
            `    ${c.orange}⚠${c.reset} ${total} params enumerate on-chain${probe ? ` for token #${probe.tokenId}` : ''} — tokenURI and tokenData assemble every one of them per call, so both grow with this count. ` +
              dim('The documented design envelope is ~64; past a few hundred a public eth_call can hit its gas cap.'),
          );
        }
      }
    } catch (e) {
      // First line only. A viem read error carries a multi-line dump (Contract Call / args / Docs /
      // Version) that is meaningless to a creator and buried the actual sentence when this fired.
      const first = String((e as Error).message ?? e).split('\n')[0].trim();
      console.log(`    ${c.orange}⚠${c.reset} on-chain URI check unavailable: ${first}`);
    }
  }

  if (renderGap) console.log(`\n  ${dim('live view animates regardless; the placeholder only affects the static marketplace thumbnail.')}\n`);
  else console.log(anyCheck && allGood ? `\n  ${g('✓ verified')} — the node serves exactly what the chain commits to.\n` : '\n');
  // A byte-vs-chain mismatch is an integrity FAILURE, so fail the command. Verify's whole job is to
  // answer "is what's served what the chain vouches for" — exiting 0 while printing ✗ meant nothing
  // could gate on it (a script or CI would sail past a corrupted image). Deliberately narrow: a
  // missing render / placeholder is a normal, expected state and still exits 0.
  if (anyCheck && !allGood) process.exitCode = 1;
}

// `abx verify <addr> --remote <url>` — verify what a HOSTED resolver actually serves (the local
// `verify` checks THIS machine's store/backend, the wrong store for a hosted drop). Probes the real
// `/…/image` route, so it accounts for the locator bridge (a 302 to ipfs/ar) exactly as a marketplace
// sees it — the truthful "did the thumbnail land?" check after a remote render.
export async function cmdVerifyRemote(
  address: Address,
  remote: RemoteTarget,
  emit: (p: Record<string, unknown>) => void,
): Promise<void> {
  const base = remote.url.replace(/\/$/, '');
  const chainId = resolveChain(CHAIN).id;
  // Same shape, same field names as the local lane's `verifyReport` (cmdVerifyBody) wherever the
  // two lanes answer the same question, so a caller doesn't need a second parser for `--remote`.
  // `--remote --json` used to emit NOTHING at all — this command routed around `withJson` entirely
  // (see `cmdVerify`) — so every field here is new, not a rename of something that already worked.
  const verifyReport: Record<string, unknown> = {
    address,
    remote: base,
    name: null as string | null,
    watching: null as boolean | null,
    contentChecks: [] as unknown[],
    contentIntegrity: 'not-checked' as 'ok' | 'mismatch' | 'no-commitments' | 'not-checked',
    renders: null as unknown,
    availability: null as unknown,
    // FAIL CLOSED. `emit` registers this object and `withJson` prints its FINAL state, so every
    // terminal path must earn its verdict — and a path that throws (a down endpoint, a 404 from a
    // resolver that doesn't serve this project) never reaches one. This used to initialize `true`,
    // which meant `verify --remote --json` on an unregistered project printed `"ok": true` on
    // stdout while exiting 1 and saying "register it first" on stderr. `ok` is documented as the
    // field CI gates on, so an un-earned `true` is the one wrong answer this payload can give:
    // "we could not check" is not "it is fine". Every early return below sets it explicitly.
    ok: false,
  };
  emit(verifyReport);

  console.log(bold(`\n  verify ${address} ${dim(`(remote → ${base})`)}`));
  // A DOWN endpoint and a wrong-address endpoint are different problems with different fixes, and a
  // bare `fetch failed` says neither. Match `abx status --remote` so both commands describe the same
  // condition consistently.
  let stateRes: Response;
  try {
    stateRes = await fetch(`${base}/api/project/${address}`);
  } catch {
    throw new Error(
      `verify: nothing responded at ${base}${remote.source === 'named' ? ` (from ABX_REMOTE_${remote.name}_URL)` : ''}. Is it running, and is that the right address?`,
    );
  }
  if (!stateRes.ok) {
    throw new Error(`resolver ${base} doesn't serve ${address} (HTTP ${stateRes.status}) — register it first: abx add ${address} --remote ${remote.name?.toLowerCase() ?? base}`);
  }
  const state = (await stateRes.json()) as {name?: string; tokens?: Array<{tokenId: string; lifecycle: TokenState['lifecycle']}>};
  verifyReport.name = state.name ?? null;
  info(`serving as "${state.name ?? address}"`);
  // Is the resolver actively WATCHING the chain? Prove it from /api/watch (the meta the watcher
  // stamps each tick) so a hosted operator who can't tail the log still sees liveness — and catches
  // a silently-stalled watcher (pollAt gone stale) instead of assuming auto-updates still work.
  const watch = (await fetch(`${base}/api/watch`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as
    | {watching: boolean; intervalMs: number; pollAt: string | null; lastDeltaAt: string | null; chains: Record<string, {head: string | null}>}
    | null;
  verifyReport.watching = watch?.watching ?? null;
  emit(verifyReport);
  if (watch?.watching) {
    const heads = Object.entries(watch.chains).map(([ck, s]) => `${ck} @ block ${s.head}`).join(', ');
    const ageS = watch.pollAt ? Math.round((Date.now() - Date.parse(watch.pollAt)) / 1000) : null;
    const stalled = ageS !== null && ageS > Math.max(60, Math.round((Number(watch.intervalMs) / 1000) * 4));
    const detail = `watching ${heads || 'chain'}${ageS !== null ? ` · last poll ${ageS}s ago` : ''}${watch.lastDeltaAt ? ` · last change ${watch.lastDeltaAt}` : ''}`;
    if (stalled) console.log(`    ${c.orange}⚠${c.reset} ${detail} — watcher looks STALLED; restart \`abx serve\``);
    else ok(detail);
  } else if (watch) {
    console.log(`    ${dim('watcher OFF — changes land only via explicit add/index or a manual render (ABX_WATCH_INTERVAL_MS=0)')}`);
  }
  const minted = (state.tokens ?? []).filter((t) => t.lifecycle === 'live');
  if (minted.length === 0) {
    info('no tokens minted yet — mint token #0, then re-run.');
    verifyReport.availability = jsonSafe({status: 'unknown', note: 'no tokens minted yet'});
    // Nothing committed yet is not a FAILURE — there is simply nothing to hash, and this path exits
    // 0. Said explicitly because the initializer is now fail-closed: an un-minted project is the one
    // early return that legitimately earns `ok`.
    verifyReport.contentIntegrity = 'no-commitments';
    verifyReport.ok = true;
    emit(verifyReport);
    console.log('');
    return;
  }
  // Prefer the resolver's effect-status API (the derived 4-state readout: up-to-date · rendering ·
  // failed(error) · stale). Falls back to the raw /image probe for a resolver without the route.
  const statusRes = await fetch(`${base}/api/project/${address}/effects`).catch(() => null);
  if (statusRes?.ok) {
    const report = (await statusRes.json()) as {
      counts: {upToDate: number; stale: number; rendering: number; failed: number};
      tokens: Array<{tokenId: string; effectKey: string; status: string; error?: string; attempts?: number}>;
    };
    for (const t of report.tokens) {
      const label = `token #${t.tokenId} ${t.effectKey}`;
      if (t.status === 'up-to-date') ok(`${label}: up to date (real render at the current state)`);
      else if (t.status === 'rendering') info(`${label}: rendering — the effects runner is on it`);
      else if (t.status === 'failed') console.log(`    ${c.red}✗${c.reset} ${label}: FAILED${t.attempts ? ` after ${t.attempts} attempt(s)` : ''} — ${t.error ?? 'see runner logs'} ${dim(`(fix, then \`abx render ${address} ${t.tokenId} --force --remote ${base}\`)`)}`);
      else console.log(`    ${c.orange}⚠${c.reset} ${label}: stale — no render at the current state yet (the runner's next notify/sweep picks it up, or \`abx render ${address} --remote ${base}\`)`);
    }
    const {upToDate, stale, rendering, failed} = report.counts;
    // RENDERS ONLY — say so. This report answers "is there a current render for each token", never
    // "do the served bytes match the on-chain commitment"; those are different questions and this
    // command promises the second one too. A project with no renders at all (a 1/1, an image Series)
    // has nothing to be "up to date" ABOUT, so don't print a 0/N fraction — but don't let a green ✓
    // here read as "the image is verified" either. Byte integrity comes from the check below.
    if (report.tokens.length === 0) {
      info(`renders    ${dim('none for this project (a static image needs no off-chain render)')}`);
    } else {
      // Lead with the count that carries the polarity: "N of M current" never inverts on a skim the
      // way "0/M up to date" does.
      const summary = `${upToDate} of ${minted.length} token(s) current${rendering ? ` · ${rendering} rendering` : ''}${stale ? ` · ${stale} stale` : ''}${failed ? ` · ${failed} FAILED` : ''}`;
      if (failed || stale) console.log(`  ${c.orange}⚠${c.reset} renders: ${summary} ${dim('— live view animates regardless; only the static thumbnail is affected.')}`);
      else ok(`renders: ${summary}`);
    }
    verifyReport.renders = jsonSafe({minted: minted.length, upToDate, stale, rendering, failed, tokens: report.tokens});
    verifyReport.availability = jsonSafe(
      computeAvailability({isCode: report.tokens.length > 0, minted: minted.length, present: upToDate, anyCheck: false, unrecomputablePointers: 0}),
    );
    emit(verifyReport);
    const integrity = await reportRemoteByteIntegrity(address, remote, base);
    verifyReport.contentIntegrity = integrity.status;
    verifyReport.contentChecks = integrity.checks;
    verifyReport.ok = integrity.status !== 'mismatch';
    emit(verifyReport);
    return;
  }
  let gap = false;
  let present = 0;
  const missing: string[] = [];
  for (const t of minted) {
    const img = await fetch(`${base}/t/${chainId}/${address}/${t.tokenId}/image`, {redirect: 'manual'});
    const loc = img.headers.get('location');
    const ct = img.headers.get('content-type') ?? '';
    if (img.status >= 300 && img.status < 400 && loc) { present++; ok(`token #${t.tokenId} image: real render — resolver 302s to ${loc}`); }
    else if (img.status === 200 && !/svg/i.test(ct)) { present++; ok(`token #${t.tokenId} image: real render present (${ct})`); }
    else {
      gap = true;
      missing.push(t.tokenId);
      console.log(`    ${c.orange}⚠${c.reset} token #${t.tokenId} image: PLACEHOLDER (${ct || 'svg'}) — run \`abx render ${address} --remote ${base}\`, or stand up the effects runner`);
    }
  }
  console.log(
    gap
      ? `  ${dim('live view animates regardless; the placeholder only affects the static marketplace thumbnail.')}`
      : `  ${g('✓ thumbnails are real renders')} ${dim('— served straight from the resolver.')}`,
  );
  verifyReport.renders = jsonSafe({minted: minted.length, present, missing, scope: 'the resolver (raw image probe — no /effects route)'});
  verifyReport.availability = jsonSafe(computeAvailability({isCode: true, minted: minted.length, present, anyCheck: false, unrecomputablePointers: 0}));
  emit(verifyReport);
  const integrity = await reportRemoteByteIntegrity(address, remote, base);
  verifyReport.contentIntegrity = integrity.status;
  verifyReport.contentChecks = integrity.checks;
  verifyReport.ok = integrity.status !== 'mismatch';
  emit(verifyReport);
}

/** What {@link reportRemoteByteIntegrity} found, structured for the JSON payload as well as its own
 *  prose. `status` deliberately has a 4th value the local lane's `contentIntegrity` doesn't need:
 *  `'not-checked'` — no credential, a rejected token, an older node with no `/verify` route, or an
 *  unreachable endpoint. That is a DIFFERENT fact from `'no-commitments'` (the route answered and
 *  said there's nothing to check) and must never collapse into it — "we didn't ask" and "we asked
 *  and there was nothing" are different reasons for the same empty result. */
export interface RemoteByteIntegrity {
  status: 'ok' | 'mismatch' | 'no-commitments' | 'not-checked';
  checks: Array<{tokenId: string; kind: string; verified: boolean}>;
}

/**
 * The half `abx verify --remote` was missing: do the served BYTES still hash to the on-chain
 * commitment? Everything above it checks renders (is a thumbnail current, is it a placeholder) — a
 * different question, and a green ✓ there was reading as "the image is correct" when the bytes could
 * genuinely mismatch.
 *
 * The service is the right place to answer it: it holds both the bytes and the chain, and it already
 * exposes exactly this check (`GET /api/project/:addr/verify`, bearer-gated because it triggers
 * outbound fetches). When we can't reach that — no credential, or an older node — say plainly that
 * byte integrity was NOT checked rather than leaving the ✓ above to imply it was.
 */
export async function reportRemoteByteIntegrity(address: Address, remote: RemoteTarget, base: string): Promise<RemoteByteIntegrity> {
  if (!remote.token) {
    warn(`byte integrity NOT checked — that check is credentialed on the service. Set ${remote.tokenVar} (or pass --remote-token) and re-run, or run ${bold(`abx verify ${address}`)} against a node that holds the bytes.`);
    return {status: 'not-checked', checks: []};
  }
  let report: {tokens?: Array<{tokenId: string; checks: Array<{kind: string; verified: boolean}>}>; error?: string};
  try {
    const res = await fetch(`${base}/api/project/${address}/verify`, {headers: {authorization: `Bearer ${remote.token}`}});
    if (res.status === 401 || res.status === 403) {
      warn(`byte integrity NOT checked — ${base} rejected ${tokenSourceLabel(remote)} for its verify route (the read plane served fine, so this is a credential/scoping issue, not a broken project).`);
      return {status: 'not-checked', checks: []};
    }
    if (!res.ok) {
      // Spec'd as part of `abx-token-api/v1`, so a conforming service has it — but say it neutrally:
      // this is equally "an older self-hosted node" and "a provider that didn't implement it".
      warn(
        `byte integrity NOT checked — ${base} serves no /api/project/…/verify route (HTTP ${res.status}). ` +
          `Your own node? Redeploy it (\`abx deploy-resolver\`). A provider's? It's part of abx-token-api/v1 — ask them for it. ` +
          `Meanwhile ${bold(`abx verify ${address}`)} checks the bytes on a node that holds them.`,
      );
      return {status: 'not-checked', checks: []};
    }
    report = (await res.json()) as typeof report;
  } catch {
    warn(`byte integrity NOT checked — couldn't reach ${base}'s verify route.`);
    return {status: 'not-checked', checks: []};
  }
  const checked = (report.tokens ?? []).filter((t) => t.checks.length > 0);
  if (checked.length === 0) {
    info(`bytes      ${dim('no on-chain byte commitment to check (this project commits no image hash)')}`);
    return {status: 'no-commitments', checks: []};
  }
  const flatChecks = checked.flatMap((t) => t.checks.map((k) => ({tokenId: t.tokenId, kind: k.kind, verified: k.verified})));
  const bad = checked.filter((t) => t.checks.some((k) => !k.verified));
  if (bad.length === 0) {
    ok(`bytes: ${checked.length} token(s) hash-match their on-chain commitment ${dim('(what the service serves IS what the chain vouches for)')}`);
    return {status: 'ok', checks: flatChecks};
  }
  const spec = remote.name?.toLowerCase() ?? base;
  console.log(
    `  ${c.red}✗${c.reset} ${bold('BYTE MISMATCH')} on token(s) ${bad.map((t) => `#${t.tokenId}`).join(', ')} — ${base} does NOT serve bytes that hash to the on-chain commitment ` +
      `${dim('(this is what a marketplace shows as a blank or placeholder image)')}. The chain is the truth, so the served copy is the wrong one. Two causes, two fixes:`,
  );
  info(`durable bytes exist (ipfs://, ar://) but weren't bridged → ${bold(`abx add ${address} --remote ${spec}`)} forwards the locator, then re-run this.`);
  info(`the bytes only exist on THIS machine (local fs custody) → a hosted resolver can never serve them: ${bold('abx storage upload')} to a durable backend + re-point the field, or serve the project from a node that holds them.`);
  process.exitCode = 1; // same rule as the local lane: an integrity mismatch fails the command
  return {status: 'mismatch', checks: flatChecks};
}

// ── state: a one-glance operational snapshot of a deployed contract, read straight from chain ──
// Read-only (no tx, no local index). Series-only getters revert on a 1/1, so each read is defensive
// → the same command works for both. The agent-friendly "what's the state before/after an op" call.
/**
 * The `seed source` readout — three states, and the distinction between them is the whole reason the
 * line exists. `0x0` is a code project that deliberately draws no mint seed; the canonical address is
 * the shared pseudorandom `AbxSeedSource` (whose properties are documented and NOT lottery-grade);
 * anything else is the creator's own contract, about which ABX knows and claims nothing. A buyer or an
 * agent reading this needs to be able to tell "the standard one" from "someone's custom randomness"
 * at a glance — flattening them to a bare address hides exactly the fact worth surfacing.
 */
function describeSeedSource(source: Address): string {
  if (source === zeroAddress) return dim('none (0x0 — no mint-time seed drawn at mint)');
  if (source.toLowerCase() === canonicalSeedSource(resolveChain(CHAIN).id).toLowerCase()) {
    return `${source} ${dim('(canonical AbxSeedSource — pseudorandom, not lottery-grade)')}`;
  }
  return `${source} ${dim('— CUSTOM IAbxSeedSource (not the canonical one; its randomness properties are the project’s to state)')}`;
}

export const STATE_ABI = [
  {type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'nextTokenId', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'maxInvocations', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'primaryPayee', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'tokenURIRenderer', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'royaltyInfo', stateMutability: 'view', inputs: [{type: 'uint256'}, {type: 'uint256'}], outputs: [{type: 'address'}, {type: 'uint256'}]},
  // ERC-721C (creator token) — ERC-165 advertises ICreatorToken ONLY when enrolled at deploy.
  {type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{type: 'bytes4'}], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'getTransferValidator', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  // The royalty ceiling + burn opt-in are read via the SDK's `readCollectionPolicy` (one owner of
  // those two getters, shared with every other integrator) — deliberately not re-declared here.
  // Seed Source extension — composed by CODE projects only, so absent (undefined) on an image token.
  // Shown because it is the one setting an owner can re-point mid-sale that changes what a LATER
  // buyer receives; `SeedSourceSet` puts it on the spine, and this makes it readable in one command.
  {type: 'function', name: 'seedSource', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  // Report every irreversible lock in full (previously only `paramHooksLocked`
  // showed here). `tokenURILocked`/`contractURILocked`/`contractFieldLocked` exist on every ABX
  // token (baseline URI + On-Chain Metadata surface); `scriptLocked`/`dependenciesLocked` exist only
  // on the two code twins — see `readCollectionLocks`, which gates those two on `isCode` rather than
  // trusting a revert to mean "unknown" for a contract that never had the surface at all.
  {type: 'function', name: 'tokenURILocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'contractURILocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'scriptLocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'dependenciesLocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'contractFieldLocked', stateMutability: 'view', inputs: [{type: 'bytes32'}], outputs: [{type: 'bool'}]},
] as const;

/** The edition twin of {@link STATE_ABI} — `owner`/`maxInvocations`/`paused`/`minter`/
 *  `primaryPayee`/`tokenURIRenderer`/`royaltyInfo` are shared, unchanged, function names (see
 *  `kind.ts`'s own note on why); `totalSupply`/`maxSupply` take an id. The creator-token probe is
 *  ALSO shared, unchanged: Limit Break uses the identical `ICreatorToken` ERC-165 id (0xad0d7f6c)
 *  and `getTransferValidator()` surface for 721C and 1155C, and `CreatorToken1155` advertises them
 *  the same way when enrolled — so an enrolled edition reports its validator exactly like a 721. */
export const EDITION_STATE_ABI = [
  {type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'maxInvocations', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [{type: 'uint256'}], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'maxSupply', stateMutability: 'view', inputs: [{type: 'uint256'}], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'primaryPayee', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'tokenURIRenderer', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'royaltyInfo', stateMutability: 'view', inputs: [{type: 'uint256'}, {type: 'uint256'}], outputs: [{type: 'address'}, {type: 'uint256'}]},
  // ERC-1155C (creator token) — identical ERC-165 id + getter as 721C; advertised only when enrolled.
  {type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{type: 'bytes4'}], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'getTransferValidator', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  // The royalty ceiling + burn opt-in are read via the SDK's `readCollectionPolicy` (one owner of
  // those two getters, shared with every other integrator) — deliberately not re-declared here.
  // Seed Source extension — EditionCode composes it; the image editions don't. See STATE_ABI's note.
  {type: 'function', name: 'seedSource', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  // The same lock surface as STATE_ABI's edit — see the note there. Identical getter names on both
  // standards (verified against the generated ABI: every edition twin exposes the same five).
  {type: 'function', name: 'tokenURILocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'contractURILocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'scriptLocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'dependenciesLocked', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'contractFieldLocked', stateMutability: 'view', inputs: [{type: 'bytes32'}], outputs: [{type: 'bool'}]},
] as const;

/**
 * The royalty ceiling line — and the headroom, which is the part a creator has not been told.
 *
 * A ceiling above the live rate means the owner can raise the rate to it unilaterally, and nobody
 * looking at a listing can see that. So the useful sentence is not "your cap is 10%": it is that
 * reducing the cap TO the current rate is what turns "5% today" into "5%, provably, forever".
 */
function royaltyCapLine(address: Address, capBps: number, rateBps: number | null): string {
  const cap = `${capBps / 100}%`;
  const tail = '(ceiling — owner-set at deploy, reduce-only)';
  if (rateBps === null || capBps <= rateBps) {
    return `${cap} ${dim(`${tail} — locked to the current rate: this royalty can never rise`)}`;
  }
  return (
    `${cap} ${dim(tail)}\n` +
    `                 ${dim(`↳ headroom: the rate is ${rateBps / 100}%, and the owner may raise it to ${cap} without asking anyone.`)}\n` +
    `                 ${dim(`  \`abx set-royalty-cap ${address} --cap ${rateBps}\` makes today's rate permanent.`)}`
  );
}

/**
 * Refuse an obsolete RPC variable before silently falling back to the public default. In the exact
 * failure this guards, ABX_RPC_URL held the reporter's dead endpoint, `state` ignored it, reached a
 * different node, and then described the contract instead of naming the misspelling. A valid
 * chain-specific or shared plural variable wins and suppresses this refusal.
 */
function assertNoIgnoredRpcEnv(address: Address, env: Record<string, string | undefined> = process.env): void {
  const chainVariable = rpcEnvVar(CHAIN);
  if (!env.ABX_RPC_URL || env.ABX_RPC_URLS || env[chainVariable]) return;
  throw new Error(
    `ABX_RPC_URL (singular) is set but is not read. Rename it to ${chainVariable} or ABX_RPC_URLS; ` +
      `refusing to ignore an RPC setting while reading ${address}.`,
  );
}

/**
 * Distinguish "the RPC is down" from "this address isn't an ABX token" before contract reads.
 * This catches endpoints that cannot answer even a head query; the required-getter diagnostics
 * below separately catch nodes that answer block/code probes but refuse `eth_call`.
 */
async function assertRpcReachable(publicClient: PublicClient, address: Address): Promise<void> {
  try {
    await publicClient.getBlockNumber();
  } catch {
    throw new Error(
      `could not reach the ${CHAIN} RPC (check ${rpcEnvVar(CHAIN)} or ABX_RPC_URLS).` +
        ` This is not a fact about ${address}.`,
    );
  }
}

type StateRead<T> = {value: T; error?: undefined} | {value?: undefined; error: unknown};

async function diagnosticStateRead<T>(
  publicClient: PublicClient,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<StateRead<T>> {
  try {
    const value = (await publicClient.readContract({address, abi, functionName, args} as never)) as T;
    return {value};
  } catch (error) {
    return {error};
  }
}

async function describeMissingAbxState(
  publicClient: PublicClient,
  address: Address,
  requiredReadErrors: readonly unknown[],
): Promise<string> {
  let code: string | undefined;
  try {
    code = await publicClient.getCode({address});
  } catch {
    return (
      `could not read ${address} on ${CHAIN} — the RPC failed mid-call ` +
      `(check ${rpcEnvVar(CHAIN)} or ABX_RPC_URLS).`
    );
  }
  if (!code || code === '0x') {
    return `no code at ${address} on ${CHAIN} — not an ABX token, or the wrong chain.`;
  }
  if (requiredReadErrors.some(isRpcReadFailure)) {
    return (
      `could not read ABX state for ${address} on ${CHAIN} — the RPC answered block/code requests ` +
      `but failed eth_call (rate-limited or backend unhealthy; check ${rpcEnvVar(CHAIN)} or ABX_RPC_URLS). ` +
      `This is not a contract verdict.`
    );
  }
  return `${address} has code on ${CHAIN} but is not an ABX token (no usable owner/supply getters).`;
}

/**
 * What a `canonical: NO` actually costs, said once and shared by both state readouts.
 *
 * A contract deployed outside a trust anchor is a real, working NFT — this is not a failure — but the
 * one property it can never gain is the one platforms allowlist against, and it cannot be granted
 * later at any price: canonicity is fixed at deploy by WHICH contract created it. So the readout says
 * what was lost and what the only remedy is (redeploy through the factory, migrate holders), rather
 * than printing a bare "NO" the reader has to interpret.
 */
function warnNotCanonical(address: Address): void {
  warn(
    `${address} was not created by an ABX trust anchor, so ${bold('isAbxClone is false')} for it. It still works as ` +
      `an NFT, but nothing that allowlists ABX collections — marketplaces, the App Store, this toolkit's own ` +
      `provenance checks — can recognize it as one, and that cannot be added afterwards: canonicity is decided ` +
      `by which contract deployed it. The only remedy is a fresh deploy through ${bold('abx deploy')} / ` +
      `${bold('deploy-series')} / ${bold('deploy-code')} and moving holders to it. If this was deliberate ` +
      `(a bespoke contract, a superseded factory), nothing here is broken — just make sure whoever owns the ` +
      `project knows they chose it.`,
  );
}

// ── locks: the coherent "everything that can never be undone" summary ──────────────────────────
// Before this, `abx state` reported ONLY `paramHooks.locked`; script/dependency locks appeared
// solely in `verify` (and only for code projects), and token/contract-URI + field locks appeared
// nowhere in either command. A creator reading a green `paramHooks: frozen` line had no way to tell
// that four OTHER independent locks existed, let alone whether any of them were armed.

/** One boolean lock, tri-state: `true` (frozen forever) · `false` (open — the owner can still
 *  change it) · `null` (the read failed — an RPC refusal, or a wrong dialect). Never collapse
 *  `null` into `false`: an unread lock is not proof it's off, and `state`'s whole job here is to
 *  keep that distinction visible all the way to the JSON payload. */
type LockRead = boolean | null;

/**
 * The bounded field-lock scan: every field this node can enumerate is one
 * of the protocol registry's `METADATA_FIELD` keys (site/content/docs/protocol/metadata.mdx), read
 * with `contractFieldLocked`. A creator's own custom field (`stems`, `palette`, …) is a real,
 * independently-lockable key — but this node can only learn its NAME from the spine's
 * `ContractFieldLocked` event, which needs an indexer, not a bare head read. So this reports "none
 * of the STANDARD fields are locked", never "no fields are locked" — the caveat has to travel with
 * the data, not live only in a comment a caller never sees.
 */
async function readFieldLocks(
  publicClient: PublicClient,
  address: Address,
  abi: readonly unknown[],
): Promise<{field: string; locked: LockRead}[]> {
  return Promise.all(
    Object.values(METADATA_FIELD).map(async (field) => ({
      field,
      locked: (await tryReadContract<boolean>(publicClient, {address, abi, functionName: 'contractFieldLocked', args: [encodeTag(field)]})) ?? null,
    })),
  );
}

/** Every irreversible lock a collection can carry, as read straight from chain. */
export interface CollectionLocks {
  tokenURI: LockRead;
  contractURI: LockRead;
  /** The bounded METADATA_FIELD scan — see {@link readFieldLocks}'s doc for the caveat this carries. */
  fields: {field: string; locked: LockRead}[];
  /** `null` (the OBJECT, not the inner `locked`) ⇒ not applicable: this contract has no on-chain
   *  script surface at all (not a code project), a different fact from "unknown" ({@link LockRead}'s
   *  `null`), which is reserved for "the surface exists but the read failed". */
  script: {locked: LockRead} | null;
  dependencies: {locked: LockRead} | null;
}

/**
 * Read every applicable irreversible lock for one collection: token/contract URI config, the
 * bounded standard field set, and — for a code project — the script and dependency freezes.
 * `paramHooks.locked` is deliberately NOT read here: `cmdStateBody`/`cmdStateEditionBody` already
 * read it (`readParamHooksLocked`) as part of the existing param-hooks readout, and re-reading it
 * would cost a second `eth_call` for a fact already on hand — see the callers, which pass it into
 * {@link printLocks} instead.
 *
 * `isCode` gates `scriptLocked`/`dependenciesLocked`: those getters exist ONLY on the two code
 * twins (SeriesCode/EditionCode), so asking a plain image/Series contract for them isn't a failed
 * read to report as "unknown" — it's a surface that was never there, reported as `null` (not
 * applicable) via the OUTER object rather than the boolean inside it.
 */
export async function readCollectionLocks(
  publicClient: PublicClient,
  address: Address,
  abi: readonly unknown[],
  isCode: boolean,
): Promise<CollectionLocks> {
  const read = <T>(fn: string): Promise<T | undefined> => tryReadContract<T>(publicClient, {address, abi, functionName: fn});
  const [tokenURI, contractURI, fields, script, dependencies] = await Promise.all([
    read<boolean>('tokenURILocked'),
    read<boolean>('contractURILocked'),
    readFieldLocks(publicClient, address, abi),
    isCode ? read<boolean>('scriptLocked') : Promise.resolve(undefined),
    isCode ? read<boolean>('dependenciesLocked') : Promise.resolve(undefined),
  ]);
  return {
    tokenURI: tokenURI ?? null,
    contractURI: contractURI ?? null,
    fields,
    script: isCode ? {locked: script ?? null} : null,
    dependencies: isCode ? {locked: dependencies ?? null} : null,
  };
}

/** One lock's human verdict — the same three words everywhere this prints, so a reader learns the
 *  vocabulary once. */
function lockVerdict(locked: LockRead): string {
  return locked === true
    ? `${c.green}frozen${c.reset}`
    : locked === false
      ? `${c.orange}unlocked${c.reset}`
      : dim('unknown (node refused the check)');
}

/**
 * Print + emit the "Locks" section shared by both `state` bodies (721 and edition) — the one
 * coherent summary, in place of a lone `paramHooks.locked` line. Every lock is its
 * own independent switch (freezing one does nothing to any other), which is easy to miss when each
 * only ever appeared alone — so the header says so explicitly, and every line names the exact
 * command that freezes THAT lock and nothing else.
 */
function printLocks(
  address: Address,
  locks: CollectionLocks,
  hasParamHooks: boolean,
  paramHooksLock: boolean | undefined,
  payload: Record<string, unknown>,
  emit: (p: Record<string, unknown>) => void,
): void {
  const lockedFieldNames = locks.fields.filter((f) => f.locked === true).map((f) => f.field);
  const unknownFieldCount = locks.fields.filter((f) => f.locked === null).length;
  payload.locks = jsonSafe({
    tokenURI: locks.tokenURI,
    contractURI: locks.contractURI,
    script: locks.script,
    dependencies: locks.dependencies,
    // `null` ⇒ no ConfigurableParams surface on this contract (not a code project) — matching the
    // `script`/`dependencies` null-means-N/A convention rather than reusing LockRead's "unknown".
    paramHooks: hasParamHooks ? (paramHooksLock ?? null) : null,
    fields: {
      // The bounded scan, keyed by name — automation gets the same three-way distinction the human
      // line does (true/false/null), never a collapsed "none locked".
      checked: locks.fields,
      note: "checks only the standard METADATA_FIELD set (site/content/docs/protocol/metadata.mdx); a project's own custom field keys are real and independently lockable but are NOT enumerated here — that needs an indexer over ContractFieldLocked events.",
    },
  });
  emit(payload);

  console.log(`\n  ${bold('Locks')}  ${dim('each is INDEPENDENT — freezing one does nothing to the others')}`);
  info(`tokenURI       ${lockVerdict(locks.tokenURI)}   ${dim(`\`abx lock-uri ${address}\` freezes the pointer + renderer forever`)}`);
  info(`contractURI    ${lockVerdict(locks.contractURI)}   ${dim(`\`abx lock-uri ${address} --collection\` freezes the pointer + renderer forever`)}`);
  if (locks.script) info(`script         ${lockVerdict(locks.script.locked)}   ${dim(`\`abx lock-script ${address}\` freezes the program bytes forever`)}`);
  if (locks.dependencies) info(`dependencies   ${lockVerdict(locks.dependencies.locked)}   ${dim(`\`abx lock-dependencies ${address}\` freezes the library set forever`)}`);
  if (hasParamHooks) info(`param hooks    ${lockVerdict(paramHooksLock ?? null)}   ${dim(`\`abx lock-param-hooks ${address}\` freezes all three hook addresses forever (detail above)`)}`);
  info(
    lockedFieldNames.length
      ? `fields         ${c.green}locked${c.reset}: ${lockedFieldNames.join(', ')}`
      : `fields         ${dim('none of the standard fields are locked')}`,
  );
  info(
    dim(
      `               checked the standard METADATA_FIELD set only (${locks.fields.length} keys${unknownFieldCount ? `, ${unknownFieldCount} unreadable` : ''}) — a custom field key is real and lockable but not enumerable without an indexer. ` +
        `\`abx lock-field ${address} --field <name> [--collection | --token 0]\` freezes one.`,
    ),
  );
}

export async function cmdState(address: Address | undefined, flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx state <address>  — a read-only, on-chain operational snapshot\n');
    process.exitCode = 1;
    return;
  }
  // `--json` emits the same facts as data, so programs never need to parse prose. The human
  // narration below is unchanged and rides stderr under --json.
  return withJson(flags, async (emit) => cmdStateBody(address, flags, emit));
}

export async function cmdStateBody(
  address: Address,
  flags: Flags,
  emit: (p: Record<string, unknown>) => void,
): Promise<void> {
  assertNoIgnoredRpcEnv(address);
  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertRpcReachable(publicClient, address);
  // Edition family branches to its own (leaner) readout — supply/maxSupply are per-id, so "supply
  // X/Y minted" (a whole-contract fact on a 721) doesn't generalize; see cmdStateEditionBody.
  const kind = await detectTokenKind(publicClient, address);
  if (kind.isEdition) return cmdStateEditionBody(address, publicClient, kind, emit);
  // getter absent (extension not composed) or contract has no code → undefined, never a throw.
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T | undefined> =>
    tryReadContract<T>(publicClient, {address, abi: STATE_ABI, functionName, args});

  const [ownerRead, totalSupplyRead, nextTokenId, maxInvocations, paused, minter, primaryPayee, renderer, royalty, creatorToken, transferValidator, seedSource] = await Promise.all([
    diagnosticStateRead<Address>(publicClient, address, STATE_ABI, 'owner'),
    diagnosticStateRead<bigint>(publicClient, address, STATE_ABI, 'totalSupply'),
    read<bigint>('nextTokenId'),
    read<bigint>('maxInvocations'),
    read<boolean>('paused'),
    read<Address>('minter'),
    read<Address>('primaryPayee'),
    read<Address>('tokenURIRenderer'),
    read<readonly [Address, bigint]>('royaltyInfo', [0n, 10_000n]),
    read<boolean>('supportsInterface', [CREATOR_TOKEN_INTERFACE_ID]),
    read<Address>('getTransferValidator'),
    read<Address>('seedSource'),
  ]);
  const owner = ownerRead.value;
  const totalSupply = totalSupplyRead.value;
  if (owner === undefined && totalSupply === undefined) {
    throw new Error(
      await describeMissingAbxState(publicClient, address, [ownerRead.error, totalSupplyRead.error]),
    );
  }
  // Trust, not just shape. Everything above is readable off ANY ERC-721-ish address, so without this
  // `state` described a hand-rolled contract exactly as confidently as a canonical clone. Canonicity
  // is what platforms allowlist and it can never be added after deploy, so it belongs in the snapshot.
  const provenance = await verifyProvenance(publicClient, address, resolveChain(CHAIN).id);
  const isCanonical = provenance.canonical;
  const isSeries = maxInvocations !== undefined; // series-only getter
  const addrOrNone = (a?: Address): string => (a && a !== zeroAddress ? a : dim('none'));
  // The payload mirrors what is printed, with `undefined` (getter absent) kept distinct from a zero
  // address (present and deliberately unset) — collapsing those is what makes a readout lie.
  const zeroToNull = (a?: Address) => (a === undefined ? null : a === zeroAddress ? null : a);
  const {maxRoyaltyBps: royaltyCap, burnable} = await readCollectionPolicy(publicClient, address);
  const payload: Record<string, unknown> = jsonSafe({
    address,
    chain: CHAIN,
    chainId: resolveChain(CHAIN).id,
    type: isSeries ? 'series' : '1of1',
    canonical: isCanonical, // tri-state: true | false | null (couldn't check) — never collapse it
    // Provenance, not just trust: WHICH generation of the anchors stamped this clone, and the core
    // version it therefore reports. `prior` is "canonically ABX, older" — a different fact from
    // `canonical: false`, which the two used to share.
    abxGeneration: provenance.generation,
    abxCoreVersion: provenance.coreVersion,
    owner: owner ?? null,
    totalSupply: totalSupply ?? null,
    nextTokenId: nextTokenId ?? null,
    maxInvocations: maxInvocations ?? null,
    paused: paused ?? null,
    minter: zeroToNull(minter),
    primaryPayee: zeroToNull(primaryPayee),
    tokenURIRenderer: zeroToNull(renderer),
    onChainTokenUri: !!(renderer && renderer !== zeroAddress),
    royalty: royalty ? {receiver: royalty[0], bps: Number(royalty[1])} : null,
    royaltyCap,
    burnable,
    creatorToken: !!creatorToken,
    transferValidator: creatorToken ? zeroToNull(transferValidator) : null,
    // `undefined` (no extension — an image token) and `0x0` (a code project that opted out) are
    // different facts; the JSON keeps them apart the same way every other getter here does.
    seedSource: zeroToNull(seedSource),
    hasSeedSource: seedSource !== undefined,
    // `enumerable: false` means "no governed keys were FOUND", never "none exist" — a legacy /
    // pre-enumeration / non-canonical contract can hold real PostParams this node cannot list at
    // all. Kept apart from `governed` so a reader cannot collapse "confirmed empty" and "unprovable"
    // into the same silence.
    params: {governed: [] as unknown[], contractScopeSet: [] as string[], enumerable: true},
  });
  emit(payload);

  console.log(bold(`\n  ${isSeries ? 'Series' : '1/1'} state`) + dim(`  ${address} · ${CHAIN}`));
  info(`canonical      ${canonicalLabel(isCanonical, provenance)}`);
  if (isCanonical === false) warnNotCanonical(address);
  info(`owner          ${owner ?? dim('?')}`);
  if (isSeries) {
    // Fully minted (totalSupply == maxInvocations) ⇒ fixed supply exhausted: the collection is
    // COMPLETE and `unpause` is moot (nothing left for anyone to mint). Say so, so a fully-minted
    // paused series doesn't read as "unfinished, go unpause".
    const soldOut = totalSupply !== undefined && maxInvocations !== undefined && totalSupply >= maxInvocations;
    info(`supply         ${totalSupply ?? 0n} / ${maxInvocations} minted   ${dim(soldOut ? '(complete — fixed supply fully minted)' : `(nextTokenId ${nextTokenId ?? 0n})`)}`);
    info(`paused         ${paused ? `${c.orange}true${c.reset}  ${dim(soldOut ? '— moot: all tokens minted, nothing left to mint' : '— owner-only minting until `abx unpause`')}` : `false ${dim('— open to minter/public')}`}`);
    info(`minter         ${addrOrNone(minter)}${minter && minter !== zeroAddress ? '' : dim('  (owner-only)')}`);
    info(`primary payee  ${addrOrNone(primaryPayee)}`);
  } else {
    info(`supply         ${totalSupply ?? 0n} / 1 minted`);
  }
  if (royalty) info(`royalty        ${Number(royalty[1]) / 100}% → ${royalty[0]}`);
  if (royaltyCap !== null) info(`royalty cap    ${royaltyCapLine(address, royaltyCap, royalty ? Number(royalty[1]) : null)}`);
  if (burnable !== null) info(`burnable       ${burnable ? `${c.orange}true${c.reset} ${dim('— holders may burn their own token')}` : dim('false — no token can be destroyed')}`);
  info(`renderer       ${renderer && renderer !== zeroAddress ? `on-chain (${renderer})` : dim('off-chain (stored URI base / override)')}`);
  // ERC-721C: shown ONLY for an enrolled collection — an unenrolled token is a plain ERC-721
  // (indistinguishable from a pre-721C token) and shows nothing new here.
  if (creatorToken) {
    info(
      `721C validator ${transferValidator && transferValidator !== zeroAddress ? transferValidator : `${c.orange}suspended${c.reset} ${dim('(zero — enforcement off; re-enable with `abx set-transfer-validator`)')}`}`,
    );
  }
  if (seedSource !== undefined) info(`seed source    ${describeSeedSource(seedSource)}`);
  // The PostParam surface, read straight from chain: `paramSchemaKeys()` is the DECLARED (governed)
  // set — append-only, and it includes keys declared but never yet written, which nothing off-chain
  // could otherwise discover — and `contractParamKeys()` is the collection-scope set values. Both
  // are maintained by the contract's own write paths, so there is no list to drift. Read-only,
  // best-effort, and skipped entirely for a project that has none (a 1/1, a legacy pre-enumeration
  // project, or a code project with no params).
  // Hoisted above the try block: the Locks section (printed after it, see `printLocks`) reuses
  // whatever this reads rather than paying for a second `eth_call` on the same fact.
  let hooks: Awaited<ReturnType<typeof readParamHooks>> = null;
  let paramHooksLock: boolean | undefined;
  try {
    const rawKeys = await readParamSchemaKeys(publicClient, address);
    const enumerable = rawKeys !== null;
    const keys = rawKeys ?? [];
    const rows = keys.length
      ? await Promise.all(keys.map(async (key: string) => ({key, s: await readParamSchema(publicClient, address, key)})))
      : [];
    const governed = rows.filter((r) => r.s.exists);
    const now = Math.floor(Date.now() / 1000);
    (payload.params as Record<string, unknown>).enumerable = enumerable;
    (payload.params as Record<string, unknown>).governed = jsonSafe(
      governed.map(({key, s}) => ({
        key,
        // Canonical NAMES, not the raw enum indices — a caller must not have to know the Solidity
        // enum's ordering to read this (the same reason `retired` is a boolean below).
        paramType: PARAM_TYPES[s.paramType] ?? String(s.paramType),
        auth: AUTH_OPTIONS[s.auth] ?? String(s.auth),
        authAddress: s.authAddress === zeroAddress ? null : s.authAddress,
        lockAfter: s.lockAfter,
        // A past lockAfter IS how a param is retired — surfaced as a boolean so a caller doesn't
        // have to re-derive the convention from a timestamp.
        retired: s.lockAfter !== 0 && s.lockAfter < now,
        selectOptions: s.selectOptions,
      })),
    );
    emit(payload);
    if (governed.length) {
      console.log(`\n  ${bold('PostParams')}  ${dim(`${governed.length} governed · collectors/creator set these; the generator injects them`)}`);
      for (const {key, s} of governed) {
        const retired = s.lockAfter !== 0 && s.lockAfter < now;
        const locks = s.lockAfter !== 0 && !retired ? dim(`  locks ${new Date(s.lockAfter * 1000).toISOString().slice(0, 10)}`) : '';
        const tag = retired ? `  ${c.orange}retired${c.reset}${dim(' — writes revert')}` : locks;
        console.log(`    ${describeSchema({key, paramType: s.paramType, auth: s.auth, authAddress: s.authAddress, lockAfter: 0, min: s.min, max: s.max, selectOptions: s.selectOptions})}${tag}`);
      }
    } else if (!enumerable) {
      // NOT "no PostParams" — this contract predates (or never implemented) the enumeration
      // extension, so `paramSchemaKeys()` itself is unreadable. Zero governed keys found here is
      // not proof zero exist; say so plainly rather than printing nothing, which reads as "confirmed
      // none" to a creator about to lock.
      console.log(
        `\n  ${bold('PostParams')}  ${c.orange}cannot be enumerated on this contract${c.reset} ${dim('(pre-enumeration or non-canonical) — this does NOT prove none exist, only that this node could not list them')}`,
      );
    }

    // Collection-scope values (every token sees these). `seed` is per-token and never enumerated —
    // it is a tokenData coordinate, read directly.
    const set = await readSetParamKeys(publicClient, address);
    if (set?.contract.length) {
      (payload.params as Record<string, unknown>).contractScopeSet = [...set.contract].sort();
      emit(payload);
      info(`${dim('contract-scope params set:')} ${[...set.contract].sort().join(', ')} ${dim('(apply to every token)')}`);
    }

    // The hooks, and whether they can still change. This is a BUYER's read, which is why it lives in
    // `state` next to the validator rather than only in `verify`: the transfer hook is a veto over
    // transfers and mints, so "which hooks, and are they frozen" is exactly the pair someone needs
    // before buying. Printed whenever the surface exists — including with all three unset, because
    // "none, and frozen" is the strongest thing this line can say and it must be visible.
    hooks = await readParamHooks(publicClient, address);
    if (hooks) {
      paramHooksLock = await readParamHooksLocked(publicClient, address);
      const shown = ([['configure', hooks.configureHook], ['augment', hooks.augmentHook], ['transfer', hooks.transferHook]] as const)
        .filter(([, a]) => a !== zeroAddress)
        .map(([role, a]) => `${role} ${a}`);
      (payload.params as Record<string, unknown>).hooks = jsonSafe({
        configureHook: hooks.configureHook === zeroAddress ? null : hooks.configureHook,
        augmentHook: hooks.augmentHook === zeroAddress ? null : hooks.augmentHook,
        transferHook: hooks.transferHook === zeroAddress ? null : hooks.transferHook,
        // `null` = could not be established (see readParamHooksLocked). Never collapse it to false:
        // "unknown" and "the owner can still arm a transfer veto" are different answers.
        locked: paramHooksLock ?? null,
      });
      emit(payload);
      const lockNote =
        paramHooksLock === true
          ? `${c.green}frozen${c.reset} ${dim('— no hook address can ever change again')}`
          : paramHooksLock === false
            ? `${c.orange}not frozen${c.reset} ${dim('— the owner can re-point these (`abx lock-param-hooks` freezes them forever)')}`
            : dim('freeze state unknown (the node refused the check)');
      info(`param hooks    ${shown.length ? shown.join(' · ') : dim('none set')}   ${lockNote}`);
      if (hooks.transferHook !== zeroAddress) {
        info(dim(`               the transfer hook is a VETO: if it reverts, the transfer fails — and mints too (mint = transfer from 0x0).`));
      }
    }
  } catch {
    /* best-effort — a non-code project has no params surface to read */
  }

  // The coherent lock summary — every irreversible switch this node can read, side
  // by side, independent of whether this project happens to compose the params surface above.
  const locks = await readCollectionLocks(publicClient, address, STATE_ABI, kind.kind === 'code');
  printLocks(address, locks, !!hooks, paramHooksLock, payload, emit);
  console.log('');
}

/**
 * The edition (ERC-1155) half of {@link cmdStateBody}: `owner`/`paused`/`minter`/`primaryPayee`/
 * `royalty`/`renderer` are the SAME facts, read the SAME way (shared, unchanged function names);
 * what differs is supply — there's no whole-contract `totalSupply()`, only a per-id one, so the
 * headline is id #0's copies (the flagship OneOfOneEdition case, and a representative sample for
 * EditionImage/EditionCode) with a pointer at `abx tokens` for the full per-id breakdown.
 */
async function cmdStateEditionBody(
  address: Address,
  publicClient: PublicClient,
  kind: TokenKindInfo,
  emit: (p: Record<string, unknown>) => void,
): Promise<void> {
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T | undefined> =>
    tryReadContract<T>(publicClient, {address, abi: EDITION_STATE_ABI, functionName, args});

  const [ownerRead, maxInvocations, paused, minter, primaryPayee, renderer, royalty, creatorToken, transferValidator, seedSource] = await Promise.all([
    diagnosticStateRead<Address>(publicClient, address, EDITION_STATE_ABI, 'owner'),
    read<bigint>('maxInvocations'), // absent on a 1/1-edition — its id space is fixed to {0}
    read<boolean>('paused'),
    read<Address>('minter'),
    read<Address>('primaryPayee'),
    read<Address>('tokenURIRenderer'),
    read<readonly [Address, bigint]>('royaltyInfo', [0n, 10_000n]),
    read<boolean>('supportsInterface', [CREATOR_TOKEN_INTERFACE_ID]),
    read<Address>('getTransferValidator'),
    read<Address>('seedSource'),
  ]);
  const owner = ownerRead.value;
  if (owner === undefined) {
    throw new Error(await describeMissingAbxState(publicClient, address, [ownerRead.error]));
  }
  const [supply0, maxSupply0, provenance] = await Promise.all([
    read<bigint>('totalSupply', [0n]),
    read<bigint>('maxSupply', [0n]),
    verifyProvenance(publicClient, address, resolveChain(CHAIN).id), // the edition twin owes the same answer
  ]);
  const isCanonical = provenance.canonical;

  const addrOrNone = (a?: Address): string => (a && a !== zeroAddress ? a : dim('none'));
  const zeroToNull = (a?: Address) => (a === undefined ? null : a === zeroAddress ? null : a);
  const {maxRoyaltyBps: royaltyCap, burnable} = await readCollectionPolicy(publicClient, address);
  const payload: Record<string, unknown> = jsonSafe({
    address,
    chain: CHAIN,
    chainId: resolveChain(CHAIN).id,
    type: kind.kind,
    canonical: isCanonical, // tri-state, same as the 721 readout
    abxGeneration: provenance.generation,
    abxCoreVersion: provenance.coreVersion,
    owner: owner ?? null,
    maxInvocations: maxInvocations ?? null,
    supply0: supply0 ?? null,
    maxSupply0: maxSupply0 ?? null,
    paused: paused ?? null,
    minter: zeroToNull(minter),
    primaryPayee: zeroToNull(primaryPayee),
    tokenURIRenderer: zeroToNull(renderer),
    onChainTokenUri: !!(renderer && renderer !== zeroAddress),
    royalty: royalty ? {receiver: royalty[0], bps: Number(royalty[1])} : null,
    royaltyCap,
    burnable,
    creatorToken: !!creatorToken,
    transferValidator: creatorToken ? zeroToNull(transferValidator) : null,
    seedSource: zeroToNull(seedSource),
    hasSeedSource: seedSource !== undefined,
    params: {governed: [] as unknown[], contractScopeSet: [] as string[], enumerable: true},
  });
  emit(payload);

  console.log(bold(`\n  ${describeKind(kind)} state`) + dim(`  ${address} · ${CHAIN}`));
  info(`canonical      ${canonicalLabel(isCanonical, provenance)}`);
  if (isCanonical === false) warnNotCanonical(address);
  info(`owner          ${owner ?? dim('?')}`);
  const capNote = (cap?: bigint) => (cap !== undefined && cap > 0n ? `${cap} cap` : 'open — no cap');
  if (kind.kind === '1of1-edition') {
    info(`supply         ${supply0 ?? 0n} cop${(supply0 ?? 0n) === 1n ? 'y' : 'ies'} of #0   ${dim(`(${capNote(maxSupply0)})`)}`);
  } else {
    info(`id space       up to ${maxInvocations ?? '?'} distinct id(s)`);
    info(`#0 copies      ${supply0 ?? 0n}   ${dim(`(${capNote(maxSupply0)} — per-id breakdown: \`abx tokens ${address}\`)`)}`);
  }
  info(`paused         ${paused ? `${c.orange}true${c.reset}  ${dim('— owner-only minting until `abx unpause`')}` : `false ${dim('— open to minter/public')}`}`);
  info(`minter         ${addrOrNone(minter)}${minter && minter !== zeroAddress ? '' : dim('  (owner-only)')}`);
  info(`primary payee  ${addrOrNone(primaryPayee)}`);
  if (royalty) info(`royalty        ${Number(royalty[1]) / 100}% → ${royalty[0]}`);
  if (royaltyCap !== null) info(`royalty cap    ${royaltyCapLine(address, royaltyCap, royalty ? Number(royalty[1]) : null)}`);
  if (burnable !== null) info(`burnable       ${burnable ? `${c.orange}true${c.reset} ${dim('— holders may burn their own token')}` : dim('false — no token can be destroyed')}`);
  info(`renderer       ${renderer && renderer !== zeroAddress ? `on-chain (${renderer})` : dim('off-chain (stored URI base / override)')}`);
  // ERC-1155C: shown ONLY for an enrolled collection — same rule (and same interface id) as 721C.
  if (creatorToken) {
    info(
      `1155C validator ${transferValidator && transferValidator !== zeroAddress ? transferValidator : `${c.orange}suspended${c.reset} ${dim('(zero — enforcement off; re-enable with `abx set-transfer-validator`)')}`}`,
    );
  }
  if (seedSource !== undefined) info(`seed source    ${describeSeedSource(seedSource)}`);
  // EditionCode has the same ConfigurableParams surface as SeriesCode. Keep the JSON shape and
  // human readout identical; ERC-1155 changes ownership semantics, not param discoverability.
  try {
    const rawKeys = await readParamSchemaKeys(publicClient, address);
    const enumerable = rawKeys !== null;
    const rows = rawKeys?.length
      ? await Promise.all(rawKeys.map(async (key: string) => ({key, s: await readParamSchema(publicClient, address, key)})))
      : [];
    const governed = rows.filter((r) => r.s.exists);
    const now = Math.floor(Date.now() / 1000);
    (payload.params as Record<string, unknown>).enumerable = enumerable;
    (payload.params as Record<string, unknown>).governed = jsonSafe(
      governed.map(({key, s}) => ({
        key,
        paramType: PARAM_TYPES[s.paramType] ?? String(s.paramType),
        auth: AUTH_OPTIONS[s.auth] ?? String(s.auth),
        authAddress: s.authAddress === zeroAddress ? null : s.authAddress,
        lockAfter: s.lockAfter,
        retired: s.lockAfter !== 0 && s.lockAfter < now,
        selectOptions: s.selectOptions,
      })),
    );
    emit(payload);
    if (governed.length) {
      console.log(`\n  ${bold('PostParams')}  ${dim(`${governed.length} governed · shared by every copy of an id`)}`);
      for (const {key, s} of governed) {
        const retired = s.lockAfter !== 0 && s.lockAfter < now;
        const locks = s.lockAfter !== 0 && !retired ? dim(`  locks ${new Date(s.lockAfter * 1000).toISOString().slice(0, 10)}`) : '';
        const tag = retired ? `  ${c.orange}retired${c.reset}${dim(' — writes revert')}` : locks;
        console.log(`    ${describeSchema({key, paramType: s.paramType, auth: s.auth, authAddress: s.authAddress, lockAfter: 0, min: s.min, max: s.max, selectOptions: s.selectOptions})}${tag}`);
      }
    } else if (!enumerable) {
      console.log(`\n  ${bold('PostParams')}  ${c.orange}cannot be enumerated on this contract${c.reset} ${dim('(pre-enumeration or non-canonical) — this does NOT prove none exist')}`);
    }
    const set = await readSetParamKeys(publicClient, address);
    if (set?.contract.length) {
      (payload.params as Record<string, unknown>).contractScopeSet = [...set.contract].sort();
      emit(payload);
      info(`${dim('contract-scope params set:')} ${[...set.contract].sort().join(', ')} ${dim('(apply to every id)')}`);
    }
  } catch {
    /* best-effort — image edition families have no params surface */
  }
  // EditionCode composes ConfigurableParams exactly like SeriesCode, so an edition has hooks too —
  // and the transfer hook's veto reaches a mint, which on this lane is a buyer picking an id. Report
  // the same pair as the 721 body (which hooks, and whether they can still change); silent for the
  // image/1-of-1 edition twins, which have no params surface at all.
  const hooks = await readParamHooks(publicClient, address);
  let paramHooksLock: boolean | undefined;
  if (hooks) {
    paramHooksLock = await readParamHooksLocked(publicClient, address);
    const shown = ([['configure', hooks.configureHook], ['augment', hooks.augmentHook], ['transfer', hooks.transferHook]] as const)
      .filter(([, a]) => a !== zeroAddress)
      .map(([role, a]) => `${role} ${a}`);
    (payload.params as Record<string, unknown>).hooks = jsonSafe({
      configureHook: hooks.configureHook === zeroAddress ? null : hooks.configureHook,
      augmentHook: hooks.augmentHook === zeroAddress ? null : hooks.augmentHook,
      transferHook: hooks.transferHook === zeroAddress ? null : hooks.transferHook,
      locked: paramHooksLock ?? null, // null = unknown; never collapse it to false
    });
    emit(payload);
    const lockNote =
      paramHooksLock === true
        ? `${c.green}frozen${c.reset} ${dim('— no hook address can ever change again')}`
        : paramHooksLock === false
          ? `${c.orange}not frozen${c.reset} ${dim('— the owner can re-point these (`abx lock-param-hooks` freezes them forever)')}`
          : dim('freeze state unknown (the node refused the check)');
    info(`param hooks    ${shown.length ? shown.join(' · ') : dim('none set')}   ${lockNote}`);
    if (hooks.transferHook !== zeroAddress) {
      info(dim(`               the transfer hook is a VETO: if it reverts, the transfer fails — and mints too (mint = transfer from 0x0).`));
    }
  }

  // The coherent lock summary — see cmdStateBody's identical call for why.
  const locks = await readCollectionLocks(publicClient, address, EDITION_STATE_ABI, kind.kind === 'edition-code');
  printLocks(address, locks, !!hooks, paramHooksLock, payload, emit);
  console.log('');
}

/**
 * `abx status [address] [--remote [name|url]] [--watch]` — INDEXING status: where a project sits in
 * the lifecycle (`queued | backfilling | live | stale | failed`) and how far behind head it is.
 *
 * One vocabulary for both sides of the membrane, which is the point: bare = this node, `--remote` =
 * ask the service, and the same five words either way. Distinct from `abx state <address>`, which
 * reads the CHAIN (owner, royalty, locks) and knows nothing about who is serving it.
 */
export async function cmdStatus(address: Address | undefined, flags: Flags) {
  // `abx status --remote <name>` has no address — without this guard the flag itself lands in
  // rest[0] and gets sent as the address path segment (the same guard every other command applies).
  if (address?.startsWith('--')) address = undefined;
  const remote = remoteFlag(flags);
  if (remote) return cmdStatusRemote(address, remote, flags);
  const indexer = localIndexer();
  const regs = indexer.store.listRegistrations();
  if (address) {
    const reg = indexer.store.getRegistration(address);
    if (!reg) throw new Error(`${address} isn't tracked by this node. Add it with \`abx add ${address}\`, or ask a service: \`abx status ${address} --remote <name>\``);
    const s = indexer.getProject(address);
    const row = indexer.indexStatus(address);
    const head = indexer.store.getMeta(`watch:${reg.chainKey}:head`);
    // Don't print the address twice when there's no name to lead with.
    console.log(s?.name ? `\n  ${bold(s.name)}  ${dim(address)}` : `\n  ${bold(address)}`);
    statusRow(
      'status',
      statusLine({
        chainId: resolveChain(reg.chainKey).id,
        address,
        status: row.status,
        fromBlock: reg.fromBlock,
        toBlock: s?.toBlock ?? null,
        headBlock: head,
        eventCount: s?.eventCount ?? 0,
        tokenCount: s?.tokens.length ?? 0,
        mintedCount: 0,
        reconstructedAt: s?.reconstructedAt ?? null,
        ...(row.errorClass ? {error: {class: row.errorClass, message: row.errorMessage ?? undefined}} : {}),
      }),
    );
    statusRow('floor', `${reg.fromBlock}${row.attempts ? dim(`   attempts ${row.attempts}`) : ''}`);
    statusRow('indexed', s ? `${s.eventCount} events · ${s.tokens.length} token(s) ${dim(`· ${s.reconstructedAt}`)}` : dim('no projection yet'));
    if (!head) statusRow('head', dim("unknown — this node isn't watching the chain (ABX_WATCH_INTERVAL_MS=0, or `abx serve` isn't running)"));
    console.log('');
    return;
  }
  console.log(bold(`\n  ABX self-host node`));
  info(`chain: ${CHAIN} · factory: ${factoryAddress() ?? 'none'} · storage: ${activeBackendId()} · data: ${indexer.store.path}`);
  if (regs.length === 0) {
    console.log(dim('\n  No projects yet. `abx demo` to create one.\n'));
    return;
  }
  console.log('');
  for (const reg of regs) {
    const s = indexer.getProject(reg.address as Address);
    const st = indexer.indexStatus(reg.address as Address).status;
    const mark = st === 'failed' || st === 'stale' ? `${c.orange}●${c.reset}` : s ? g('●') : dim('○');
    const tail = s ? `${s.eventCount} events` : dim('(registered, not indexed)');
    console.log(`  ${mark} ${s?.name ?? reg.address}  ${dim(reg.address)}  ${tail}  ${statusLabel(st)}`);
  }
  console.log(dim(`\n  one project in detail: abx status <address>\n`));
}

/** The `--remote` half of {@link cmdStatus}: one project, or the roll-up for every project the token
 *  can see. `--watch` tails until everything reaches a terminal state. */
export async function cmdStatusRemote(address: Address | undefined, remote: RemoteTarget, flags: Flags) {
  requireRemoteToken(remote);
  const client = serviceClient(remote);
  const chainId = resolveChain(CHAIN).id;
  const watch = flags.watch !== undefined;
  const spec = remote.name ? remote.name.toLowerCase() : remote.source === 'default' ? '' : remote.url;
  info(`${bold('REMOTE')} → ${remote.url}  ${dim('(indexing status as the service reports it)')}`);
  if (address) {
    for (;;) {
      let s: RemoteProjectStatus;
      try {
        s = await client.projectStatus(chainId, address);
      } catch (err) {
        throw describeRemoteError(err, remote, 'remote status');
      }
      console.log(`\n  ${bold(address)}`);
      statusRow('status', statusLine(s));
      statusRow('floor', `${s.fromBlock}${s.attempts ? dim(`   attempts ${s.attempts}`) : ''}`);
      statusRow('indexed', `${s.eventCount} events · ${s.tokenCount} token(s)${s.reconstructedAt ? dim(` · ${s.reconstructedAt}`) : ''}`);
      // Spell out what `watching` means on the line itself; a bare `no` does not say whether it is a
      // problem (it usually is not).
      if (s.watcher) {
        statusRow(
          'watching',
          s.watcher.watching
            ? `${g('yes')}${s.watcher.head ? dim(` · head ${s.watcher.head}`) : ''}${dim(' — it tails new blocks, so on-chain changes land on their own')}`
            : `${dim('no')} ${dim('— this service updates on an explicit add/index, not by tailing new blocks (normal for many providers)')}`,
        );
      }
      // Don't leave a creator staring at a red word with no next move. `failed` especially reads as
      // terminal when it isn't — name what it means and the one command that follows it.
      if (!watch && s.status !== 'live') {
        if (s.status === 'failed' && s.error) statusRow('what now', indexErrorAction(s.error.class));
        statusRow('follow', dim(`this is not final — ${bold(`abx status ${address} --remote${spec ? ` ${spec}` : ''} --watch`)} tails it until it settles`));
      }
      console.log('');
      if (!watch || s.status === 'live' || s.status === 'failed') return;
      await sleep(3000);
    }
  }
  for (;;) {
    let projects;
    try {
      projects = await client.listProjects();
    } catch (err) {
      throw describeRemoteError(err, remote, 'remote status');
    }
    if (projects.length === 0) {
      console.log(dim('\n  no projects visible to this token\n'));
      return;
    }
    console.log('');
    for (const p of projects) {
      console.log(
        `  ${g('●')} ${p.name ?? p.label ?? p.address}  ${dim(p.address)}  ` +
          `${p.status ? statusLabel(p.status) : dim('status not reported')}` +
          `${p.error ? ` ${c.orange}${p.error.class}${c.reset}` : ''}  ${dim(`${p.tokenCount ?? '?'} token(s)`)}`,
      );
    }
    console.log(`\n  ${rollUp(projects)}\n`);
    const settled = projects.every((p) => !p.status || p.status === 'live' || p.status === 'failed');
    if (!watch || settled) return;
    await sleep(3000);
  }
}

// ── forget ────────────────────────────────────────────────────────────────--
// Drop a project this node tracks (registration + projection) — for cleaning up
// test/junk deploys. On-chain data is untouched; `abx add` can re-register it.
export async function cmdForget(address: Address | undefined, flags: Flags) {
  if (!address || address.startsWith('--')) {
    console.error('usage: abx forget <address> [--remote [name|url]]\n');
    process.exitCode = 1;
    return;
  }
  const remote = remoteFlag(flags);
  if (remote) {
    requireRemoteToken(remote);
    info(`${bold('REMOTE')} → ${remote.url}  ${dim('(deregistering on the remote resolver — NOT this machine)')}`);
    let removed: boolean;
    try {
      ({removed} = await serviceClient(remote).removeProject(resolveChain(CHAIN).id, address));
    } catch (err) {
      throw describeRemoteError(err, remote, 'remote forget');
    }
    if (removed) ok(`remote resolver forgot ${address} — it will stop serving it. On-chain data is untouched.`);
    else console.log(dim(`  ${address} wasn't registered on ${remote.url} — nothing to forget.`));
    return;
  }
  const indexer = localIndexer();
  if (!indexer.store.getRegistration(address)) {
    console.log(dim(`  ${address} isn't tracked by this node — nothing to forget.`));
    return;
  }
  indexer.store.deregister(address);
  ok(`forgot ${address} — dropped its registration + projection. On-chain data is untouched.`);
}
