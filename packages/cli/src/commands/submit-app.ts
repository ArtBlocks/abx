/**
 * `abx submit-app` — optional post-deploy listing in the ABX App Store.
 *
 * Not part of deploy. A creator (or the agent driving them) opts in after the
 * collection exists: mint one entry token through the store's gated minter, then
 * write catalog copy as the registry's TokenOwner params. Same transactions as
 * the store's `/submit` page; the CLI is the agent path.
 *
 * Catalog copy is NOT the collection's `--name` / `--description`. Those are NFT
 * metadata. The store wants outcome copy — what someone can do — and this command
 * requires those fields on purpose so an agent cannot silently reuse deploy flags.
 */
import {
  assertChainId,
  encodeScalarParam,
  makePublicClient,
  prepareConfigureTokenParam,
  prepareConfigureTokenParamData,
  prepareMulticall,
  type Address,
  type Hex,
  type PreparedTx,
} from '@artblocks/abx-sdk';
import {encodeFunctionData, getAddress, isAddress, parseEventLogs, toHex} from 'viem';
import {CHAIN, chainId, explorerBase} from '../config.js';
import {CliError} from '../errors.js';
import {type Flags, isDryRun} from '../flags.js';
import {jsonMode, withJson} from '../jsonout.js';
import {bold, dim, g, ok} from '../output.js';
import {confirmSend, laneFromFlags} from '../riskgate.js';
import {
  openWalletSession,
  signHotSequence,
  signTx,
  type SignResult,
} from '../signer.js';

/** Matches the App Store registry schema (`lib/submissions.ts` in abx-app-store). */
export const APP_CATEGORIES = [
  'Create',
  'Games',
  'Physical world',
  'Records',
  'Coordination',
  'Utilities',
  'Developer tools',
] as const;

export const APP_STAGES = ['Live', 'Prototype', 'Concept'] as const;
export const APP_TONES = ['acid', 'coral', 'blue', 'violet', 'amber', 'mint'] as const;
export const APP_RELATIONSHIP = 'built-on-abx';
export const SUBMIT_APP_CATALOG_NOTE =
  'The on-chain listing is updated. Hosted catalog refresh timing is provider-owned; verify the displayed copy separately. Re-run this command to change the on-chain copy (no second mint).';

const PARAM_KEYS = [
  'name',
  'summary',
  'description',
  'url',
  'urlLabel',
  'image',
  'mark',
  'tone',
  'category',
  'relationships',
  'stage',
  'tags',
] as const;

type ParamKey = (typeof PARAM_KEYS)[number];

/** Sequencer/RPC per-tx gas cap. A full param dump in one multicall exceeds it. */
export const MAX_CALLS_PER_TX = 3;

const MINTER_ABI = [
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [{name: 'collection', type: 'address'}],
    outputs: [{name: 'tokenId', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'claimed',
    stateMutability: 'view',
    inputs: [{name: 'collection', type: 'address'}],
    outputs: [{name: '', type: 'bool'}],
  },
  {
    type: 'function',
    name: 'entryOf',
    stateMutability: 'view',
    inputs: [{name: 'collection', type: 'address'}],
    outputs: [{name: '', type: 'uint256'}],
  },
  {
    type: 'event',
    name: 'EntrySubmitted',
    inputs: [
      {name: 'collection', type: 'address', indexed: true},
      {name: 'tokenId', type: 'uint256', indexed: true},
      {name: 'owner', type: 'address', indexed: true},
    ],
  },
] as const;

const OWNER_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'address'}],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{name: '', type: 'address'}],
  },
] as const;

/**
 * Shipped App Store registry + gated minter, per chain. Override with
 * `--registry` / `--minter` or `ABX_APP_STORE_REGISTRY` / `ABX_APP_STORE_MINTER`.
 * A chain with no row is not an error until someone runs this command there.
 */
const APP_STORE: Record<string, {registry: Address; minter: Address}> = {
  'base-sepolia': {
    registry: '0xBD0D5eE35075E62d970467771775c630B9FB87fa',
    minter: '0xBC0aD16F6501424f7028260a5A396b41aa6d9046',
  },
};

export type SubmitAppEntry = {
  name: string;
  summary: string;
  description: string;
  url: string;
  urlLabel: string;
  image: string;
  mark: string;
  tone: (typeof APP_TONES)[number];
  category: (typeof APP_CATEGORIES)[number];
  stage: (typeof APP_STAGES)[number];
  tags: string[];
};

export type AppStoreAddresses = {registry: Address; minter: Address};

const USAGE =
  'abx submit-app <collection> --name <s> --summary "<s>" --description "<s>" [--mark A/] [--tone acid] [--category Create] [--stage Prototype] [--url https://…] [--url-label "Open app"] [--image https://…] [--tags a,b] [--registry 0x…] [--minter 0x…] [--sign|--unsigned|--dry-run]';

function requireFlag(flags: Flags, name: string): string {
  const v = flags[name];
  if (!v || v === 'true') {
    throw new Error(`missing --${name}\nusage: ${USAGE}`);
  }
  return v;
}

function optionalFlag(flags: Flags, name: string): string {
  const v = flags[name];
  if (!v || v === 'true') return '';
  return v;
}

function oneOf<T extends string>(value: string, options: readonly T[], flag: string): T {
  if ((options as readonly string[]).includes(value)) return value as T;
  throw new Error(`--${flag} must be one of ${options.join(' | ')} (got "${value}").`);
}

function requireHttps(value: string, flag: string): string {
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--${flag} must be an HTTPS URL.`);
  }
  if (url.protocol !== 'https:') throw new Error(`--${flag} must be an HTTPS URL.`);
  return value.trim();
}

function parseTags(raw: string): string[] {
  if (!raw) return [];
  const tags = raw
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > 12) throw new Error('--tags accepts at most 12 tags.');
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag.length > 60) throw new Error(`tag "${tag}" is longer than 60 characters.`);
    const key = tag.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate tag "${tag}".`);
    seen.add(key);
  }
  return tags;
}

function bound(value: string, flag: string, max: number, min = 1): string {
  const t = value.trim();
  if (t.length < min) throw new Error(`--${flag} is required.`);
  if (t.length > max) throw new Error(`--${flag} is longer than ${max} characters.`);
  return t;
}

/**
 * Catalog copy from flags. Requires name / summary / description so deploy identity
 * cannot silently become the listing.
 */
export function parseSubmitAppEntry(flags: Flags): SubmitAppEntry {
  return {
    name: bound(requireFlag(flags, 'name'), 'name', 100),
    summary: bound(requireFlag(flags, 'summary'), 'summary', 240),
    description: bound(requireFlag(flags, 'description'), 'description', 2_000),
    url: requireHttps(optionalFlag(flags, 'url'), 'url'),
    urlLabel: optionalFlag(flags, 'url-label').trim().slice(0, 60),
    image: requireHttps(optionalFlag(flags, 'image'), 'image'),
    mark: bound(optionalFlag(flags, 'mark') || 'A/', 'mark', 3),
    tone: oneOf(optionalFlag(flags, 'tone') || 'acid', APP_TONES, 'tone'),
    category: oneOf(optionalFlag(flags, 'category') || 'Create', APP_CATEGORIES, 'category'),
    stage: oneOf(optionalFlag(flags, 'stage') || 'Prototype', APP_STAGES, 'stage'),
    tags: parseTags(optionalFlag(flags, 'tags')),
  };
}

export function paramValues(entry: SubmitAppEntry): Record<ParamKey, string> {
  return {
    name: entry.name,
    summary: entry.summary,
    description: entry.description,
    url: entry.url,
    urlLabel: entry.urlLabel,
    image: entry.image,
    mark: entry.mark,
    tone: entry.tone,
    category: entry.category,
    relationships: APP_RELATIONSHIP,
    stage: entry.stage,
    tags: entry.tags.join(','),
  };
}

export function resolveAppStoreAddresses(
  chainKey: string,
  flags: Flags = {},
  env: NodeJS.ProcessEnv = process.env,
): AppStoreAddresses {
  const shipped = APP_STORE[chainKey];
  const registryRaw =
    optionalFlag(flags, 'registry') || env.ABX_APP_STORE_REGISTRY || shipped?.registry;
  const minterRaw = optionalFlag(flags, 'minter') || env.ABX_APP_STORE_MINTER || shipped?.minter;
  if (!registryRaw || !minterRaw) {
    throw new Error(
      `No ABX App Store registry is shipped for '${chainKey}'. Pass --registry 0x… and --minter 0x… ` +
        `(or set ABX_APP_STORE_REGISTRY / ABX_APP_STORE_MINTER).`,
    );
  }
  if (!isAddress(registryRaw) || !isAddress(minterRaw)) {
    throw new Error('--registry and --minter must be 0x… addresses.');
  }
  return {registry: getAddress(registryRaw), minter: getAddress(minterRaw)};
}

export function chunkItems<T>(items: T[], size = MAX_CALLS_PER_TX): T[][] {
  if (size < 1) throw new Error('chunk size must be ≥ 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildParamOps(args: {
  registry: Address;
  tokenId: bigint;
  entry: SubmitAppEntry;
  chainId: number;
}): PreparedTx[] {
  const values = paramValues(args.entry);
  const ops: PreparedTx[] = [];
  for (const key of PARAM_KEYS) {
    const value = values[key];
    if (value === '') continue;
    if (key === 'tone') {
      const encoded = encodeScalarParam('Select', value, [...APP_TONES]);
      ops.push(
        prepareConfigureTokenParam({
          contract: args.registry,
          tokenId: args.tokenId,
          key,
          value: encoded.value,
          display: encoded.display,
          chainId: args.chainId,
        }),
      );
      continue;
    }
    ops.push(
      prepareConfigureTokenParamData({
        contract: args.registry,
        tokenId: args.tokenId,
        key,
        data: toHex(new TextEncoder().encode(value)),
        chainId: args.chainId,
      }),
    );
  }
  return ops;
}

export function batchParamOps(ops: PreparedTx[]): PreparedTx[] {
  return chunkItems(ops, MAX_CALLS_PER_TX).map((group, i, all) => {
    if (group.length === 1) return group[0];
    return prepareMulticall({
      ops: group,
      summary: `Write App Store metadata ${i + 1}/${all.length} (${group.length} fields)`,
    });
  });
}

function prepareSubmitCollection(args: {
  minter: Address;
  collection: Address;
  chainId: number;
}): PreparedTx {
  return {
    op: 'submit-app',
    to: args.minter,
    data: encodeFunctionData({
      abi: MINTER_ABI,
      functionName: 'submit',
      args: [args.collection],
    }),
    value: '0x0',
    chainId: args.chainId,
    summary: `List ${args.collection} in the ABX App Store`,
    fields: {minter: args.minter, collection: args.collection},
  };
}

function tokenIdFromMintLogs(logs: {data: Hex; topics: readonly Hex[]}[]): bigint | null {
  try {
    const parsed = parseEventLogs({
      abi: MINTER_ABI,
      logs: logs as never,
      eventName: 'EntrySubmitted',
    });
    const first = parsed[0];
    return first ? (first.args.tokenId as bigint) : null;
  } catch {
    return null;
  }
}

/**
 * Bounded, backed-off retry for ONLY the first metadata write immediately following a mint THIS
 * run performed.
 *
 * `pinGas` (packages/sdk/src/execute.ts) is a provable-floor lie detector: it re-tries an estimate
 * only when the number it got back is BELOW a gas floor it can compute in advance from bytes stored
 * on-chain (its own docs walk through why). None of `buildParamOps`'s writes carry a `gasFloor` — a
 * param write has no on-chain bytes to compute one from — so an estimate revert on any of them
 * surfaces through `pinGas` immediately, with zero retries: `if (floor === 0n) throw err`. That is
 * the right GENERAL behavior — an unfloored estimate revert is usually a real rejection ("caller is
 * not the token owner"), and teaching `pinGas` to retry every unfloored revert would hide real ones
 * behind a multi-second stall on every write the CLI makes, not just this one.
 *
 * This ONE call site is different in a way `pinGas` has no way to see: the token being written to is
 * one THIS SAME PROCESS just minted a few lines up. Its estimate reverting is very likely the same
 * read-after-write lag `execute.ts` already retries the nonce and the code-deposit gas for — the RPC
 * answering the estimate hasn't caught up to the mint's block yet, so the registry's owner-gated
 * param check reads a token that (from that node's point of view) does not exist yet — just on a
 * write `pinGas` has no floor to detect it with. So the retry lives here, scoped to exactly the one
 * write our own just-broadcast mint could have caused to fail this way (see `resumableConfigError`
 * for what happens once the bound is spent).
 */
export const FIRST_METADATA_WRITE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;

/**
 * Takes a `send` thunk rather than a tx + lane opts so the retry policy is testable on its own — a
 * fake `send` that fails a scripted number of times before succeeding, no RPC or signing involved —
 * the same shape `sendMintThenParams` above already uses for its lane-agnostic send injection.
 */
export async function withFirstMetadataWriteRetry<T>(
  send: () => Promise<T>,
  delaysMs: readonly number[] = FIRST_METADATA_WRITE_RETRY_DELAYS_MS,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await send();
    } catch (err) {
      const delay = delaysMs[retry];
      if (delay === undefined) throw err; // bound spent — surface the real error to the caller
      console.log(
        dim(
          `  metadata write did not simulate yet (RPC may still be catching up to the mint) — ` +
            `retrying in ${delay / 1000}s… (retry ${retry + 1}/${delaysMs.length})`,
        ),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Wrap an exhausted retry as an explicit resumable result instead of a bare estimate error. The mint
 * already happened and is irreversible, and the collection's `claimed` gate — read at the top of
 * `cmdSubmitApp`, before either lane decides whether to build a mint tx at all — means the NEXT
 * invocation, even seconds later once the RPC has caught up, is guaranteed to skip straight to
 * writing metadata onto THIS token rather than minting a second one (see `cmdSubmitApp`'s `claimed`
 * read and its `if (claimed) { … } else { … }` branch just below it — a fresh mint is only ever
 * prepared in the `else`). So the fix is always the same command again, never a different one — name
 * that explicitly rather than leaving a raw revert on screen with no next step.
 */
export function resumableConfigError(args: {tokenId: bigint; cause: unknown}): Error {
  const reason = args.cause instanceof Error ? args.cause.message : String(args.cause);
  return new Error(
    `Minted token #${args.tokenId.toString()}, but its metadata still won't simulate after retrying — nothing ` +
      `else was sent. The collection is now claimed, so re-running this exact command will skip the mint and ` +
      `pick up writing metadata onto token #${args.tokenId.toString()}.\n  underlying: ${reason}`,
  );
}

function previewTx(tx: PreparedTx, expectedSigner?: Address): void {
  console.log(`\n  ${bold('◆ ' + tx.summary)}  ${dim('(dry run — nothing sent)')}`);
  for (const [k, v] of Object.entries(tx.fields)) console.log(`    ${dim(k.padEnd(12))} ${v}`);
  console.log(`    ${dim('to'.padEnd(12))} ${tx.to ?? dim('(none)')}`);
  if (expectedSigner) console.log(`    ${dim('signer'.padEnd(12))} ${expectedSigner}`);
}

export async function cmdSubmitApp(address: string | undefined, flags: Flags): Promise<void> {
  if (!address || address.startsWith('--')) {
    console.error(`usage: ${USAGE}\n`);
    throw new CliError('', 1, true);
  }
  if (!isAddress(address)) {
    throw new Error(`<collection> must be a 0x… address (got "${address}").`);
  }
  const collection = getAddress(address);
  const entry = parseSubmitAppEntry(flags);
  const store = resolveAppStoreAddresses(CHAIN, flags);
  const cid = chainId();
  const publicClient = makePublicClient({chainKey: CHAIN});

  const claimed = (await publicClient.readContract({
    address: store.minter,
    abi: MINTER_ABI,
    functionName: 'claimed',
    args: [collection],
  })) as boolean;

  let tokenId: bigint | null = null;
  let expectedSigner: Address;
  if (claimed) {
    tokenId = (await publicClient.readContract({
      address: store.minter,
      abi: MINTER_ABI,
      functionName: 'entryOf',
      args: [collection],
    })) as bigint;
    expectedSigner = (await publicClient.readContract({
      address: store.registry,
      abi: OWNER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as Address;
    // This narration runs BEFORE `withJson` below ever starts — its console.log → stderr swap
    // hasn't engaged yet, so an unguarded `console.log` here would land on the real stdout and
    // corrupt the one JSON document `--json` promises there (see jsonout.ts). Every other narration
    // line in this command lives inside the `withJson` body for exactly that reason; this is the one
    // read that happens first (deciding whether to mint at all), so it routes itself the same way
    // `withJson` would: stderr under `--json` (still visible, never suppressed), plain stdout
    // otherwise.
    const alreadyListedLine = `  already listed as token #${tokenId.toString()} — skipping mint, writing metadata (same as /update).`;
    if (jsonMode(flags)) process.stderr.write(dim(alreadyListedLine) + '\n');
    else console.log(dim(alreadyListedLine));
  } else {
    expectedSigner = (await publicClient.readContract({
      address: collection,
      abi: OWNER_ABI,
      functionName: 'owner',
      args: [],
    })) as Address;
  }

  const paramOps = tokenId !== null
    ? buildParamOps({registry: store.registry, tokenId, entry, chainId: cid})
    : buildParamOps({registry: store.registry, tokenId: 0n, entry, chainId: cid});
  // When the token id isn't known yet, ops are only used to count batches for the sign-page total
  // and the dry-run preview. Calldata is rebuilt after mint with the real id.
  const paramBatches = batchParamOps(paramOps);
  const mintTx = claimed
    ? null
    : prepareSubmitCollection({minter: store.minter, collection, chainId: cid});
  const approvalCount = (mintTx ? 1 : 0) + paramBatches.length;

  return withJson(flags, async (emit) => {
    if (isDryRun(flags)) {
      if (mintTx) previewTx(mintTx, expectedSigner);
      console.log(
        dim(
          `\n  then ${paramBatches.length} metadata transaction(s) (${paramOps.length} fields, max ${MAX_CALLS_PER_TX} per tx).`,
        ),
      );
      for (const key of PARAM_KEYS) {
        const value = paramValues(entry)[key];
        if (value === '') continue;
        console.log(`    ${dim(key.padEnd(16))} ${value.length > 80 ? value.slice(0, 77) + '…' : value}`);
      }
      console.log(dim(`\n  Re-run without --dry-run to send (lane: ${laneFromFlags(flags)}).\n`));
      return {
        collection,
        chainId: cid,
        registry: store.registry,
        minter: store.minter,
        claimed,
        tokenId: tokenId !== null ? tokenId.toString() : null,
        sent: false,
        approvals: approvalCount,
      };
    }

    await confirmSend(
      claimed
        ? `Update App Store listing #${tokenId!.toString()} (${paramBatches.length} metadata tx)`
        : `List ${collection} in the App Store (mint + ${paramBatches.length} metadata tx)`,
      flags,
    );
    await assertChainId(CHAIN);

    const lane = laneFromFlags(flags);
    let mintHash: Hex | null = null;
    let paramsHashes: Hex[] = [];
    let listedId = tokenId;

    // The mint is real and irreversible the moment its receipt confirms — a `--json` caller must be
    // able to recover that token id even if every step after this one fails (jsonout.ts's `withJson`
    // prints whatever was last `emit()`-ed before a later throw, alongside the error). Nothing past
    // the mint is guaranteed sent yet, so this always reports `sent: false`; the final return at the
    // bottom of this function is the only place that reports `sent: true`, and (per withJson) a
    // returned value always wins over an earlier emit.
    const emitMinted = () =>
      emit({
        collection,
        chainId: cid,
        registry: store.registry,
        minter: store.minter,
        claimed,
        tokenId: listedId !== null ? listedId.toString() : null,
        sent: false,
        mintTx: mintHash,
        paramsTxs: paramsHashes,
      });

    const sendMintThenParams = async (send: (tx: PreparedTx) => Promise<{txHash: Hex; logs: {data: Hex; topics: readonly Hex[]}[]}>): Promise<void> => {
      if (mintTx) {
        const minted = await send(mintTx);
        mintHash = minted.txHash;
        listedId = tokenIdFromMintLogs(minted.logs);
        if (listedId === null) {
          throw new Error(
            'Mint succeeded but the entry token id was not in the receipt. The collection is claimed — retry to write metadata onto the existing token.',
          );
        }
        ok(`listed as token #${listedId.toString()}`);
        emitMinted();
      }
      const ops = buildParamOps({
        registry: store.registry,
        tokenId: listedId!,
        entry,
        chainId: cid,
      });
      const batches = batchParamOps(ops);
      for (const [i, tx] of batches.entries()) {
        const sent = await send(tx);
        paramsHashes.push(sent.txHash);
        console.log(dim(`  metadata ${i + 1}/${batches.length}`));
      }
    };

    if (lane === 'unsigned') {
      // Cold lane can't do mint-then-params in one shot (the token id is assigned at mint).
      // Print the mint (or the param batches if already claimed) and stop.
      if (mintTx) {
        await signTx(mintTx, {
          lane: 'unsigned',
          chainKey: CHAIN,
          expectedSigner,
          yes: !!flags.yes,
        });
        console.log(
          dim(
            '  After the mint confirms, re-run this command to write catalog copy onto the new token (configure is an upsert).',
          ),
        );
      } else {
        for (const tx of paramBatches) {
          await signTx(tx, {
            lane: 'unsigned',
            chainKey: CHAIN,
            expectedSigner,
            yes: !!flags.yes,
          });
        }
      }
      return {
        collection,
        chainId: cid,
        registry: store.registry,
        minter: store.minter,
        claimed,
        tokenId: listedId !== null ? listedId.toString() : null,
        sent: false,
        mintTx: null,
        paramsTxs: [],
      };
    }

    if (lane === 'send') {
      const results: SignResult[] = [];
      if (mintTx) {
        const minted = await signTx(mintTx, {
          lane: 'send',
          chainKey: CHAIN,
          expectedSigner,
          yes: !!flags.yes,
        });
        if (!minted) throw new Error('Mint was not sent.');
        results.push(minted);
        mintHash = minted.txHash;
        const receipt = await publicClient.getTransactionReceipt({hash: minted.txHash});
        listedId = tokenIdFromMintLogs(receipt.logs);
        if (listedId === null) {
          throw new Error(
            'Mint succeeded but the entry token id was not in the receipt. Retry to write metadata onto the existing token.',
          );
        }
        ok(`listed as token #${listedId.toString()}`);
        emitMinted();
      }
      const ops = buildParamOps({
        registry: store.registry,
        tokenId: listedId!,
        entry,
        chainId: cid,
      });
      const batches = batchParamOps(ops);
      if (batches.length > 0) {
        // Only the batch immediately after OUR OWN just-broadcast mint risks the read-after-write RPC
        // lag `withFirstMetadataWriteRetry` retries: a run that skipped straight to `configure` (already
        // claimed, no mint this run) hits state that has been settled for as long as the collection
        // has been listed, so it gets the ordinary un-retried path instead.
        const [first, ...rest] = batches;
        const sendFirst = async (): Promise<SignResult> =>
          (await signHotSequence([first], {chainKey: CHAIN, yes: !!flags.yes}))[0];
        let firstResult: SignResult;
        try {
          firstResult = mintTx ? await withFirstMetadataWriteRetry(sendFirst) : await sendFirst();
        } catch (err) {
          // Bounded retries spent (or this wasn't a fresh mint, so none were attempted): the mint is
          // done either way, so tell the caller exactly how to finish rather than a bare estimate
          // error with no next step.
          throw resumableConfigError({tokenId: listedId!, cause: err});
        }
        results.push(firstResult);
        paramsHashes.push(firstResult.txHash);
        if (rest.length > 0) {
          const restResults = await signHotSequence(rest, {chainKey: CHAIN, yes: !!flags.yes});
          results.push(...restResults);
          paramsHashes.push(...restResults.map((r) => r.txHash));
        }
      }
    } else {
      const session = await openWalletSession({
        chainKey: CHAIN,
        expectedSigner,
        total: approvalCount,
        port: flags.port ? Number(flags.port) : undefined,
        signUrlFile: flags['sign-url-file'],
      });
      try {
        await session.connect();
        await sendMintThenParams(async (tx) => {
          const {txHash, receipt} = await session.send(tx);
          return {txHash, logs: receipt.logs};
        });
      } finally {
        session.close();
      }
    }

    console.log(
      `\n  ${g('Listed.')} token #${listedId!.toString()} on ${CHAIN}  ${dim(explorerBase() + '/token/' + store.registry + '?a=' + listedId!.toString())}`,
    );
    console.log(dim(`  ${SUBMIT_APP_CATALOG_NOTE}`));

    return {
      collection,
      chainId: cid,
      registry: store.registry,
      minter: store.minter,
      claimed,
      tokenId: listedId!.toString(),
      sent: true,
      mintTx: mintHash,
      paramsTxs: paramsHashes,
    };
  });
}
