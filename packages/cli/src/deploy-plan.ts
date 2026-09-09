/**
 * The structured `--dry-run --json` / `--json` deploy plan.
 *
 * The JSON payload and human prose are rendered from the same values but remain separate surfaces.
 * Deploy is a high-stakes command family (real gas, address pinning, salt reservation), its exact
 * dry-run prose is covered extensively, and the end-user skill depends on that prose. This module
 * therefore provides a versioned, typed object populated from the SAME locals `commands/deploy.ts`
 * uses for human narration at every `emit(jsonSafe({...}))` call site.
 *
 * A field a lane genuinely has no answer for is explicit `null`, never silently absent — that
 * distinction (present-but-empty vs. not-applicable-here) is the whole point of a schema. See each
 * `deploy.ts` call site for the specific reasoning behind its nulls.
 */
import type {Address} from '@artblocks/abx-sdk';

/** Bump whenever a field is added, renamed, or reinterpreted — a consumer keys behavior off this,
 *  not off the CLI's own package version (that changes for reasons unrelated to this shape).
 *
 *  `as const` is load-bearing, not decoration: a plain `= 1` is a WIDENING literal, so the moment it
 *  is read into an un-annotated intermediate object (the resume lane builds one and spreads it into
 *  several emits) the property degrades to `number` and stops satisfying `DeployPlan`. Keep it.
 *
 *  v2 (this change): added `custody.renderer` and `custody.image`; reinterpreted `transactions.legs`
 *  to end with `'deploy'` whenever it is non-null (previously silent about the deploy tx itself —
 *  see each field's own doc comment). A consumer keying behavior off `legs`' shape needs to know
 *  which version it's reading. */
export const DEPLOY_PLAN_SCHEMA_VERSION = 2 as const;

/** The six product lanes `deploy.ts` implements — a stable discriminator independent of the legacy
 *  `command`/`kind` fields already on the payload (which exist for backward compat and don't fully
 *  agree with each other across lanes: `kind: 'edition-code'` vs. this union's `'code-edition'`). */
export type DeployPlanFamily = '1of1' | '1of1-edition' | 'series' | 'series-edition' | 'code' | 'code-edition';

/** The three signing lanes `laneFromFlags` resolves to, reused verbatim. */
export type DeployPlanLane = 'send' | 'sign' | 'unsigned';

export interface DeployPlanTransactions {
  /** Wallet TX SIGNATURES this run needs — the exact same count the lane's own dry-run/confirm
   *  "approvals" line reports (an off-chain storage upload is a separate signature class, never
   *  counted here — see the `approvals` local at each call site). */
  approvals: number;
  /**
   * The ordered, NAMED stages this run signs, ending with `'deploy'` itself — e.g.
   * `['onchain-image-staging', 'deploy']` for an image lane staging bytes into the chunk store first,
   * or `['chunks', 'param-schemas', 'dependencies', 'onchain-uri', 'mints', 'deploy']` for a code
   * project whose setup rides one or more gas-bounded transactions ahead of the deploy tx. `null`
   * when the deploy is a single, self-contained transaction with no named stage worth calling out.
   *
   * A stage name is a GROUP, not a 1:1 tx count: `'chunks'`/`'onchain-image-staging'` can be one
   * atomic write or SEVERAL gas-bounded batch transactions (a 60KB+ script's setup, in particular —
   * see `commands/deploy.ts`'s `planCodeSetupBatches`), and `approvals` is what reports the real
   * total signature count — `legs.length` never needs to equal `approvals`. The one invariant this
   * schema DOES hold: `legs === null` iff `approvals` is exactly the trivial case for that lane (1 for
   * a fresh deploy with nothing riding ahead of it; the resume lane's own fixed count when everything
   * is already done) — i.e. non-null legs always means "something happens beyond the bare minimum."
   *
   * EXCEPTION: the `--resume` lane never deploys (the contract already exists), so its legs name only
   * the groups riding the setup transaction(s) it sends (one or more, gas-bounded, same as a fresh
   * deploy) and never include `'deploy'` — see the `resumeLegs` call sites in `commands/deploy.ts` for
   * why that lane's unit model differs.
   */
  legs: string[] | null;
}

export interface DeployPlanRoles {
  /** The address that signs this deploy. `null` only when genuinely unknown yet (a dry run with no
   *  `--for` and no resolvable wallet key — the plan is still previewable; just not addressed to
   *  anyone in particular). */
  signer: string | null;
  /** Always equal to `signer` in this codebase — every lane sets `owner: deployer` — carried as its
   *  own field because a consumer reasoning about roles shouldn't have to know that fact. */
  owner: string | null;
  royaltyReceiver: string | null;
  /** `null` when no `--primary-payee` was given (sale proceeds go to the owner) — the lanes with no
   *  concept of a delegated payee at all (the plain 1/1) also report `null` here. */
  primaryPayee: string | null;
  /** `null` when no `--minter` was given (only the owner can mint) — same "no concept" case as
   *  `primaryPayee` on the plain 1/1 lane. */
  minter: string | null;
}

export interface DeployPlanRoyalty {
  bps: number;
  capBps: number;
  burnable: boolean;
}

export interface DeployPlanCustody {
  /** Does `tokenURI`/`contractURI` (or `uri`/`contractURI` on an edition) resolve on-chain via the
   *  canonical renderer, vs. through a resolver base baked on-chain. */
  onChainUri: boolean;
  /** Are the IMAGE bytes themselves on-chain (a chunk-store `reader` field) — distinct from
   *  `onChainUri`, which only says the metadata JSON resolves on-chain (see deploy.ts's own
   *  "puts the metadata JSON on-chain, not the image" warning). `null` on the code lanes, where an
   *  image is one of several independently-disposed surfaces — see `surfaces.thumbnail` instead. */
  imageOnChain: boolean | null;
  /** The off-chain storage backend holding bytes this deploy custodies (e.g. `ipfs`, `arweave`,
   *  `fs`) — `null` when nothing is stored off-chain (fully on-chain content, or a code project
   *  whose script chunks are on-chain and carries no directory build). */
  backend: string | null;
  /** The on-chain `tokenURIBase`/`contractURIBase` this deploy writes — `null`, not `''`, when the
   *  lane deliberately leaves it empty because the on-chain renderer is authoritative (baking a
   *  base anyway would be misleading: nothing ever reads it while a renderer is set). */
  tokenUriBase: string | null;
  contractUriBase: string | null;
  /** The on-chain renderer address serving `tokenURI`/`contractURI` — the SAME address the "On-chain
   *  renderer" step already prints (`would use renderer 0x…` on a dry run, `using renderer 0x…` on a
   *  real send). The zero address there means "would deploy the canonical renderer fresh," never
   *  "no renderer" — a consumer reading this field needs the same caveat the prose carries. `null`
   *  when `onChainUri` is false: off-chain custody has no renderer question to answer. On a
   *  `--resume` emit this is always `null` too — the renderer is an InitParams field fixed at the
   *  ORIGINAL deploy (like `royalty`/`mint`, see their own doc comments), and a resume doesn't
   *  re-read or re-decide it here. */
  renderer: Address | null;
  /** File-level facts about the `--onchain-image` bytes THIS deploy stages, read locally (no chain
   *  call) from the exact path `--image` names — `null` unless `imageOnChain` is `true` on a lane
   *  that stages a SINGLE file (the 1/1 and 1/1-edition lanes). `null` on `series`/`series-edition`
   *  too even when `imageOnChain` is `true` there: those lanes stage ONE FILE PER TOKEN, so no
   *  single-file shape fits — the per-token detail is prose-only today (see the `previewImageStaging`
   *  loop in `commands/deploy.ts`). */
  image: DeployPlanImageFile | null;
}

export interface DeployPlanImageFile {
  /** Raw size of the file on disk, in bytes — the same number the "Stage on-chain image" step's
   *  `NNNB → …` line already prints. */
  bytes: number;
  /** Size after the staging plan's chunking/compression (`--compress fastlz` shrinks per chunk;
   *  `gzip` shrinks the whole file; `none` leaves it unchanged) — the same number that line's
   *  `[fastlz NNN→MMMB]` bracket already prints. */
  stagedBytes: number;
  /** MIME type sniffed from the file's extension (the same `contentTypeFromPath` helper every other
   *  content-type-aware line in this file uses) — not itself printed by the staging preview line,
   *  but a deterministic fact about the exact file already opened for that preview, computed locally
   *  with no chain read, so reporting it costs nothing and fabricates nothing. */
  mimeType: string;
  /** keccak256 of the RAW (pre-compression) file bytes. This is NOT an on-chain commitment — a
   *  reader-backed on-chain image has none; the bytes themselves ARE the on-chain content, so there
   *  is nothing to commit to separately. It is a content-addressing fact about the LOCAL file,
   *  computed the same way (no chain read) for a `--json` consumer that wants to verify provenance
   *  later against what actually got staged. */
  contentHash: string;
}

export interface DeployPlanMint {
  /** True when nothing mints at deploy (mint later, or via a delegated minter/sale). */
  deferred: boolean;
  /** How many distinct tokens/ids mint at deploy — `0` when deferred. */
  count: number;
  /** Copies PER id (edition lanes only) — `null` on a unique-token lane, where the concept doesn't
   *  exist (every id is exactly one copy by construction). A bigint, stringified (see jsonSafe). */
  amountPerId: string | null;
  recipient: string | null;
}

export interface DeployPlanEstimate {
  /**
   * A rough, hedged order-of-magnitude ETH/gas figure for THIS deploy's on-chain write cost.
   *
   * `null` is not "not implemented yet" here — it is the honest answer on every lane that genuinely
   * computes no such number today, including the image lanes' `--onchain-image` staging (1/1,
   * 1/1-edition, series, series-edition all skip this: verified directly — none of them prices gas or
   * prints an "est. on-chain cost" line anywhere on the dry-run path). The ONE lane that does compute
   * and print one is the fresh `code` family's on-chain-byte-storage guidance (a best-effort
   * `~200 gas/byte` heuristic priced at the live gas price, wrapped in a try/catch that skips silently
   * if the RPC can't price gas) — see the `planEstimate` local in `commands/deploy.ts`.
   *
   * This field NEVER re-derives or newly computes a number for the plan — it only carries over the
   * exact estimate the human readout already printed. Do not extend this to a lane that doesn't
   * already print one without saying so explicitly wherever that change is made: an estimate implies
   * an RPC gas-price read, which is a new class of work for a dry run that today makes none.
   */
  ethApprox: string | null;
  gasApprox: string | null;
}

export interface DeployPlanSurface {
  ok: boolean;
  detail: string;
}

/** The code lane's "every marketplace-facing dimension, resolved now" block — `null` on every other
 *  lane (an image lane's thumbnail is fully covered by `custody`; it has no separate traits/postParam
 *  disposition to report). */
export interface DeployPlanSurfaces {
  thumbnail: DeployPlanSurface;
  traits: DeployPlanSurface;
  postParams: DeployPlanSurface;
}

/** `null` on the image lanes, which have no dependency-registry concept. */
export interface DeployPlanDependencies {
  count: number;
  registry: string | null;
}

/** Present only on a `deploy-code --resume` emit — `null` on a fresh deploy. */
export interface DeployPlanResume {
  target: string;
  sentLegs: number;
  complete: boolean;
}

export interface DeployPlan {
  schemaVersion: typeof DEPLOY_PLAN_SCHEMA_VERSION;
  family: DeployPlanFamily;
  lane: DeployPlanLane;
  transactions: DeployPlanTransactions;
  roles: DeployPlanRoles;
  /** `null` on a `--resume` emit: royalty is an InitParams field fixed at the ORIGINAL deploy, and a
   *  resume never touches it — reporting the flags passed to `--resume` here would misleadingly
   *  imply this run writes them. */
  royalty: DeployPlanRoyalty | null;
  custody: DeployPlanCustody;
  /** `null` on a `--resume` emit — see the field's own module doc for why the mint plan isn't
   *  cleanly reducible to one shape there (edition resume mints are a PER-ID list, not a count). */
  mint: DeployPlanMint | null;
  estimate: DeployPlanEstimate;
  /** Every `warn()` line this invocation raised, ANSI-stripped, in print order — see
   *  `beginPlanWarnings`/the local `warn` wrapper in deploy.ts. Not exhaustive of every warning this
   *  FILE can print (a trust-anchor bootstrap warning from `output.ts`'s `ensureFactory`/etc. isn't
   *  captured — those only fire on a real send that also stands up a fresh trust anchor, and are
   *  file-scoped to a different module), but covers every warning the LANE ITSELF raises, which is
   *  what a dry-run consumer cares about. */
  warnings: string[];
  surfaces: DeployPlanSurfaces | null;
  dependencies: DeployPlanDependencies | null;
  resume: DeployPlanResume | null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Strip the tiny ANSI color wrappers (`bold`/`dim`/`g` from output.ts) so a warning captured for the
 *  plan reads as plain text — a JSON consumer has no terminal to render escape codes against. */
export function stripAnsiForPlan(s: string): string {
  return s.replace(ANSI, '');
}
