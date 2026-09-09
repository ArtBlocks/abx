/**
 * Owner operations — the writes that *operate* a project after it's born:
 * sell/transfer, re-point its resolver, change royalties, update or freeze
 * content, hand over admin. Each builds an unsigned tx with the SDK and runs it
 * through the signing harness (hot / wallet / cold lane), then re-indexes so the
 * served state reflects the change. The agent picks the lane; the human only
 * approves (wallet lane) or it's the env key (hot lane).
 */
import {
  MAX_ROYALTY_BPS,
  assertChainId,
  ensureChunkStore as sdkEnsureChunkStore,
  type ChunkStoreEvent,
  predictFixedPriceMinter,
  predictFixedPriceMinter1155,
  makeHotSender,
  makePublicClient,
  makeWalletClient,
  oneOfOneImageAbi,
  oneOfOneEditionAbi,
  seriesImageAbi,
  deployFixedPriceMinter,
  deployFixedPriceMinter1155,
  prepareConfigureSale,
  prepareConfigureSale1155,
  preparePurchase,
  preparePurchase1155,
  readSaleConfig,
  readSaleConfig1155,
  prepareEditionMint,
  prepareEditionTransfer,
  prepareSetMaxSupply,
  preparePingURI,
  prepareLockContractField,
  prepareLockContractURI,
  prepareLockTokenField,
  prepareLockTokenURI,
  prepareMint,
  mintedTokenIds,
  prepareSeriesMintMany,
  prepareSetMinter,
  prepareSetMaxInvocations,
  prepareSetPrimaryPayee,
  prepareSetPaused,
  prepareSetContractField,
  prepareSetContractURIBase,
  prepareSetContractURIOverride,
  prepareSetContractURIRenderer,
  prepareSetParamHooks,
  prepareSetParamSchema,
  prepareRetireParam,
  readParamSchema,
  type OnChainParamSchema,
  PARAM_TYPES,
  prepareSetRoyalty,
  prepareReduceMaxRoyaltyBps,
  prepareSetTokenField,
  batchOps,
  prepareSetTokenURIBase,
  prepareSetTokenURIOverride,
  prepareSetTokenURIRenderer,
  prepareSetTransferValidator,
  prepareSetSeedSource,
  probeSeedSource,
  readSeedSource,
  type SeedSourceProbe,
  predictSeedSource,
  getDeployment,
  prepareTransfer,
  prepareTransferOwnership,
  probeTransferValidator,
  readCreatorTokenStatus,
  resolveRecommendedTransferValidator,
  RECOMMENDED_TRANSFER_VALIDATOR,
  KNOWN_CHAIN_KEYS,
  resolveChain,
  resolveRpcUrl,
  redactRpcUrl,
  type SendTx,
  encodeTag,
  METADATA_FIELD as F,
  METADATA_REPRESENTATION as R,
  type Address,
  type Hex,
  type PublicClient,
  type OnChainFieldInput,
  type PreparedTx,
  stageFieldContent,
  planStagedContent,
  exceedsOnchainSoftLimit,
  classifyOnchainReadSize,
  tokenUriGasEstimate,
  ONCHAIN_IMAGE_SOFT_LIMIT,
  ONCHAIN_PROJECT_SOFT_LIMIT,
  ONCHAIN_READ_WARN_BYTES,
  ETH_CALL_GAS_FLOOR,
  readableBytesAtGas,
  probeBestEthCallGasCap,
  type Compress,
  type ContentPlan,
  type StagingEvent,
} from '@artblocks/abx-sdk';
import {
  encodeScalarParam,
  encodeTag as encodeTagSdk,
  isAccepted,
  prepareConfigureTokenParam,
  prepareConfigureTokenParamData,
  prepareSetContractParam,
  prepareSetContractParamData,
  seriesCodeAbi,
  tryReadContract,
  type ParamTypeName,
} from '@artblocks/abx-sdk';
import {hasParamEnumeration, GATEWAY_FIELD, GATEWAY_FLOOR, gatewayPrefixFrom, readCollectionPolicy, readEnv} from '@artblocks/abx-sdk';
import {
  decodeFieldRenderer,
  encodeFieldRenderer,
  resolveGenerator,
  DEP_RESOLUTION,
  parseDependencyRef,
  prepareLockDependencies,
  prepareLockParamHooks,
  prepareLockScript,
  prepareRemoveLastDependency,
  prepareSetDependency,
  prepareSetDependencyRegistry,
} from '@artblocks/abx-sdk';
import {
  planScriptReplace,
  prepareRemoveLastScriptChunk,
  prepareSetScriptChunk,
  verifyScriptReplace,
  type ScriptChunkReader,
} from '@artblocks/abx-sdk';
import {contentTypeFromPath} from '@artblocks/abx-storage';
import {toHex as toHexSdk} from 'viem';
import {existsSync, readFileSync} from 'node:fs';
import {basename, resolve as resolvePath} from 'node:path';
import {gzipSync} from 'node:zlib';
import {formatEther, getAddress, hexToBytes, isAddress, parseEther, toHex, zeroAddress} from 'viem';
import {backendResolution, CHAIN, chainId, chunkStoreAddress, fixedPriceMinterAddress, fixedPriceMinter1155Address, localIndexer} from './config.js';
import {CliError} from './errors.js';
import {detectTokenKind, describeKind, isEditionContract, assertHasParamsSurface, hasParamsSurface} from './kind.js';
import {planOnChainScript} from './script-chunks.js';
import {fetchServedTokenUri, servedOk} from './served.js';
import {openWalletSession, type SignResult, type TxProvider, type WalletSession} from './signer.js';
import {gatedSend, laneFromFlags} from './riskgate.js';
import {withJson} from './jsonout.js';
import {resolveRemote, serviceClient} from './remote.js';
import {isDryRun, positionalArgs, unknownFlags, warnStrayFlags} from './flags.js';
import {parseSchemaSpecs, describeSchema, type ParsedSchema} from './schema.js';

// Re-exported for main.ts (the on-chain-vs-off-chain cost model + the compression-mode type now
// live in the SDK's staging.ts, layered on planChunks/planContentTxs — see the comment at their
// definition below).
export {ONCHAIN_PROJECT_SOFT_LIMIT, ONCHAIN_READ_WARN_BYTES, ETH_CALL_GAS_FLOOR, tokenUriGasEstimate, readableBytesAtGas, type Compress};

// ── ANSI (local) ─────────────────────────────────────────────────────────────
const C = {reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[38;5;115m', yellow: '\x1b[38;5;221m', red: '\x1b[31m'};
const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const green = (s: string) => `${C.green}${s}${C.reset}`;
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`;
const bold = (s: string) => `${C.bold}${s}${C.reset}`;
const red = (s: string) => `${C.red}${s}${C.reset}`;

type Flags = Record<string, string | undefined>;

// ── data plane: attach files, and the keys you can't set by hand ──────────────
// A token anchors named, typed files ("artifacts"). The served JSON's `artifacts` list is the
// COMPLETE set — but it's COMPUTED by the resolver/renderer from the token's fields + effect
// outputs; it is never a field you set. These keys are that computed output, so setting them by
// hand would only pollute the manifest with a bogus entry (a real round-1 agent trap). Refuse them
// and point at the real verb. `abx_params` stays in this set even though spec v8 removed the
// projection from `tokenURI`: the name is now free, which makes it MORE attractive as a decoy field
// and no more meaningful than before. Params are chain state; a field of that name would be a
// hand-set impostor of a read that lives on the contract. See site/content/docs/protocol/data-plane.mdx + site/content/docs/protocol/metadata.mdx.
const COMPUTED_FIELD_KEYS = new Set<string>(['artifacts', 'abx_params', 'abx_provenance']);
export function assertSettableField(field: string): void {
  // The gateway keys ARE stored in the field store, but every way to get them wrong is silent: a
  // token-scope write (a gateway is one answer per project, so nothing reads it), a representation
  // other than `inline` (ignored), or a prefix missing its trailing path (`https://ipfs.io` + a CID
  // is a 404 nobody attributes to this command). So the generic verb refuses and names the one that
  // enforces all three, rather than warning and letting the write land.
  if (field === GATEWAY_FIELD.ipfs || field === GATEWAY_FIELD.arweave) {
    const network = field === GATEWAY_FIELD.ipfs ? 'ipfs' : 'arweave';
    throw new Error(
      `"${field}" is a serving preference, not a metadata field — set it with the command that validates it:\n` +
        `    abx set-gateway <address> --${network} ${GATEWAY_FLOOR[network]}\n` +
        `  (collection scope, \`inline\`, and a prefix that ends in its path — set-field would let you get all three wrong silently.)`,
    );
  }
  if (COMPUTED_FIELD_KEYS.has(field)) {
    const what =
      field === 'artifacts'
        ? "the COMPUTED manifest (the complete list of this token's files), assembled by the resolver/renderer from your fields"
        : field === 'abx_params'
          ? "a reserved name, not a field — params are chain state read straight off the contract (set one with `abx configure-param`, declare one with `abx set-schema`)"
          : 'the COMPUTED provenance list, assembled by the resolver/renderer';
    throw new Error(
      `"${field}" is not a field you set — it's ${what}.` +
        (field === 'abx_params'
          ? `\n  Set a param instead:\n    abx configure-param <address> <tokenId|-> <key> <value>\n  (or attach a FILE under your own key: abx attach <address> <yourkey> <ipfs://… | ar://… | https://…>)`
          : ` To attach a file so it appears in the manifest, pick your OWN key:\n    abx attach <address> <yourkey> <ipfs://… | ar://… | https://…>`),
    );
  }
}

/** Whether a value fits the literal `bytes32` lane of a raw contract-param write (printable ASCII,
 *  ≤ 31 bytes). Anything longer takes the data path — one blob, its hash evented. */
function fitsLiteralBytes32(value: string): boolean {
  return value.length <= 31 && /^[\x20-\x7e]+$/.test(value);
}

/** Flags `abx attach` recognizes — anything else warns (non-fatal), so a silent no-op flag surfaces. */
const ATTACH_FLAGS = ['file', 'compress', 'collection', 'token', 'send', 'sign', 'unsigned', 'yes', 'dry-run', 'confirm', 'port', 'sign-url-file', 'remote'];

/**
 * The flags EVERY owner write accepts, regardless of command — the signing lane (`laneFromFlags`),
 * the opt-in confirm gate, the wallet-lane plumbing, the post-write reindex nudge, and `--json`.
 * Factored out so a per-command allowlist below only has to name that command's OWN flags.
 */
const SHARED_WRITE_FLAGS = ['send', 'sign', 'unsigned', 'dry-run', 'yes', 'confirm', 'port', 'sign-url-file', 'remote', 'remote-token', 'json'];

/**
 * Per-command allowlists for the owner ops where a silently-ignored flag changes MONEY or SUPPLY.
 *
 * These commands took no stray-flag notice at all, and the ERC-1155 lane made that expensive: an
 * edition's semantics live in its OPTIONAL flags, which default rather than fail. A typo'd
 * `--amount 50` minted 1 copy; a typo'd `--quantity 5` bought 1 and paid 1×; and nothing said a word.
 * (`deploy` refuses strays outright, but its allowlists are exhaustively maintained. Here we WARN —
 * per `unknownFlags`' own contract and the owner's scriptability line: a false warning on a valid
 * flag must never break someone's script, and a warning already ends the silence.)
 */
const MINT_FLAGS = [...SHARED_WRITE_FLAGS, 'to', 'count', 'token-id', 'amount'];
const TRANSFER_FLAGS = [...SHARED_WRITE_FLAGS, 'to', 'token', 'token-id', 'amount', 'from'];
const SET_MAX_SUPPLY_FLAGS = [...SHARED_WRITE_FLAGS, 'token-id', 'cap'];
const MINTER_CONFIGURE_FLAGS = [...SHARED_WRITE_FLAGS, 'price', 'price-raw', 'allocation', 'erc20', 'token-id', 'minter-contract'];
const MINTER_SHOW_FLAGS = [...SHARED_WRITE_FLAGS, 'token-id', 'minter-contract'];
const MINTER_BUY_FLAGS = [...SHARED_WRITE_FLAGS, 'to', 'token-id', 'quantity', 'minter-contract'];

/** Auto-detect the on-chain representation for an off-chain locator by its URI scheme. Returns null
 *  for anything that isn't a recognized durable/http locator (so `attach` can refuse it loudly
 *  rather than silently storing a bad value — the round-1 `--representation` guessing trap). */
export function representationForLocator(uri: string): string | null {
  const u = uri.trim();
  if (/^ipfs:\/\//i.test(u)) return R.ipfs;
  if (/^ar:\/\//i.test(u)) return R.arweave;
  if (/^https?:\/\//i.test(u)) return R.url;
  return null;
}

function requireAddress(address: string | undefined, usage: string): Address {
  if (!address || address.startsWith('--')) {
    console.error(`usage: ${usage}\n`);
    throw new CliError('', 1, true); // already printed above — see CliError's alreadyPrinted doc
  }
  return address as Address;
}

function requireFlag(flags: Flags, name: string, usage: string): string {
  const v = flags[name];
  if (!v || v === 'true') {
    console.error(`missing --${name}\nusage: ${usage}\n`);
    throw new CliError('', 1, true); // already printed above — see CliError's alreadyPrinted doc
  }
  return v;
}

/**
 * Every owner-op's send choke point. Returns the {@link SignResult} when a tx was broadcast, else
 * `null` (dry run, or the cold lane which prints a tx instead of sending one).
 *
 * It used to return a bare boolean. It returns the result now because a caller sometimes needs the
 * *receipt* — `abx mint --json` has to report which token id was actually minted, and the only
 * authoritative answer is the Transfer log the mint emitted. Callers that only asked "did it send?"
 * keep working: `null` is falsy, and a result object is truthy.
 *
 * The dry-run preview / `--confirm` prompt / lane selection live in {@link gatedSend} — the SAME
 * choke point the deploy family's resumed-setup send routes through — so this is now just "gate,
 * then re-index if the project is known."
 */
async function runWrite(address: Address, provider: TxProvider, flags: Flags, expectedSigner?: Address): Promise<SignResult | null> {
  const result = await gatedSend(provider, flags, {chainKey: CHAIN, expectedSigner});
  if (!result) return null; // dry run, or the cold lane — nothing broadcast
  await reindexIfKnown(address, flags);
  return result;
}

async function reindexIfKnown(address: Address, flags: Flags): Promise<void> {
  const indexer = localIndexer();
  if (indexer.store.getRegistration(address)) {
    const {state, elapsedMs} = await indexer.reindex(address);
    console.log(`  ${green('✓')} re-indexed ${state.name ?? address}: ${state.eventCount} events in ${elapsedMs}ms`);
  } else {
    console.log(dim(`  (not indexed by this node — run \`abx add ${address}\` then \`abx index\` to serve it)`));
  }
  // Remote-resolver nudge. A remote resolver serves from ITS OWN store, so the LOCAL reindex above
  // never reaches it: after an owner-op — especially a PostParam change — it stays stale, and its
  // effect runner never sees the new inputsHash, so the marketplace thumbnail never auto-updates.
  // `--remote <name|url>` re-indexes the remote resolver (incremental), which pings its effect
  // runner (ABX_EFFECTS_URL) → the automatic re-render. This is what makes a remote
  // `configure-param` a one-command change (no separate `abx index --remote` + no stale thumbnail).
  // Best-effort BY DESIGN: the signed tx already landed, so a missing token soft-skips (a hard
  // error here would turn an on-chain success into a CLI failure) — worse only than stale-until-reindex.
  const remote = resolveRemote(flags.remote, flags['remote-token'] as string | undefined);
  if (!remote) return;
  if (!remote.token) {
    console.log(dim(`  (--remote: set ${remote.tokenVar} in .env to nudge ${remote.url}; skipped — it will serve stale state until it re-indexes)`));
    return;
  }
  try {
    // no fromBlock ⇒ incremental nudge
    const r = await serviceClient(remote).registerProject({chainId: chainId(), address});
    // A deferred nudge (202) is NOT waited on here: the signed tx has already landed, and blocking a
    // completed owner-op behind someone else's backfill would be the wrong trade. Say where it got to.
    if (isAccepted(r)) {
      console.log(
        `  ${green('✓')} nudged remote resolver ${dim(remote.url)}: ${r.project.status} — it will pick up the change (check: abx status ${address} --remote ${flags.remote})`,
      );
    } else {
      console.log(`  ${green('✓')} nudged remote resolver ${dim(remote.url)}: ${r.project.eventCount} events (${r.mode}) — its effect runner picks up the change`);
    }
  } catch (e) {
    console.log(dim(`  (couldn't nudge ${remote.url}: ${(e as Error).message} — run \`abx index ${address} --remote ${flags.remote}\` to refresh it)`));
  }
}

async function read<T>(address: Address, functionName: string, args: unknown[] = []): Promise<T> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const result = await tryReadContract<T>(publicClient, {address, abi: oneOfOneImageAbi, functionName, args});
  if (result !== undefined) return result;
  // A read that "returned no data" is usually not a real revert but an address with NO CONTRACT —
  // previewing before deploy, a typo'd address, or the wrong chain. Every owner-op reads the
  // owner/ownerOf here FIRST, so this one guard turns the opaque viem error into an actionable one
  // across all of them. Only runs on the error path (zero cost when the contract exists).
  await assertContractExists(address);
  // The contract DOES exist → a genuine revert. tryReadContract already swallowed that error, so
  // re-read once (uncaught) to surface it rather than a generic "read failed".
  return (await publicClient.readContract({
    address,
    abi: oneOfOneImageAbi,
    functionName: functionName as never,
    args: args as never,
  })) as T;
}

/** Throw a clear, actionable error when `address` has no contract on the active chain — the common
 *  cause of an owner-op's raw `returned no data ("0x")`. No-op when code is present or unknowable. */
export async function assertContractExists(address: Address): Promise<void> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  let code: string | undefined;
  try {
    code = await publicClient.getCode({address});
  } catch {
    return; // can't check (RPC issue) → let the caller's original error surface
  }
  if (!code || code === '0x') {
    throw new Error(
      `no contract at ${address} on ${CHAIN} — nothing to operate on. Owner ops run AFTER deploy: ` +
        `deploy it first (e.g. abx deploy / deploy-series / deploy-code), or check the address and that ` +
        `ABX_CHAIN='${CHAIN}' is the right network — we asked ${redactRpcUrl(resolveRpcUrl(CHAIN))}, and a ` +
        `wrong-network endpoint reads as empty even when the address is right.`,
    );
  }
}


// ── configure-param ──────────────────────────────────────────────────────────
/**
 * `abx configure-param <address> <tokenId> <key> <value>` — set a schema-governed
 * PostParam through the typed path, any lane. Reads the key's on-chain schema first
 * and canonically ENCODES the human input per its type (`#rrggbb`, decimals ×1e10,
 * Select by label, …); `String`/`Bytes` schemas take the value as UTF-8 (or
 * `--file <path>` for bytes) via the data path. The signer must satisfy the schema's
 * auth (Creator = contract owner, TokenOwner — delegate.xyz honored — or the named
 * address); the chain enforces it either way.
 */
/** Positional args only — drops `--flags` AND the single token each value-taking flag consumes
 *  (mirrors parseFlags). `rest.filter(r => !r.startsWith('--'))` was NOT enough: a flag's VALUE
 *  (e.g. the URL after `--remote`, or the path after `--file`) isn't `--`-prefixed, so it leaked
 *  into the positional value (`configure-param … #ff0000 --remote http://h` → value "#ff0000 http://h"). */
/**
 * Encode a command-line value for a payload-typed param (`String` / `Bytes`).
 *
 * `String` is UTF-8 text — the literal characters are the value, which is what a user means.
 *
 * `Bytes` is NOT text, and the old code UTF-8'd whatever string it was handed. A tester passed
 * base64 (the encoding the params docs mention — which describes the *canonical decode* a program
 * receives, not what you type here), and 128 packed bytes were stored as 172 bytes of base64 ASCII.
 * Nothing errored; the in-chain renderer read ASCII where it expected bytes and drew garbage. So a
 * `Bytes` value must state its encoding: `0x…` hex, or `--file` for real binary. A bare string is
 * refused rather than guessed at — there is no safe guess between "these characters" and "these
 * bytes", and the failure is invisible until a work renders wrong.
 */
export function encodePayloadParam(typeName: 'String' | 'Bytes', valueInput: string, key: string): Hex {
  if (typeName === 'String') return toHexSdk(new TextEncoder().encode(valueInput));
  const v = valueInput.trim();
  if (/^0x[0-9a-fA-F]*$/.test(v)) {
    if (v.length % 2 !== 0) {
      throw new Error(`--${key} hex value has an odd number of digits (${v.length - 2}) — a byte is two hex digits.`);
    }
    return v as Hex;
  }
  throw new Error(
    `"${key}" is a Bytes param, so its value must say what its bytes ARE — this looks like text.\n` +
      `  Pass 0x-prefixed hex:   abx configure-param <addr> <id> ${key} 0x00112233…\n` +
      `  Or the bytes in a file: abx configure-param <addr> <id> ${key} --file ./payload.bin\n` +
      `  (Base64 is how a Bytes param is DECODED for your program — not how you write it here. ` +
      `Storing base64 text would put ASCII on-chain where a renderer expects bytes, silently. ` +
      `To store these literal characters on purpose, declare the key as String instead.)`,
  );
}

export async function cmdConfigureParam(address: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const usage = 'abx configure-param <address> <tokenId|-> <key> <value> [--file <path>] [--remote [url]] [--sign|--unsigned]   (tokenId "-" = contract scope, schema-less keys only)';
  const contract = requireAddress(address, usage);
  const [tokenIdRaw, key, ...valueParts] = positionalArgs(rest);
  const valueInput = valueParts.join(' ');
  if (!tokenIdRaw || !key || (!valueInput && !flags.file)) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }

  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertHasParamsSurface(publicClient, contract, 'abx configure-param');
  const schema = (await publicClient.readContract({
    address: contract,
    abi: seriesCodeAbi,
    functionName: 'paramSchema',
    args: [encodeTagSdk(key)],
  })) as [boolean, number, number, Address, number, Hex, Hex, string[]];
  const [exists, paramTypeIdx, , , , , , selectOptions] = schema;

  // Contract scope (`-`): the raw owner setters (`setContractParam[Data]`) — the write path of
  // well-known contract params like `display.animation`. Schema-less keys only: a schema'd key closes
  // the raw path on-chain (`SchemaGoverned`) and is per-token by design. No key is special here: a
  // contract param is enumerated on-chain like any other and lands in tokenData for every token.
  if (tokenIdRaw === '-') {
    if (exists) {
      throw new Error(
        `"${key}" is schema-governed — it's a per-token PostParam (abx configure-param ${contract} <tokenId> ${key} …). ` +
          'Contract-scope raw params are owner-set and schema-less.',
      );
    }
    const owner = await read<Address>(contract, 'owner');
    const cid = chainId();
    if (flags.file && flags.file !== 'true') {
      const data = toHexSdk(new Uint8Array(readFileSync(flags.file)));
      await runWrite(contract, prepareSetContractParamData({contract, key, data, chainId: cid}), flags, owner);
      return;
    }
    // Printable ASCII ≤ 31 chars rides as a literal readable bytes32; anything longer takes the
    // data path (one blob, hash evented).
    if (fitsLiteralBytes32(valueInput)) {
      console.log(`  ${key} (contract scope) ← "${valueInput}"  ${dim('(literal bytes32; owner-only raw setter)')}`);
      await runWrite(contract, prepareSetContractParam({contract, key, value: encodeTagSdk(valueInput), display: valueInput, chainId: cid}), flags, owner);
    } else {
      console.log(`  ${key} (contract scope) ← ${valueInput.length} chars  ${dim('(data-backed; owner-only raw setter)')}`);
      await runWrite(contract, prepareSetContractParamData({contract, key, data: toHexSdk(new TextEncoder().encode(valueInput)), chainId: cid}), flags, owner);
    }
    return;
  }

  const tokenId = BigInt(tokenIdRaw);
  if (!exists) {
    throw new Error(
      `no PostParam schema for "${key}" on ${contract}. Declare one — at deploy with ` +
        `abx deploy-code … --schema ${key}:<Type>:<Auth>, or right now on the live contract with ` +
        `abx set-schema ${contract} --schema ${key}:<Type>:<Auth>  (e.g. ${key}:HexColor:TokenOwner).`,
    );
  }
  const typeName = (['Bool','Select','Uint256Range','Int256Range','DecimalRange','HexColor','Timestamp','String','Bytes'] as const)[paramTypeIdx] as ParamTypeName;

  let sent: SignResult | null;
  if (typeName === 'String' || typeName === 'Bytes') {
    const data = flags.file
      ? toHexSdk(new Uint8Array(readFileSync(flags.file)))
      : encodePayloadParam(typeName, valueInput, key);
    const bytes = (data.length - 2) / 2;
    // Echo the DECODED byte count. The old code echoed the string's length, which is precisely how a
    // wrong encoding announced itself and was missed: 128 packed bytes passed as base64 printed
    // "172 bytes".
    console.log(`  ${key} (${typeName}) ← ${bytes} bytes  ${dim(flags.file ? '(file contents, verbatim)' : typeName === 'Bytes' ? '(decoded from hex)' : '(UTF-8 text)')}`);
    sent = await runWrite(contract, prepareConfigureTokenParamData({contract, tokenId, key, data, chainId: chainId()}), flags);
  } else {
    const {value, display} = encodeScalarParam(typeName, valueInput, [...selectOptions]);
    // The canonical `display` can silently differ from what was typed (HexColor accepts a bare
    // `ff7f50` and normalizes to `#ff7f50`; a Select index resolves to its label; a hex digit's case
    // can flip) — say so rather than silently correcting a value.
    const normalized = display !== valueInput.trim() ? `  ${dim(`(normalized from "${valueInput}")`)}` : '';
    console.log(`  ${key} (${typeName}) ← ${display}${normalized}  ${dim('(canonical encode; the chain enforces schema + auth)')}`);
    sent = await runWrite(contract, prepareConfigureTokenParam({contract, tokenId, key, value, display, chainId: chainId()}), flags);
  }

  if (sent) {
    // What happens to the IMAGE depends on how it's produced. If the `image` field is computed
    // on-chain (a `renderer` representation — the in-chain SVG lane), it re-tints AUTOMATICALLY: the
    // renderer reads the param live, so tokenURI's image is already updated, nothing to re-render.
    // Otherwise the image is an off-chain rendered STILL that re-addresses to a new inputsHash → it's
    // stale until re-rendered (a running resolver+runner or `--remote` auto-catches it; a no-resolver
    // drop has no watcher → re-render by hand). This is the "I changed palette, why is it stale?" moment.
    if (!flags.remote) {
      let imageOnChain = false;
      try {
        const res = (await publicClient.readContract({address: contract, abi: seriesCodeAbi, functionName: 'contractField', args: [encodeTag('image')]})) as readonly [string, string];
        imageOnChain = String(res[0]).toLowerCase() === String(encodeTag('renderer')).toLowerCase();
      } catch { /* advisory — never fail the write over a field read */ }
      if (imageOnChain) {
        console.log(`  ${dim('the on-chain image re-tints automatically from this param — nothing to re-render (the renderer reads it live; tokenURI is already updated).')}`);
      } else {
        console.log(`  ${dim('live view updates now; the thumbnail still is stale until re-rendered (no resolver watcher = no auto-refresh):')} ${bold(`abx render ${contract} ${tokenIdRaw}`)}`);
      }
    }
  }
}

// ── set-param-hooks ────────────────────────────────────────────────────────────
const HOOK_ROLES = ['configure', 'augment', 'transfer'] as const;
type HookRole = (typeof HOOK_ROLES)[number];
const HOOK_NOTE: Record<HookRole, string> = {
  configure: 'write-time veto/validator (a configure tx reverts if it reverts)',
  augment: 'read-time derivation folded into tokenData (live view reads chain per view)',
  transfer: 'ownership-change VETO — its revert fails the transfer, and a mint too (mint = transfer from 0x0)',
};
const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Parse a hook-address flag: a 0x address, or `none`/`zero`/`0`/`0x0` to clear that role. */
export function parseHookAddress(role: HookRole, v: string): Address {
  const s = v.trim().toLowerCase();
  if (v === 'true' || v === '') throw new Error(`--${role} needs a value: a 0x address, or "none" to clear it`);
  if (s === 'none' || s === 'zero' || s === '0' || s === '0x0' || s === zeroAddress) return zeroAddress;
  if (!isAddress(v)) throw new Error(`--${role} must be a 0x address or "none" (to clear it) — got '${v}'`);
  return getAddress(v);
}

/**
 * `abx set-param-hooks <address> [--configure 0x|none] [--augment 0x|none] [--transfer 0x|none] [--clear]`
 * — wire (or clear) a SeriesCode/EditionCode project's three param-lifecycle hooks. The contract has NO per-hook
 * setter (`setParamHooks` writes all three at once), so this READS the current trio (`paramHooks()`)
 * and re-sends it with your changes applied: omit a role to KEEP it, pass an address to set it, or
 * `none` to clear it (`--clear` clears all three). Owner-only, any lane, guards `--dry-run`. Code kinds
 * only — static 1/1, Series, and edition kinds have no configurable params to hook. Bare (no flags) prints the current
 * hooks and does nothing.
 */
export async function cmdSetParamHooks(address: string | undefined, flags: Flags): Promise<void> {
  const usage =
    'abx set-param-hooks <address> [--configure 0x|none] [--augment 0x|none] [--transfer 0x|none] [--clear] [--sign|--unsigned] [--dry-run]';
  const contract = requireAddress(address, usage);
  const clearAll = flags.clear !== undefined;
  const roleFlags = HOOK_ROLES.filter((r) => flags[r] !== undefined);
  if (clearAll && roleFlags.length) {
    // Refuse the contradictory combo rather than silently pick one (enforce, don't warn).
    throw new Error(`--clear clears ALL three hooks; don't combine it with --${roleFlags.join('/--')}. Use either --clear, or per-role flags.`);
  }

  // Read the current trio FIRST — this doubles as the SeriesCode/EditionCode guard (paramHooks()
  // exists only on the ConfigurableParams extension; a static kind reverts "no data").
  const publicClient = makePublicClient({chainKey: CHAIN});
  let current: readonly [Address, Address, Address];
  try {
    current = (await publicClient.readContract({
      address: contract,
      abi: seriesCodeAbi,
      functionName: 'paramHooks',
    })) as readonly [Address, Address, Address];
  } catch (err) {
    await assertContractExists(contract); // no contract at all → the actionable no-contract error
    // Name the ACTUAL kind rather than assuming 721 — a 1/1-edition or EditionImage has no param
    // hooks either (only EditionCode composes ConfigurableParams, mirroring SeriesCode), so the old
    // blanket "a 1/1 or a plain Series" message misnamed an edition target's real kind.
    const kind = await detectTokenKind(publicClient, contract);
    throw new Error(
      `${contract} exposes no param hooks — the configure/augment/transfer hooks are a SeriesCode/EditionCode ` +
        `(PostParams) feature. ${kind.label} has no configurable params to hook.`,
    );
  }

  const cur: Record<HookRole, Address> = {configure: current[0], augment: current[1], transfer: current[2]};
  const label = (a: Address) => (eqAddr(a, zeroAddress) ? dim('none') : a);

  // Bare invocation: show the current hooks, mutate nothing.
  if (!clearAll && roleFlags.length === 0) {
    console.log(`  param hooks on ${contract}:`);
    for (const r of HOOK_ROLES) console.log(`    ${r.padEnd(10)} ${label(cur[r])}  ${dim(`(${HOOK_NOTE[r]})`)}`);
    console.log(dim(`\n  set one with e.g. \`${usage}\``));
    return;
  }

  // Read-modify-write: preserve each omitted role; a huge win is that changing ONE hook can't
  // silently zero the other two (the contract's all-at-once setter would, if fed blindly).
  const next: Record<HookRole, Address> = {
    configure: clearAll ? zeroAddress : flags.configure !== undefined ? parseHookAddress('configure', flags.configure) : cur.configure,
    augment: clearAll ? zeroAddress : flags.augment !== undefined ? parseHookAddress('augment', flags.augment) : cur.augment,
    transfer: clearAll ? zeroAddress : flags.transfer !== undefined ? parseHookAddress('transfer', flags.transfer) : cur.transfer,
  };
  if (HOOK_ROLES.every((r) => eqAddr(next[r], cur[r]))) {
    console.log(dim('  no change — the hooks already match. Nothing sent.'));
    return;
  }

  console.log(`  param hooks on ${contract}:`);
  for (const r of HOOK_ROLES) {
    const changed = !eqAddr(cur[r], next[r]);
    console.log(`    ${r.padEnd(10)} ${changed ? `${label(cur[r])} → ${label(next[r])}` : `${label(cur[r])} ${dim('(unchanged)')}`}`);
  }
  // Arming a transfer hook is the one hook change with a consequence for COLLECTORS, so say it at
  // the moment of arming rather than only in the docs. It is not a warning against doing it — an
  // owner-dependent work needs it — it is the disclosure that comes with it.
  if (!eqAddr(next.transfer, zeroAddress) && !eqAddr(next.transfer, cur.transfer)) {
    console.log(`  ${bold('the transfer hook is a VETO:')} if it reverts, the transfer fails. It also runs on mint and burn (mint = transfer from 0x0), so a reverting hook stops minting for this project too — including through the shared minter.`);
    console.log(dim(`    that is a standing power over whether a collector can sell. Disclose it, and if you want to prove you will never arm one, \`abx lock-param-hooks ${contract}\` freezes all three addresses forever.`));
  }
  const owner = await read<Address>(contract, 'owner');
  await runWrite(
    contract,
    prepareSetParamHooks({contract, configureHook: next.configure, augmentHook: next.augment, transferHook: next.transfer, chainId: chainId()}),
    flags,
    owner,
  );
}

// ── dependencies (code projects) ──────────────────────────────────────────────
// The ordered library declarations of a template-mode code project (Dependencies
// extension) — index 0 = the runtime, by convention; the list stays dense. Owner-only;
// each runs through the same signing lanes + re-index as every other owner op.

/**
 * `abx set-dependency <address> <index> <ref>` — declare/replace the dependency at an
 * index. The ref auto-detects: `name@version` (e.g. `p5@1.0.0` — resolves through the
 * collection's soft registry pointer) or `0x…` (an on-chain data contract, read directly).
 * The chain enforces density (index ≤ dependencyCount) and the lock.
 */
export async function cmdSetDependency(address: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const usage = 'abx set-dependency <address> <index> <ref>   (ref: name@version | 0x<data-contract>) [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const [indexRaw, refRaw] = positionalArgs(rest);
  if (indexRaw === undefined || !refRaw) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }
  if (!/^\d+$/.test(indexRaw)) throw new Error(`<index> must be a non-negative integer (got '${indexRaw}') — the list is dense: index ≤ dependencyCount`);
  const dep = parseDependencyRef(refRaw);
  console.log(
    dim(
      `  dependency [${indexRaw}] ← ${dep.display} (${dep.resolution === DEP_RESOLUTION.registry ? 'registry name@version — resolves through the registry pointer' : 'on-chain data contract — read directly'})${indexRaw === '0' ? ' · index 0 = the runtime, by convention' : ''}`,
    ),
  );
  const owner = await read<Address>(contract, 'owner');
  await runWrite(
    contract,
    prepareSetDependency({contract, index: BigInt(indexRaw), resolution: dep.resolution, ref: dep.ref, display: dep.display, chainId: chainId()}),
    flags,
    owner,
  );
}

/** `abx remove-last-dependency <address>` — pop the LAST dependency (the list stays dense;
 *  to replace one in place, `set-dependency` at its index instead). */
export async function cmdRemoveLastDependency(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx remove-last-dependency <address> [--sign|--unsigned]');
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareRemoveLastDependency({contract, chainId: chainId()}), flags, owner);
}

/** `abx set-dependency-registry <address> <registry>` — point (or clear, with `none`) the
 *  soft, non-validating registry pointer the project's `name@version` refs resolve through. */
export async function cmdSetDependencyRegistry(address: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const usage = 'abx set-dependency-registry <address> <0x…|none> [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const [raw] = positionalArgs(rest);
  if (!raw) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }
  if (raw !== 'none' && !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`<registry> must be an address (0x + 40 hex) or 'none' to clear; got '${raw}'`);
  }
  const registry = (raw === 'none' ? zeroAddress : raw) as Address;
  console.log(dim('  the pointer is SOFT and non-validating — it disambiguates resolution; the declared refs stay either way.'));
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetDependencyRegistry({contract, registry, chainId: chainId()}), flags, owner);
}

/** `abx lock-dependencies <address>` — freeze the dependency set (list + registry pointer) forever. */
export async function cmdLockDependencies(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx lock-dependencies <address> [--sign|--unsigned]');
  const owner = await read<Address>(contract, 'owner');
  console.log(dim('  note: locking the dependency set is permanent and irreversible (list AND registry pointer freeze).'));
  console.log(dim("  this pins WHICH library each ref means, not the library's bytes: a Registry ref is fetched from the registry on every read, so those bytes stay in the registry owner's hands."));
  await runWrite(contract, prepareLockDependencies({contract, chainId: chainId()}), flags, owner);
}

/** `abx lock-script <address>` — freeze the on-chain program (script chunks) forever. This is the
 *  lock that actually freezes the WORK of a code project: after it, `setScriptChunk` /
 *  `removeLastScriptChunk` revert. `lock-field`/`lock-uri` only freeze metadata; the full set for a
 *  code drop is lock-script + lock-dependencies + lock-field/lock-uri — which freezes what THIS
 *  contract stores, not necessarily what the token renders (params have no lock, and a Registry
 *  dependency's bytes live in the registry). */
export async function cmdLockScript(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx lock-script <address> [--sign|--unsigned]');
  const owner = await read<Address>(contract, 'owner');
  console.log(dim('  note: locking the script is permanent and irreversible (the program bytes can never change again).'));
  console.log(dim('  this freezes the WORK — pair with lock-dependencies and lock-field/lock-uri to freeze everything this contract stores.'));
  console.log(dim('  that is not the same as a frozen OUTPUT: params stay writable and a Registry dependency is re-fetched live, so say "locked metadata" to a buyer, not "immutable".'));
  await runWrite(contract, prepareLockScript({contract, chainId: chainId()}), flags, owner);
}

/** Flags `abx replace-script` recognizes — anything else warns (non-fatal). */
const REPLACE_SCRIPT_FLAGS = [...SHARED_WRITE_FLAGS, 'script', 'chunk-size'];

/** A `ScriptChunkReader` backed by a real chain read — the only place `replace-script` touches
 *  `seriesCodeAbi` directly, so `planScriptReplace`/`verifyScriptReplace` themselves stay chain-free
 *  and testable (see packages/sdk/src/script-chunks.ts). `scriptChunk` returns `null` on a revert
 *  (an index at/past the CURRENT on-chain count) rather than throwing — exactly what both SDK
 *  functions expect for "nothing stored here yet". */
function chainScriptReader(contract: Address): ScriptChunkReader {
  const client = makePublicClient({chainKey: CHAIN});
  return {
    scriptChunkCount: async () => Number(await client.readContract({address: contract, abi: seriesCodeAbi, functionName: 'scriptChunkCount'})),
    scriptChunk: async (index) => {
      try {
        return (await client.readContract({address: contract, abi: seriesCodeAbi, functionName: 'scriptChunk', args: [BigInt(index)]})) as Hex;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The `gasFloor` `replace-script` restates for its batched multicall (see the call site's own
 * comment for WHY it restates rather than sums the per-op values `prepareSetScriptChunk` already
 * computes). This used to be `writeByteCounts.reduce((sum, n) => sum + n * 200, 0)` — code-deposit
 * cost alone, mirroring `prepareSetScriptChunk`'s own per-chunk floor exactly.
 *
 * A funded on-chain sweep found that number 49% below what a real replace-script send actually
 * needed, and the send failed after passing a `--dry-run` that called it "would succeed" (see
 * riskgate.ts's `simulateDryRun`, fixed alongside this for the OTHER half of that finding: the dry
 * run never checked gas/cost at all, floor included). Investigating this specific number: the
 * deposit-only floor was never WRONG about what it claims — it is still a true lower bound — but it
 * was radically INCOMPLETE for a multi-chunk replacement, because it omits two costs that are just as
 * unconditionally "physics" as the 200 gas/byte deposit, and are not "an invented estimate" the
 * codebase's own philosophy (see execute.ts's `pinGas` doc) warns against including:
 *
 *   - `Gcreate` = 32,000 gas per `setScriptChunk` WRITE. `OnChainScript.setScriptChunk` stores its
 *     bytes via `SSTORE2.write`, which is one `CREATE` per call — a fixed opcode cost incurred
 *     regardless of chain state, chunk size, or whether the index already held something. A replace
 *     that (say) uses a small `--chunk-size` to spread one program over many chunks pays this 32,000
 *     once per chunk; the old floor counted 0 of it, so the gap grows with chunk COUNT, not just
 *     total bytes — exactly the shape a small-`--chunk-size` multi-chunk replacement produces.
 *   - The intrinsic cost of the multicall's own calldata — 16 gas per non-zero byte, 4 gas per zero
 *     byte (EIP-2028), plus the flat 21,000 base every transaction pays (EIP-2) — computed from the
 *     REAL encoded `data`, not approximated from chunk byte counts. `eth_estimateGas` (what `pinGas`
 *     compares the floor against) always includes both; the old floor included neither, so it could
 *     never clear this amount even for a single-chunk replacement with no removes at all.
 *
 * Deliberately still NOT included, because — unlike the two above — they genuinely depend on
 * on-chain state this function doesn't read, and a floor that could overstate the true minimum stops
 * being a floor: the SSTORE cost of the chunk-pointer mapping and the chunk-count counter (cold vs.
 * warm, zero-vs-nonzero all vary by what's on chain now), `removeLastScriptChunk`'s own cost, and any
 * gas refund (refunds apply AFTER execution and never reduce what a transaction must be GIVEN to
 * avoid running out mid-execution, so they could only ever justify a LOWER floor, working against the
 * "never send an under-funded tx" goal this exists for). So this remains a floor, not an estimate —
 * `simulateDryRun`'s new `estimatedGas`/`estimatedCostWei` (from `pinGas`'s real `eth_estimateGas`,
 * the same call the send itself makes) is the number to trust for cost guidance; this is only ever
 * the threshold that flags an implausible one.
 */
function replaceScriptGasFloor(finalCalldata: Hex, writeByteCounts: readonly number[]): bigint {
  const bytes = hexToBytes(finalCalldata);
  let calldataGas = 0n;
  for (const b of bytes) calldataGas += b === 0 ? 4n : 16n;
  const createBase = BigInt(writeByteCounts.length) * 32_000n;
  const depositGas = writeByteCounts.reduce((sum, n) => sum + BigInt(n) * 200n, 0n);
  return 21_000n + calldataGas + createBase + depositGas;
}

/**
 * `abx replace-script <address> --script <path>` — the safe, first-class way to replace an
 * UNLOCKED code project's on-chain program. `OnChainScript.sol` permits `setScriptChunk`/
 * `removeLastScriptChunk` right up until `lock-script` — but before this command the only writer
 * was `deploy-code` (its initial setup, or its `--resume` leg for a setup that never landed).
 * Neither is "replace a program that's already live and correct on-chain", which is the gap this
 * closes: a creator iterating on a generative project pre-lock had no supported way to ship a fix.
 *
 * Safety properties, in the order they're enforced:
 *   1. REFUSE outright — never warn-and-proceed — on a locked script or a non-code target. Both are
 *      "there is nothing here for this command to safely do", not "proceed with caution".
 *   2. Diff by CONTENT against what's on-chain now ({@link planScriptReplace}, mirroring
 *      `resume.ts`'s script-chunk leg) so an index that already matches is never re-sent — SSTORE2
 *      deposit is 200 gas/byte, so a needless re-store is the most expensive way to be "safe".
 *   3. Every write AND every remove rides in ONE atomic `multicall` (`batchOps`, the same primitive
 *      `abx attach` uses for its own all-or-nothing guarantee). This is what makes "half-applied"
 *      structurally impossible from this command's own send: a revert undoes everything, a success
 *      lands everything. Writes are ordered before removes — the retained indices get their correct
 *      content before the tail is trimmed, so the intermediate calldata sequence never shrinks the
 *      script before it's right (the two groups touch disjoint indices, so this is a documentation
 *      choice about intent, not a correctness requirement of the atomic call itself).
 *   4. After a real send, READ THE SCRIPT BACK and verify it reassembles EXACTLY to the source file
 *      ({@link verifyScriptReplace}) before reporting success. A transaction not reverting proves the
 *      EVM accepted each call; it does not prove the final program is what was intended. This is the
 *      step that actually justifies the command existing — skip it and "replace-script" is just
 *      "send some txs and hope".
 *
 * `--dry-run`/`--sign`/`--unsigned` all route through the shared `runWrite`/`gatedSend` choke point
 * (the same one every owner-op uses), so a dry run sends nothing, per the house invariant.
 */
export async function cmdReplaceScript(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx replace-script <address> --script <path> [--chunk-size <bytes>] [--sign|--unsigned] [--dry-run]';
  const contract = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(REPLACE_SCRIPT_FLAGS), 'replace-script');
  const scriptPath = requireFlag(flags, 'script', usage);
  if (!existsSync(scriptPath)) {
    throw new Error(`no file at ${scriptPath} — pass the path to the replacement program (the same --script a deploy-code would take).`);
  }
  const source = readFileSync(scriptPath, 'utf8');

  // REFUSE (not warn) on a target this command cannot safely act on — before any signing prompt.
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, contract);
  if (!hasParamsSurface(kind)) {
    throw new Error(
      `${contract} is a ${kind.label} — replace-script only applies to a SeriesCode/EditionCode on-chain program ` +
        `(the OnChainScript extension). ${kind.label} has no script to replace.`,
    );
  }
  const scriptLocked = (await publicClient.readContract({address: contract, abi: seriesCodeAbi, functionName: 'scriptLocked'})) as boolean;
  if (scriptLocked) {
    throw new Error(
      `${contract}'s script is LOCKED (\`abx lock-script\` was already sent) — setScriptChunk/removeLastScriptChunk ` +
        `revert forever, on-chain, for everyone. There is no way to replace it; that refusal IS the safety property ` +
        `lock-script exists to guarantee, so this command does not attempt a workaround.`,
    );
  }

  const owner = await read<Address>(contract, 'owner');
  const chunkSize = flags['chunk-size'] !== undefined ? Number(flags['chunk-size']) : undefined;
  if (chunkSize !== undefined && (!Number.isFinite(chunkSize) || chunkSize < 1)) {
    throw new Error(`--chunk-size must be a positive integer, got "${flags['chunk-size']}"`);
  }
  const nextChunks = planOnChainScript(source, chunkSize);
  if (nextChunks.length === 0) {
    console.log(yellow('  ⚠ ') + `${scriptPath} is empty — this will REMOVE every existing script chunk, leaving no program on-chain. Ctrl-C now if that's not what you meant.`);
  }

  const reader = chainScriptReader(contract);
  const plan = await planScriptReplace(reader, nextChunks);

  console.log(`  script: ${plan.currentCount} chunk(s) on-chain → ${plan.targetCount} chunk(s) in ${scriptPath}`);
  if (plan.noop) {
    console.log(`  ${green('✓')} no-op — the on-chain script already matches ${scriptPath} byte-for-byte. Nothing to send.`);
    return;
  }
  if (plan.toWrite.length) {
    console.log(dim(`    write ${plan.toWrite.length} chunk(s): index ${plan.toWrite.map((w) => w.index).join(', ')}`));
  }
  if (plan.toRemove) {
    console.log(
      dim(`    remove ${plan.toRemove} trailing chunk(s) — shrinking ${plan.currentCount} → ${plan.targetCount} (removeLastScriptChunk has no "remove N"; this is ${plan.toRemove} queued call(s))`),
    );
  }

  // Writes before removes (see the function doc for why this ordering, not the reverse). Both
  // groups fold into ONE multicall below — that's what makes a half-applied result impossible from
  // this command's own send, not the ordering.
  const ops: PreparedTx[] = [
    ...plan.toWrite.map((w) => prepareSetScriptChunk({contract, index: w.index, chunk: w.hex, chainId: chainId()})),
    ...Array.from({length: plan.toRemove}, () => prepareRemoveLastScriptChunk({contract, chainId: chainId()})),
  ];
  const batched = batchOps(ops);
  if (batched.length !== 1) {
    // Defensive: every op above targets the SAME contract and carries no value, so batchOps must
    // fold them to exactly one multicall. If that ever changes, fail loudly rather than send N
    // separate transactions with no atomicity — the one property this command exists to guarantee.
    throw new Error(`replace-script expected to batch ${ops.length} op(s) into one transaction, got ${batched.length}`);
  }
  // `batchOps`/`prepareMulticall` don't sum a folded gasFloor from their sub-ops (each PER-CHUNK
  // gasFloor is real physics — see prepareSetScriptChunk's own doc — but is dropped once several ops
  // merge into one multicall PreparedTx). Restate it here — using the REAL final calldata, not an
  // approximation — so the eth_estimateGas sanity check fires for any replacement that changes
  // anything on-chain, writes or pure removes alike. See replaceScriptGasFloor's own doc for what
  // changed here and why (a real sweep found the deposit-only version 49% under the true minimum).
  const writeByteCounts = plan.toWrite.map((w) => (w.hex.length - 2) / 2);
  const floor = replaceScriptGasFloor(batched[0].data, writeByteCounts);
  const tx: PreparedTx = {...batched[0], gasFloor: `0x${floor.toString(16)}` as Hex};

  const sent = await runWrite(contract, tx, flags, owner);
  if (!sent) return; // dry run, or the cold lane — nothing landed to verify yet

  const verify = await verifyScriptReplace(reader, source);
  if (!verify.ok) {
    console.error(
      `\n  ${red('✗')} VERIFICATION FAILED — the on-chain script does NOT reassemble to ${scriptPath} after this write.\n` +
        `  on-chain now reports ${verify.chunkCount} chunk(s) (wanted ${plan.targetCount}). This can mean the write only\n` +
        `  partially landed, or something else wrote to this contract concurrently — either way, DO NOT assume the\n` +
        `  program is what you intended.\n` +
        `  Way forward: re-run \`abx replace-script ${contract} --script ${scriptPath}\` — it re-diffs against whatever\n` +
        `  is ACTUALLY on-chain now and sends only what's still missing or wrong; it will not resend what already matches.\n` +
        `  Inspect by hand: abx tokenuri ${contract} --fetch  (or scriptChunkCount/scriptChunk directly).\n`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `  ${green('✓')} verified — the on-chain script reassembles EXACTLY to ${scriptPath} (${verify.chunkCount} chunk(s), ${source.length} bytes).\n` +
      dim(`    this is the safety property \`abx lock-script ${contract}\` later makes permanent.`),
  );
}

/** `abx lock-param-hooks <address>` — freeze the three param-lifecycle hook addresses forever.
 *  The sibling of lock-script/lock-dependencies/lock-uri, and the only one aimed at a BUYER rather
 *  than at metadata: the transfer hook is a veto over transfers and mints, so an unlocked hook set
 *  is a standing power over whether a collector can sell. After this, `set-param-hooks` reverts
 *  ParamHooksLocked. Owner-only, any lane, guards --dry-run. */
export async function cmdLockParamHooks(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx lock-param-hooks <address> [--sign|--unsigned] [--dry-run]');
  // Read the current trio first: it is the SeriesCode/EditionCode guard (paramHooks() exists only on
  // the ConfigurableParams extension) AND the thing being frozen — nobody should sign a permanent
  // freeze without seeing exactly what it freezes.
  const publicClient = makePublicClient({chainKey: CHAIN});
  let current: readonly [Address, Address, Address];
  try {
    current = (await publicClient.readContract({address: contract, abi: seriesCodeAbi, functionName: 'paramHooks'})) as readonly [
      Address,
      Address,
      Address,
    ];
  } catch {
    await assertContractExists(contract);
    const kind = await detectTokenKind(publicClient, contract);
    throw new Error(
      `${contract} exposes no param hooks — they are a SeriesCode/EditionCode (PostParams) feature, ` +
        `so there is nothing to freeze. ${kind.label} has no configurable params to hook.`,
    );
  }
  const cur: Record<HookRole, Address> = {configure: current[0], augment: current[1], transfer: current[2]};
  const label = (a: Address) => (eqAddr(a, zeroAddress) ? dim('none') : a);
  console.log(`  freezing these three addresses on ${contract}, permanently:`);
  for (const r of HOOK_ROLES) console.log(`    ${r.padEnd(10)} ${label(cur[r])}`);
  console.log(dim('  note: this is permanent and irreversible — no hook address can ever be set, re-pointed, or cleared again.'));
  console.log(
    dim(
      `  you are giving up: arming a transfer veto (a hook that can block transfers and mints), arming a write-time configure veto, and re-pointing or clearing the augment hook. ` +
        `${eqAddr(cur.transfer, zeroAddress) ? 'With no transfer hook set, freezing is how you PROVE you can never add one — the guarantee a buyer can check.' : 'The transfer hook already set stays live and keeps its veto: freezing the set is not disarming what is in it.'}`,
    ),
  );
  console.log(dim('  this freezes only the hooks. Schemas, param values, script, dependencies and URIs keep their own locks (`abx verify` lists them).'));
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareLockParamHooks({contract, chainId: chainId()}), flags, owner);
}

// ── editions: shared small parsers ────────────────────────────────────────────
/** A non-negative-integer edition flag (`--token-id`, `--amount`, …) — the shared parse +
 *  bound-check so every edition command that takes "an id" or "a count" rejects the same way. */
export function parseEditionCountFlag(raw: string, flag: string): bigint {
  if (raw === 'true' || !/^\d+$/.test(raw.trim())) throw new Error(`--${flag} must be a non-negative integer; got '${raw}'.`);
  return BigInt(raw.trim());
}

/** `--token-ids <csv|range>` — the shape `ping-uri` (and any future batch-by-id command) takes: a
 *  comma-separated list of ids and/or `lo-hi` ranges (`0-9,20,25-30`), de-duplicated and sorted. */
export function parseTokenIdRange(raw: string): bigint[] {
  const ids = new Set<bigint>();
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [lo, hi] = [BigInt(range[1]), BigInt(range[2])];
      if (lo > hi) throw new Error(`--token-ids: range '${part}' has lo > hi.`);
      for (let i = lo; i <= hi; i++) ids.add(i);
    } else if (/^\d+$/.test(part)) {
      ids.add(BigInt(part));
    } else {
      throw new Error(`--token-ids: '${part}' isn't a token id or a 'lo-hi' range.`);
    }
  }
  if (!ids.size) throw new Error("--token-ids needs at least one id (e.g. '0,1,2' or '0-99').");
  return [...ids].sort((a, b) => Number(a - b));
}

// ── mint ─────────────────────────────────────────────────────────────────────
// Issue a token — a deferred mint (deploy → warm resolver → mint) or a primary sale
// (mint straight to the buyer). For a 1/1 this is the one-shot token #0. For a Series
// it mints the next sequential token id (metadata = token id): bare (one), or `--count <n>`
// (n in order). Owner or an authorized minter signs.
// For an EDITION (OneOfOneEdition/EditionImage/EditionCode) this mints copies of ONE id:
// --token-id (required unless the target is a 1/1-edition, whose id space is fixed to {0}) +
// --amount (default 1). --count is the 721 Series primitive and is refused on an edition.
export async function cmdMint(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx mint <address> [--to 0x…] [--count <n> | --token-id <id> --amount <n>] [--json] [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(MINT_FLAGS), 'mint');
  // `--json`: the TOKEN ID is the value a program came for, and it was previously only obtainable by
  // regex-scraping coloured prose. It is read from the mint's own Transfer logs rather than by
  // re-reading `nextTokenId` afterwards — a concurrent mint would make that answer wrong, and a
  // number that is usually right is worse than no number.
  return withJson(flags, async () => {
    const publicClient = makePublicClient({chainKey: CHAIN});
    const kind = await detectTokenKind(publicClient, contract);
    const owner = await read<Address>(contract, 'owner');
    const to = (flags.to as Address) ?? owner; // default: pre-mint to the admin

    if (kind.isEdition) {
      // `--count` is the 721 Series primitive (N sequential ids); an edition mint always names its
      // id and an amount — there is no "next in order" to count through. Refuse, don't silently
      // reinterpret it as something else.
      if (flags.count !== undefined) {
        throw new Error(`--count is a 721 Series flag (mint N tokens in order) — ${contract} is a ${kind.label} (edition). Use --token-id <id> --amount <n> instead.`);
      }
      // OneOfOneEdition's id space is fixed to {0}, so --token-id defaults there; EditionImage/
      // EditionCode ids are caller-named works with no sensible default — require it.
      if (kind.kind !== '1of1-edition' && flags['token-id'] === undefined) {
        throw new Error(
          `--token-id is required on a ${kind.label} — its ids are caller-named works, not a single default. ` +
            `See existing ids with \`abx tokens ${contract}\`.`,
        );
      }
      const tokenId = flags['token-id'] !== undefined ? parseEditionCountFlag(flags['token-id'] as string, 'token-id') : 0n;
      const amount = flags.amount !== undefined ? parseEditionCountFlag(flags.amount as string, 'amount') : 1n;
      console.log(dim(`  minting ${amount} cop${amount === 1n ? 'y' : 'ies'} of #${tokenId} → ${to}${flags.to ? '' : ' (owner — pass --to for a buyer)'}`));
      const tx = prepareEditionMint({contract, to, tokenId, amount, chainId: chainId()});
      const result = await runWrite(contract, tx, flags, owner);
      if (result) console.log(`  ${green('✓')} minted ${amount} cop${amount === 1n ? 'y' : 'ies'} of ${bold('#' + tokenId)} → ${to}`);
      console.log(dim(`  next: \`abx refresh ${contract}\` so marketplaces pick up the change.`));
      return {
        contract,
        chainId: chainId(),
        to,
        sent: !!result,
        txHash: result?.txHash ?? null,
        blockNumber: result ? String(result.blockNumber) : null,
        tokenIds: [tokenId.toString()],
        amount: amount.toString(),
      };
    }

    // 721 path (unchanged): --token-id/--amount have no meaning here — refuse rather than silently
    // ignore (the membrane rule: enforce, don't warn).
    if (flags['token-id'] !== undefined || flags.amount !== undefined) {
      throw new Error(
        `--token-id/--amount are edition-only (ERC-1155 copies) — ${contract} is a ${kind.label} (721). ` +
          `Mint the next token with \`abx mint ${contract}\`${kind.kind !== '1of1' ? ' (or --count N for several in order)' : ''}.`,
      );
    }
    let tx: PreparedTx;
    let count = 1n;
    if (flags.count !== undefined && flags.count !== 'true') {
      count = BigInt(flags.count);
      console.log(dim(`  minting ${count} Series tokens in order → ${to}`));
      tx = prepareSeriesMintMany({contract, to, count, chainId: chainId()});
    } else {
      // Bare mint: the `mint(address)` selector is shared by the 1/1 (token #0) and a
      // Series (next sequential token) — one path serves both.
      console.log(dim(`  minting token → ${to}${flags.to ? '' : ' (owner — pass --to for a buyer)'}`));
      tx = prepareMint({contract, to, chainId: chainId()});
    }
    const result = await runWrite(contract, tx, flags, owner);
    const tokenIds = result ? await mintedTokenIds(makePublicClient({chainKey: CHAIN}), contract, result.txHash) : [];
    if (result && tokenIds.length) {
      console.log(`  ${green('✓')} minted token${tokenIds.length > 1 ? 's' : ''} ${bold(tokenIds.map((t) => '#' + t).join(', '))} → ${to}`);
    }
    console.log(dim(`  next: \`abx refresh ${contract}\` so marketplaces pick up the new token.`));
    return {
      contract,
      chainId: chainId(),
      to,
      // `sent: false` is the dry-run and cold-lane answer — an empty tokenIds with no explanation
      // would read as a failed mint.
      sent: !!result,
      txHash: result?.txHash ?? null,
      blockNumber: result ? String(result.blockNumber) : null,
      tokenIds,
      requestedCount: Number(count),
    };
  });
}

// ── series owner ops (minter set · supply cap · primary payee) ────────────────
// The multi-token knobs. All owner-only; each runs through the same signing lane +
// re-index as every other owner op.

/** Set (or clear, with `--minter none`) the single authorized minter — a drop/auction/router
 *  contract. Setting a new one atomically replaces any previous minter. */
export async function cmdSetMinter(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-minter <address> --minter 0x…|none [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const raw = requireFlag(flags, 'minter', usage);
  const minter = (raw === 'none' ? zeroAddress : raw) as Address;
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetMinter({contract, minter, chainId: chainId()}), flags, owner);
}

/** Lower the supply cap (monotonic — e.g. close an open edition early at `--max <totalSupply>`). */
export async function cmdSetMaxInvocations(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-max-invocations <address> --max <N> [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const max = BigInt(requireFlag(flags, 'max', usage));

  // The cap only ever decreases, but `--dry-run` used to print "Set max invocations → 20" and state
  // the new value as fact for a contract capped at 16 — then the real send reverted. A creator (or an
  // agent) reads a clean dry run as permission to send, so the preview has to know what the chain
  // knows. Best-effort: an unreadable getter does NOT block, since the chain enforces it regardless.
  // `readSeries`, not `read`: the 1/1 ABI that `read` uses has no `maxInvocations` at all, so reading
  // through it always threw and this guard silently never fired.
  const capNow = await readSeries<bigint>(contract, 'maxInvocations').catch(() => null);
  if (capNow !== null && max > capNow) {
    throw new Error(
      `${contract}'s cap is already ${capNow} and maxInvocations can only DECREASE — ${max} would raise it, which the chain refuses. ` +
        `Pass a number at or below ${capNow} (a supply cap is one-way by design: it can be tightened, never reopened).`,
    );
  }

  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetMaxInvocations({contract, maxInvocations: max, chainId: chainId()}), flags, owner);
}

// ── set-max-supply (editions only) — the per-id twin of set-max-invocations ──────────────────────
/**
 * `abx set-max-supply <address> --token-id <n> --cap <n>` — owner overrides ONE id's ERC-1155
 * supply cap (Edition Supply extension). Monotonically non-increasing once used for that id — the
 * chain enforces it (`MaxSupplyIncreaseForbidden`/`MaxSupplyBelowFloor`), and `--cap open` is
 * refused HERE, before any gas: the contract's own "0" means "closed forever" once an id has been
 * overridden (not "reopen to uncapped" — `EditionSupply.sol`'s own doc calls this out), so accepting
 * `open` as an alias for 0 would silently promise the opposite of what it does on a re-run.
 */
export async function cmdSetMaxSupply(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-max-supply <address> --token-id <n> --cap <n> [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(SET_MAX_SUPPLY_FLAGS), 'set-max-supply');
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, contract);
  if (!kind.isEdition) {
    throw new Error(`set-max-supply is edition-only (a per-id ERC-1155 cap) — ${contract} is a ${kind.label} (721). Use \`abx set-max-invocations\` instead (the whole-project cap).`);
  }
  const tokenId = parseEditionCountFlag(requireFlag(flags, 'token-id', usage), 'token-id');
  const capRaw = requireFlag(flags, 'cap', usage);
  if (capRaw.trim().toLowerCase() === 'open') {
    throw new Error(
      `--cap open is refused: once you set a cap for #${tokenId} it can only DECREASE (never increase back to uncapped) — ` +
        `"open" would ask for exactly the increase the chain forbids. If this id has never been overridden, it's already open ` +
        `(the --copies default from deploy) — there's nothing to set. To lower an existing cap, pass the number.`,
    );
  }
  const cap = parseEditionCountFlag(capRaw, 'cap');

  // Both ways this reverts on chain were reachable through `--dry-run` unchanged: the preview printed
  // "#0 supply cap → 50" and stated the new cap as fact, then the real send reverted. A dry run that
  // green-lights an impossible write is worse than no dry run — the creator's next step is to send it.
  // `maxSupply(id) === 0` reads as "open" (the un-overridden --copies default), so any finite cap is a
  // decrease from open and allowed. Reads are best-effort: if either read fails we do NOT block, since
  // the chain still enforces the invariant and a guard must not turn an RPC miss into a refusal.
  const [capNow, supplyNow] = await Promise.all([
    readEdition<bigint>(contract, 'maxSupply', [tokenId]).catch(() => null),
    readEdition<bigint>(contract, 'totalSupply', [tokenId]).catch(() => null),
  ]);
  if (capNow !== null && capNow > 0n && cap > capNow) {
    throw new Error(
      `#${tokenId}'s cap is already ${capNow} and a cap can only DECREASE — ${cap} would raise it, which the chain refuses. ` +
        `Pass a number at or below ${capNow}${supplyNow !== null ? ` and at or above its ${supplyNow} live cop${supplyNow === 1n ? 'y' : 'ies'}` : ''}.`,
    );
  }
  if (supplyNow !== null && cap < supplyNow) {
    throw new Error(
      `#${tokenId} already has ${supplyNow} cop${supplyNow === 1n ? 'y' : 'ies'} minted, so a cap of ${cap} would sit BELOW live supply — the chain refuses that. ` +
        `The lowest cap you can set is ${supplyNow} (which closes the id to further minting).`,
    );
  }

  const owner = await read<Address>(contract, 'owner');
  console.log(dim(`  #${tokenId} supply cap → ${cap}`));
  await runWrite(contract, prepareSetMaxSupply({contract, tokenId, cap, chainId: chainId()}), flags, owner);
}

// ── ping-uri (editions only) — the OWNER's URI re-emission ───────────────────────────────────────
/** How many ids one `pingURI` call carries per transaction — large enough that a normal collection
 *  fits in one tx, small enough that a genuinely huge id list doesn't build one unbounded call. */
const PING_URI_CHUNK_SIZE = 200;

/**
 * `abx ping-uri <address> --token-ids <csv|range>` — re-emit the native ERC-1155 `URI` event for
 * the given ids after a contract-wide re-point (`set-token-uri`/`set-renderer`), so marketplaces/
 * indexers that only honor the native event re-index. Permissionless (anyone may call it — it only
 * re-emits already-public, current truth), so there is no owner check and no `expectedSigner` to
 * pin; whichever signer the active lane resolves sends it. Chunks a large id list into several
 * transactions, each through the SAME `--dry-run`/`--confirm` gate as any other write.
 */
export async function cmdPingUri(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx ping-uri <address> --token-ids <csv|range> [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, contract);
  if (!kind.isEdition) {
    throw new Error(
      `ping-uri is edition-only — it re-emits the ERC-1155 URI event, which a ${kind.label} (721) doesn't have ` +
        `(both lanes emit ERC-4906 automatically on a URI change; this command is for indexers that ` +
        `honor only the native 1155 event).`,
    );
  }
  const ids = parseTokenIdRange(requireFlag(flags, 'token-ids', usage));
  const chunks: bigint[][] = [];
  for (let i = 0; i < ids.length; i += PING_URI_CHUNK_SIZE) chunks.push(ids.slice(i, i + PING_URI_CHUNK_SIZE));
  console.log(
    dim(`  re-emitting URI for ${ids.length} id${ids.length === 1 ? '' : 's'} — owner-only — ${chunks.length} tx${chunks.length === 1 ? '' : '(s)'} of up to ${PING_URI_CHUNK_SIZE} id(s) each`),
  );
  for (const [i, chunk] of chunks.entries()) {
    if (chunks.length > 1) console.log(dim(`  chunk ${i + 1}/${chunks.length}: ${chunk.length} id(s) (#${chunk[0]}–#${chunk[chunk.length - 1]})`));
    await runWrite(contract, preparePingURI({contract, tokenIds: chunk, chainId: chainId()}), flags);
  }
}

/** Pause minting — restrict it to the owner (config/reserves) until unpaused. */
export async function cmdPause(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx pause <address> [--sign|--unsigned]');
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetPaused({contract, paused: true, chainId: chainId()}), flags, owner);
}

/** Unpause minting — open it to the authorized minter (go live). */
export async function cmdUnpause(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx unpause <address> [--sign|--unsigned]');
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetPaused({contract, paused: false, chainId: chainId()}), flags, owner);
}

// ── authorship + rights deploy fields (parity with --description / --external-url) ───────────
/** The optional authorship + rights deploy flags, each paired with the reserved collection-field
 *  key it writes. Set at deploy → baked as on-chain **inline collection** fields (same slot the
 *  `--description` / `--external-url` identity writes use); unset → nothing written. Collection
 *  scope, so one value covers the whole project — they project into `contractURI` on the resolver
 *  AND the on-chain renderer. Works for every token type (1/1 · Series · code). */
export const AUTHORSHIP_DEPLOY_FIELDS: ReadonlyArray<readonly [flag: string, field: string]> = [
  ['creator', F.creator],
  ['display-notes', F.displayNotes],
  ['creator-links', F.creatorLinks],
  ['license', F.license],
];

/** Build the on-chain (inline) collection fields for whichever authorship/rights deploy flags are
 *  set — pure, so a deploy path just spreads the result into its `contractFields`. */
export function authorshipContractFields(flags: Flags): OnChainFieldInput[] {
  return AUTHORSHIP_DEPLOY_FIELDS.flatMap(([flag, field]) =>
    flags[flag] ? [{field: encodeTag(field), representation: encodeTag(R.inline), value: toHex(String(flags[flag]))}] : [],
  );
}

// ── preferred gateways ───────────────────────────────────────────────────────
// The two reserved COLLECTION-scope fields that turn a content-addressed `ipfs`/`arweave` value
// into the `https://` a marketplace can render. Identity (the CID) stays in the field; the serving
// prefix lives here, project-wide, so a dead or slow gateway is a REPOINT and never a rewrite.

/** Refuse a prefix that cannot serve. Two rules only — a URL parser here would be a liability, but
 *  a value that is not http(s) simply cannot be concatenated into a working URL by any consumer. */
export function assertGatewayPrefix(network: 'ipfs' | 'arweave', prefix: string): string {
  const value = prefix.trim();
  if (!value) throw new Error(`--${network} needs a gateway prefix (e.g. ${GATEWAY_FLOOR[network]}), or 'none' to clear it`);
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(
      `gateway prefix "${value}" must start with https:// (or http://) — it is concatenated directly ` +
        `onto the CID, so it has to be the whole serving prefix INCLUDING the trailing path.\n` +
        `  e.g. ${GATEWAY_FLOOR[network]}` +
        (network === 'ipfs' ? '  or  https://<your>.mypinata.cloud/ipfs/' : ''),
    );
  }
  return value;
}

/**
 * The gateway fields a deploy should write.
 *
 * Precedence, per scheme: `--ipfs-gateway` / `--arweave-gateway` → `--gateway` (only for the backend
 * actually in use) → `ABX_IPFS_GATEWAY` / `ABX_ARWEAVE_GATEWAY` → nothing.
 *
 * `--gateway` counts because it has to. It is the STORAGE gateway — where the CLI uploads, probes,
 * and builds `locator()` — and before this it was also, accidentally, the serving gateway, because
 * deploy baked `locator()` straight into a `url` field. Now that the field holds a bare CID, a
 * creator who passed `--gateway https://mine.mypinata.cloud` and nothing else would have had their
 * gateway stripped out and their tokens served from `ipfs.io`: strictly worse than before, for a
 * flag they did pass. Someone who genuinely wants to upload through one gateway and serve through
 * another says so with the scheme-specific flag.
 *
 * Deliberately writes NOTHING when no source names one. Persisting the public floor would make a
 * project that simply took the default look like it chose `ipfs.io` — and would freeze it there,
 * since a floor only improves for collections that stayed silent. Silence is a live default; an
 * explicit value is a decision.
 */
export function gatewayContractFields(flags: Flags): OnChainFieldInput[] {
  const out: OnChainFieldInput[] = [];
  for (const network of ['ipfs', 'arweave'] as const) {
    const {prefix, chosen} = servingGateway(network, flags);
    if (!chosen) continue;
    out.push({
      field: encodeTag(GATEWAY_FIELD[network]),
      representation: encodeTag(R.inline),
      value: toHex(prefix),
    });
  }
  return out;
}

/**
 * The prefix this run will actually be SERVED from for one scheme — the same precedence
 * `gatewayContractFields` writes, but resolved all the way down to the public floor so a caller can
 * *show* the creator the URL their token will really carry.
 *
 * Split out because a deploy used to narrate the backend's UPLOAD locator (`gateway.pinata.cloud/…`)
 * while committing a bare CID served from somewhere else entirely — a progress line that contradicted
 * the chain. `chosen` distinguishes "the project picked this" (written on chain) from "the floor is
 * filling a silence" (nothing written, and a later floor change moves the project with it).
 *
 * `--gateway` and the env vars are HOST-shaped (`https://my.gw`); the on-chain/served form is a full
 * prefix including the trailing path, so normalize once, here.
 */
export function servingGateway(
  network: 'ipfs' | 'arweave',
  flags: Flags,
): {prefix: string; chosen: boolean} {
  const activeBackend = backendResolution({backend: flags.backend as string | undefined}).backend;
  const named =
    flags[`${network}-gateway`] ??
    (activeBackend === network ? flags.gateway : undefined) ??
    readEnv(network === 'ipfs' ? 'ABX_IPFS_GATEWAY' : 'ABX_ARWEAVE_GATEWAY');
  if (!named || named === 'true') return {prefix: GATEWAY_FLOOR[network], chosen: false};
  return {prefix: gatewayPrefixFrom(network, assertGatewayPrefix(network, String(named))), chosen: true};
}

/**
 * `abx set-gateway <address> [--ipfs <prefix>] [--arweave <prefix>]` — repoint where this
 * collection's content-addressed fields are served from. The CID never moves.
 *
 * A separate command rather than two `set-field` invocations because the failure modes are all
 * silent: a token-scope write (ignored — a gateway is one answer per project), a non-`inline`
 * representation (ignored), a prefix missing its trailing path (`https://ipfs.io` + `<cid>` is a
 * 404). `set-field` refuses these keys and points here instead.
 */
export async function cmdSetGateway(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-gateway <address> [--ipfs <prefix>|none] [--arweave <prefix>|none] [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const writes: {network: 'ipfs' | 'arweave'; value: string}[] = [];
  for (const network of ['ipfs', 'arweave'] as const) {
    const raw = flags[network];
    if (raw === undefined) continue;
    if (raw === 'true') throw new Error(`--${network} needs a value: a prefix like ${GATEWAY_FLOOR[network]}, or 'none' to fall back to the public default`);
    // Clearing is a real operation: it returns the collection to the floor, which is what a project
    // wants after a dedicated gateway subscription lapses.
    writes.push({network, value: raw === 'none' ? '' : gatewayPrefixFrom(network, assertGatewayPrefix(network, String(raw)))});
  }
  if (!writes.length) throw new Error(`${usage}\n  Pass at least one of --ipfs / --arweave. They are separate so a project can pay for a dedicated IPFS gateway and leave Arweave on the public one.`);

  const owner = await read<Address>(contract, 'owner');
  for (const {network, value} of writes) {
    console.log(
      value
        ? `  ${bold(network)} → ${value}`
        : `  ${bold(network)} → ${dim(`cleared (falls back to ${GATEWAY_FLOOR[network]})`)}`,
    );
    await runWrite(
      contract,
      prepareSetContractField({
        contract,
        field: GATEWAY_FIELD[network],
        representation: R.inline,
        // An empty value clears the field, so the read falls through to the floor. The store refuses
        // an empty write (`EmptyFieldValue`), so clearing writes a single space — which
        // `projectGatewayPrefix` trims to nothing and treats as "no preference stated".
        value: toHex(value || ' '),
        chainId: chainId(),
      }),
      flags,
      owner,
    );
  }
  if (!isDryRun(flags)) {
    console.log(dim('\n  Every token whose image is a content-addressed field now resolves through the new prefix.'));
    console.log(dim('  ERC-4906 fired, so 4906-aware marketplaces refresh on their own; `abx refresh <address>` nudges the rest.\n'));
  }
}

/** Set (or clear, with `--payee none`) the primary-sale payout destination. */
export async function cmdSetPrimaryPayee(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-primary-payee <address> --payee 0x…|none [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const raw = requireFlag(flags, 'payee', usage);
  const payee = (raw === 'none' ? zeroAddress : raw) as Address;
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetPrimaryPayee({contract, payee, chainId: chainId()}), flags, owner);
}

// ── refresh ──────────────────────────────────────────────────────────────────
// Ask marketplaces to (re)index a token's metadata. The instant a mint lands,
// marketplaces fetch the on-chain tokenURI; if the resolver wasn't warm they cache
// a miss until refreshed. We emit ERC-4906 on URI changes (4906-aware marketplaces
// auto-refresh) — this is the manual fallback for the rest, and after the genesis mint.
/**
 * OpenSea's own chain slugs, keyed by ours. They are NOT our keys (`base-sepolia` is `base_sepolia`
 * there) and not derivable from viem, so the map is unavoidable — but a chain missing from it must
 * produce NO link rather than a wrong one, which is what `osChain ?? CHAIN` used to do.
 *
 * It previously listed only `sepolia` and `mainnet`, so the CLI's own DEFAULT chain (`base-sepolia`)
 * fell through to the raw key: the refresh POST went to `/chain/base-sepolia/…` (a slug OpenSea does
 * not know) and the printed link pointed at **mainnet** `opensea.io` for a testnet token. Same shape
 * as the hardcoded explorer table that once sent every Base Sepolia link to Etherscan — hence
 * `testnet` now comes from the chain registry instead of a second hand-maintained set.
 */
const OPENSEA_CHAIN: Record<string, string> = {'base-sepolia': 'base_sepolia', sepolia: 'sepolia'};
export async function cmdRefresh(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx refresh <address> [--token 0]');
  const tokenId = flags.token ?? '0';
  const chain = resolveChain(CHAIN);
  const osChain: string | undefined = OPENSEA_CHAIN[CHAIN];
  const explorer = chain.blockExplorers?.default?.url ?? '';
  const apiKey = process.env.OPENSEA_API_KEY;

  if (!osChain) {
    console.log(dim(`  no OpenSea slug known for '${CHAIN}' — skipping the OpenSea refresh (a guessed slug 404s, and a guessed link would point at the wrong network).`));
  } else if (apiKey) {
    const url = `https://api.opensea.io/api/v2/chain/${osChain}/contract/${contract}/nfts/${tokenId}/refresh`;
    try {
      const res = await fetch(url, {method: 'POST', headers: {'x-api-key': apiKey, accept: 'application/json'}});
      if (res.ok) console.log(`  ${green('✓')} asked OpenSea to refresh ${contract} #${tokenId}`);
      else console.log(dim(`  OpenSea API ${res.status} ${res.statusText} — use the page link below and click “Refresh metadata”.`));
    } catch (err) {
      console.log(dim(`  OpenSea API unreachable (${(err as Error).message}) — use the links below.`));
    }
  } else {
    console.log(dim('  no OPENSEA_API_KEY set — open these and click “Refresh metadata”:'));
  }

  // `testnet` from the chain registry (viem), never a local set — that is the drift this bug was.
  const osBase = chain.testnet ? 'https://testnets.opensea.io' : 'https://opensea.io';
  if (osChain) console.log(`    ${dim('OpenSea  ')}${osBase}/assets/${osChain}/${contract}/${tokenId}`);
  if (explorer) console.log(`    ${dim('Etherscan')} ${explorer}/token/${contract}?a=${tokenId}`);

  // Both lanes now emit ERC-4906 on a URI change, so this is one sentence again. The 1155 lane
  // used to emit only its own config event, which is why this branched and why `ping-uri` exists;
  // a collection-wide re-point on an edition must emit a refresh signal, and the
  // fix was to emit the O(1) ERC-4906 range form there too. `ping-uri` is still useful on an
  // edition, but for a narrower reason: it re-emits the NATIVE ERC-1155 `URI` event for indexers
  // that honor only that one.
  console.log(dim('  (ERC-4906 already pings 4906-aware marketplaces on URI changes; this covers the genesis mint + the rest.)'));
}

// ── transfer ─────────────────────────────────────────────────────────────────
export async function cmdTransfer(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx transfer <address> --to 0x… [--token 0 | --token-id 0] [--amount <n> --from 0x… (editions only)] [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(TRANSFER_FLAGS), 'transfer');
  const to = requireFlag(flags, 'to', usage) as Address;
  // `--token-id` is accepted as an alias for `--token`: EVERY sibling id-taking command (`mint`,
  // `set-max-supply`, `minter …`) spells it `--token-id`, so an agent that learned the name there
  // passed it here — where it was silently ignored and id 0 moved instead of the id they named.
  // On an edition that means transferring the WRONG WORK with no warning. Both spellings work now;
  // disagreeing values are refused rather than silently preferring one.
  if (flags.token !== undefined && flags['token-id'] !== undefined && flags.token !== flags['token-id']) {
    throw new Error(`--token ${flags.token} and --token-id ${flags['token-id']} disagree — pass one (they are aliases for the same id).`);
  }
  const tokenId = BigInt(flags['token-id'] ?? flags.token ?? '0');
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, contract);

  if (kind.isEdition) {
    const amount = flags.amount !== undefined ? parseEditionCountFlag(flags.amount as string, 'amount') : 1n;
    // Unlike a 721 (one holder, read on-chain via ownerOf), an edition id can have MANY concurrent
    // holders — there is no single "the owner" to move copies from, so the holder must be named.
    const fromRaw = flags.from as string | undefined;
    if (!fromRaw || fromRaw === 'true') {
      throw new Error(
        `--from 0x.. is required on a ${kind.label} — an edition id can have many concurrent holders, so ` +
          `there is no single current owner to read on-chain (unlike a 721). Pass the holder's address.`,
      );
    }
    if (!isAddress(fromRaw)) throw new Error(`--from must be a 0x address; got '${fromRaw}'.`);
    const from = getAddress(fromRaw);
    const tx = prepareEditionTransfer({contract, from, to, tokenId, amount, chainId: chainId()});
    await runWrite(contract, tx, flags, from);
    return;
  }

  // 721 path (unchanged): --amount has no meaning — a token transfers as a whole. Refuse rather
  // than silently ignore.
  if (flags.amount !== undefined) {
    throw new Error(`--amount is edition-only (ERC-1155 copies) — ${contract} is a ${kind.label} (721), where a token transfers as a whole. Drop --amount.`);
  }
  const from = await read<Address>(contract, 'ownerOf', [tokenId]);
  const tx: PreparedTx = prepareTransfer({contract, from, to, tokenId, chainId: chainId()});
  await runWrite(contract, tx, flags, from);
}

// ── set-token-uri ──────────────────────────────────────────────────────────--
// `--uri <base>` re-points the resolver BASE (the contract derives {base}/{chainId}/{address}/{tokenId}).
// `--override <uri> [--token <id>]` pins ONE token to a fixed locator (e.g. ipfs://) — the rare,
// deliberate escape out of the spec; pass an empty string to clear it.
export async function cmdSetTokenUri(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-token-uri <address> (--uri <base> | --override <uri> [--token <id>]) [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const owner = await read<Address>(contract, 'owner');
  if (flags.override !== undefined) {
    const tokenId = flags.token ? Number(flags.token) : 0;
    await runWrite(contract, prepareSetTokenURIOverride({contract, tokenId, uri: flags.override, chainId: chainId()}), flags, owner);
    return;
  }
  const base = requireFlag(flags, 'uri', usage);
  await runWrite(contract, prepareSetTokenURIBase({contract, base, chainId: chainId()}), flags, owner);
}

// ── set-contract-uri ─────────────────────────────────────────────────────────
// `--uri <base>` re-points the collection base; `--override <uri>` pins a fixed locator.
export async function cmdSetContractUri(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-contract-uri <address> (--uri <base> | --override <uri>) [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const owner = await read<Address>(contract, 'owner');
  if (flags.override !== undefined) {
    await runWrite(contract, prepareSetContractURIOverride({contract, uri: flags.override, chainId: chainId()}), flags, owner);
    return;
  }
  const base = requireFlag(flags, 'uri', usage);
  await runWrite(contract, prepareSetContractURIBase({contract, base, chainId: chainId()}), flags, owner);
}

// ── set-royalty ──────────────────────────────────────────────────────────────
/** Parse + bound-check a royalty `--bps` (basis points). The bound is the CONTRACT's cap, not ERC-2981's
 *  range — see {@link MAX_ROYALTY_BPS}. Throws a plain-language
 *  error on a non-integer or out-of-range value instead of letting it hit the chain (or a cryptic
 *  ABI read). Exported for the regression test. */
export function parseRoyaltyBps(raw: string): number {
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_ROYALTY_BPS) {
    throw new Error(
      `--bps must be a whole number 0–${MAX_ROYALTY_BPS} (100 = 1%, 750 = 7.5%, ${MAX_ROYALTY_BPS} = ${MAX_ROYALTY_BPS / 100}%); got '${raw}'. ` +
        `A collection's own royalty cap (owner-set at deploy, reduce-only) may be lower and is enforced on chain.`,
    );
  }
  return bps;
}

export async function cmdSetRoyalty(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx set-royalty <address> --bps <0-1000> [--receiver 0x…] [--sign|--unsigned]');
  const bps = parseRoyaltyBps(requireFlag(flags, 'bps', 'abx set-royalty <address> --bps <0-1000>'));
  const owner = await read<Address>(contract, 'owner');
  // Default the receiver to the CURRENT on-chain receiver so `--bps` alone just changes the rate.
  // Read it via the ERC-2981 `royaltyInfo` view (there is NO bare `royaltyReceiver()` getter —
  // reading one threw "not found on ABI", which broke `set-royalty --bps` without `--receiver`).
  // Fall back to the owner if it can't be read or is unset (a zero receiver would revert on set).
  let receiver = flags.receiver && flags.receiver !== 'true' ? (flags.receiver as Address) : undefined;
  if (!receiver) {
    receiver = await read<readonly [Address, bigint]>(contract, 'royaltyInfo', [0n, 10000n])
      .then((r) => r[0])
      .catch(() => owner);
    if (!receiver || receiver === zeroAddress) receiver = owner;
  }
  await runWrite(contract, prepareSetRoyalty({contract, receiver, bps, chainId: chainId()}), flags, owner);
}

/**
 * `abx set-royalty-cap <address> --cap <0-10000>` — lower the collection's royalty ceiling.
 * Owner-only and REDUCE-ONLY: the ceiling was fixed at deploy (default 10%, or the royalty rate if
 * higher) and can only ever come down, so buyers can trust a stated maximum. Both ways the chain
 * refuses are checked HERE, before any signing, so the refusal is instant and free rather than a paid
 * revert (reads are best-effort — an unreadable getter does NOT block, since the chain enforces
 * both invariants regardless):
 *   - not a reduction (`newCap >= currentCap`) → `RoyaltyCapNotReduced()`;
 *   - below the live royalty rate (`newCap < currentRoyaltyBps`) → `RoyaltyCapBelowRoyalty()`.
 */
export async function cmdSetRoyaltyCap(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-royalty-cap <address> --cap <0-10000> [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const cap = parseRoyaltyBps(requireFlag(flags, 'cap', usage));
  // The ceiling comes from the SDK's `readCollectionPolicy` — one owner of that getter, shared with
  // `abx state` and with any other integrator, rather than a second local read of the same fact.
  const [{maxRoyaltyBps: capNow}, royaltyNow] = await Promise.all([
    readCollectionPolicy(makePublicClient({chainKey: CHAIN}), contract),
    read<readonly [Address, bigint]>(contract, 'royaltyInfo', [0n, 10_000n]).then((r) => Number(r[1])).catch(() => null),
  ]);
  if (capNow !== null && cap >= capNow) {
    throw new Error(
      `${contract}'s royalty cap is already ${capNow / 100}% and a cap can only DECREASE — ${cap / 100}% would ` +
        `${cap === capNow ? 'leave it unchanged' : 'raise it'}, which the chain refuses (RoyaltyCapNotReduced). ` +
        `Pass a value below ${capNow / 100}% (a royalty cap is one-way by design: it can be tightened, never reopened).`,
    );
  }
  if (royaltyNow !== null && cap < royaltyNow) {
    throw new Error(
      `the current royalty rate is ${royaltyNow / 100}%, so a cap of ${cap / 100}% would sit BELOW it — the chain refuses ` +
        `that (RoyaltyCapBelowRoyalty: a cap can never drop under the live royalty). Lower the royalty first ` +
        `(\`abx set-royalty ${contract} --bps <=${cap}\`), or set a cap at or above ${royaltyNow / 100}%.`,
    );
  }
  const owner = await read<Address>(contract, 'owner');
  console.log(dim(`  royalty cap → ${(cap / 100).toFixed(2)}% (reduce-only)`));
  await runWrite(contract, prepareReduceMaxRoyaltyBps({contract, newMaxBps: cap, chainId: chainId()}), flags, owner);
}

// ── ERC-721C (creator token) — the transfer-validator surface ─────────────────
// Enrollment is a DEPLOY-TIME decision (`--721c` on the deploy commands) and permanent in both
// directions: an unenrolled token can never gain a validator, an enrolled one never sheds the
// standard. Within an enrolled token the owner re-points or suspends (zero) the validator freely.

/** The chain keys the manifest recommends a transfer validator for — for refusal messages. */
function chainsWithRecommendedValidator(): string {
  const ids = new Set(Object.keys(RECOMMENDED_TRANSFER_VALIDATOR).map(Number));
  return KNOWN_CHAIN_KEYS.filter((k) => ids.has(resolveChain(k).id)).join(', ');
}

/**
 * Parse a transfer-validator choice — the shared grammar of the deploy flag (`--721c`) and the
 * owner op (`abx set-transfer-validator`):
 *   - `recommended` (or a bare `--721c`) → the per-chain recommended validator, refusing on a
 *     chain the manifest has no entry for (naming the chains that do — never guess one);
 *   - a `0x…` address → checksum-validated (EIP-55) and returned as its canonical form;
 *   - `none`/zero → `allowNone` decides: the owner op suspends with it; the DEPLOY flag refuses
 *     it (a zero validator at deploy never enrolls — that is already the default, so someone
 *     passing it either wants plain ERC-721 (drop the flag) or mistakenly believes "enrolled but
 *     suspended" is a deploy-time state — it isn't).
 * Pure (no RPC) — callers do the has-code precheck themselves. Exported for the regression test.
 */
export function parseTransferValidatorValue(
  raw: string,
  opts: {chainId: number; chainLabel: string; allowNone?: boolean},
): Address {
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '' || s === 'recommended') {
    const rec = resolveRecommendedTransferValidator(opts.chainId);
    if (!rec) {
      throw new Error(
        `no recommended transfer validator is known for '${opts.chainLabel}' (chainId ${opts.chainId}) — ` +
          `chains with one: ${chainsWithRecommendedValidator() || '(none shipped)'}. ` +
          `Pass an explicit validator address instead (it must be a deployed contract on this chain).`,
      );
    }
    return rec;
  }
  if (s === 'none' || s === 'zero' || s === '0' || s === '0x0' || s === zeroAddress) {
    if (opts.allowNone) return zeroAddress;
    throw new Error(
      `a zero transfer validator never enrolls — a plain (unenrolled) token is already the default, so drop --721c. ` +
        `("enrolled but suspended" is not a deploy-time state: enroll with a real validator, then suspend ` +
        `with \`abx set-transfer-validator <address> none\`.)`,
    );
  }
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(
      `transfer validator must be 'recommended'${opts.allowNone ? ", 'none'," : ''} or a 0x address (0x + 40 hex); got '${raw}'`,
    );
  }
  // `isAddress` strict-validates the EIP-55 checksum of a mixed-case address (all-lowercase carries
  // no checksum and passes); `getAddress` alone only NORMALIZES — it would silently accept a
  // mis-cased paste, which is exactly the transposition this check exists to catch.
  if (!isAddress(trimmed, {strict: true})) {
    throw new Error(`transfer validator address failed its EIP-55 checksum: '${raw}' — paste it exactly (or all-lowercase).`);
  }
  return getAddress(trimmed);
}

/**
 * `abx set-transfer-validator <address> <0x…|none|recommended>` — re-point an ENROLLED (ERC-721C)
 * collection's transfer validator, or suspend enforcement with `none` (address(0); the token
 * STAYS enrolled). Refuses up front, before any signing: a plain ERC-721 (enrollment is
 * deploy-time-only — the contract would revert `NotCreatorToken()`), and a codeless validator
 * (would revert `InvalidTransferValidator()`). Owner-only, any lane, guards `--dry-run`.
 */
export async function cmdSetTransferValidator(address: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const usage = 'abx set-transfer-validator <address> <0x…|none|recommended> [--sign|--unsigned] [--dry-run]';
  const contract = requireAddress(address, usage);
  const [raw] = positionalArgs(rest);
  if (!raw) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }
  const cid = chainId();
  const validator = parseTransferValidatorValue(raw, {chainId: cid, chainLabel: CHAIN, allowNone: true});

  const publicClient = makePublicClient({chainKey: CHAIN});
  // Enrollment guard FIRST — a read, not a send. An unenrolled token would revert
  // `NotCreatorToken()`; refuse with the real story instead of letting the chain say it in hex.
  // (readCreatorTokenStatus is defensive, so check the contract exists first — a typo'd address
  // must not read as "plain ERC-721".)
  await assertContractExists(contract);
  const status = await readCreatorTokenStatus(publicClient, contract);
  if (!status.enrolled) {
    throw new Error(
      `${contract} did not enroll as a creator token — 721C/1155C enrollment is a deploy-time decision. ` +
        `Enrollment can never be added to a live collection; if enforcement is required, redeploy with ` +
        `--721c recommended (or --721c 0x…) on the deploy command.`,
    );
  }
  // Unusable-validator guard: the contract refuses a non-zero validator that fails its own probe —
  // no code, OR a permissive fallback that would enforce nothing (a Safe, an uninitialised proxy, a
  // 7702-delegated EOA). Both revert `InvalidTransferValidator()`, so the preflight has to ask the
  // same question the chain asks; a bare has-code check passed a creator's Safe and then let the
  // send fail on chain with an error whose documented meaning ("no code") was false for their case.
  if (validator !== zeroAddress) {
    const probe = await probeTransferValidator(publicClient, validator, {as: contract});
    if (probe.verdict === 'unreachable') {
      throw new Error(`couldn't verify the validator at ${validator} (${probe.error ?? 'RPC did not answer'}) — refusing to re-point blind; retry when the RPC answers.`);
    }
    if (probe.verdict !== 'ok') {
      const rec = resolveRecommendedTransferValidator(cid);
      const recHint = rec ? ` (the recommended one: \`abx set-transfer-validator ${contract} recommended\` → ${rec})` : '';
      throw new Error(
        probe.verdict === 'no-code'
          ? `no contract code at ${validator} on ${CHAIN} — the token would revert InvalidTransferValidator(). ` +
              `A transfer validator must be a DEPLOYED contract on this chain${recHint}.`
          : `${validator} has code on ${CHAIN}, but it is not a transfer validator — it answers ANY function call successfully ` +
              `(a Safe, an uninitialised proxy, or a 7702-delegated EOA does this), so every transfer would silently pass ` +
              `validation while ERC-165 and getTransferValidator() reported enforcement as ON. The token refuses it too ` +
              `(InvalidTransferValidator()). Pass a real validator contract${recHint}, or \`none\` to suspend enforcement.`,
      );
    }
  }
  if (eqAddr(status.validator, validator)) {
    console.log(dim(`  no change — the validator is already ${validator === zeroAddress ? 'suspended (0x0)' : validator}. Nothing sent.`));
    return;
  }
  const label = (a: Address) => (eqAddr(a, zeroAddress) ? 'suspended (0x0)' : a);
  console.log(dim(`  transfer validator: ${label(status.validator)} → ${label(validator)}${validator === zeroAddress ? '  — transfers go unvalidated until one is set again (the token stays enrolled)' : ''}`));
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetTransferValidator({contract, validator, chainId: cid}), flags, owner);
}

// ── the seed source — where a code project's mint randomness comes from ───────
// The canonical `AbxSeedSource` is deliberately pseudorandom: replayable after the mint (what makes
// generative output verifiable) and computable DURING it (so a buyer can decline an outcome for the
// price of gas — and on an EDITION, where the buyer names the id and the id is in the preimage, they
// can shop the unminted ids rather than merely decline; bounded by how many remain)
// price of gas). We tell creators that the escape hatch for anything lottery-like is "point
// `seedSource` at your own IAbxSeedSource over commit-reveal or a VRF oracle" — this is the surface
// that makes that promise real instead of a doc claim: `--seed-source` at deploy, `abx
// set-seed-source` after, and one probe standing in front of both.

/** The canonical `AbxSeedSource` for a chain — the manifest entry (the source of truth) with the
 *  CREATE2 prediction as the cross-chain fallback (the singleton is address-identical everywhere).
 *  Deliberately does NOT go through `resolveSeedSource`, which reads `ABX_SEED_SOURCE`: that env var
 *  names the source you have CONFIGURED, which is exactly the thing `canonical` exists to name the
 *  alternative to. Asking for `canonical` and silently getting your custom override would be the
 *  worst possible answer. */
export function canonicalSeedSource(chainId: number): Address {
  return (getDeployment(chainId).seedSource as Address | undefined) ?? predictSeedSource();
}

/**
 * Parse a seed-source choice — the shared grammar of the deploy flag (`--seed-source`) and the owner
 * op (`abx set-seed-source`):
 *   - `canonical` (or a bare `--seed-source`) → the chain's canonical `AbxSeedSource`, i.e. the
 *     default; spelled out so a creator can state it rather than rely on absence meaning it;
 *   - a `0x…` address → checksum-validated (EIP-55) and returned canonicalized. The caller MUST
 *     probe it (see {@link refuseUnusableSeedSource}) — a bad address here is silent until the
 *     first buyer, and then every mint reverts;
 *   - `none`/zero → `allowNone` decides: the owner op clears with it (future mints draw no seed);
 *     the DEPLOY flag refuses it and points at `--no-seed`, which already means exactly that. Two
 *     spellings of one thing is how a creator ends up unsure which they used.
 * Pure (no RPC) — mirrors `parseTransferValidatorValue`, deliberately, so the two knobs read the
 * same. Exported for the regression test.
 */
export function parseSeedSourceValue(
  raw: string,
  opts: {chainId: number; allowNone?: boolean},
): Address {
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '' || s === 'canonical' || s === 'default') return canonicalSeedSource(opts.chainId);
  if (s === 'none' || s === 'zero' || s === '0' || s === '0x0' || s === zeroAddress) {
    if (opts.allowNone) return zeroAddress;
    throw new Error(
      `--seed-source none is refused: "no mint-time seed" already has a flag — pass \`--no-seed\` instead. ` +
        `(One meaning, one spelling: --seed-source names WHERE the seed comes from, --no-seed says there isn't one.)`,
    );
  }
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(
      `seed source must be 'canonical'${opts.allowNone ? ", 'none'," : ''} or a 0x address (0x + 40 hex); got '${raw}'`,
    );
  }
  // Strict EIP-55 (see the identical note on parseTransferValidatorValue): `getAddress` alone only
  // normalizes, so a mis-cased paste would sail through — and a seed source pointed one nibble off
  // is a collection whose every mint reverts.
  if (!isAddress(trimmed, {strict: true})) {
    throw new Error(`seed source address failed its EIP-55 checksum: '${raw}' — paste it exactly (or all-lowercase).`);
  }
  return getAddress(trimmed);
}

/**
 * Turn a non-`ok` {@link SeedSourceProbe} into the refusal a creator can act on. One place, because
 * the deploy flag and the owner op hit the identical failure shapes and must say the identical
 * thing; `context` only names which surface asked (so the fix names the right flag).
 *
 * Every branch is a REFUSAL, not a warning. A seed source is the one setting where "looks fine, is
 * broken" is the normal outcome of a mistake: `seedSource()` reads back exactly what you set, the
 * `SeedSourceSet` event fires, `abx state` shows it — and then the first mint reverts in the ABI
 * decode of a return that isn't 32 bytes. There is no later moment at which this gets easier to
 * notice, so it is caught here or it is caught by a buyer.
 */
export function refuseUnusableSeedSource(probe: SeedSourceProbe, context: {flag: string; chainLabel: string}): never {
  const {flag, chainLabel} = context;
  const head = `${flag}: ${probe.address} is not a usable seed source on ${chainLabel}`;
  const tail =
    `\n  A seed source must answer \`seed(uint256 tokenId, address to)\` with 32 bytes — the token calls it ` +
    `SYNCHRONOUSLY inside every mint and decodes the result as \`bytes32\`, so anything else reverts the mint.`;
  switch (probe.verdict) {
    case 'no-code':
      throw new Error(
        `${head} — there is no contract code there.${tail}\n` +
          `  (A Solidity call to a codeless address succeeds with empty returndata, so the revert would land in the ` +
          `decode, at mint time, for every buyer. Check the address and the chain — ${flag} is chain-specific.)`,
      );
    case 'empty-return':
      throw new Error(
        `${head} — it has code, answered, and returned NOTHING.${tail}\n` +
          `  This is the permissive-fallback shape: a Safe (its fallback returns empty for an unset handler), an ` +
          `uninitialised proxy, or an EIP-7702-delegated EOA. Pasting your own wallet/Safe here is the common way in. ` +
          `A seed source is a purpose-built contract implementing IAbxSeedSource — commit-reveal or a VRF oracle.`,
      );
    case 'short-return':
      throw new Error(
        `${head} — it answered with only ${probe.returnedBytes} byte(s), not 32.${tail}\n` +
          `  Whatever is deployed there has a different ABI; it is not an IAbxSeedSource.`,
      );
    case 'reverted':
      throw new Error(
        `${head} — the call reverted (${probe.error ?? 'no reason returned'}).${tail}\n` +
          `  Two ways in: (1) it isn't a seed source at all — a token, a renderer, a registry has no such function; ` +
          `(2) it IS one, but it refuses right now (gating callers, or not yet armed/committed). Both are refusals here: ` +
          `a source that cannot answer today cannot answer at mint either, and its revert would bubble through the mint. ` +
          `Arm the source first, then point at it.`,
      );
    default:
      // `unreachable` and any verdict a future SDK adds: refuse rather than proceed. A `default` (not
      // a `case 'unreachable'`) so a new verdict cannot silently become "allowed" by falling through.
      throw new Error(
        `${head} — couldn't verify it (${probe.verdict}${probe.error ? `: ${probe.error}` : ''}). ` +
          `Refusing to configure a seed source blind; retry when the RPC answers.`,
      );
  }
}

/**
 * `abx set-seed-source <address> <0x…|canonical|none>` — re-point (or clear) where a code project
 * draws its mint seeds. Owner-only; **future mints only**, because a seed settles the moment it is
 * assigned and nothing rewrites it. Refuses before any signing: a target with no Seed Source
 * extension (a 1/1 or an image Series — there is nothing to set), and any candidate the probe
 * rejects.
 *
 * This op is deliberately loud about one thing the chain cannot enforce: re-pointing mid-sale means
 * tokens minted before and after draw from **different** sources. That is legitimate (it is how you
 * fix a broken source, or hand over to a commit-reveal one), and it is public — `SeedSourceSet` is
 * on the event spine and `abx state` prints the current source — but a collector who bought early
 * has no way to know it will happen. So the print names the split when supply already exists.
 */
export async function cmdSetSeedSource(address: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const usage = 'abx set-seed-source <address> <0x…|canonical|none> [--sign|--unsigned] [--dry-run]';
  const contract = requireAddress(address, usage);
  const [raw] = positionalArgs(rest);
  if (!raw) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }
  const cid = chainId();
  const source = parseSeedSourceValue(raw, {chainId: cid, allowNone: true});

  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertContractExists(contract);
  // Extension guard FIRST — a read, not a send. `seedSource()` is absent on a 1/1 / image Series, so
  // `setSeedSource` there is a call to a selector the contract doesn't have: it would revert with no
  // reason bytes at all. Say what the target actually is instead.
  const current = await readSeedSource(publicClient, contract);
  if (current === undefined) {
    throw new Error(
      `${contract} has no seed source to set — the Seed Source extension is composed only by CODE projects ` +
        `(SeriesCode / EditionCode, i.e. \`abx deploy-code\`). An image 1/1 or Series has no mint-time seed at all, ` +
        `and the extension can't be added to a live contract.`,
    );
  }
  if (eqAddr(current, source)) {
    console.log(dim(`  no change — the seed source is already ${source === zeroAddress ? 'cleared (0x0 — no mint-time seed)' : source}. Nothing sent.`));
    return;
  }
  if (source !== zeroAddress) {
    const probe = await probeSeedSource(publicClient, source, {as: contract});
    if (probe.verdict !== 'ok') refuseUnusableSeedSource(probe, {flag: 'set-seed-source', chainLabel: CHAIN});
  }

  const label = (a: Address) => (eqAddr(a, zeroAddress) ? 'none (0x0 — no mint-time seed)' : eqAddr(a, canonicalSeedSource(cid)) ? `${a} (canonical AbxSeedSource)` : a);
  console.log(dim(`  seed source: ${label(current)} → ${label(source)}`));
  // Seeds already assigned are settled — say so, and say what the split means. `totalSupply()` is a
  // 721 getter (an edition's is per-id), so the count is best-effort; the note itself is not, because
  // "future mints only" is the part a creator has to understand before sending.
  const minted = await readSeries<bigint>(contract, 'totalSupply').catch(() => null);
  if (minted === null || minted > 0n) {
    console.log(
      dim(
        `  ${minted === null ? 'Tokens' : `${minted} token(s)`} already minted carry a seed drawn from ${label(current)} — settled, and unchanged by this. ` +
          `This applies to FUTURE mints only, so a part-sold collection ends up spanning two sources. The change is public ` +
          `(SeedSourceSet on the event spine; \`abx state ${contract}\` prints the current one), but a collector who ` +
          `already bought won't be told — if the drop is live, consider pausing and saying so.`,
      ),
    );
  }
  if (source === zeroAddress) {
    console.log(dim('  clearing means future mints draw NO seed at all — a generative program that expects one will render blank/identical.'));
  } else if (!eqAddr(source, canonicalSeedSource(cid))) {
    console.log(dim("  custom source — its randomness properties are now yours to state to buyers; ABX makes no claim about them."));
  }
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareSetSeedSource({contract, seedSource: source, chainId: cid}), flags, owner);
}

// ── multi-chunk on-chain content (the `reader` path) ─────────────────────────
// The plan math (chunk count + tx shape), the cost-model constants, and the actual
// plan→resolve-store→stage→encode orchestration all live in the SDK's staging.ts, layered on
// planChunks/planContentTxs/stageContent/encodeReader/ensureChunkStore — see its module doc. What
// stays here is Node-only (reading the file, gzip) plus the narration: every console.log below is
// this file's onEvent handler for the SDK's `StagingEvent`, so the lines are unchanged from before
// the move.

export function parseCompress(v: string | undefined): Compress {
  const c = (v ?? 'none').toLowerCase();
  if (c === 'none' || c === 'fastlz' || c === 'gzip') return c;
  throw new Error(`--compress must be none | fastlz | gzip (got '${v}')`);
}

/** The chunk-store bootstrap narration shared by every content-staging path below — one place so
 *  the lines are identical whether the store is resolved for a single field ({@link putContentOnChain}
 *  → the SDK's `stageFieldContent`) or once up front for a whole batch ({@link ensureChunkStore}). */
function printChunkStoreEvent(e: ChunkStoreEvent): void {
  if (e.kind === 'stale') console.log(yellow(`  configured chunk store ${e.address} is a stale deployment (no writeContent) — deploying a current one`));
  else if (e.kind === 'canonical') console.log(dim(`  using the canonical chunk store at its deterministic address ${e.address}`));
  else if (e.kind === 'deploying') console.log(dim('  deploying the canonical multi-chunk content store (AbxChunkStore) — CREATE2…'));
  else {
    console.log(`  ${green('✓')} chunk store ${e.address}`);
    console.log(dim(`  not in the shipped manifest for ${CHAIN} — to reuse it set ABX_CHUNK_STORE=${e.address} (or add it to packages/sdk/src/deployments.ts)`));
  }
}

/**
 * The chain's shared multi-chunk store/reader; deploy it once if missing, signing through
 * `send` (the env key on the hot lane, or the connected wallet on the wallet lane) — the
 * store is ownerless, so any funded signer can stand it up. Used directly only by
 * {@link stageImageFieldsBatch} (resolving ONE store up front for every token); a single-field
 * stage ({@link putContentOnChain}) resolves its store through the SDK's `stageFieldContent`
 * instead, which calls the very same SDK `ensureChunkStore` internally.
 */
async function ensureChunkStore(send: SendTx, override?: string): Promise<Address> {
  // The resolution logic lives in the SDK (`ensureChunkStore`) so an SDK integrator bootstraps
  // identically instead of hand-rolling the "is this store capable?" guard — forget it and an
  // incapable store fails deep inside a mint, after transactions have landed. The CLI keeps only the
  // narration: the SDK reports progress through `onEvent` rather than printing.
  const publicClient = makePublicClient({chainKey: CHAIN});
  return sdkEnsureChunkStore(publicClient, send, {chainId: chainId(), override, onEvent: printChunkStoreEvent});
}

/**
 * The hot-lane staging signer: the env key signs + broadcasts each chunk-store write, via the
 * SDK's `makeHotSender` (pinned nonce, pinned gas, typed revert). Built lazily so commands that
 * never stage on-chain don't require a key. The wallet lane passes a session-backed sender
 * instead (see {@link openWalletSession}); the cold lane can't stage interactively, so it's
 * rejected up front by the deploy/set-field commands.
 */
export function envStagingSender(): SendTx {
  const {wallet, account} = makeWalletClient({chainKey: CHAIN});
  const publicClient = makePublicClient({chainKey: CHAIN});
  return makeHotSender({wallet, account, publicClient});
}

/** Wallet-lane staging signer: each chunk-store write is approved in the human's browser
 *  wallet through the open {@link WalletSession}, sharing one connection with the final tx. A
 *  {@link PreparedTx} already carries everything `session.send` needs, so this is a thin adapter. */
export function sessionStagingSender(session: WalletSession): SendTx {
  return async (tx) => (await session.send(tx)).receipt;
}

const kb = (n: number): string => `${n < 10 * 1024 ? (n / 1024).toFixed(1) : Math.round(n / 1024)}KB`;
const mgas = (n: number): string => `~${(n / 1_000_000).toFixed(0)}M gas`;

/**
 * The measured `eth_call` gas allowance of the best configured endpoint, cached for the process.
 * `null` = could not be measured (an endpoint that rejects state overrides, or is unreachable),
 * which is a normal outcome and never blocks anything — the report degrades to the conservative
 * {@link ETH_CALL_GAS_FLOOR} instead.
 *
 * Measured once per run because it is a property of the endpoint, not of the content: a 40-file
 * Series should not fire 40 probes.
 */
let cachedGasCap: {gasCap: number | null; label: string | null} | undefined;

/** Measure (once) what the configured RPCs will actually serve an `eth_call`. Never throws. */
export async function ensureRpcGasCap(): Promise<{gasCap: number | null; label: string | null}> {
  if (cachedGasCap === undefined) {
    try {
      cachedGasCap = await probeBestEthCallGasCap();
    } catch {
      cachedGasCap = {gasCap: null, label: null};
    }
  }
  return cachedGasCap;
}

/** Test seam: force the cached cap (or clear it with `undefined`). */
export function __setRpcGasCapForTest(v: {gasCap: number | null; label: string | null} | undefined): void {
  cachedGasCap = v;
}

/**
 * Report what putting `bytesLen` of content on-chain costs, on both axes that matter — and REFUSE
 * NOTHING at any size.
 *
 * Readability depends on the configured RPC's `eth_call` cap, so the toolkit reports the measured
 * allowance instead of refusing content at a fixed byte threshold.
 *
 * Two axes, and they fail differently:
 *   • WRITE is chunked (22,000-byte SSTORE2 chunks across separate transactions), so no block gas
 *     limit ever binds it. It is purely a money question at ~200 gas/byte.
 *   • READ is one `eth_call`, and whether it succeeds is a property of WHOSE endpoint is asking.
 *     Ours is measurable; a marketplace's is not, and that distinction survives into the output.
 *
 * Returns true if it printed anything.
 */
export async function guardOnChainSize(bytesLen: number, label: string): Promise<boolean> {
  const {gasCap, label: rpcLabel} = await ensureRpcGasCap();
  const verdict = classifyOnchainReadSize(bytesLen, gasCap);
  const readGas = tokenUriGasEstimate(bytesLen);
  const writeGas = bytesLen * 200;
  const floorKb = kb(readableBytesAtGas(ETH_CALL_GAS_FLOOR));
  const uncapped = gasCap === Number.POSITIVE_INFINITY;
  const capText = uncapped ? 'no eth_call cap at all' : `${mgas(gasCap ?? 0)}`;
  const servesText = uncapped ? 'any size this toolkit can write' : `~${kb(readableBytesAtGas(gasCap ?? 0))}`;
  // The route that dissolves the reach problem entirely, and the reason none of this is a refusal:
  // a resolver reads the on-chain bytes with ITS rpc and serves them as ordinary HTTP, so the
  // marketplace never makes the big eth_call. The bytes stay on-chain and permanent either way.
  const resolverRoute =
    ' Reach is fixable after the fact and the bytes are permanent regardless: a resolver reads on-chain content and serves it over plain HTTP' +
    ' (abx deploy-resolver, or a hosted one), so marketplaces fetch a URL instead of making this call — point tokenURI at it with `abx set-renderer <addr> --off`.' +
    ' On-chain storage is preservation; serving is a separate, swappable choice.';

  if (verdict === 'beyond-local-rpc') {
    console.log(yellow(`  ⚠ ${label} is ${kb(bytesLen)} on-chain — reading tokenURI in ONE call costs ${mgas(readGas)}, past what your own RPC serves (${capText}${rpcLabel ? `, ${rpcLabel}` : ''}).`));
    console.log(dim(`    Writing is unaffected — ${mgas(writeGas)}, chunked, and the bytes are permanent the moment they land.${resolverRoute}`));
    return true;
  }

  if (verdict === 'endpoint-dependent') {
    console.log(yellow(`  ⚠ ${label} is ${kb(bytesLen)} on-chain — reading tokenURI in ONE call costs ${mgas(readGas)}, past the ${mgas(ETH_CALL_GAS_FLOOR)} floor every endpoint serves.`));
    console.log(dim(`    ${gasCap != null ? `Measured just now, your RPC allows ${capText}${rpcLabel ? ` (${rpcLabel})` : ''} — it serves ${servesText}.` : `Your RPC's cap could not be measured, so the floor below is the reference.`} We can measure yours; we CANNOT know a marketplace's or an indexer's, and those are the ones that decide whether your token displays. On a 50M-capped provider the ceiling is ~${floorKb}, and past it they see a revert. Writing is unaffected: ${mgas(writeGas)}, chunked.${resolverRoute}`));
    return true;
  }

  if (bytesLen >= ONCHAIN_READ_WARN_BYTES) {
    console.log(dim(`  ${label} is ${kb(bytesLen)} on-chain — ${mgas(writeGas)} to write (chunked), ${mgas(readGas)} to read. Under the ${mgas(ETH_CALL_GAS_FLOOR)} every endpoint serves, so it renders anywhere.`));
    return true;
  }

  if (exceedsOnchainSoftLimit(bytesLen)) {
    console.log(dim(`  ${label} is ${kb(bytesLen)} — past ~${kb(ONCHAIN_IMAGE_SOFT_LIMIT)}/file on-chain costs more to write than off-chain (~200 gas/byte), so pick it for self-resolution, not for price. Reading tokenURI: ${mgas(readGas)}.`));
    return true;
  }
  return false;
}

/**
 * Pure staging plan for a piece of content — chunk count + transaction shape — with NO chain
 * writes, no signer, no `ensureChunkStore`. The CLI-facing wrapper over the SDK's pure
 * {@link planStagedContent}: `gzip` is a Node-only transform, so it happens here (not in the SDK —
 * see staging.ts's module doc) before handing the result off to the SDK's chunk/tx-shape math.
 * Shared by {@link putContentOnChain} (which then actually stages) and the deploy dry-run preview,
 * so the count the human is told up front is the same one the real staging will produce.
 */
export function computeContentPlan(bytes: Buffer, compress: Compress): ContentPlan {
  const content = compress === 'gzip' ? new Uint8Array(gzipSync(bytes)) : new Uint8Array(bytes);
  return planStagedContent(content, compress);
}

/** Human-readable size line for a content plan, e.g. `2812B → 1 chunk [fastlz 2812→904B]`. */
function planSizeLine(bytes: number, p: ContentPlan, compress: Compress): string {
  const savings =
    compress === 'fastlz'
      ? `fastlz ${bytes}→${p.stagedBytes}B`
      : compress === 'gzip'
        ? `gzip ${bytes}→${p.stagedBytes}B (off-chain decode)`
        : 'no compression';
  return `${bytes}B → ${p.chunks} chunk(s) [${savings}]`;
}

/**
 * The transaction-count line for a content plan, given what the FINAL (owner) tx is —
 * a separate `set-field` after staging, or the `deploy` that bakes the reader field in.
 * Staging itself is 1 atomic `writeContent` (content fits one tx's gas) or N gas-bounded
 * chunk-batch txs + 1 manifest tx.
 */
function planTxLine(p: ContentPlan, finalLabel: string): string {
  return p.plan.mode === 'single'
    ? `plan: 1 staging tx (atomic writeContent) + ${finalLabel} = 2 transactions`
    : `plan: ${p.plan.batches.length} chunk-batch tx(s) + 1 manifest tx + ${finalLabel} = ${p.plan.txCount + 1} transactions`;
}

/**
 * Put `bytes` on-chain as SSTORE2 chunks behind the shared reader, and return the field's
 * `(representation, value)`. `fastlz` compresses per chunk (reader decodes on read → stays
 * on-chain renderable); `gzip` compresses the whole content (off-chain decode → the
 * `reader-gzip` representation, not on-chain renderable) — done here, not in the SDK's
 * `stageFieldContent` (a Node-only transform; see staging.ts's module doc).
 *
 * Staging is one atomic `writeContent` when the content fits a single tx's gas, else
 * gas-bounded chunk-write `multicall`s plus a final manifest write — the SDK picks, and we
 * print the tx plan up front (via its `onEvent`) so the human knows the count before signing.
 * These store writes use the env key (the data contracts are ownerless); the owner only
 * signs the field set that references the manifest.
 */
async function putContentOnChain(
  bytes: Buffer,
  compress: Compress,
  field: string,
  send: SendTx,
  finalLabel = '1 owner field-set',
  store?: Address, // pre-resolved store (batch staging reuses one); else resolve/deploy here
): Promise<{value: Hex; representation: string}> {
  await guardOnChainSize(bytes.length, `'${field}'`);
  const content = compress === 'gzip' ? new Uint8Array(gzipSync(bytes)) : new Uint8Array(bytes);
  const publicClient = makePublicClient({chainKey: CHAIN});
  return stageFieldContent({
    content,
    compress,
    field,
    send,
    publicClient,
    chainId: chainId(),
    store,
    onEvent: (e: StagingEvent) => {
      if (e.kind === 'chunk-store') printChunkStoreEvent(e.event);
      else if (e.kind === 'planned') {
        console.log(dim(`  '${field}' on-chain: ${planSizeLine(bytes.length, e.contentPlan, compress)} via reader ${e.store}`));
        console.log(dim(`    ${planTxLine(e.contentPlan, finalLabel)}`));
      } else {
        console.log(dim(`    staged in ${e.txHashes.length} tx(s); manifest → ${e.manifest}`));
      }
    },
  });
}

export function refusePrewrappedImage(bytes: Uint8Array | string, label: string): void {
  const head = typeof bytes === 'string' ? bytes.slice(0, 40) : new TextDecoder().decode(bytes.subarray(0, 40));
  if (/^\s*data:/i.test(head)) {
    throw new Error(
      `${label} is already a data URI. The on-chain renderer wraps inline image bytes as a data URI ` +
        'itself — storing one produces a blank (double-wrapped) token. Pass the raw SVG, starting with <svg or <?xml.',
    );
  }
}

/**
 * Dry-run preview of staging an image fully on-chain — the REAL chunk + transaction plan,
 * computed without writing anything (so `abx deploy --dry-run --onchain-image` reports the
 * true count instead of leaving the agent to guess). The final tx here is the deploy that
 * bakes in the reader field, so the count is staging tx(s) + the deploy.
 */
export async function previewImageStaging(imagePath: string, compress: Compress): Promise<string> {
  const bytes = readFileSync(resolvePath(imagePath));
  refusePrewrappedImage(bytes, basename(resolvePath(imagePath)));
  const p = computeContentPlan(bytes, compress);
  // The gate runs on the dry-run too: a refusal a creator only meets after the first staging tx has
  // landed is a refusal that already cost them gas.
  await guardOnChainSize(bytes.length, basename(resolvePath(imagePath)));
  return (
    `would stage ${basename(resolvePath(imagePath))} on-chain (chunk store): ` +
    `${planSizeLine(bytes.length, p, compress)} as ${p.representation}; ` +
    `${planTxLine(p, '1 deploy (bakes the reader field + mints)')}`
  );
}

/**
 * Stage an image file fully on-chain (chunk store) and return the `reader`-backed
 * `image` field to bake into a deploy's `InitParams.tokenFields`. The staging writes
 * are ownerless (env key) and happen before the deploy, so "deploy a 50 kB on-chain
 * image" is just those staging tx(s) + the single deploy — no post-deploy `set-field`.
 * The manifest is deployer-independent, so this is computed once and reused for any signer.
 */
export async function stageImageField(
  imagePath: string,
  compress: Compress,
  send: SendTx,
): Promise<{field: OnChainFieldInput; note: string}> {
  const bytes = readFileSync(resolvePath(imagePath));
  refusePrewrappedImage(bytes, basename(resolvePath(imagePath)));
  const {value, representation} = await putContentOnChain(bytes, compress, 'image', send, '1 deploy (bakes the reader field + mints)');
  return {
    field: {field: encodeTag(F.image), representation: encodeTag(representation), value},
    note: `image: ${bytes.length}B staged ON-CHAIN via reader (${representation}) — baked into the deploy`,
  };
}

/**
 * Stage MANY images on-chain against a **single, shared** chunk store — the batch form of
 * {@link stageImageField} for a Series. The store is resolved/deployed **once** (not per token),
 * then every file is staged against it and returned as its own `reader`-backed `image` field.
 * Each field still points at its own manifest, so each token's work is independent; they just
 * share the store contract. Returns the fields in input order (token order).
 */
export async function stageImageFieldsBatch(
  imagePaths: string[],
  compress: Compress,
  send: SendTx,
  storeOverride?: string,
): Promise<{fields: OnChainFieldInput[]; store: Address}> {
  const store = await ensureChunkStore(send, storeOverride);
  const fields: OnChainFieldInput[] = [];
  for (const imagePath of imagePaths) {
    const bytes = readFileSync(resolvePath(imagePath));
    const {value, representation} = await putContentOnChain(
      bytes,
      compress,
      'image',
      send,
      '1 deploy (bakes the reader fields + mints)',
      store,
    );
    fields.push({field: encodeTag(F.image), representation: encodeTag(representation), value});
  }
  return {fields, store};
}

// ── the generator repoint guard ───────────────────────────────────────────────
// The canonical AbxGenerator reads a token's param surface FROM CHAIN (`tokenParamKeys` /
// `contractParamKeys`). A LEGACY implementation — deployed before enumeration shipped — has neither
// getter, so the generator finds nothing: every configured param vanishes from tokenData and from
// the live view, silently, behind a tokenURI that still looks perfectly healthy. That is the exact
// failure class this toolkit refuses rather than warns about, so pointing a legacy token at the
// current generator is REFUSED. (Repointing the metadata RENDERER is safe and unguarded: a v4
// renderer on a legacy token just emits no params block.)

// ── structured representations: `--value` is not raw bytes ───────────────────
// Two representations carry a STRUCTURE rather than content, and the metadata renderer decodes
// them before it can resolve the field: `renderer` is `abi.encode(address fieldRenderer)` (32
// bytes) and `reader`/`reader-gzip` is `abi.encode(address reader, address pointer)` (64 bytes).
//
// `--value` used to be written to chain VERBATIM. So the natural input — a bare 20-byte address,
// exactly what `--image-renderer` takes at deploy — landed as 20 bytes, and `abi.decode(v,
// (address))` reverts on anything shorter than a word. The field itself read back fine, which is
// what made this so hard to see from outside: `contractField("image")` returned the right
// representation and the right-looking address, and `tokenURI` reverted for EVERY token in the
// collection. Re-pointing at the renderer the collection was deployed with didn't fix it either —
// every post-deploy write had the same wrong shape, so it looked permanent and looked like the
// protocol's fault. Reported from the field on alpha.29 after four builds on Base Sepolia.
//
// Enforce, don't warn: normalize what is unambiguous (a bare address IS the field renderer),
// refuse what is not, and never let a shape the renderer cannot decode reach the chain.

/** Canonical `abi.encode(address)` — 24 zero nibbles then the 40 address nibbles. */
const ABI_WORD_PAD = '0'.repeat(24);

/**
 * The on-chain bytes for `--value` under `representation`. For a structured representation this
 * normalizes (a bare address → `abi.encode(address)`) and REFUSES anything the renderer could not
 * decode; every other representation carries raw bytes and passes through untouched.
 */
export function encodeStructuredFieldValue(representation: string, value: string): Hex {
  const hex = value.trim();
  if (representation === R.renderer) {
    // A bare 20-byte address: the shape `--image-renderer` takes, and what anyone reading
    // `contractField` back sees. Encode it rather than making the creator pad it by hand.
    if (/^0x[0-9a-fA-F]{40}$/.test(hex)) return encodeFieldRenderer(getAddress(hex) as Address);
    if (/^0x[0-9a-fA-F]{64}$/.test(hex)) {
      if (hex.slice(2, 26).toLowerCase() !== ABI_WORD_PAD) {
        throw new CliError(
          `--representation renderer needs abi.encode(address) — a 32-byte word whose first 12 bytes are zero.\n` +
            `  ${hex} is 32 bytes but its high bytes are not zero, so it decodes to a garbage address and every\n` +
            `  tokenURI in the collection would revert. Pass the field renderer's plain 0x address instead.`,
        );
      }
      return hex.toLowerCase() as Hex;
    }
    throw new CliError(
      `--representation renderer expects the field renderer's 0x address (20 bytes) — not ${byteLen(hex)}.\n` +
        `  The chain stores this field as abi.encode(address) and the metadata renderer abi.decode()s it before\n` +
        `  it can call render(); any other length reverts tokenURI for the WHOLE collection.\n` +
        `  Example: abx set-field <token> --field image --value 0xYourFieldRenderer --representation renderer --collection`,
    );
  }
  if (representation === R.reader || representation === R.readerGzip) {
    const ok =
      /^0x[0-9a-fA-F]{128}$/.test(hex) &&
      hex.slice(2, 26).toLowerCase() === ABI_WORD_PAD &&
      hex.slice(66, 90).toLowerCase() === ABI_WORD_PAD;
    if (!ok) {
      throw new CliError(
        `--representation ${representation} expects abi.encode(address reader, address pointer) — 64 bytes, two\n` +
          `  zero-padded address words — not ${byteLen(hex)}. Hand-encoding this is rarely what you want:\n` +
          `  \`abx set-field <token> --field <name> --file <path>\` stages the bytes on chain and writes the\n` +
          `  reader value for you, correctly.`,
      );
    }
    return hex.toLowerCase() as Hex;
  }
  return hex as Hex;
}

/** "20 bytes" / "not hex" — the half of the message that says what the input actually was. */
function byteLen(hex: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) return `'${hex}' (not an even-length 0x hex string)`;
  const n = (hex.length - 2) / 2;
  return `${n} byte${n === 1 ? '' : 's'}`;
}

/**
 * Refuse a `renderer` field that points at an address with NO CODE — the same guard
 * `deploy-code --image-renderer` applies, now on the post-deploy path it was missing from. A
 * codeless target passes every static check and still reverts every tokenURI.
 */
export async function assertFieldRendererDeployed(value: Hex): Promise<void> {
  let target: Address;
  try {
    target = decodeFieldRenderer(value);
  } catch {
    return; // not decodable as an address — encodeStructuredFieldValue already refused those
  }
  if (target === zeroAddress) {
    throw new CliError(
      'a `renderer` field pointing at the zero address reverts every tokenURI. To stop computing this field on\n' +
        '  chain, set it to a real representation (--text / --value with `inline`, `url`, `ipfs`, …) instead.',
    );
  }
  const publicClient = makePublicClient({chainKey: CHAIN});
  let code: string | undefined;
  try {
    code = await publicClient.getCode({address: target});
  } catch {
    return; // node unreachable — the owner read upstream already proved it was, so don't invent a failure
  }
  if (!code || code === '0x') {
    throw new CliError(
      `${target} has NO code on '${CHAIN}' — that is not a deployed IAbxFieldRenderer, and pointing a field at it\n` +
        `  reverts tokenURI for every token in the collection. Deploy the renderer first (\`abx scaffold solidity\`\n` +
        `  → forge test → forge script), then pass the address it printed.`,
    );
  }
}

/** The field-renderer address a `--value` names: the canonical `abi.encode(address)` (32 bytes),
 *  or a bare 20-byte address. Null when it is neither. */
function fieldRendererTarget(value: string): Address | null {
  const hex = value.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex.length === 42) return getAddress(hex) as Address;
  if (hex.length !== 66) return null;
  try {
    return decodeFieldRenderer(hex as Hex);
  } catch {
    return null;
  }
}

export async function assertGeneratorRepointable(
  contract: Address,
  field: string,
  flags: Flags,
  /** Injected for tests; the real probe is one eth_call. */
  probe: (c: Address) => Promise<boolean> = (c) => hasParamEnumeration(makePublicClient({chainKey: CHAIN}), c),
): Promise<void> {
  if (flags.representation !== R.renderer || !flags.value || flags.value === 'true') return;
  const target = fieldRendererTarget(flags.value);
  const generator = resolveGenerator(chainId());
  // Only the CANONICAL generator is guarded — any other field renderer is the creator's own contract
  // and none of our business.
  if (!target || !generator || target.toLowerCase() !== generator.toLowerCase()) return;
  // The `owner` read has already succeeded by the time this runs, so the RPC is proven reachable:
  // a failing probe here means the getter is absent, not that the node is down.
  if (await probe(contract)) return;
  throw new Error(
    `refusing to point ${field} at the canonical generator ${generator} — ${contract} does not expose the param\n` +
      `  enumeration surface (tokenParamKeys/contractParamKeys), so it is a LEGACY implementation. The current\n` +
      `  generator reads params FROM CHAIN, so on this token it would read NOTHING: every configured param would\n` +
      `  silently disappear from tokenData, the live view, and every render — with a tokenURI that still looks fine.\n\n` +
      `  Two honest options:\n` +
      `    • stay on the generator this project already uses (pass that address as --value; it reads the project's\n` +
      `      params.keys list, which is how it has always worked here), or\n` +
      `    • redeploy the project with the current \`abx deploy-code\` — new projects enumerate on-chain and need no list.`,
  );
}

// ── set-field ──────────────────────────────────────────────────────────────--
// Set an on-chain metadata field. `--field` is what (e.g. image, description),
// `--representation` is how it's carried (default `inline` for --text, `keccak256`
// for --value). `--text "…"` stores literal UTF-8; `--value 0x..` stores raw bytes.
// `--collection` targets the collection scope; otherwise token `--token` (default 0).
// The resolver prefers on-chain over off-chain. Owner-only.
export async function cmdSetField(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(
    address,
    'abx set-field <address> --field <name> (--text "…" | --value 0x…) [--representation <rep>] [--collection | --token 0]',
  );
  const field = requireFlag(flags, 'field', 'abx set-field <address> --field <name> (--text … | --value 0x… | --file <path>)');
  assertSettableField(field); // `artifacts`/`abx_provenance` are computed, not settable → point at `abx attach`
  await assertChainId(CHAIN); // verify network up front — this op may stage on-chain content before the field tx
  const collection = !!flags.collection;
  const lane = laneFromFlags(flags);
  const owner = await read<Address>(contract, 'owner');
  await assertGeneratorRepointable(contract, field, flags); // legacy impl + the current generator = params silently invisible
  const staging = !!(flags.file && flags.file !== 'true'); // large content ON-CHAIN via chunk store/reader
  if (staging && field === 'image') {
    refusePrewrappedImage(readFileSync(resolvePath(flags.file as string)), `--file`);
  }

  // --file + --dry-run: preview the on-chain staging plan and store/send NOTHING. (The locator/text
  // path flows through runWrite, which previews there; staging must short-circuit before any upload.)
  if (staging && isDryRun(flags)) {
    const bytes = readFileSync(resolvePath(flags.file as string));
    const p = computeContentPlan(bytes, parseCompress(flags.compress));
    // Same render-gas gate the real path applies, so a refusal costs a dry run rather than gas.
    await guardOnChainSize(bytes.length, `'${field}'`);
    console.log(`\n  ${bold('◆ set-field ' + field)} ${dim('(dry run — nothing staged or sent)')}`);
    console.log(`    ${dim('scope'.padEnd(12))} ${collection ? 'collection' : `token #${flags.token ?? '0'}`}`);
    console.log(`    ${planSizeLine(bytes.length, p, parseCompress(flags.compress))}`);
    console.log(dim(`\n  Re-run without --dry-run to stage on-chain (lane: ${lane}).\n`));
    return;
  }

  const buildTx = (value: Hex, representation: string): PreparedTx =>
    collection
      ? prepareSetContractField({contract, field, representation, value, chainId: chainId()})
      : prepareSetTokenField({contract, tokenId: BigInt(flags.token ?? '0'), field, representation, value, chainId: chainId()});

  // On-chain staging (--file) is a SEQUENCE — chunk write(s) → manifest → the field-set that
  // references it — where each tx's receipt feeds the next, so it can't be signed offline.
  if (staging && lane === 'unsigned') {
    throw new Error(
      'Staging on-chain content (--file) needs interactive signing — each chunk tx feeds the next, ' +
        "so it can't run on the cold lane (--unsigned). Use the hot lane (a funded key) or --sign (browser wallet).",
    );
  }

  // Wallet lane + on-chain staging: ONE sign session signs every chunk write AND the field-set,
  // so the human connects once and approves each step (the env key is never needed).
  if (staging && lane === 'sign') {
    const compress = parseCompress(flags.compress);
    const bytes = readFileSync(resolvePath(flags.file as string));
    const p = computeContentPlan(bytes, compress);
    const stagingTxs = p.plan.mode === 'single' ? 1 : p.plan.txCount;
    const session = await openWalletSession({
      chainKey: CHAIN,
      expectedSigner: owner,
      total: stagingTxs + 1,
      port: flags.port ? Number(flags.port) : undefined,
      signUrlFile: flags['sign-url-file'],
    });
    try {
      await session.connect();
      const {value, representation} = await putContentOnChain(bytes, compress, field, sessionStagingSender(session));
      await session.send(buildTx(value, representation));
    } finally {
      session.close();
    }
    await reindexIfKnown(contract, flags);
    return;
  }

  // Hot lane (or no staging): compute the value, then sign the single field-set tx as usual.
  let value: Hex;
  let representation: string;
  if (staging) {
    const compress = parseCompress(flags.compress);
    ({value, representation} = await putContentOnChain(readFileSync(resolvePath(flags.file as string)), compress, field, envStagingSender()));
  } else if (flags.text && flags.text !== 'true') {
    if (field === 'image') refusePrewrappedImage(flags.text, `--text`);
    value = toHex(flags.text);
    representation = flags.representation ?? R.inline;
    console.log(dim(`  inline on-chain '${field}'${collection ? ' (collection)' : ` on token #${flags.token ?? '0'}`}: ${JSON.stringify(flags.text.slice(0, 60))}${flags.text.length > 60 ? '…' : ''}`));
  } else {
    value = requireFlag(flags, 'value', 'abx set-field <address> --field <name> --text … | --value 0x…') as Hex;
    representation = flags.representation ?? R.keccak256;
  }
  // A structured representation is decoded on chain before the field can resolve — normalize the
  // shape and refuse an undecodable one HERE, where it costs nothing, rather than on the read path
  // where it costs the whole collection's tokenURI. (Staged content already arrives correctly
  // encoded from putContentOnChain; this only ever changes a hand-passed --value.)
  value = encodeStructuredFieldValue(representation, value);
  if (representation === R.renderer) await assertFieldRendererDeployed(value);
  const sent = await runWrite(contract, buildTx(value, representation), flags, owner);
  // Then prove the thing the creator actually cares about: that the served document still reads.
  // A field renderer is the project's OWN contract — it can revert for reasons no static check
  // sees — so the honest confirmation is to call tokenURI once, after the write.
  if (sent) await reportUriAfterFieldWrite(contract, collection, flags);
}

/**
 * After a field write lands, staticcall what a marketplace calls and say plainly whether it still
 * resolves. The write is already on chain, so this never throws — a reverting `tokenURI` is
 * reported with the read that proves it and the write that undoes it.
 *
 * This is the check that would have caught the `renderer` encoding bug on the first collection
 * instead of the fourth: `abx verify` surfaced the reverting tokenURI, but only when it was next
 * run, and nothing tied it back to the write that caused it.
 */
async function reportUriAfterFieldWrite(contract: Address, collection: boolean, flags: Flags): Promise<void> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  const tokenId = BigInt(flags.token ?? '0');
  // An ERC-1155 edition serves `uri(id)`, not `tokenURI(id)` — read the one this contract has, or the
  // check would report a healthy edition as broken.
  const edition = await isEditionContract(publicClient, contract).catch(() => false);
  const fn = edition ? 'uri' : 'tokenURI';
  const abi = edition ? oneOfOneEditionAbi : oneOfOneImageAbi;
  const uri = await tryReadContract<string>(publicClient, {address: contract, abi, functionName: fn, args: [tokenId]});
  if (uri !== undefined) {
    console.log(`  ${green('✓')} ${fn}(${tokenId}) still resolves`);
    return;
  }
  {
    // A collection with nothing minted yet has no token to read — not a failure, just nothing to
    // prove. Separate that from a real revert before alarming anyone.
    const supply = await tryReadContract<bigint>(publicClient, {
      address: contract,
      abi: oneOfOneImageAbi,
      functionName: 'totalSupply',
      args: [],
    });
    if (supply === 0n) {
      console.log(dim(`  (no tokens minted yet — nothing to read back; run \`abx verify ${contract}\` after the first mint)`));
      return;
    }
    console.log(
      yellow('  ⚠ ') +
      `${fn}(${tokenId}) REVERTS after this write — the field is on chain but the served document no longer reads.\n` +
        `  confirm: abx tokenuri ${contract} ${tokenId}\n` +
        `  This is recoverable: the field is not locked until you \`abx lock-field\` it, so re-setting '${flags.field}'\n` +
        `  to a working value${collection ? ' --collection' : ''} restores it. Check the renderer's own render() first —\n` +
        `  a field renderer must NEVER revert.`,
    );
  }
}

// ── attach: the canonical fetch URL + a real reachability probe ───────────────
/**
 * The exact, directly-fetchable URL for one attached key — `{base}/{chainId}/{address}[/{tokenId}]
 * /data/{key}`, the token-api route grammar (`packages/token-api/src/server.ts`'s `/t` and `/c`
 * routes). `base` already carries its OWN `/t` or `/c` prefix (see `TokenURI.sol`/`ContractURI.sol`
 * — `deploy-code`/`deploy`/etc. bake `tokenURIBase = "${host}/t"`), so this never re-adds one.
 * Exported so a creator or an agent never has to hand-assemble this from the docs. The old `attach`
 * output was a bare path, not a URL anyone could actually GET.
 */
export function canonicalAttachmentUrl(opts: {uriBase: string; chainId: number; contract: Address; tokenId?: bigint; key: string}): string {
  const base = opts.uriBase.replace(/\/+$/, '');
  const coords = opts.tokenId === undefined ? `${opts.chainId}/${opts.contract}` : `${opts.chainId}/${opts.contract}/${opts.tokenId}`;
  return `${base}/${coords}/data/${encodeURIComponent(opts.key)}`;
}

/**
 * Is ANY resolver actually answering for this project right now — the precondition for an
 * attachment to ever become fetchable, and the check `attach` did not originally run (it warned on
 * an EMPTY resolver base, but a non-empty one that answered nothing got a silent, confident "listed
 * in this project's resolver artifacts"). Reuses `cmdVerifyRemote`'s own GET-and-classify shape
 * (`served.ts`'s `fetchServedTokenUri`) rather than a second HTTP client.
 *
 * Deliberately probes the token's (or collection's) OWN metadata document — NEVER the specific key
 * being attached. That document already exists for any minted token; the key being attached here
 * does not exist server-side until the write this gates on lands and the resolver re-indexes, so
 * probing it directly would 404 on a perfectly healthy resolver and cry wolf on every attach.
 */
export async function probeResolverReachable(opts: {
  uriBase: string;
  chainId: number;
  contract: Address;
  tokenId?: bigint;
  fetchFn?: typeof fetch;
}): Promise<{reachable: boolean; url: string; detail: string}> {
  const base = opts.uriBase.replace(/\/+$/, '');
  const coords = opts.tokenId === undefined ? `${opts.chainId}/${opts.contract}` : `${opts.chainId}/${opts.contract}/${opts.tokenId}`;
  const url = `${base}/${coords}`;
  const served = await fetchServedTokenUri(url, {fetchFn: opts.fetchFn});
  if (servedOk(served)) return {reachable: true, url, detail: `HTTP ${served.status}`};
  const detail = served.error ? `no response: ${served.error}` : served.status !== null ? `HTTP ${served.status}` : (served.skipped ?? 'unreachable');
  return {reachable: false, url, detail};
}

// ── attach (the data-plane verb: put a named file on a token) ─────────────────
/**
 * `abx attach <address> <key> <uri>` — attach a named, typed file to a token (or the collection),
 * so it appears in the token's served `artifacts` manifest as `{key, mimeType, uri}`. This is the
 * creator-facing verb for the token data plane (site/content/docs/protocol/data-plane.mdx); it's a thin,
 * correct-by-construction wrapper over `set-field`:
 *   - the on-chain representation is AUTO-DETECTED from the URI scheme (ipfs:// · ar:// · https://)
 *     — no `--representation` to guess wrong;
 *   - `--file <path>` instead of a URI stores tiny bytes ON-CHAIN (SSTORE2), for a small file with
 *     no external host (≈200 gas/byte — locators are the norm for anything non-trivial);
 *   - the declared `mimeType` comes from the file EXTENSION in the URI (`…/master.tiff` → image/tiff),
 *     so give the file a real extension or it lands as `application/octet-stream`;
 *   - computed keys (`artifacts`, `abx_provenance`) are refused — they're the manifest, not inputs.
 * Scope: token (`--token`, default 0) or `--collection`. Any signing lane. Owner-only.
 */
/**
 * Attach one or more artifacts. Several `<key> <uri>` pairs in one invocation become **one
 * transaction**.
 *
 * That batching is a safety fix, not a convenience. The documented flow —
 * mint, then attach each artifact, then refresh — sent one transaction per step with no all-or-nothing
 * boundary, so a failure partway through left a permanently half-written token that cannot be
 * un-minted. An integrator hit exactly this and folded 8 operations into 1 transaction using the SDK's
 * `batchOps`, which the CLI already shipped and did not use. Now it does: N pairs are one
 * `multicall`, so either every artifact lands or none does.
 *
 * A single pair passes through `batchOps` untouched, so the one-artifact case sends the identical
 * transaction it always did.
 */
export async function cmdAttach(rest: string[], flags: Flags): Promise<void> {
  const usage =
    'abx attach <address> <key> <ipfs://… | ar://… | https://…> [<key> <uri> …]   [--file <path>] [--collection | --token 0] [--sign|--unsigned] [--dry-run]';
  const [address, ...pairArgs] = positionalArgs(rest);
  const key = pairArgs[0];
  const uri = pairArgs[1];
  // Warn (never throw) on an unrecognized flag — a typo or a hopeful `--mime-type` otherwise no-ops
  // INVISIBLY (round-1: an agent passed `--mime-type` and it was silently swallowed). mimeType is
  // declared from the URL extension, not a flag; say so.
  for (const f of unknownFlags(flags, ATTACH_FLAGS)) {
    const hint = f.includes('mime')
      ? ' mimeType is declared from the file EXTENSION in the URI, not a flag.'
      : f === 'for'
        ? ' --for is a deploy flag (it pins the future owner); an owner-op signs as the on-chain owner automatically — just connect that wallet.'
        : '';
    console.log(yellow('  ⚠ ') + dim(`unrecognized flag --${f} (ignored).${hint}`));
  }
  const contract = requireAddress(address, usage);
  if (!key) {
    console.error(`usage: ${usage}\n  the <key> is the name your file appears under in the manifest (e.g. print, certificate, stems, readme).\n`);
    process.exitCode = 1;
    return;
  }
  assertSettableField(key);
  const hasFile = !!(flags.file && flags.file !== 'true');
  if (!uri && !hasFile) {
    console.error(`usage: ${usage}\n  pass a locator URI (ipfs://… / ar://… / https://…) or --file <path> to store bytes on-chain.\n`);
    process.exitCode = 1;
    return;
  }
  if (uri && hasFile) throw new Error('pass EITHER a locator URI OR --file <path>, not both.');

  const collection = !!flags.collection;
  const scope = collection ? 'the collection' : `token #${flags.token ?? '0'}`;

  // --file: reuse set-field's on-chain staging path (tiny files only). Delegate rather than
  // re-implement the chunk sequence.
  if (hasFile) {
    return cmdSetField(address, {...flags, field: key});
  }

  // Locator path (the common case): auto-detect the representation, refuse an unrecognized scheme
  // loudly (never silently store a bad value) — fail fast before any RPC. Derive the declared
  // mimeType from the extension.
  // Every `<key> <uri>` pair, validated BEFORE anything is sent — a batch that would revert partway
  // is exactly what this command now exists to prevent, so a bad locator in pair 5 must stop pair 1.
  if (pairArgs.length % 2 !== 0) {
    throw new Error(
      `attach takes <key> <uri> PAIRS; got ${pairArgs.length} positional argument(s) after the address. ` +
        `Last one seen: "${pairArgs[pairArgs.length - 1]}".`,
    );
  }
  const pairs: Array<{key: string; uri: string; representation: string; mimeType: string}> = [];
  for (let i = 0; i < pairArgs.length; i += 2) {
    const k = pairArgs[i];
    const u = pairArgs[i + 1];
    assertSettableField(k);
    const rep = representationForLocator(u);
    if (!rep) {
      throw new Error(
        `"${u}" isn't a recognized file locator. Use ipfs://… (pinned/IPFS), ar://… (Arweave), or https://… . ` +
          'To store literal text or raw bytes on-chain instead, use `abx set-field`.',
      );
    }
    pairs.push({key: k, uri: u, representation: rep, mimeType: contentTypeFromPath(u)});
  }
  // A key repeated within one batch would have the later write silently win — the same
  // full-column-upsert hazard that bit `register` and `lock-field`. Refuse instead.
  const dupes = pairs.map((p) => p.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupes.length) {
    throw new Error(
      `the same key appears twice in one batch: ${[...new Set(dupes)].join(', ')}. ` +
        'Each field holds ONE active value, so the last write would silently win — attach them separately if that is really what you want.',
    );
  }
  const representation = pairs[0].representation;
  const owner = await read<Address>(contract, 'owner');
  for (const p of pairs) {
    if (p.mimeType === 'application/octet-stream') {
      console.log(
        yellow('  ⚠ ') +
          dim(`no file extension in "${p.uri.slice(0, 64)}" → declared type will be application/octet-stream. `) +
          dim('Point the URI at the file itself (…/master.tiff, …/coa.pdf) so collectors get the right type.'),
      );
    }
  }
  const mimeType = pairs[0].mimeType;

  for (const p of pairs) {
    console.log(`  attaching ${bold(p.key)} ${dim(`(${p.mimeType}, ${p.representation})`)} to ${scope}: ${dim(p.uri)}`);
  }
  // Where it surfaces — and whether anything can actually SERVE it. This used to be one dim
  // line assuming a non-empty resolver base meant the artifact would be listed; it never checked.
  // An integrator attached five audio stems to a fully-on-chain token, paid to store them, and found
  // `tokenURI` listed none of them — "paid for, stored on-chain, and invisible". The on-chain
  // renderer deliberately omits locator-represented artifacts (they duplicate no on-chain type
  // information — see site/content/docs/protocol/data-plane.mdx), so the complete artifacts manifest
  // comes from a RESOLVER — and a resolver base baked on-chain is a CONFIGURATION, not proof one is
  // actually running and knows this project. `--collection` reads the collection-scope base
  // (`contractURIBase`); a token-scope attach reads `tokenURIBase` — these are two separate on-chain
  // fields (the earlier version of this always read `tokenURIBase`, silently wrong for --collection).
  const uriBase = await read<string>(contract, collection ? 'contractURIBase' : 'tokenURIBase').catch(() => '');
  const tokenIdForUrl = collection ? undefined : BigInt(flags.token ?? '0');
  let reachability: {reachable: boolean; url: string; detail: string} | null = null;
  if (uriBase && uriBase.trim() !== '') {
    // The canonical fetch URL for every key, printed directly — no hand-assembling a resolver
    // route from the docs. A PROMISE, not yet a fact: the key doesn't exist server-side until the
    // write below lands and the resolver re-indexes, so it is printed here, never probed here.
    for (const p of pairs) {
      console.log(dim(`    → fetch: ${canonicalAttachmentUrl({uriBase, chainId: chainId(), contract, tokenId: tokenIdForUrl, key: p.key})}`));
    }
    // What CAN be checked before any write: does ANY resolver answer for this project at all right
    // now — the precondition for the URL(s) above to ever resolve. Same GET-and-classify shape
    // `cmdVerifyRemote` uses for its own reachability check (served.ts).
    reachability = await probeResolverReachable({uriBase, chainId: chainId(), contract, tokenId: tokenIdForUrl});
    if (reachability.reachable) {
      console.log(dim(`    resolver answers for this project (${reachability.detail}) — the URL(s) above start serving once this write lands and re-indexes.`));
    } else {
      console.log(
        yellow('  ⚠ ') +
          `the resolver base baked on-chain (${uriBase}) does not currently answer for ${scope} (${reachability.detail}) — ` +
          `the on-chain FIELD WRITE below will still succeed, but nothing is known to be able to SERVE ${pairs.map((p) => bold(p.key)).join(', ')} right now. ` +
          `Local: is ${bold('abx serve')} running, and is this project ${bold('abx add')}-ed + indexed? Hosted: ${bold(`abx add ${contract} --remote <name>`)} then ${bold(`abx index ${contract} --remote <name>`)}.`,
      );
    }
  } else {
    console.log(
      yellow('  ⚠ ') +
        `this project resolves ON-CHAIN (no resolver base baked in) — the on-chain FIELD WRITE below will still succeed, but there is NO off-chain serving path at all: the on-chain document carries reserved fields only, ` +
        `so ${pairs.map((p) => bold(p.key)).join(', ')} will NEVER appear in ${bold('tokenURI')} for ANY resolver. The bytes are stored and provable, but nothing surfaces them to a marketplace or wallet. ` +
        dim('(Params are chain state, readable with abx tokens and by any contract call — attachments are the surface that needs a resolver.)'),
    );
    console.log(
      dim(`    to make attached artifacts servable at all, point the project at a resolver (${bold('abx deploy-resolver')}, or a managed one via ${bold('abx add <addr> --remote <name>')}) — then re-run this.`),
    );
  }
  // ONE transaction for the whole set. `batchOps` folds a same-target run into a `multicall` and
  // passes a lone op through untouched, so a single attach is byte-identical to before.
  const ops: PreparedTx[] = pairs.map((p) =>
    collection
      ? prepareSetContractField({contract, field: p.key, representation: p.representation, value: toHex(p.uri), chainId: chainId()})
      : prepareSetTokenField({contract, tokenId: BigInt(flags.token ?? '0'), field: p.key, representation: p.representation, value: toHex(p.uri), chainId: chainId()}),
  );
  const batched = batchOps(ops);
  if (batched.length !== 1) {
    // Defensive: every op here targets the same contract and carries no value, so batchOps must
    // return exactly one tx. If that ever changes, fail loudly rather than send a partial set.
    throw new Error(`attach expected to batch ${ops.length} op(s) into one transaction, got ${batched.length}`);
  }
  if (pairs.length > 1) {
    console.log(dim(`  ${pairs.length} artifacts → ONE transaction (all-or-nothing: a revert lands none of them, so no half-written token).`));
  }

  const sent = await runWrite(contract, batched[0], flags, owner);
  if (sent) {
    const id = flags.token ?? '0';
    const names = pairs.map((p) => bold(p.key)).join(', ');
    // Preserve the distinction between the on-chain FIELD WRITE succeeding (this line, always true
    // when we get here) is not the same fact as the artifact being SERVABLE — say both, separately,
    // rather than one "✓ attached" that a reader takes to mean "and it's live".
    const servingLine =
      !uriBase || uriBase.trim() === ''
        ? dim(`    serving: NONE — this project resolves fully on-chain (see the warning above); the bytes are stored and provable, but no resolver will ever list them.\n`)
        : reachability?.reachable
          ? dim(`    serving: a resolver answered for ${scope} just before this write (see above); fetch the URL(s) above once it re-indexes to confirm.\n`)
          : dim(`    serving: NOT CONFIRMED — no resolver answered for ${scope} just before this write (see the warning above). The FIELD is on-chain now; SERVING it is a separate, still-unmet, concern.\n`);
    console.log(
      `  ${green('✓')} on-chain field write succeeded — ${names} join${pairs.length > 1 ? '' : 's'} ${scope}'s ${bold('artifacts')} manifest (stored on-chain, anchored).\n` +
        servingLine +
        dim(`    verify (a resolver serves the complete listing): `) +
        `abx tokenuri ${contract}${id === '0' ? '' : ` --token ${id}`} --fetch` +
        dim(`  ${collection ? '' : `→ artifacts[].key ${pairs.map((p) => `"${p.key}"`).join(', ')}; /data/<key> fetches each`}\n`) +
        dim(`    (The complete file listing is a resolver surface — the bare on-chain tokenURI enumerates reserved fields. Params never need a resolver, they are read straight off the contract; attachments do.)\n`),
    );
  }
}

// ── lock-field ───────────────────────────────────────────────────────────────
/**
 * Refuse `lock-field` on a name that is a declared PARAM key.
 *
 * Fields and params are two separate namespaces that may share a name, and `lock-field` only ever
 * locks the *field*. A tester welded `grid` — a `Bytes` param holding the work — with
 * `lock-field --field grid`, got "permanent", got `tokenFieldLocked(0,"grid") == true`, and then
 * overwrote the work with `configure-param` on the next call. Every individual statement the CLI
 * made was true; together they promised a protection that did not exist. Permanence is the pitch, so
 * this refuses rather than warns, and names the mechanism that actually welds a param.
 */
async function refuseIfParamKey(contract: Address, field: string): Promise<void> {
  let exists = false;
  try {
    const schema = (await makePublicClient({chainKey: CHAIN}).readContract({
      address: contract,
      abi: seriesCodeAbi,
      functionName: 'paramSchema',
      args: [encodeTagSdk(field)],
    })) as readonly [boolean, ...unknown[]];
    exists = !!schema[0];
  } catch {
    // No param surface at all (a 1/1 or plain Series) — nothing to confuse the name with.
    return;
  }
  if (!exists) return;
  throw new Error(
    `"${field}" is a declared PostParam key on ${contract}, and lock-field does NOT lock params — ` +
      `it locks the metadata FIELD of the same name. They are separate namespaces, so this would have ` +
      `reported "permanent" while configure-param stayed free to overwrite the value.\n` +
      `  To weld the param, lock its schema instead:\n` +
      `    abx set-schema ${contract} --schema ${field}:<Type>:<Auth>:lock=now\n` +
      `  (after that every configure-param on "${field}" reverts ParamLockExpired — check with ` +
      `\`abx inspect ${contract}\`.)\n` +
      `  If you really did mean the metadata field "${field}" and not the param, re-run with --force-field.`,
  );
}

/**
 * Which scope actually SERVES `field` right now — the same question `abx tokenuri`'s
 * `abx_provenance` line answers, and the one `lock-field` did not originally ask:
 * `lock-field --field description --token 0` reported "would succeed" — and DID succeed — on a
 * project where `description` is COLLECTION-scoped, freezing an empty token-scope slot while the
 * value every viewer actually sees (the collection one) stayed completely mutable. Every statement
 * the CLI made was true; together they promised a permanent freeze that never happened.
 *
 * Mirrors the renderer's own fallback (`AbxMetadataRenderer._field` / `fieldWithFallback` in
 * token-api/metadata.ts): a token-scope value wins when set; only when the token slot is empty does
 * the collection-scope value show through. Best-effort by design — a read that could not be
 * answered (RPC unreachable, or a contract predating the on-chain-metadata extension) returns
 * `null` rather than asserting a scope this call does not actually know, matching
 * `refuseIfParamKey`'s posture just above.
 *
 * Exported with an injected `client` (mirrors `readCollectionLocks` in project.ts) so a test can
 * exercise the real chain-read shape against a mocked `PublicClient` — no network, no live fixture.
 */
export async function fieldScopePresence(
  client: PublicClient,
  contract: Address,
  tokenId: bigint,
  field: string,
): Promise<FieldScopePresence | null> {
  const tag = encodeTag(field);
  const [tokenEntry, collectionEntry] = await Promise.all([
    tryReadContract<readonly [Hex, Hex]>(client, {address: contract, abi: oneOfOneImageAbi, functionName: 'tokenField', args: [tokenId, tag]}),
    tryReadContract<readonly [Hex, Hex]>(client, {address: contract, abi: oneOfOneImageAbi, functionName: 'contractField', args: [tag]}),
  ]);
  if (!tokenEntry || !collectionEntry) return null;
  return {token: tokenEntry[1] !== '0x', collection: collectionEntry[1] !== '0x'};
}

/** Does the token scope, or the collection scope, hold a (non-empty) value for the field —
 *  independently; a project can have either, both, or neither. See {@link fieldScopePresence}. */
export interface FieldScopePresence {
  token: boolean;
  collection: boolean;
}
export type LockFieldScope = 'token' | 'collection';

/**
 * Pure decision core for the wrong-scope lock check — exported so it is unit-testable with no chain
 * at all, matching `computeAvailability`'s split (project.ts): the
 * chain read is a thin, low-risk passthrough; the judgment call belongs in a function a test can
 * call directly.
 *
 * Mirrors the renderer's own fallback (`AbxMetadataRenderer._field` / `fieldWithFallback` in
 * token-api/metadata.ts): a token-scope value wins over collection when both are set, so the scope
 * that's actually SERVED can differ from the scope the caller names. Returns `null` — nothing to
 * flag — when the chosen scope already IS what's served, or when genuinely neither scope carries a
 * value yet (locking a truly empty field is unambiguous: there's no "other" visible value this
 * command could fail to protect).
 */
export function detectLockFieldScopeMismatch(
  presence: FieldScopePresence,
  chosen: LockFieldScope,
): {effective: LockFieldScope; chosen: LockFieldScope} | null {
  const effective: LockFieldScope | 'none' = presence.token ? 'token' : presence.collection ? 'collection' : 'none';
  if (effective === 'none' || effective === chosen) return null;
  return {effective, chosen};
}

/**
 * Refuse, or (under `--force-field`) loudly warn but proceed — the two allowed outcomes of a
 * detected mismatch, decided PURELY from the mismatch + whether the override flag was passed, so
 * this is unit-testable without a chain or a console.
 *
 * Deliberately does NOT refuse unconditionally with no escape hatch: pre-locking an empty slot so
 * it can never be filled — e.g. permanently guaranteeing one token can never diverge from the
 * collection default — is a legitimate, deliberate use of this same command, and an unconditional
 * refusal would just trade one bug (a silent no-op freeze) for another (a real, protocol-supported
 * shape the CLI now falsely claims is impossible — see "false refusal is a membrane defect").
 * `--force-field` is lock-field's existing general override for its own protective checks (see
 * `refuseIfParamKey` above); this reuses it rather than adding a second, narrower flag for the same
 * "yes, I really mean this" answer.
 */
export function lockFieldScopeVerdict(
  mismatch: {effective: LockFieldScope; chosen: LockFieldScope},
  opts: {contract: string; tokenId: bigint; field: string; forced: boolean},
): {action: 'refuse' | 'warn'; message: string} {
  const {effective, chosen} = mismatch;
  const correctCmd =
    effective === 'collection'
      ? `abx lock-field ${opts.contract} --field ${opts.field} --collection`
      : `abx lock-field ${opts.contract} --field ${opts.field} --token ${opts.tokenId}`;
  const servedFrom = effective === 'collection' ? 'COLLECTION scope (shared across every token)' : `TOKEN #${opts.tokenId}'s own scope (a per-token override)`;
  const chosenDesc = chosen === 'collection' ? 'the COLLECTION scope' : `token #${opts.tokenId}'s scope`;
  if (!opts.forced) {
    return {
      action: 'refuse',
      message:
        `locking ${chosenDesc} would report "permanent" and DO NOTHING to freeze what's actually shown: '${opts.field}' for token #${opts.tokenId} ` +
        `is currently served from ${servedFrom}, not the scope you're about to lock. Lock the scope that's actually visible instead:\n` +
        `    ${correctCmd}\n` +
        `  If you deliberately want to freeze ${chosenDesc}'s slot forever anyway (e.g. guaranteeing this token can never diverge from the ` +
        `collection default), re-run with --force-field — it will proceed, with a loud warning that ${servedFrom} stays unfrozen.`,
    };
  }
  return {
    action: 'warn',
    message:
      `⚠⚠ LOCKING A SLOT THAT IS NOT WHAT'S DISPLAYED ⚠⚠\n` +
      `    '${opts.field}' for token #${opts.tokenId} is currently served from ${servedFrom} — THIS LOCK DOES NOT FREEZE THAT VALUE.\n` +
      `    You are about to PERMANENTLY lock ${chosenDesc}'s slot instead (proceeding because of --force-field). That value can never change again, ` +
      `but the value viewers actually see today is untouched by this operation and remains fully mutable.`,
  };
}

/**
 * Refuse (or, under `--force-field`, loudly warn but proceed) a `lock-field` whose CHOSEN scope is
 * not the scope actually serving `field` right now. Best-effort by design: a read that could not be
 * answered (RPC unreachable, or a contract predating the on-chain-metadata extension) skips the
 * check rather than asserting a scope this call does not actually know, matching
 * `refuseIfParamKey`'s posture above. Runs BEFORE `runWrite`, so `--dry-run` and a real send see
 * this identically.
 */
async function warnOrRefuseWrongScope(contract: Address, tokenId: bigint, field: string, collection: boolean, flags: Flags): Promise<void> {
  const presence = await fieldScopePresence(makePublicClient({chainKey: CHAIN}), contract, tokenId, field);
  if (!presence) return; // couldn't determine either scope — don't block on a fact we don't have
  const chosen: LockFieldScope = collection ? 'collection' : 'token';
  const mismatch = detectLockFieldScopeMismatch(presence, chosen);
  if (!mismatch) return; // nothing to freeze, or the right scope
  const verdict = lockFieldScopeVerdict(mismatch, {contract, tokenId, field, forced: flags['force-field'] !== undefined});
  if (verdict.action === 'refuse') throw new Error(verdict.message);
  console.log(`    ${red(verdict.message)}`);
}

export async function cmdLockField(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx lock-field <address> --field <name> [--collection | --token 0] [--sign|--unsigned]');
  const field = requireFlag(flags, 'field', 'abx lock-field <address> --field <name>');
  const collection = !!flags.collection;
  const tokenId = BigInt(flags.token ?? '0');
  // The metadata field and a same-named param are different things; only an explicit --force-field
  // says "yes, I mean the field". See refuseIfParamKey.
  if (flags['force-field'] === undefined) await refuseIfParamKey(contract, field);
  await warnOrRefuseWrongScope(contract, tokenId, field, collection, flags);
  const owner = await read<Address>(contract, 'owner');
  console.log(dim(`  note: locking the '${field}' field is permanent and irreversible (freezes all its representations).`));
  const tx = collection
    ? prepareLockContractField({contract, field, chainId: chainId()})
    : prepareLockTokenField({contract, tokenId, field, chainId: chainId()});
  await runWrite(contract, tx, flags, owner);
}

// ── set-renderer (toggle on-chain URI resolution) ─────────────────────────────
/** Point a token's URI resolution at an on-chain renderer (or clear it with `--off`).
 *  `flags.renderer` is the resolved address (main.ts defaults it to the canonical
 *  renderer). With it set, `tokenURI`/`contractURI` are assembled on-chain from the
 *  fields — no resolver needed. Scope: token (default) or `--collection`. */
export async function cmdSetRenderer(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(
    address,
    'abx set-renderer <address> [--collection] [--off | --renderer 0x..] [--sign|--unsigned]',
  );
  const collection = !!flags.collection;
  const renderer = (flags.off ? zeroAddress : (flags.renderer ?? zeroAddress)) as Address;
  const owner = await read<Address>(contract, 'owner');
  console.log(
    dim(
      renderer === zeroAddress
        ? `  clearing the on-chain renderer → ${collection ? 'contractURI' : 'tokenURI'} resolves off-chain again.`
        : `  ${collection ? 'contractURI' : 'tokenURI'} will resolve ON-CHAIN via ${renderer} (assembled from fields).`,
    ),
  );
  const tx = collection
    ? prepareSetContractURIRenderer({contract, renderer, chainId: chainId()})
    : prepareSetTokenURIRenderer({contract, renderer, chainId: chainId()});
  await runWrite(contract, tx, flags, owner);
}

// ── lock-uri (freeze the URI config) ──────────────────────────────────────────
/** Freeze a scope's URI config (pointer + renderer) forever. With the fields also
 *  locked, the stored metadata can never change again — the on-chain twin of a frozen
 *  `tokenURI`. Not the same as a frozen OUTPUT: params have no lock and the renderer
 *  projects them, and a Registry dependency resolves live. Scope: token or `--collection`. */
export async function cmdLockUri(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx lock-uri <address> [--collection] [--sign|--unsigned]');
  const collection = !!flags.collection;
  const owner = await read<Address>(contract, 'owner');
  console.log(
    dim(
      `  note: locking the ${collection ? 'contractURI' : 'tokenURI'} config is permanent — pointer + renderer can never change again. Locked metadata is not a locked output: params stay writable and the renderer serves them.`,
    ),
  );
  const tx = collection
    ? prepareLockContractURI({contract, chainId: chainId()})
    : prepareLockTokenURI({contract, chainId: chainId()});
  await runWrite(contract, tx, flags, owner);
}

// ── set-admin (transfer contract ownership) ──────────────────────────────────
export async function cmdSetAdmin(address: string | undefined, flags: Flags): Promise<void> {
  const contract = requireAddress(address, 'abx set-admin <address> --to 0x… [--sign|--unsigned]');
  const newOwner = requireFlag(flags, 'to', 'abx set-admin <address> --to 0x…') as Address;
  const owner = await read<Address>(contract, 'owner');
  await runWrite(contract, prepareTransferOwnership({contract, newOwner, chainId: chainId()}), flags, owner);
}

// ── fixed-price minter (the Minter spine) ─────────────────────────────────────
// A shared, ownerless, multi-tenant sale singleton. `configure` defers to the token owner;
// `buy` is public. Sale config is keyed by token address; proceeds route to the token's
// primaryPayee; the token's Paused extension is the on/off switch. See site/content/docs/protocol/minting.mdx.

/** A Series read (minter/primaryPayee/paused/…) via the Series ABI (the 1/1 ABI lacks these). */
async function readSeries<T>(token: Address, fn: string, args: unknown[] = []): Promise<T> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  return (await publicClient.readContract({
    address: token,
    abi: seriesImageAbi,
    functionName: fn as never,
    args: args as never,
  })) as T;
}

/** The edition twin of {@link readSeries} — reads a per-id getter (`totalSupply(id)`,
 *  `maxSupply(id)`, `uri(id)`, …) via the narrowest-common-superset edition ABI. */
async function readEdition<T>(token: Address, fn: string, args: unknown[] = []): Promise<T> {
  const publicClient = makePublicClient({chainKey: CHAIN});
  return (await publicClient.readContract({
    address: token,
    abi: oneOfOneEditionAbi,
    functionName: fn as never,
    args: args as never,
  })) as T;
}

/** Resolve the shared minter for the chain (flag → env → manifest), or deploy it if none exists.
 *  It's ownerless, so any funded signer can stand it up — the sibling of `ensureChunkStore`. */
async function ensureFixedPriceMinter(override?: string): Promise<Address> {
  const known = fixedPriceMinterAddress(override);
  const publicClient = makePublicClient({chainKey: CHAIN});
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') return known;
    console.log(yellow(`  configured minter ${known} has no code on ${CHAIN} — deploying a fresh one`));
  }
  // CREATE2-deterministic: it may already exist at its predicted address (forge script deployed it,
  // manifest not yet updated). Check there before deploying — self-healing, never a duplicate.
  const predicted = predictFixedPriceMinter();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x') {
      console.log(dim(`  using the canonical fixed-price minter at its deterministic address ${predicted}`));
      return predicted;
    }
  }
  const {wallet, account} = makeWalletClient({chainKey: CHAIN});
  const send = makeHotSender({wallet, account, publicClient});
  console.log(dim('  deploying the canonical fixed-price minter (shared, ownerless) — CREATE2…'));
  const {minter, txHash} = await deployFixedPriceMinter(send, publicClient);
  console.log(`  ${green('✓')} fixed-price minter ${minter}`);
  console.log(dim(`  tx ${txHash}`));
  console.log(
    dim(
      `  not in the shipped manifest for ${CHAIN} — to reuse it set ${bold(`ABX_FIXED_PRICE_MINTER=${minter}`)} (or add it to packages/sdk/src/deployments.ts)`,
    ),
  );
  return minter;
}

/** The edition twin of {@link ensureFixedPriceMinter} — resolves (or deploys) the chain's shared
 *  `AbxFixedPriceMinter1155`, the Minter spine's per-`(token, id)` sale singleton. */
async function ensureFixedPriceMinter1155(override?: string): Promise<Address> {
  const known = fixedPriceMinter1155Address(override);
  const publicClient = makePublicClient({chainKey: CHAIN});
  if (known) {
    const code = await publicClient.getCode({address: known});
    if (code && code !== '0x') return known;
    console.log(yellow(`  configured edition minter ${known} has no code on ${CHAIN} — deploying a fresh one`));
  }
  const predicted = predictFixedPriceMinter1155();
  if (!known || known.toLowerCase() !== predicted.toLowerCase()) {
    const pcode = await publicClient.getCode({address: predicted});
    if (pcode && pcode !== '0x') {
      console.log(dim(`  using the canonical fixed-price edition minter at its deterministic address ${predicted}`));
      return predicted;
    }
  }
  const {wallet, account} = makeWalletClient({chainKey: CHAIN});
  const send = makeHotSender({wallet, account, publicClient});
  console.log(dim('  deploying the canonical fixed-price edition minter (shared, ownerless) — CREATE2…'));
  const {minter, txHash} = await deployFixedPriceMinter1155(send, publicClient);
  console.log(`  ${green('✓')} fixed-price edition minter ${minter}`);
  console.log(dim(`  tx ${txHash}`));
  console.log(
    dim(
      `  not in the shipped manifest for ${CHAIN} — to reuse it set ${bold(`ABX_FIXED_PRICE_MINTER_1155=${minter}`)} (or add it to packages/sdk/src/deployments.ts)`,
    ),
  );
  return minter;
}

/** A minter write (configure/buy). No re-index — the sale lives on the minter, not the token
 *  projection; the token's own state is unchanged by a sale config.
 *
 * Used to hand-roll its own dry-run guard — "the minter path does not go through runWrite, so it
 * needs its OWN" — which is exactly the duplication {@link gatedSend} exists to end: this now shares
 * the identical choke point `runWrite` does, so `minter configure`/`minter buy` also pick up
 * `--confirm` (previously only the deploy family had it) with no extra code here. */
async function runMinterWrite(provider: TxProvider, flags: Flags, expectedSigner?: Address): Promise<void> {
  await gatedSend(provider, flags, {chainKey: CHAIN, expectedSigner});
}

/** Parse the sale price: `--price-raw <units>` (exact base units) or the friendly `--price <ether>`
 *  (18-decimals). ETH sales use `--price`; non-18-dp ERC-20s should use `--price-raw`. */
function parseSalePrice(flags: Flags, usage: string): bigint {
  if (flags['price-raw'] && flags['price-raw'] !== 'true') return BigInt(flags['price-raw']);
  if (flags.price && flags.price !== 'true') return parseEther(flags.price);
  console.error(`missing --price <ether> or --price-raw <units>\nusage: ${usage}\n`);
  throw new CliError('', 1, true); // already printed above — see CliError's alreadyPrinted doc
}

/**
 * `abx minter configure <token> --price <eth> --allocation <n> [--erc20 0x…]` — set the fixed-price
 * sale for a project on the shared minter. Defers to the token owner. Resolves (or deploys) the
 * shared minter, then reports the two remaining grants the owner still needs (assign the minter on
 * the token, set a primary payee) and whether the token is paused.
 *
 * On an EDITION (OneOfOneEdition/EditionImage/EditionCode), `--token-id` is REQUIRED (sales are
 * keyed `(token, id)` — a per-work price, not one project-wide sale) and the sale routes to the
 * shared `AbxFixedPriceMinter1155` instead. Refused on a 721 target.
 */
export async function cmdMinterConfigure(address: string | undefined, flags: Flags): Promise<void> {
  const usage =
    'abx minter configure <token> (--price <eth> | --price-raw <units>) --allocation <n> [--erc20 0x…] [--token-id <n> (editions)] [--minter-contract 0x…] [--sign|--unsigned]';
  const token = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(MINTER_CONFIGURE_FLAGS), 'minter configure');
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, token);
  const owner = await read<Address>(token, 'owner');
  const erc20 = flags.erc20 && flags.erc20 !== 'true' ? (flags.erc20 as Address) : zeroAddress;
  const allocation = BigInt(requireFlag(flags, 'allocation', usage));
  const price = parseSalePrice(flags, usage);
  const isEth = erc20 === zeroAddress;
  // On --dry-run resolve the minter WITHOUT deploying — ensure* would deploy the shared singleton
  // if absent, and a preview must never send. Fall back to a label if none exists.
  const dryRun = isDryRun(flags);

  if (kind.isEdition) {
    const tokenId = parseEditionCountFlag(requireFlag(flags, 'token-id', usage), 'token-id');
    const knownMinter = fixedPriceMinter1155Address(flags['minter-contract']);
    if (dryRun && !knownMinter) {
      console.log(yellow(`  ⚠ no shared edition minter deployed on ${CHAIN} yet — a real run deploys it once (a separate tx) before configuring.`));
    }
    const minter = dryRun ? (knownMinter ?? zeroAddress) : await ensureFixedPriceMinter1155(flags['minter-contract']);

    // Sanity-check the allocation against what THIS id can still mint. `maxSupply(id) === 0` reads
    // as "open" (the un-overridden --copies default, or an id nobody has ever capped) — the same
    // convention `tokens.ts`'s TokenRow.maxSupply documents; see set-max-supply's own note on why a
    // bare 0 can't be told apart from "explicitly closed" without more than this one read.
    const [maxSupply, supplyNow] = await Promise.all([
      readEdition<bigint>(token, 'maxSupply', [tokenId]).catch(() => 0n),
      readEdition<bigint>(token, 'totalSupply', [tokenId]).catch(() => 0n),
    ]);
    const remaining = maxSupply > 0n ? (maxSupply > supplyNow ? maxSupply - supplyNow : 0n) : null;
    if (remaining !== null && allocation > remaining) {
      console.log(
        yellow(`  ⚠ allocation ${allocation} exceeds the ${remaining} #${tokenId} can still mint `) +
          dim(`(cap ${maxSupply} − ${supplyNow} minted). Only ${remaining} will actually sell.`),
      );
      console.log(dim(`    Selling ${allocation} isn't reachable: this id's cap can only ever DECREASE — set --allocation ${remaining} (or less, to hold reserves).`));
    }

    console.log(dim(`  configuring sale on ${minter}`));
    console.log(dim(`    token      ${token}  ·  id #${tokenId}`));
    console.log(dim(`    price      ${isEth ? `${formatEther(price)} ETH` : `${price} units of ${erc20}`} / copy`));
    console.log(dim(`    allocation ${allocation}`));
    await runMinterWrite(
      prepareConfigureSale1155({minter, token, tokenId, paymentToken: erc20, price, allocation, chainId: chainId()}),
      flags,
      owner,
    );

    // Through the EDITION ABI, for the same reason `minter show` spells out: the generic `read()`
    // is the 721 1/1 ABI, which has no minter()/primaryPayee() at all, so the call throws
    // client-side and the `.catch` swallows it into zeroAddress. That printed "⚠ assign this
    // minter" + "⚠ set a primary payee" on an edition that already had both.
    const [assignedMinter, payee, paused] = await Promise.all([
      readEdition<Address>(token, 'minter').catch(() => zeroAddress),
      readEdition<Address>(token, 'primaryPayee').catch(() => zeroAddress),
      readEdition<boolean>(token, 'paused').catch(() => false),
    ]);
    const assigned = assignedMinter.toLowerCase() === minter.toLowerCase();
    console.log('');
    console.log(assigned ? dim('  ✓ minter is assigned on the token') : yellow(`  ⚠ assign this minter on the token:  abx set-minter ${token} --minter ${minter}`));
    if (payee === zeroAddress) console.log(yellow(`  ⚠ set a primary payee (sales revert without one):  abx set-primary-payee ${token} --payee 0x…`));
    else console.log(dim(`  ✓ proceeds → ${payee}`));
    if (paused) console.log(yellow(`  • token is paused — open the sale when ready:  abx unpause ${token}`));
    console.log(dim(`  buyers then run:  abx minter buy ${token} --token-id ${tokenId} --quantity <n>`));
    return;
  }

  // 721 path (unchanged): --token-id has no meaning — a 721 sale is one project-wide price.
  if (flags['token-id'] !== undefined) {
    throw new Error(`--token-id is edition-only (per-(token,id) sales) — ${token} is a ${kind.label} (721), sold as a single project-wide sale. Drop --token-id.`);
  }
  const knownMinter = fixedPriceMinterAddress(flags['minter-contract']);
  if (dryRun && !knownMinter) {
    console.log(yellow(`  ⚠ no shared minter deployed on ${CHAIN} yet — a real run deploys it once (a separate tx) before configuring.`));
  }
  const minter = dryRun ? (knownMinter ?? zeroAddress) : await ensureFixedPriceMinter(flags['minter-contract']);

  // Sanity-check the allocation against what the contract can actually mint. A creator who sets
  // --allocation 100 on a 16-supply Series would only ever sell the remainder (maxInvocations binds
  // tighter than the minter's allocation) and discover it when mint #16 reverts. Warn loudly — but
  // don't refuse: allocation is a cap, and holding reserves (allocating < remaining) is legitimate.
  const [maxInv, supplyNow] = await Promise.all([
    readSeries<bigint>(token, 'maxInvocations').catch(() => 0n),
    readSeries<bigint>(token, 'totalSupply').catch(() => 0n),
  ]);
  const remaining = maxInv > supplyNow ? maxInv - supplyNow : 0n;
  if (maxInv > 0n && allocation > remaining) {
    console.log(
      yellow(`  ⚠ allocation ${allocation} exceeds the ${remaining} this contract can still mint `) +
        dim(`(maxInvocations ${maxInv} − ${supplyNow} minted). The token's cap binds tighter, so only ${remaining} will actually sell.`),
    );
    console.log(dim(`    To sell ${allocation}, redeploy a Series with a higher --max; otherwise set --allocation ${remaining} (or less, to hold reserves).`));
  }

  console.log(dim(`  configuring sale on ${minter}`));
  console.log(dim(`    token      ${token}`));
  console.log(dim(`    price      ${isEth ? `${formatEther(price)} ETH` : `${price} units of ${erc20}`} / token`));
  console.log(dim(`    allocation ${allocation}`));
  await runMinterWrite(
    prepareConfigureSale({minter, token, paymentToken: erc20, price, allocation, chainId: chainId()}),
    flags,
    owner,
  );

  // The two grants + the pause switch — surface what's still needed to actually sell.
  const [assignedMinter, payee, paused] = await Promise.all([
    readSeries<Address>(token, 'minter').catch(() => zeroAddress),
    readSeries<Address>(token, 'primaryPayee').catch(() => zeroAddress),
    readSeries<boolean>(token, 'paused').catch(() => false),
  ]);
  const assigned = assignedMinter.toLowerCase() === minter.toLowerCase();
  console.log('');
  console.log(assigned ? dim('  ✓ minter is assigned on the token') : yellow(`  ⚠ assign this minter on the token:  abx set-minter ${token} --minter ${minter}`));
  if (payee === zeroAddress) console.log(yellow(`  ⚠ set a primary payee (sales revert without one):  abx set-primary-payee ${token} --payee 0x…`));
  else console.log(dim(`  ✓ proceeds → ${payee}`));
  if (paused) console.log(yellow(`  • token is paused — open the sale when ready:  abx unpause ${token}`));
  console.log(dim(`  buyers then run:  abx minter buy ${token}`));
}

/** `abx minter show <token>` — the sale terms + the token's readiness (assigned? payee? paused?).
 *  Read-only; the agent runs it to see exactly what's configured before/after a sale. On an
 *  edition, `--token-id` is required and the readout is per-id (copies, not a whole-contract cap). */
export async function cmdMinterShow(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx minter show <token> [--token-id <n> (editions)] [--minter-contract 0x…]';
  const token = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(MINTER_SHOW_FLAGS), 'minter show');
  // Refuse a nonexistent contract like the sibling owner-ops (state/unpause/minter configure) do —
  // otherwise the minter singleton returns zero-config for the unconfigured token and we print a
  // plausible-but-fake `paused: no (open)` readout for an address that has no project at all.
  await assertContractExists(token);
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, token);

  if (kind.isEdition) {
    const tokenId = parseEditionCountFlag(requireFlag(flags, 'token-id', usage), 'token-id');
    const minter = fixedPriceMinter1155Address(flags['minter-contract']);
    if (!minter) {
      console.log(yellow(`  no shared edition minter known for ${CHAIN} — configure a sale (deploys it) or set ABX_FIXED_PRICE_MINTER_1155`));
      return;
    }
    const sale = await readSaleConfig1155(publicClient, minter, token, tokenId);
    // Every read here goes through the EDITION ABI: the generic `read()` is the 721 1/1 ABI,
    // which has no minter()/primaryPayee() at all; a swallowed client-side throw would print a false
    // "not assigned / no payee" for a correctly configured edition.
    const [assignedMinter, payee, paused, maxSupply, supply] = await Promise.all([
      readEdition<Address>(token, 'minter').catch(() => zeroAddress),
      readEdition<Address>(token, 'primaryPayee').catch(() => zeroAddress),
      readEdition<boolean>(token, 'paused').catch(() => false),
      readEdition<bigint>(token, 'maxSupply', [tokenId]).catch(() => 0n),
      readEdition<bigint>(token, 'totalSupply', [tokenId]).catch(() => 0n),
    ]);
    const isEth = sale.paymentToken === zeroAddress;
    const assigned = assignedMinter.toLowerCase() === minter.toLowerCase();

    console.log(bold(`\n  minter sale — ${token} #${tokenId}`));
    console.log(`    shared minter:     ${minter}`);
    if (!sale.configured) {
      console.log(yellow(`    not configured     — abx minter configure ${token} --token-id ${tokenId} --price <eth> --allocation <n>`));
    } else {
      console.log(`    price:             ${isEth ? `${formatEther(sale.price)} ETH` : `${sale.price} units of ${sale.paymentToken}`}`);
      console.log(`    allocation:        ${sale.sold}/${sale.allocation} sold`);
    }
    console.log(`    assigned on token: ${assigned ? green('yes') : yellow(`no — abx set-minter ${token} --minter ${minter}`)}`);
    console.log(`    primary payee:     ${payee === zeroAddress ? yellow('none — abx set-primary-payee …') : payee}`);
    console.log(`    paused:            ${paused ? yellow(`yes — abx unpause ${token}`) : green('no (open)')}`);
    console.log(`    copies:            ${supply}${maxSupply > 0n ? `/${maxSupply}` : dim(' (open — no cap)')}`);
    const remaining = maxSupply > 0n ? (maxSupply > supply ? maxSupply - supply : 0n) : null;
    if (sale.configured && remaining !== null && sale.allocation > remaining) {
      console.log(yellow(`    ⚠ allocation ${sale.allocation} exceeds the ${remaining} still mintable for #${tokenId} (cap ${maxSupply} − ${supply} minted) — only ${remaining} can actually sell.`));
    }
    console.log('');
    return;
  }

  if (flags['token-id'] !== undefined) {
    throw new Error(`--token-id is edition-only — ${token} is a ${kind.label} (721). Drop --token-id.`);
  }
  const minter = fixedPriceMinterAddress(flags['minter-contract']);
  if (!minter) {
    console.log(yellow(`  no shared minter known for ${CHAIN} — configure a sale (deploys it) or set ABX_FIXED_PRICE_MINTER`));
    return;
  }
  const sale = await readSaleConfig(publicClient, minter, token);
  const [assignedMinter, payee, paused, max, supply] = await Promise.all([
    readSeries<Address>(token, 'minter').catch(() => zeroAddress),
    readSeries<Address>(token, 'primaryPayee').catch(() => zeroAddress),
    readSeries<boolean>(token, 'paused').catch(() => false),
    readSeries<bigint>(token, 'maxInvocations').catch(() => 0n),
    readSeries<bigint>(token, 'totalSupply').catch(() => 0n),
  ]);
  const isEth = sale.paymentToken === zeroAddress;
  const assigned = assignedMinter.toLowerCase() === minter.toLowerCase();

  console.log(bold(`\n  minter sale — ${token}`));
  console.log(`    shared minter:     ${minter}`);
  if (!sale.configured) {
    console.log(yellow(`    not configured     — abx minter configure ${token} --price <eth> --allocation <n>`));
  } else {
    console.log(`    price:             ${isEth ? `${formatEther(sale.price)} ETH` : `${sale.price} units of ${sale.paymentToken}`}`);
    console.log(`    allocation:        ${sale.sold}/${sale.allocation} sold`);
  }
  console.log(`    assigned on token: ${assigned ? green('yes') : yellow(`no — abx set-minter ${token} --minter ${minter}`)}`);
  console.log(`    primary payee:     ${payee === zeroAddress ? yellow('none — abx set-primary-payee …') : payee}`);
  console.log(`    paused:            ${paused ? yellow(`yes — abx unpause ${token}`) : green('no (open)')}`);
  console.log(`    supply:            ${supply}/${max}`);
  // Readiness must also flag an allocation that overshoots what the contract can still mint — the
  // same check `minter configure` does, surfaced here (this is the command billed as "check state").
  const remaining = max > supply ? max - supply : 0n;
  if (sale.configured && max > 0n && sale.allocation > remaining) {
    console.log(yellow(`    ⚠ allocation ${sale.allocation} exceeds the ${remaining} still mintable (cap ${max} − ${supply} minted) — only ${remaining} can actually sell.`));
  }
  console.log('');
}

/** `abx minter buy <token> [--to 0x…]` — buy one token through the shared minter (public; any
 *  funded signer). ETH sales attach the price; ERC-20 sales need a prior approval to the minter.
 *  On an edition, `--token-id` is required and `--quantity` (default 1) buys several copies in the
 *  same purchase — the total ETH attached is `price × quantity`. */
export async function cmdMinterBuy(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx minter buy <token> [--to 0x…] [--token-id <n> --quantity <n> (editions)] [--minter-contract 0x…] [--sign|--unsigned]';
  const token = requireAddress(address, usage);
  warnStrayFlags(flags, new Set(MINTER_BUY_FLAGS), 'minter buy');
  const publicClient = makePublicClient({chainKey: CHAIN});
  const kind = await detectTokenKind(publicClient, token);

  if (kind.isEdition) {
    const tokenId = parseEditionCountFlag(requireFlag(flags, 'token-id', usage), 'token-id');
    const quantity = flags.quantity !== undefined ? parseEditionCountFlag(flags.quantity as string, 'quantity') : 1n;
    if (quantity === 0n) throw new Error('--quantity must be at least 1 (0 copies is not a purchase).');
    const minter = fixedPriceMinter1155Address(flags['minter-contract']);
    if (!minter) throw new Error(`no shared edition minter known for ${CHAIN} — configure a sale first, or set ABX_FIXED_PRICE_MINTER_1155`);
    const sale = await readSaleConfig1155(publicClient, minter, token, tokenId);
    if (!sale.configured) throw new Error(`no sale configured for ${token} #${tokenId} — run: abx minter configure ${token} --token-id ${tokenId} …`);
    const isEth = sale.paymentToken === zeroAddress;
    const to = flags.to && flags.to !== 'true' ? (flags.to as Address) : undefined;
    // Payment math AND the buyer's terms bound both come off `sale` inside the SDK op (one
    // computation of price × quantity, for the attached ETH and for `maxTotalPrice`) — the terms
    // just read are the terms the tx commits to, so a mid-flight `configure` reverts instead of
    // spending more. Shown in the confirm/dry-run readout below (runMinterWrite → gatedSend).
    const total = sale.price * quantity;
    if (!isEth) {
      console.log(yellow(`  ERC-20 sale: the buyer must have approved ${minter} to spend ${total} units of ${sale.paymentToken} first (else the tx reverts).`));
    }
    console.log(
      dim(
        `  buying ${quantity} cop${quantity === 1n ? 'y' : 'ies'} of #${tokenId}${to ? ` → ${to}` : ' → signer'} for ` +
          `${isEth ? `${formatEther(total)} ETH (${formatEther(sale.price)} × ${quantity})` : `${total} units (${sale.price} × ${quantity})`}`,
      ),
    );
    await runMinterWrite(preparePurchase1155({minter, token, tokenId, quantity, sale, to, chainId: chainId()}), flags);
    console.log(dim(`  next: \`abx refresh ${token}\` so marketplaces pick up the change.`));
    return;
  }

  if (flags['token-id'] !== undefined || flags.quantity !== undefined) {
    throw new Error(`--token-id/--quantity are edition-only — ${token} is a ${kind.label} (721), where a sale buys exactly one token. Drop them.`);
  }
  const minter = fixedPriceMinterAddress(flags['minter-contract']);
  if (!minter) throw new Error(`no shared minter known for ${CHAIN} — configure a sale first, or set ABX_FIXED_PRICE_MINTER`);
  const sale = await readSaleConfig(publicClient, minter, token);
  if (!sale.configured) throw new Error(`no sale configured for ${token} — run: abx minter configure ${token} …`);
  const isEth = sale.paymentToken === zeroAddress;
  const to = flags.to && flags.to !== 'true' ? (flags.to as Address) : undefined;
  if (!isEth) {
    console.log(yellow(`  ERC-20 sale: the buyer must have approved ${minter} to spend ${sale.price} units of ${sale.paymentToken} first (else the tx reverts).`));
  }
  console.log(dim(`  buying 1 token${to ? ` → ${to}` : ' → signer'} for ${isEth ? `${formatEther(sale.price)} ETH` : `${sale.price} units`}`));
  // The terms just read go into the tx as the buyer's bound (SDK op derives value + maxPrice from
  // `sale`), so an owner who re-`configure`s mid-flight gets a revert, not the buyer's allowance.
  await runMinterWrite(preparePurchase({minter, token, sale, to, chainId: chainId()}), flags);
  console.log(dim(`  next: \`abx refresh ${token}\` so marketplaces pick up the new token.`));
}

// ── PostParam schemas, after deploy ──────────────────────────────────────────
// `setParamSchema` is owner-gated with no deploy-time restriction, so a project's param surface was
// never actually frozen at deploy — the toolkit just had no way to reach it, which read to creators
// as a protocol limitation ("we must guess every param up front, or redeploy and lose the address").
// Two commands close that: `set-schema` (attach or replace one key) and `retire-param` (stop all
// further writes, the closest thing to a delete the protocol has).


/** Values already stored under a key can be stranded by a schema change — the contract does NOT
 *  re-validate them. Compare old vs new and name what would break, so the guard can refuse. */
export function strandingRisks(before: OnChainParamSchema, after: ParsedSchema): string[] {
  const risks: string[] = [];
  const typeName = (i: number) => PARAM_TYPES[i] ?? String(i);
  if (before.paramType !== after.paramType) {
    risks.push(`type ${typeName(before.paramType)} → ${typeName(after.paramType)} (a stored value keeps its old encoding)`);
  }
  const dropped = before.selectOptions.filter((o) => !after.selectOptions.includes(o));
  if (before.selectOptions.length && dropped.length) {
    risks.push(`Select option(s) removed: ${dropped.join(', ')} (a token already set to one keeps it)`);
  }
  // Narrowing either bound can strand a value that sat inside the old range.
  const asInt = (h: Hex) => (PARAM_TYPES[after.paramType] === 'Int256Range' ? BigInt.asIntN(256, BigInt(h)) : BigInt(h));
  if (before.min !== after.min && asInt(after.min) > asInt(before.min)) risks.push(`min raised (${asInt(before.min)} → ${asInt(after.min)})`);
  if (before.max !== after.max && asInt(before.max) !== 0n && asInt(after.max) < asInt(before.max)) {
    risks.push(`max lowered (${asInt(before.max)} → ${asInt(after.max)})`);
  }
  return risks;
}

/** `abx set-schema <address> --schema key:Type:Auth[:lock=<when>]` — attach or replace ONE key's
 *  on-chain schema, any time in a project's life. Owner-only. */
export async function cmdSetSchema(address: string | undefined, flags: Flags): Promise<void> {
  const usage = 'abx set-schema <address> --schema key:Type:Auth[:lock=<when>] [--force] [--dry-run] [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const specs = parseSchemaSpecs(flags.schema as string | undefined);
  if (specs.length !== 1) {
    console.error(`usage: ${usage}\n\n  One key per call — a schema write is a full-row upsert, so batching them hides which one changed.\n`);
    process.exitCode = 1;
    return;
  }
  const next = specs[0];
  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertHasParamsSurface(publicClient, contract, 'abx set-schema');
  const owner = await read<Address>(contract, 'owner');
  const before = await readParamSchema(publicClient, contract, next.key);

  if (!before.exists) {
    console.log(`  ${next.key} ${dim('— new governed key')} ${describeSchema(next)}`);
  } else {
    // The upsert hazard: this is a FULL row write, so anything not restated is overwritten. Show
    // both sides, and refuse a change that could strand values unless the caller insists.
    console.log(`  ${next.key} ${dim('— replacing an existing schema')}`);
    console.log(`    ${dim('before')} ${describeSchema(onChainToParsed(next.key, before))}`);
    console.log(`    ${dim('after ')} ${describeSchema(next)}`);
    const risks = strandingRisks(before, next);
    if (risks.length && flags.force === undefined) {
      throw new Error(
        `refusing to replace "${next.key}" — this change can strand values already stored under it:\n` +
          risks.map((r) => `    • ${r}`).join('\n') +
          `\n\n  The contract does NOT re-validate stored values against a new schema, so affected tokens would keep\n` +
          `  values their own schema no longer allows. Re-run with --force if that is what you intend.`,
      );
    }
    // With --force, say what is being overridden. Silently applying a value-stranding change is the
    // one outcome worse than refusing it: the operator gets no record of which tokens they may have
    // just invalidated, and neither does anyone reading the terminal afterwards.
    if (risks.length) {
      console.log(`    ${C.yellow}⚠${C.reset} ${bold('--force')} — applying a change that can strand stored values:`);
      for (const r of risks) console.log(`        • ${r}`);
      console.log(dim(`        any token already holding a value for "${next.key}" keeps it, now outside what its schema allows.`));
    }
    if (before.lockAfter && !next.lockAfter) {
      console.log(`    ${C.yellow}⚠${C.reset} the existing lock (${new Date(before.lockAfter * 1000).toISOString().slice(0, 19)}Z) is being REMOVED — restate it with :lock= to keep it.`);
    }
  }

  // ONE op. A schema write used to need a `params.keys` companion write in the same tx to keep the
  // on-chain generator's key list in step; the generator now enumerates params from the token
  // itself, so the schema write is the whole change.
  await runWrite(
    contract,
    prepareSetParamSchema({
      contract,
      key: next.key,
      paramType: next.paramType,
      auth: next.auth,
      authAddress: next.authAddress,
      lockAfter: next.lockAfter,
      min: next.min,
      max: next.max,
      selectOptions: next.selectOptions,
      chainId: chainId(),
      display: describeSchema(next),
    }),
    flags,
    owner,
  );
}

/** Render an on-chain schema through the same formatter the CLI uses for a parsed one. */
function onChainToParsed(key: string, s: OnChainParamSchema): ParsedSchema {
  return {
    key,
    paramType: s.paramType,
    auth: s.auth,
    authAddress: s.authAddress,
    lockAfter: s.lockAfter,
    min: s.min,
    max: s.max,
    selectOptions: s.selectOptions,
  };
}

/** `abx retire-param <address> <key>` — permanently stop further writes to a PostParam. */
export async function cmdRetireParam(address: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const usage = 'abx retire-param <address> <key> [--dry-run] [--sign|--unsigned]';
  const contract = requireAddress(address, usage);
  const [key] = positionalArgs(rest);
  if (!key) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }
  const publicClient = makePublicClient({chainKey: CHAIN});
  await assertHasParamsSurface(publicClient, contract, 'abx retire-param');
  const owner = await read<Address>(contract, 'owner');
  const current = await readParamSchema(publicClient, contract, key);
  if (!current.exists) throw new Error(`no PostParam schema for "${key}" on ${contract} — nothing to retire.`);
  if (current.lockAfter && current.lockAfter < Math.floor(Date.now() / 1000)) {
    console.log(`  ${C.green}✓${C.reset} "${key}" is already retired (locked ${new Date(current.lockAfter * 1000).toISOString().slice(0, 19)}Z). Nothing to do.`);
    return;
  }
  console.log(`  ${key} ${dim(describeSchema(onChainToParsed(key, current)))}`);
  console.log(`    ${dim('after this: every write reverts ParamLockExpired — permanently, with no way back.')}`);
  console.log(`    ${dim('the schema stays (a key can never be un-governed), and any value ALREADY stored stays and keeps serving.')}`);
  // Read-modify-write: carry every field forward and change only the lock. Composing a fresh schema
  // here would silently reset type/auth/bounds/options — the upsert clobber this command exists to avoid.
  await runWrite(contract, prepareRetireParam({contract, key, current, chainId: chainId()}), flags, owner);
}
