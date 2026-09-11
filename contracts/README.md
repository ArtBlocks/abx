# ABX Contracts

Foundry package for the ABX protocol's on-chain implementations: six concrete token types —
three ERC-721 — **`OneOfOneImage`** (a 1/1), **`SeriesImage`** (a multi-token drop), **`SeriesCode`**
(a generative / code-project drop) — and their three ERC-1155 edition twins, **`OneOfOneEdition`**,
**`EditionImage`** and **`EditionCode`**. Each has its own clone factory (the trust anchor), plus the
shared renderer, reader, minter, and seed-source singletons. See the maintained
[event-spine reference](../site/content/docs/protocol/event-spine.mdx).

> **Security status:** ABX is alpha and pre-mainnet. The repository does not publish a completed
> independent third-party audit. Review the source, tests, deployed bytecode, owner powers, and
> [security policy](../SECURITY.md) before relying on it.

## Install as a Solidity dependency

The same tree is published to Soldeer as `abx-contracts`. Exact-pin the protocol-compatible release;
do not copy interface files into each project:

```toml
[dependencies]
abx-contracts = "3.0.0"
```

Then run `forge soldeer install` and import, for example,
`abx-contracts/src/extensions/configurable-params/IAbxParamHooks.sol`. The package major follows
the core protocol version, independently of CLI prerelease versions. See
[`SOLDEER.md`](SOLDEER.md) for packaging and release policy.

## Layout — organized by the spine's abstractions

```
src/
  interfaces/   core + standards ABI: events + ERC-165 ids (no storage, no logic)
                  IAbxBeacon (core) · IAbxSequentialMint · IAbxSeedSource · IERC4906 · IERC7572 · …
  core/         AbxBeaconCore  — required: beacon + extension versioning + ERC-165 base
                AbxErc721Base  — core ERC-721 token (name/symbol, live supply); no URI or extensions baked in
  uri/          the metadata-URI resolution mixins — one per scope, cardinality-neutral
    token/        TokenURI    — resolves: on-chain renderer → per-token override → derived base → empty; owns ERC-4906
    contract/     ContractURI — same precedence, for the ERC-7572 collection document
  extensions/   one folder per opt-in ABX extension; each is a self-contained mixin
    royalty/ · creator-token/ · onchain-metadata/ · max-invocations/ · external-minter/ · primary-payee/
    paused/ · params/ · configurable-params/ · onchain-script/ · dependencies/ · seed-source/
  libraries/    ERC-7201-namespaced storage libraries, one per stateful concern (19 today), plus a
                handful of stateless logic libraries — most inlined; FOUR (`AbxMetadataLib`,
                `AbxParamsLib`, `AbxCodeLib`, `AbxEditionLib`) externalized and `delegatecall`ed so
                write paths and read views don't count against a token's own EIP-170 ceiling.
                `AbxMetadataLib` is the one every token type links — the on-chain metadata field
                store is external for all six
  tokens/       OneOfOneImage · SeriesImage · SeriesCode (721) · OneOfOneEdition · EditionImage ·
                EditionCode (1155) — the only concrete, deployable tokens
  factories/    one EIP-1167 clone factory per token type — each its type's trust anchor
  renderers/    AbxMetadataRenderer (on-chain tokenURI/contractURI) · AbxChunkStore (the SSTORE2
                chunk store + reader) · AbxGenerator (the code-project field renderer) — stateless,
                shared, one per chain, referenced by address, never inherited into a token
  minters/      AbxFixedPriceMinter · AbxFixedPriceMinter1155 — the shared, ownerless primary-sale
                minters (721 sells a project; the 1155 twin prices each `(token, id)` on its own terms)
  seed/         AbxSeedSource — the canonical shared mint-time seed source (pseudorandom, and
                deliberately not lottery-grade — read its class NatSpec before pricing scarcity off it)
test/    · script/   (one deploy script per factory/singleton; see Commands)
```

> **`tokens/` is concrete-only.** Abstract building blocks live by purpose — `core/` (required base),
> `uri/` (URI-resolution mixins), `extensions/` (opt-in ABX behavior) — not lumped in a generic
> "mixins" bucket. `tokens/` holds only deployable contracts, and there are exactly six of them.

**A token is assembled by composition, and each concrete type is a strict superset of the simpler
one:**

- `OneOfOneImage is AbxErc721Base, TokenURI, ContractURI, OnChainMetadata, RoyaltyExtension,
  CreatorToken` (Creator Token = opt-in ERC-721C transfer validation, enrolled at deploy or never)
- `SeriesImage` adds `MaxInvocations, ExternalMinter, PrimaryPayee, Paused` (+ `IAbxSequentialMint`) —
  what a sized, sellable drop needs on top of the 1/1's set.
- `SeriesCode` adds `SeedSourceExtension, ConfigurableParams, OnChainScript, Dependencies` — what a
  generative drop needs on top of that.
- The three **ERC-1155 edition twins** (`OneOfOneEdition`, `EditionImage`, `EditionCode`) mirror that
  same ladder on `AbxErc1155Base` + `Uri1155` + `CreatorToken1155` + `EditionSupply`, and all three
  delegate their heaviest bodies into `AbxEditionLib` for EIP-170 relief.

Each mixin is self-contained (its own events, storage, logic), so adding a flavor never edits a shared
file, and ERC-165 reflects exactly the composed set — every concrete contract manually ORs each
mixin's `supportsInterface` together (Solady's leaf implementations don't super-chain).

- **Metadata-URI resolution is one mixin per scope, not a strategy family.** `TokenURI`/`ContractURI`
  are cardinality-neutral — the *same* mixin serves a 1/1 (token id `0`) and a many-token Series
  identically — and resolve by a fixed runtime precedence: an on-chain renderer if one is set, else a
  per-token override, else a pointer derived from a stored base
  (`{base}/{chainId}/{address}/{tokenId}`), else the empty string. The renderer address is the toggle
  (non-zero ⇒ resolve fully on-chain); there's no separate on-chain/off-chain *class* to pick between.
- **What stays core (not a mixin):** `name`/`symbol`. They're plain ERC-721 identity strings with no
  resolution choice (there's no "off-chain name"), so they live in the base. Cardinality-neutral
  resolution applies only where it genuinely varies — the URIs — not to every field.
- **Each extension owns its identity.** `ID`/`VERSION` (the `bytes32` announced via the beacon + its
  implemented version) live `private` on the extension mixin — `private` specifically so a token
  composing several extensions never hits an `ID`/`VERSION` name collision; `AbxVersion` holds only the
  *core* protocol version. Adding an extension never edits it.

## Tech stack

- **Foundry** + **Soldeer** (versioned deps, no submodules — clean monorepo lift).
- **Solady** base (`ERC721`, `ERC2981`, `Ownable`, `Initializable`, `Multicallable`, `SSTORE2`,
  `LibClone`, `LibZip`) — gas-optimal, clone-tuned, audited.
- `solc 0.8.28`, **`evm_version = "paris"`** — broad multi-chain compatibility (no PUSH0/cancun
  assumptions); bump per chain as needed. The protocol is per-EVM-chain, so the floor matters.

## Library-based design, namespaced storage

Every concern with genuinely new state is a library owning its own
[ERC-7201](https://eips.ethereum.org/EIPS/eip-7201) namespace — a `Layout` struct at a slot computed
once, off any inheritance position — so storage can never collide across libraries, the Solady base, or
mixins, no matter how mixins get added, removed, or reordered on a concrete token. Nineteen storage
libraries follow this today (`BeaconStorage`, `SupplyStorage`, `CollectionMetadataLib`,
`TokenURIStorage`, `ContractURIStorage`, `ParamsStorage`, `ConfigurableParamsStorage`,
`OnChainMetadataStorage`, `OnChainScriptStorage`, `DependenciesStorage`, `MaxInvocationsStorage`,
`ExternalMinterStorage`, `PrimaryPayeeStorage`, `PausedStorage`, `SeedSourceStorage`,
`SeriesMintStorage`, `TransferValidatorStorage`, `EditionSupplyStorage`, `Erc1155SupplyStorage`)
— nothing but a `Layout` struct and a `layout()`
accessor.

**Four building blocks, deliberately distinct:**

- **Interfaces** (`IAbx*`, `IERC4906`, `IERC7572`) are the *external ABI*: the spine's events + the
  ERC-165 ids. No storage, no logic.
- **Storage libraries** exist *only where there is new storage to namespace*, as above. We deliberately
  don't add one for royalty: Solady's `ERC2981` already owns royalty *storage* and the `royaltyInfo`
  view, so `RoyaltyExtension` holds only logic (a capped, owner-settable default + the event) — no
  parallel storage, no second source of truth. *Rule of thumb: a library is for new storage; an
  interface names the ABI; a mixin carries behavior.*
- **Logic libraries** are stateless helpers, and split by how they run. Most (`TokenDataLib`,
  `DynamicBuffer`) are `internal` — compiled straight into the caller, no separate deployment.
  `AbxParamsLib`, `AbxCodeLib` and `AbxEditionLib` are `public` instead, which Solidity always
  compiles as calls to a separately-deployed copy, `delegatecall`ed. `Params` / `ConfigurableParams`
  route through the first, `OnChainScript` / `Dependencies` through the second, and all three ERC-1155
  tokens through the third. They are deployed EXPLICITLY, at canonical salts
  ([`script/DeployLibraries.s.sol`](script/DeployLibraries.s.sol)) — forge would auto-deploy and link
  them, but at its own salt rather than one this repo names, which is how two factories ended up
  bound to a library the manifest did not record. See [Deterministic addresses](#deterministic-addresses-create2).
  Both are externalized for the identical stated reason: the write paths are too large to inline into
  every implementation without risking the 24,576-byte EIP-170 contract-size ceiling — `SeriesCode`
  composes all four of these extensions at once. **Both also carry their extensions' `view` reads**:
  `AbxParamsLib` the params key-enumeration and schema views, and `AbxCodeLib` the whole
  `IAbxOnChainScript` + `IAbxDependencies` read surface. The mixin shells delegatecall the
  library with their **raw calldata** — same signature, same selector — and return its return data
  untouched, because a typed call site would spend more bytes decoding + re-encoding the returns than
  the extraction saves. That makes each library's read signatures part of the tokens' external ABI:
  they must stay in lockstep with `IAbxParams`/`IAbxConfigurableParams` and
  `IAbxOnChainScript`/`IAbxDependencies`, verbatim. The code-custody passthrough lives once, in
  `extensions/code-custody/AbxCodeDelegate.sol`, shared by both mixins. Delegatecall
  preserves the caller's storage context, so
  the externalized logic still reads and writes the *token's own* namespaced state, never any of its
  own. Even with the write paths externalized, `SeriesCode`'s implementation, its factory, and
  the on-chain generator singleton (`AbxGenerator`) still ride the ceiling closely enough that they
  compile at a separately configured, lower optimizer setting (200 runs, against 1,000,000 everywhere
  else) purely to shrink further and fit.
- **URI and extension mixins** (`TokenURI`, `RoyaltyExtension`, …) are abstract contracts owning a
  concern's events + identity + logic; a token inherits the ones it wants.

**Interfaces declare the full spine vocabulary** even when a given contract doesn't emit all of it (e.g.
`IAbxRoyalty` declares both `RoyaltyChangedForAll` and `RoyaltyChangedForToken`; `OneOfOneImage` only
ever emits the former). Royalty has *no* ABX read function — resolution is ERC-2981 `royaltyInfo`
(query with `salePrice == 10_000` to read the rate), and the rate is carried on the event; adding a view
would reinvent the standard.

**ERC-165 vs. the beacon, for discovery:** the beacon's `extensionVersion(id) != 0` is the *universal*
extension-discovery signal. ERC-165 is complementary — it advertises the *standards* (721/2981/4906),
the beacon surface (`IAbxBeacon`), and any extension that exposes **read functions** (e.g. On-Chain
Metadata, with its own interface id). An **events-only** extension (e.g. Royalty) has
`interfaceId == 0x00000000` and is therefore discoverable *only* via the beacon. One extension
branches ERC-165 on state, deliberately: `CreatorToken` advertises the ERC-721C ids (`0xad0d7f6c` /
`0xa07d229a`) **only when enrolled** (a deploy-time, permanent choice), so an unenrolled token is
indistinguishable from a pre-721C token.

## What each concrete type composes

| Mixin | `OneOfOneImage` | `SeriesImage` | `SeriesCode` |
| --- | --- | --- | --- |
| `AbxErc721Base`, `TokenURI`, `ContractURI` (core + URI) | ✓ | ✓ | ✓ |
| `OnChainMetadata`, `RoyaltyExtension` | ✓ | ✓ | ✓ |
| `CreatorToken` (opt-in ERC-721C; enrolled at deploy or never) | ✓ | ✓ | ✓ |
| `MaxInvocations`, `ExternalMinter`, `PrimaryPayee`, `Paused` | | ✓ | ✓ |
| `SeedSourceExtension`, `ConfigurableParams`, `OnChainScript`, `Dependencies` | | | ✓ |
| Token ids | one (`0`) | sequential, `IAbxSequentialMint` | sequential, `IAbxSequentialMint` |

Every concrete contract's `initialize()` calls each mixin's `_init<Name>` in one fixed order, and the
doc comment pins the exact resulting event sequence — e.g. `OneOfOneImage`'s: `AbxDeployed →
AbxExtensionVersionSet(royalty) → RoyaltyChangedForAll → [AbxExtensionVersionSet(creator-token) →
TransferValidatorUpdated] → AbxExtensionVersionSet(onchain-metadata) →
TokenFieldSet*/ContractFieldSet* → ContractURIUpdated → (if minting) Transfer(0x0, mintTo, 0)`. An
indexer author can read the sequence straight off the source instead of inferring it from tests.

## Deployment & trust model

The standard we follow is **EIP-1167** (minimal proxy, via Solady's `LibClone`). Creators deploy
through the relevant factory, which clones one **immutable** implementation. EIP-1167 guarantees every
clone runs that fixed, canonical code; each factory is **ownerless** — no admin keys, no upgrade path —
so there is nothing to rug. The only privilege is the clone owner's (accepted: ABX contracts are
owned). The implementation's own constructor calls `_disableInitializers()`, so the master copy behind
every clone can never itself be initialized or hijacked.

The entire security model lives in **one abstraction per token type: its factory.** The trust root is
the canonical factory's *address*, which platforms allowlist. Because a factory is immutable and is the
only writer of its own `isAbxClone`, trusting that mapping is exactly trusting the factory — verified
once. Membership is checked two ways:

1. `isAbxClone(addr)` — on-chain registry mapping (works for on-chain verifiers too).
2. The `Deployed(clone, impl, owner)` event — for indexers.

The `AbxDeployed` beacon is **spoofable** — any contract can emit it — so it powers only *open,
permissionless discovery*, never trust. (An off-chain verifier that prefers not to call the factory can
still recompute the EIP-1167 runtime codehash for the canonical implementation and compare
`addr.codehash` — that's a property of the standard, not something the contract needs to expose.) A new
core version ships as a new implementation + new factory per type; old clones stay frozen on their
version.

`deployDeterministic(params, salt)` clones to a predictable address (`LibClone.cloneDeterministic`),
guarded by the salt's leading 20 bytes — all-zero is permissionless, a specific address must match
`msg.sender` — so a reserved address can't be front-run.

## Commands

### Maintenance invariants

- **EIP-170 headroom:** `test/CodeSize.t.sol` is a guard, not a target to weaken. The Params read/write
  surfaces and the code-custody reads have already been moved into external libraries. If a margin
  trips again, extract another coherent surface using the established raw-calldata `delegatecall`
  pattern; typed forwarding can cost more bytecode than it saves. Preserve `msg.sender` for
  authorization checks and keep library signatures byte-for-byte aligned with the public interfaces.
  Do not use forge's `--libraries` metadata mapping, and do not externalize the ERC-721 core,
  seed-source hook, or mint path merely to buy bytes.
- **Edition/code parity:** `test/EditionOnChainRender.t.sol` proves that an open ERC-1155 code edition
  can serve Solidity-rendered image and traits with no server. Keep the CLI's
  `deploy-code --copies --image-renderer/--attributes-renderer --onchain-uri` lane aligned with that
  executable capability. If the test stops passing, it is a contract regression rather than a CLI
  feature request.

**Toolchain:** forge **1.4.3**, pinned in [`.foundry-version`](.foundry-version) and in CI. Install it
with `foundryup -i 1.4.3` (`forge --version` then reports `1.4.3-stable` — `-stable` is the build
channel, not part of the version you install). The pin exists because it is the version every committed
artifact size, test count, and deployed metadata hash was produced under — not because it is special.

> ### Never run repo-wide `forge fmt`
>
> `forge fmt --check` **fails on a clean checkout**: forge 1.4.3 disagrees with the committed style in
> ~19 files, and its own output exceeds this repo's configured `line_length = 100`. So the formatter
> cannot gate anything here, and running it repo-wide is actively harmful — it rewrites
> **deploy-frozen** sources (`AbxCodeLib.sol`, `AbxSeedSource.sol`, and every other live singleton)
> where even a whitespace-only edit changes the metadata hash, which changes the creation bytecode,
> which moves the canonical CREATE2 address at the next deploy. That churns trust anchors platforms
> have allowlisted, for zero functional gain.
>
> **Format only the lines you author.** The style is hand-maintained. A repository-wide reformat must
> be coordinated with a full redeploy because metadata-hash churn changes creation bytecode.

```bash
forge soldeer install   # fetch deps into dependencies/
forge build
forge test
forge build --sizes     # EIP-170 margins; `test/CodeSize.t.sol` guards them at PR time

# STEP 0 — the delegatecalled libraries, explicitly CREATE2'd at canonical salts. Idempotent.
# No profile to set and no flags to pass: the code-factory scripts recompute these same addresses.
forge script script/DeployLibraries.s.sol --sig 'predict()'   # dry, prints addresses
forge script script/DeployLibraries.s.sol --rpc-url <RPC> --broadcast

# one script per factory / shared singleton — all CREATE2 (canonical salts, script/AbxSalts.sol)
forge script script/Deploy.s.sol            --rpc-url <RPC> --broadcast  # OneOfOneImageFactory
forge script script/DeploySeries.s.sol      --rpc-url <RPC> --broadcast  # SeriesImageFactory
forge script script/DeploySeriesCode.s.sol  --rpc-url <RPC> --broadcast  # SeriesCodeFactory (needs STEP 0)
forge script script/DeployOneOfOneEdition.s.sol --rpc-url <RPC> --broadcast # OneOfOneEditionFactory (needs STEP 0)
forge script script/DeployEdition.s.sol      --rpc-url <RPC> --broadcast  # EditionImageFactory (needs STEP 0)
forge script script/DeployEditionCode.s.sol  --rpc-url <RPC> --broadcast  # EditionCodeFactory (needs STEP 0)
forge script script/DeploySeedSource.s.sol  --rpc-url <RPC> --broadcast  # AbxSeedSource (standalone — see note)
forge script script/DeployRenderer.s.sol    --rpc-url <RPC> --broadcast  # AbxMetadataRenderer
forge script script/DeployMinter.s.sol      --rpc-url <RPC> --broadcast  # AbxFixedPriceMinter
forge script script/DeployMinter1155.s.sol  --rpc-url <RPC> --broadcast  # AbxFixedPriceMinter1155
forge script script/DeployChunkStore.s.sol  --rpc-url <RPC> --broadcast  # AbxChunkStore
forge script script/DeployAbxGenerator.s.sol --rpc-url <RPC> --broadcast # AbxGenerator (per-chain, not cross-chain-identical)
```

## Deterministic addresses (CREATE2)

Every infra script deploys through the **keyless CREATE2 proxy** (`0x4e59b448…`, present on every
EVM chain — `forge` routes `new X{salt: …}()` through it) with a canonical salt from
[`script/AbxSalts.sol`](script/AbxSalts.sol). Identical salt + identical initcode ⇒ **the same
address on every chain**, so the whole infra set (factories, their implementations, renderer, chunk
store, minter, seed source) is cross-chain-identical and computable before the first tx. The one
exception is `AbxGenerator`, whose constructor bakes chain-specific immutables (asset pointers +
dependency registry) → its address legitimately differs per chain.

Three operational notes:

- **Deploy the libraries yourself, first, and pin them.** `DeployLibraries.s.sol` CREATE2s
  `AbxParamsLib`, `AbxCodeLib` and `AbxEditionLib` through the keyless proxy at salts named in
  `AbxSalts.sol`, and `--sig 'predict()'` prints the addresses without sending anything.
  `forge` would also auto-deploy them CREATE2-deterministically — that is how every existing
  deployment happened — but that determinism is the toolchain's, not ours, and it came from forge's
  salt rather than a salt we named. The gap cost something real: two token types were kept
  library-free and an EIP-170 floor was relaxed on the recorded belief that linking a library made a
  factory's address non-deterministic. It never did. Owning the deployment is how that stops being
  possible to believe.

  **Do not pass `--libraries`.** Compile-time linking writes the address map into
  `settings.libraries`, which is part of the metadata JSON whose hash is appended to the bytecode — so
  it changes the initcode, and therefore the CREATE2 address, of the very contracts it is meant to pin.
  Measured: adding `--libraries` moves all five of these addresses. Instead the code-factory scripts
  substitute the placeholder bytes in the compiled artifact and CREATE2 the result
  ([`script/AbxLink.sol`](script/AbxLink.sol)), recomputing the library addresses from `AbxSalts`
  rather than accepting them as flags. That is also the only method the SDK can use — it ships
  bytecode, it does not compile — which is what keeps the two lanes on one address.

  The check that proves it, worth re-running after any contract change: every `--sig 'predict()'` must
  equal the SDK's matching `predict*()` in `packages/sdk/src/create2.ts`. Both read the same compiled
  artifacts, so **this only holds while `generated.ts` is in sync — run `pnpm sync-abis` first**
  (step 2), or the two lanes are comparing different builds and will disagree.

  Libraries are *not* pinned in `foundry.toml`, so tests still auto-deploy them in-process.
- **Deploy the seed source standalone** (`DeploySeedSource.s.sol`), never bundled with the SeriesCode
  factory. Six paths are pinned to 200 optimizer runs by `foundry.toml`'s `compilation_restrictions`
  to fit the EIP-170 size ceiling — `SeriesCode`, `SeriesCodeFactory`, `EditionCode`,
  `EditionCodeFactory`, `AbxGenerator` and `AbxMetadataRenderer`. Bundling `AbxSeedSource` into one of
  those scripts pulls it into the same compilation unit, giving it a *different, non-canonical*
  bytecode + address than its default-profile artifact (the one the SDK ships and predicts). Its own
  script keeps it single-profile and canonical.

  Note this is a restriction on PATHS, not a profile you select: the restrictions apply under every
  profile, so there is no `FOUNDRY_PROFILE` to remember and the default-profile artifact is already
  the canonical one. (`additional_compiler_profiles` is not selectable via `FOUNDRY_PROFILE`; an
  earlier version of this checklist said to set it, which did nothing.)
- **Public RPCs can nonce-race** across rapid back-to-back script runs — add `--slow` (waits for each
  receipt) if you see `nonce too low`. CREATE2 addresses are nonce-independent, so a failed run just
  needs a retry; the target address is unchanged.

The CLI's lazy deployers for the single-profile keyless singletons (`ensureRenderer`,
`ensureChunkStore`, `ensureFixedPriceMinter`, `ensureSeedSource`) also use CREATE2 with the same
canonical salts (via the SDK's `create2.ts`, the TS twin of `AbxSalts.sol`), so a chain with no
manifest entry lands at the **same** deterministic address as the scripts above. They first check
whether the contract already exists at that predicted address — self-healing when the forge script
deployed it but the manifest wasn't repointed yet, never a duplicate. (The trust-anchor factories are
*not* auto-deployed — they refuse and guide unless `--bootstrap-factory` is passed for a private
chain/sandbox.)

## Changing a contract — the redeploy checklist

**A change to any `src/**.sol` is not done until the deployed world reflects it.** The generated ABIs
and the on-chain singletons are downstream of the source and do not update themselves. Whenever you
edit a contract, walk this list — an agent making the change is expected to do the same:

1. **Test** — `forge test`. A green suite is the precondition for everything below.
2. **Regenerate ABIs** — `pnpm sync-abis` (from the repo root). It rewrites
   `packages/sdk/src/abi/generated.ts` (ABI **and** creation bytecode) from `contracts/out`. The SDK
   deploys from that bytecode, so a skipped `sync-abis` means the SDK/CLI deploy the **old** contract.
   *This is not optional even for a "comment-only" change* — a license header or NatSpec edit changes
   the metadata hash, hence the creation bytecode.
3. **Decide: does anything need redeploying?**
   - **Runtime logic changed** (behavior, storage, events, an ABI function) → the affected contract
     **must** be redeployed on every supported chain. If it's the metadata renderer, also bump
     `AbxMetadataRenderer.SPEC_VERSION` **and** the CLI's `isCurrentRenderer` check in lockstep, so
     `ensureRenderer` treats deployed-but-behind renderers as stale.
   - **A runtime change to the token layer is a new anchor generation → bump
     `AbxVersion.CORE_VERSION`**, move the SDK's `ABX_CORE_VERSION` gate in
     `packages/sdk/src/anchors.ts` in lockstep, and record the generation in step 6. One core
     version identifies one immutable generation.
   - **Comment/metadata only** (SPDX/license header, NatSpec) → runtime is byte-identical, but
     creation bytecode and its CREATE2 address change. Existing deployments do not need replacing.
     Verify them from the source commit they were deployed from. Before adding a new supported chain,
     either deploy that same source commit or cut a new generation; never publish one generation as
     if two different source builds shared an identity.
4. **Redeploy + verify** (if step 3 said so) — deploy on each chain with `script/Deploy*.s.sol` (CREATE2
   canonical salts, so the new address is identical cross-chain and predictable; see [Deterministic
   addresses](#deterministic-addresses-create2) for the `SeriesCode` `--libraries` pin and the
   `--slow` nonce note), then confirm on-chain (`cast call <addr> "specVersion()(uint256)"`,
   `cast code <addr>`).
5. **Publish the source on Etherscan** — a redeploy is not done until every new address is
   source-verified on **every** chain. `forge script --broadcast` does **not** verify unless you pass
   `--verify`, and it cannot verify a contract it didn't send directly (a factory's implementation is
   `CREATE`d inside the factory constructor), so the implementations always need a separate
   `forge verify-contract`. See [Source verification](#source-verification) for the exact commands and
   the two settings that bite.
6. **Record the addresses** in **both**:
   - `packages/sdk/src/deployments.ts` (the machine source of truth), and
   - [`site/content/docs/reference/deployments.mdx`](../site/content/docs/reference/deployments.mdx) (the human mirror).
   Note the replaced address in the manifest comment (greenfield repoints are expected).
   **If the trust anchors moved**, also stamp `retired: '<date>'` on the outgoing
   `ANCHOR_GENERATIONS` entry, move its six factory literals into it (the one place a superseded
   anchor may appear), and add the new generation at the head with the bumped `coreVersion`. That
   list is what lets a consumer say "canonically ABX v2, a prior generation" instead of reporting a
   perfectly good collection as not-ABX — and it is **provenance, never trust**: it must never widen
   `verifyCanonical`, since a retired generation can predate a security remediation.
7. **Commit** the source, the regenerated `generated.ts`, and the manifest/doc updates together, so the
   repo never sits in a state where the code, the ABIs, and the recorded addresses disagree.

## Source verification

Every canonical address in the manifest must be source-verified on every supported chain — it's what
lets anyone read the trust anchors instead of trusting our word for them. One Etherscan **V2** API key
covers all chains (`ETHERSCAN_API_KEY` in `.env`; the `[etherscan]` block in `foundry.toml` maps the
chain names).

Some contracts are a plain one-liner — they compile at the profile default (1,000,000 runs):

```bash
forge verify-contract <addr> src/renderers/AbxChunkStore.sol:AbxChunkStore \
  --chain sepolia --compilation-profile default --watch
```

Run it for each chain (`--chain sepolia`, `--chain base-sepolia`, `--chain arbitrum-sepolia`). `--compilation-profile default` is
required whenever the build cache holds more than one profile (otherwise forge stops with *"Ambiguous
compilation profiles found in cache"*).

**Three settings bite, each on a different set of paths.** Miss any and Etherscan returns the same
unhelpful *"Compiled contract deployment bytecode does NOT match"*:

- **`--optimizer-runs 200`** — for **every path listed in `compilation_restrictions`** in
  `foundry.toml`, which is a longer list than the `SeriesCode` unit: it also covers
  `AbxMetadataRenderer`, `AbxGenerator`, `EditionCode` + `EditionCodeFactory`, and the two example
  renderers. `forge verify-contract` does **not** apply those restrictions — it emits the profile
  default (1,000,000) into the standard-JSON input, so you must restate the runs by hand. **Read
  `compilation_restrictions` rather than this sentence**: the renderer joined that list at spec v4 and
  this section still said "a plain one-liner" for it a generation later, which cost a failed
  verification on both chains before anyone re-read the config.
- **`--constructor-args`** — most constructors are no-arg, but `AbxGenerator`'s is not (registry,
  two SSTORE2 asset pointers, two gateway prefixes) and its args differ per chain. Build them with
  `cast abi-encode "c(address,address,address,string,string)" …` from the values the
  `DeployAbxGenerator` run printed, or read them back off the deployed contract
  (`defaultDependencyRegistry()` / `abxJsPointer()` / `gunzipScriptPointer()` /
  `defaultIpfsGateway()` / `defaultArweaveGateway()`).
- **`--libraries` (every pin)** — for the units that link write-path libraries. They were deployed
  with the libraries pinned, which lands in `settings.libraries` in the compile input and therefore in
  the metadata hash. The linked bytecode alone is not enough; the *compile input* has to match.

Pass **every** library the unit links, not just the ones you remember. `SeriesCode` links three
because the on-chain metadata field store lives in `AbxMetadataLib`; a
missing pin fails with the same unhelpful "bytecode does NOT match". The authoritative list per token
type is the table in
[`deployments.mdx`](https://github.com/ArtBlocks/abx/blob/main/site/content/docs/reference/deployments.mdx),
and the addresses are the `metadataLib` / `paramsLib` / `codeLib` / `editionLib` entries in
`packages/sdk/src/deployments.ts` — read them from there rather than from this example, which is a
snapshot and will age:

```bash
forge verify-contract <addr> src/tokens/SeriesCode.sol:SeriesCode \
  --chain sepolia --compilation-profile default --optimizer-runs 200 \
  --libraries src/libraries/AbxMetadataLib.sol:AbxMetadataLib:0x404B48AA9784FCC042B317c64bE917390Ec4b55F \
  --libraries src/libraries/AbxParamsLib.sol:AbxParamsLib:0x7200fAb33E5CbDAAb00d0b5ED3b27174F11bCf90 \
  --libraries src/libraries/AbxCodeLib.sol:AbxCodeLib:0xD6b9cbC480D172B7Ba3f475f73bB197Dd20B047C \
  --watch
```

The two ERC-721 image types link `AbxMetadataLib` alone; the three ERC-1155 types add
`AbxEditionLib` (and `AbxParamsLib`, which `AbxEditionLib` itself links). `EditionCode` needs all
four.

`AbxGenerator` is per-chain and takes constructor args, so it needs `--constructor-args` matching the
chain it was deployed to (and the same `--optimizer-runs 200`). `AbxMetadataRenderer` sits at the same
200-run floor since spec v4 — pass `--optimizer-runs 200` (no constructor args, no libraries).

**Auditing what's actually verified** — don't assume; ask Etherscan. An unverified contract returns an
empty `SourceCode` and `"ABI": "Contract source code not verified"`:

```bash
curl -s "https://api.etherscan.io/v2/api?chainid=84532&module=contract&action=getsourcecode\
&address=<addr>&apikey=$ETHERSCAN_API_KEY" | jq -r '.result[0].ContractName'
```

To check the source in the working tree still *matches* a deployed address before submitting, compare
the compiled `deployedBytecode` against `eth_getCode`, masking `immutableReferences` (immutables are
baked in at deploy) and substituting `linkReferences` with the pinned library addresses. A body match
with a differing trailing CBOR metadata hash means the code is identical but the *compile input*
differs — almost always the runs or the library pins above.
