---
name: abx
description: >-
  Use the ABX CLI (`abx`) to plan, launch, host, inspect, and operate ABX NFT projects on supported
  testnets: static 1/1s, image series, editions, JavaScript/code drops, and Solidity-rendered projects.
  Covers on-chain and off-chain content, managed or self-hosted resolvers, storage, minting and sales,
  PostParams, hooks, custom minters, migrations, feedback, locks, and capability questions. Use for
  requests to create, deploy, mint, host, serve, verify, repair, migrate, report ABX feedback, or
  change an ABX collection, or to determine whether ABX supports a mechanic.
compatibility: Drives @artblocks/abx-cli on Node 22.13+. Co-versioned with the CLI; install or refresh with `abx skill install`.
metadata:
  version: "0.1.0-alpha.43"
---

# ABX

Use `abx` as the execution and truth surface. Help, capability output, dry runs, on-chain reads, and
typed errors outrank remembered prose.

## Non-negotiable rules

- Never read or print `.env`, private keys, RPC URLs, provider tokens, storage credentials, wallet
  session URLs, or Arweave JWK contents. Use `abx doctor`, `abx remote`, and `abx storage show` to
  inspect configuration safely.
- Use `pnpm abx …` inside the ABX source repository. Use `abx …` in a creator project or installed
  environment. Run `abx version` if provenance is uncertain.
- Operate only on chains reported by `abx capabilities`; the toolkit is testnet-only today. Select
  the chain with `ABX_CHAIN=<chain>`; there is deliberately no `--chain` flag.
- Run `abx help <command>` immediately before composing a non-trivial command. Do not recover flag
  syntax from this skill.
- Never infer that a capability is absent because a flag is absent. Run `abx capabilities --json`,
  identify a native lane or extension seam, and read [capabilities.md](reference/capabilities.md).
- Never hand-roll transactions, nonces, retry loops, resolver URLs, or contract-type detection when
  the CLI exposes the operation. One EOA must have one serialized write sequence.
- Never send, mint, transfer, lower a cap, change authority, or apply a lock until the human confirms
  the exact action. Locks, ownership transfers, and several deploy choices are irreversible.
- Never submit feedback, project data, logs, or agent/session context to ABX or a remote provider
  until the human reviews the preview and approves that specific report. Redact credentials and
  unrelated personal or project information. `abx feedback` previews by default; `--yes` sends.
- Never fold `abx submit-app` into deployment. Listing is a separate, optional post-deploy action.

## Use the lifecycle

Follow this state machine instead of accumulating retries:

1. **Discover** — identify the working directory, CLI provenance/version, active chain, artifacts,
   existing contract addresses, configured remote, and signer preference. Run `abx doctor` for a
   deployment or unfamiliar environment.
2. **Classify surfaces** — decide collection shape, runtime, required public surfaces, custody,
   resolution, authority, mutability, and mint/sale timing. Use the model below.
3. **Inspect** — run `abx capabilities --json`; for code run `abx inspect` and `abx preview`. For an
   existing collection run `abx state`, `abx tokens`, `abx tokenuri`, and `abx verify` as relevant.
4. **Plan** — use the selected deploy command with `--dry-run --json`. Read its normalized shape,
   addresses, surface warnings, transaction count, storage activity, and irreversible choices back
   to the creator. A dry run may perform read-only network probes; it must not send or store.
5. **Confirm** — confirm name, symbol, token standard, code-capable/static type, burnability,
   ERC-721C/ERC-1155C enrollment, edition arithmetic, royalty ceiling, signer, costs, public URLs,
   initial mint, and every requested lock.
6. **Execute** — let the CLI sign and serialize the operation. Do not start a second write process
   with the same EOA. Honor structured lifecycle states and terminal errors.
7. **Verify** — verify the contract and each promised surface from its canonical path. Use on-chain
   reads for self-resolving metadata and `abx verify`/remote status for hosted surfaces. Mint token 0
   before expecting token-specific renders.
8. **Operate** — configure sales, publish renders, migrate, refresh marketplaces, transfer authority,
   or lock only after verification. Record the contract address, chain, deploy block, custody,
   resolution, owner powers, and remaining mutable surfaces.

When diagnosing, identify the current state and choose one next transition. Read
[diagnose.md](reference/diagnose.md); do not build a ladder of speculative retries.

## Model the project by independent dimensions

Keep these concepts separate. Most bad ABX plans collapse two of them into “hosting.”

| Dimension | Decide |
|---|---|
| **Collection shape** | one work; N unique works; one or N ids with limited/open copies |
| **Runtime** | static media; JavaScript program; build directory; Solidity field renderer |
| **Public surfaces** | metadata, image, animation, traits, attachments, PostParams |
| **Custody** | on-chain bytes, Arweave, IPFS, cloud, or local development storage |
| **Resolution** | on-chain renderer, hosted resolver, or on-chain JSON pointing at external media |
| **Rendering** | no derived render, one-shot stills, continuous effects, or Solidity-computed fields |
| **Authority** | owner, token holder, delegated address, minter, hook, transfer validator |
| **Mutability** | editable values/pointers, governed values, and the locks applied after verification |

Use precise language:

- **On-chain bytes** describes custody. **Self-resolving** describes resolution.
- **Chain-complete** means the requested document has no off-chain dependency. It does not promise
  immutability or that every third-party RPC can execute a large read.
- **Locked** names a particular stored value or pointer. It does not prove that code behind a proxy
  is immutable or that every output input is frozen.
- Marketplace refresh re-fetches a projection; it does not mutate canonical state.

## Choose the native deployment family

Run `abx capabilities --json` for the current matrix, then load [deploy.md](reference/deploy.md).

| Intent | Command | Default contract shape |
|---|---|---|
| One static work | `abx deploy` | ERC-721 1/1 |
| Folder of distinct static works | `abx deploy-series` | ERC-721 Series |
| Program or state-derived work | `abx deploy-code` | ERC-721 SeriesCode |
| One program, each token carries its own data | `deploy-code --script` + `<key>:Bytes:Creator` | SeriesCode + payload param |
| Copies of any family | add `--copies <n|open>` | corresponding ERC-1155 edition |

Important boundaries:

- `deploy-code --copies` supports `--script`, `--code-dir`, dependencies, Solidity image/attributes
  renderers, `--image-base` (a deterministic per-id off-chain still, mutually exclusive with
  `--image-renderer`), and `--resume` (a per-id mint diff — pass the same content flags plus
  `--mint-amount` if the original deploy premint ids).
- `--onchain-image` works for static 721s and editions in hot or wallet-signing lanes. It cannot be
  prepared as one cold `--unsigned` bundle because staged transactions depend on prior receipts.
- A code project may need no public host when its image/traits are computed by Solidity renderers.
  A JavaScript program still needs a deliberate marketplace-image plan even when its animation is
  chain-complete.
- Content size is not a fixed refusal. The CLI measures write cost and the active RPC's read reach.
  State the measured reach; never generalize it to every marketplace endpoint.

## Treat public surfaces as an acceptance test

Before deploying, write down the promised value for each applicable row:

| Surface | Verify with |
|---|---|
| Contract identity and owner powers | `abx state <addr>` and the deploy readout |
| Token metadata | `abx tokenuri <addr> --token <id>` |
| Collection metadata | `abx contracturi <addr>` |
| Image | decoded metadata plus a successful fetch or on-chain field provenance |
| Animation/live view | the decoded `animation_url`, loaded with a real minted token |
| Marketplace traits | decoded `attributes`, not merely console output from the program |
| Parameters and values | `abx state` for schemas; `abx tokens --json` for token values |
| Attached artifacts | `abx artifacts <addr> --token <id>` (entries + current/stale effect rows); attachments are not enumerable in bare on-chain metadata |
| Byte integrity | `abx verify <addr>` |
| Hosted lifecycle | `abx status --remote <name> --watch` or provider status |

Do not call a launch complete because the transaction mined. Complete it when every promised surface
has the expected provenance and is retrievable through the path collectors will use.

## Confirm irreversible and shared-state choices

Before any real deploy, say these choices explicitly when relevant:

- The contract family and ERC-721 versus ERC-1155 edition shape cannot be changed later.
- Hooks and PostParams require a code-capable contract. A static image contract cannot gain them.
- `--burnable` and creator-token enrollment are deploy-time choices.
- A royalty cap only moves downward.
- Edition arithmetic is **number of ids × copies per id**. For one work with 100 copies, use one id;
  do not accidentally create the code default's multiple-id space.
- An ERC-721 Series cap is lifetime minted ids: burning never reopens a slot. An ERC-1155 edition's
  per-id cap is live supply: when burnable, a burned copy may be minted again.
- PostParams on an edition are stored per id, not per physical copy. A holder-authorized value is
  shared by all holders of that id, and the last valid writer wins.
- Metadata, URI, script, dependency, hook, schema/value, and authority locks are distinct. Verify
  first and lock last.

## Use capability classification, not optimism or refusal

Classify an unusual request as exactly one of:

1. **Native** — a documented CLI lane performs it.
2. **Extension** — a custom minter, configure/transfer/augment hook, field renderer, or seed source
   performs it while the token remains a canonical factory clone.
3. **Unsupported or foreclosed** — the capability contract lists it, or the existing collection's
   irreversible type/flags already exclude it.
4. **Unknown** — no route has been proven. Inspect code/help/contracts and report uncertainty; do not
   turn absence from a no-list into a promise.

Custom Solidity is built and deployed outside `abx`; `abx scaffold-renderer` supplies a Foundry
starting point. Read [capabilities.md](reference/capabilities.md) before designing a custom mechanic.

## Load only the reference needed

- Environment, installation, signer lanes, and safe setup → [setup.md](reference/setup.md)
- Static projects, editions, placement, costs, and deploy confirmation → [deploy.md](reference/deploy.md)
- Programs, renderers, thumbnails, traits, PostParams, seeds, and dependencies → [code.md](reference/code.md)
- First-party hosted services, OAuth device login, and core/provider feedback → [services.md](reference/services.md)
- Generic remotes, self-hosted resolvers/effects, storage, lifecycle, and migration → [hosting.md](reference/hosting.md)
- Existing-project reads, mint/sales, fields, transfers, authority, and locks → [operate.md](reference/operate.md)
- Failure classification, resume, RPC/storage/rendering faults, and retry discipline → [diagnose.md](reference/diagnose.md)
- Capability questions, extension seams, mechanics, and hard boundaries → [capabilities.md](reference/capabilities.md)
- ERC-721C/ERC-1155C enrollment and validator operations → [creator-token.md](reference/creator-token.md)

Read every reference applicable to the requested workflow before sending a real transaction. Do not
load unrelated references merely because they exist.
