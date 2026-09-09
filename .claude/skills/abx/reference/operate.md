# Operating an existing ABX project

Use this reference for inspection, minting and sales, transfers, fields, gateways, URI pointers,
royalties, supply, attachments, refreshes, ownership transfer, and locks.

## Contents

- [Read before writing](#read-before-writing)
- [Mint and run primary sales](#mint-and-run-primary-sales)
- [Transfer tokens and authority](#transfer-tokens-and-authority)
- [Operate metadata and data](#operate-metadata-and-data)
- [Manage economics and supply](#manage-economics-and-supply)
- [Lock precisely](#lock-precisely)

## Read before writing

Never infer contract type or current authority from the original launch notes. Read the contract:

```bash
abx state <address>
abx tokens <address> --json
abx contracturi <address>
abx tokenuri <address> --token <id>
abx verify <address> --json
abx artifacts <address> --token <id> --json
```

`abx artifacts` reads a token's `artifacts` manifest directly, without fetching and parsing the whole
served document — entries plus every registered effect row (current and stale, labeled against the
token's active `inputsHash`). Report which surface answered: this node's local projection, or (with
`--remote <name|url>`) the hosted resolver that actually owns a hosted project's real artifact set.
Neither "not registered here" nor "not registered on that remote" is an error — both return a stable
`{surface, registered, available, reason, entries, effects}` shape. Nothing it reports is onchain data
itself; every entry is a resolver-published projection.

Use `abx status` or its remote form for projection/render lifecycle. Record active chain, detected
family, owner/admin, supply and pause state, minter/payee, royalty/cap, URI renderer/pointers, code
dependencies, schemas/hooks, and lock state.

Before every write, run its help and dry-run form when available. Confirm sender, target, value,
token/id/amount, and permanence. Let the CLI validate contract type; do not send raw ABI calls to make
an operation fit the wrong family.

## Mint and run primary sales

`abx mint` follows the detected family:

- A 1/1 issues its single token.
- A Series mints the next id in order; `--count` can mint multiple sequential ids.
- An edition requires `--token-id` except where the contract has only the single 1/1-edition id, and
  uses `--amount` for copies. `--count` is not an edition synonym.

Confirm the recipient. Minting may trigger a transfer hook; a hook that vetoes mint will revert the
whole transaction.

### Shared fixed-price minter

Use the shared minter commands for ordinary ETH primary sales:

1. `abx minter configure <token> …` sets price and allocation. Editions require a token id and use a
   per-id sale configuration.
2. `abx set-minter <token> --minter <address>` authorizes the minter.
3. `abx set-primary-payee <token> --payee <address>` declares payout.
4. `abx unpause <token>` opens minting when the family supports the pause gate.
5. `abx minter show <token> …` verifies the public sale state.
6. `abx minter buy <token> …` is the public purchase path; editions use quantity and token id.

Do not call a sale live until price units, allocation, payee, minter address, pause state, and a
representative purchase are verified. `abx mint-page` scaffolds a client for the shared minter; it does
not configure the on-chain sale for you.

Use a custom minter for auctions, allowlists, raffles, free claims, ERC-20 pricing, or other issuance
rules. The custom contract calls the canonical token's mint authority; the token itself remains a
factory clone. Read [capabilities.md](capabilities.md).

## Transfer tokens and authority

`abx transfer` moves token ownership/copies, not contract administration.

- A 721 transfer names token id and destination.
- An edition transfer names token id, amount, destination, and source holder because an id can have
  multiple holders.
- Creator-token validation or a transfer hook may reject the move. Diagnose the actual revert; do not
  bypass or clear an enforcement mechanism without the owner's explicit intent.

`abx set-admin --to <address>` transfers contract authority. Treat it as a high-risk, potentially
irrecoverable handoff:

1. Verify the recipient is correct for the active chain.
2. Inventory unfinished operations and unlocked surfaces.
3. State which powers move and which external controllers remain separate.
4. Receive exact human confirmation.
5. Execute once, then read state from chain to prove the new owner.

Never interpret a token transfer as a sale listing. ABX has no secondary order book; a marketplace or
manual transfer handles secondary exchange.

## Operate metadata and data

### URI pointers and renderers

Use `set-token-uri`, `set-contract-uri`, and `set-renderer` only after reading the current configuration
and verifying the destination. Switching `set-renderer --off` can place an HTTP resolver in front of
content that remains stored on-chain. Switching to the canonical renderer makes configured on-chain
fields self-resolving when the contract supports them.

Never hand-build a resolver path. Read `tokenURI`/`contractURI`, decode it, and follow what the
contract actually returns. A correct-looking URL constructed from memory is not evidence.

### Fields

`abx set-field` writes one metadata field representation at token or collection scope. Representations
include inline data, reader/chunk pointers, hashes, public locators, and renderer pointers as supported
by the contract. Collection-scope values act as shared defaults; token-scope values override them.

Use reserved fields such as description, attributes, creator, license, display notes, and links
according to command help. Verify the resulting provenance in decoded metadata. On-chain-wins means a
new on-chain value can intentionally supersede a resolver projection.

### Gateways

`abx set-gateway` changes the serving prefix for IPFS/Arweave locator representations without moving
the content. Verify a representative locator through the new gateway before changing it. A gateway
repoint is not a re-upload and does not change the committed CID/transaction id.

### Attachments versus parameters

`abx attach <addr> <key> <locator>` records a named artifact. It prints the CANONICAL fetch URL for
every key (`{base}/{chainId}/{address}[/<id>]/data/<key>`) directly — never hand-build that route.
It also distinguishes the on-chain field write from off-chain SERVING: an on-chain write can succeed
while nothing can serve it. With no resolver base baked in at all, it warns there is no serving path
whatsoever. With one baked in, it probes whether a resolver actually answers for this token right
now (before the write, since the key itself doesn't exist yet) and warns if not — "the on-chain
document carries reserved fields only" is a real gap creators hit; the write landing is not proof
anything can serve it. Bare on-chain metadata cannot enumerate arbitrary field keys, so consumers
need a resolver to discover all attachments even when each locator is durable and hash-anchored.

PostParams are different: the parameter store enumerates schemas and values on-chain. Read schemas
with `state` and values with `tokens --json`. Parameters do not require a resolver merely to be
canonical or enumerable.

### Replacing an unlocked script

`abx replace-script <addr> --script <file>` ships a fix to a code project's on-chain program any
time before `abx lock-script`. It refuses outright — never warns and proceeds — on a locked script
or a target that isn't SeriesCode/EditionCode. It diffs by content against what's on-chain (an index
that already matches is never re-sent), folds every write and remove into ONE atomic transaction (so
a revert can never leave a half-applied script), and reads the completed script back to verify exact
reassembly before reporting success. Prefer this over hand-encoding `setScriptChunk` calls.

`--chunk-size <bytes>` overrides the default on-chain split size (~22 KB) — the same flag
`deploy-code` accepts (see [code.md](code.md#choose-the-runtime-lane)). A small value forces a
multi-chunk layout, which is the cheap way to exercise growing/shrinking a program across several
chunks (including the on-chain removal of surplus chunks when shrinking) without needing a large
real program.

### Refresh and URI events

`abx refresh` asks external marketplaces to fetch metadata again; it does not fix the metadata or
mutate canonical state. First prove that the current URI resolves and returns the intended document.
For editions, `ping-uri` re-emits native URI events for selected ids after a repoint. Use the smallest
id set needed and verify the new path before signalling indexers.

## Manage economics and supply

Use `set-royalty` to change receiver/rate within the collection's permanent royalty ceiling. Use
`set-royalty-cap` only to lower that ceiling. State the old and new values and confirm the irreversible
loss of future headroom.

Series supply caps and edition per-id caps are monotonic downward. Read current minted supply before
lowering a cap; never propose a value below already minted supply. For editions, name the id and
distinguish its per-id cap from aggregate collection supply.

Pause/unpause controls the supported mint gate, not transfers or every external minter behavior.
Read state after changing it.

Primary payee declares sale proceeds; royalty receiver handles secondary royalty reporting. Keep them
separate. Changing one does not update the other.

## Lock precisely

Lock last, after production-path verification. Every lock freezes a different surface:

| Lock | Freezes | Does not necessarily freeze |
|---|---|---|
| `lock-field` | one token/collection field representation | other fields, URI pointer, program, params |
| `lock-uri` | URI configuration/pointer at selected scope | program/dependencies/params/hooks |
| `lock-script` | code-project script chunks | dependencies, metadata, params, external renderer code |
| `lock-dependencies` | dependency list and registry pointer | bytes returned later by a live registry entry |
| `lock-param-hooks` | configure/transfer/augment addresses | behavior behind an upgradeable address |
| governed schema/value lock | writes governed by that schema/key | unrelated or ungoverned params; some inherited defaults |
| ownership transfer | future owner-only authority at this contract | powers held by external minters/hooks/providers |

For a code project, metadata locks alone do not freeze the program. A strong freeze normally requires
script, dependency, relevant field/URI, hook, and governed-parameter decisions, plus immutable external
renderer/hook/dependency deployments.

Important qualifications:

- An ungoverned parameter remains writable despite metadata locks.
- A schema-welded token value is stronger than a collection default inherited by many tokens; the
  recovery path may still allow a poisoned collection default to be cleared.
- A registry dependency may return different bytes behind a frozen reference.
- A locked pointer to an upgradeable proxy fixes the address, not its behavior.
- A transfer-hook address represents a standing ability to veto mints/transfers. Freezing an empty
  hook set is the proof that this power cannot later be added.
- `lock-field` targets one scope (token, or `--collection`); a token-scope value wins over a
  collection-scope one when both are set. Locking a scope that ISN'T actually serving the value
  freezes an empty or overridden slot, not what a viewer sees — the CLI refuses this by default and
  names the correct command; only `--force-field` proceeds (with a loud warning, never silently).
  Check `abx tokenuri --token <id>`'s `abx_provenance` (or just try the lock without `--force-field`)
  before assuming a scope holds the value.

Use `abx verify` and direct state reads to enumerate what remains mutable. Describe the guarantee as
specific stored values and addresses that can no longer change; do not promise immutable output unless
every live input and external implementation has actually been bounded.

`abx state <address> --json` reports every lock above in one `locks` object — token/contract URI,
script, dependencies, param hooks, and the standard `METADATA_FIELD` set — each as `true` (frozen),
`false` (open), or `null` (unread; never report an unread lock as off). A project's own custom field
keys are real and independently lockable but are not enumerable from a bare head read; say so rather
than implying the field scan is exhaustive. Every lock is independent: never infer one lock's state
from another's.

`abx verify --json` separates two verdicts that must not be conflated: `ok`/`contentIntegrity` is
content-integrity ONLY (a hash mismatch, or none to check) and is the only field the exit code
reflects; `availability` is a sibling verdict for render/serve readiness (`available` / `partial` /
`unavailable` / `unknown`) that a missing render or an un-refetched `ipfs`/`arweave`/`url` locator
moves, while `ok` stays unaffected by design. Report both, never collapse one into the other.
`abx verify` also flags whether the project's stored `tokenURIRenderer`/generator pointers are the
CURRENT canonical singletons — a `false` here means an older-but-working deployment (or a fully
custom one), never "broken".
