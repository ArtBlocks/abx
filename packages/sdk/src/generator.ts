/**
 * The canonical on-chain generator — `AbxGenerator` (site/content/docs/protocol/code-projects.mdx →
 * "The canonical generator"). One field renderer for the `animation_url` field serving both
 * code custody modes: **template** (script chunks → the full HTML document, chain-complete
 * when every dependency resolves to on-chain bytes) and **directory** (`code` field → a
 * parameterized gateway URL, `text/uri-list` → landed verbatim by the metadata renderer).
 *
 * The view surface here is hand-written (the generator isn't a factory-synced artifact —
 * it's a per-chain singleton recorded in the deployments manifest; see `resolveGenerator`).
 * `onChainStatus` is the honesty read `abx verify` consumes.
 */
import type {Address, Hex} from 'viem';
import {decodeTag} from './spine.js';

/** The generator's view surface (IAbxFieldRenderer + the honesty/piecewise reads). */
export const abxGeneratorAbi = [
  {
    type: 'function',
    name: 'render',
    stateMutability: 'view',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'tokenId', type: 'uint256'},
      {name: 'field', type: 'bytes32'},
    ],
    outputs: [
      {name: 'contentType', type: 'string'},
      {name: 'data', type: 'bytes'},
    ],
  },
  {
    type: 'function',
    name: 'onChainStatus',
    stateMutability: 'view',
    inputs: [{name: 'token', type: 'address'}],
    outputs: [
      {name: 'branch', type: 'uint8'},
      {name: 'chainComplete', type: 'bool'},
      {name: 'unresolvedRefs', type: 'bytes32[]'},
      {name: 'urlOverBudget', type: 'bool'},
    ],
  },
  {
    type: 'function',
    name: 'document',
    stateMutability: 'view',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'tokenId', type: 'uint256'},
    ],
    outputs: [{name: '', type: 'string'}],
  },
  {
    type: 'function',
    name: 'tokenDataJson',
    stateMutability: 'view',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'tokenId', type: 'uint256'},
    ],
    outputs: [{name: '', type: 'string'}],
  },
  {
    type: 'function',
    name: 'dependencyTag',
    stateMutability: 'view',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'index', type: 'uint256'},
    ],
    outputs: [{name: '', type: 'string'}],
  },
  // The rest of the piecewise set. `document` on a large project can exceed a node's eth_call gas cap
  // (tokenURI assembly measures ~360-405k gas per KB, climbing with size), and these are how a client assembles the same
  // document from pieces instead: the two baked runtime blobs, plus a registry dependency's chunks
  // one at a time. Every read here is an OFF-CHAIN view call by design — no contract calls them.
  {
    type: 'function',
    name: 'abxJs',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'string'}],
  },
  {
    type: 'function',
    name: 'gunzipScript',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'string'}],
  },
  {
    type: 'function',
    name: 'registryScriptChunk',
    stateMutability: 'view',
    inputs: [
      {name: 'registry', type: 'address'},
      {name: 'ref', type: 'bytes32'},
      {name: 'index', type: 'uint256'},
    ],
    outputs: [{name: '', type: 'string'}],
  },
] as const;

/** `AbxGenerator`'s branch constants, by index: 0 = none, 1 = template, 2 = directory. */
export const GENERATOR_BRANCHES = ['none', 'template', 'directory'] as const;
export type GeneratorBranch = (typeof GENERATOR_BRANCHES)[number];

/** The generator's URL size budget for the directory branch (gateway request-line cap). */
export const GENERATOR_URL_BUDGET_BYTES = 8192;

/** The decoded `onChainStatus` read — the `abx verify` / marketplace-tooling surface. */
export interface GeneratorStatus {
  branch: number;
  branchName: GeneratorBranch;
  /** Template branch with EVERY dependency resolved to on-chain bytes — no server, gateway, or CDN
   *  in the graph. Always false off it.
   *
   *  A claim about WHERE the bytes come from, never about whether they are frozen: a `Registry`
   *  dependency is re-fetched from the registry contract on every read, so its bytes can change while
   *  this stays `true` — including after `lockDependencies` (which freezes the ref and the registry
   *  pointer, not another contract's storage). Don't render this as "immutable" in a UI. */
  chainComplete: boolean;
  /** Refs that emit `<!-- abx:unresolved … -->` markers, decoded to their readable tags. */
  unresolvedRefs: string[];
  /** Directory branch: the emitted URL exceeds the 8KB budget. Always false off it. */
  urlOverBudget: boolean;
}

/** The one read this module needs — structurally satisfied by a viem `PublicClient` or a test mock. */
export interface GeneratorReadClient {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/** eth_call `generator.onChainStatus(token)` and decode it (branch name + readable refs). */
export async function readGeneratorStatus(
  client: GeneratorReadClient,
  generator: Address,
  token: Address,
): Promise<GeneratorStatus> {
  const [branch, chainComplete, unresolvedRefs, urlOverBudget] = (await client.readContract({
    address: generator,
    abi: abxGeneratorAbi,
    functionName: 'onChainStatus',
    args: [token],
  })) as [number, boolean, readonly Hex[], boolean];
  return {
    branch: Number(branch),
    branchName: GENERATOR_BRANCHES[Number(branch)] ?? 'none',
    chainComplete,
    unresolvedRefs: unresolvedRefs.map((ref) => decodeTag(ref)),
    urlOverBudget,
  };
}
