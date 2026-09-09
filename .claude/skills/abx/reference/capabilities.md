# Capability questions and extension seams

Use this reference before answering whether ABX can support an unusual mechanic. The goal is neither
automatic optimism nor reflexive refusal; it is a proven route with explicit cost and limits.

## Contents

- [Use the four-way classification](#use-the-four-way-classification)
- [Inspect the machine-readable contract](#inspect-the-machine-readable-contract)
- [Use canonical extension seams](#use-canonical-extension-seams)
- [Map mechanics to seams](#map-mechanics-to-seams)
- [Respect deploy-time prerequisites](#respect-deploy-time-prerequisites)
- [Know the supported boundary](#know-the-supported-boundary)

## Use the four-way classification

Classify the request as one of:

1. **Native** — a current CLI command/flag combination performs it directly.
2. **Extension** — a custom minter, hook, field renderer, seed source, or transfer validator performs
   it while the token remains a canonical factory clone.
3. **Unsupported/foreclosed** — the capability contract lists it as unsupported, or the existing
   contract's immutable type/options exclude the prerequisite.
4. **Unknown** — no supported route has been demonstrated. Inspect help, implementation/contracts,
   and state; report uncertainty if it remains unproven.

Never infer “unsupported” from the absence of a flag. Never infer “possible” merely because an item is
absent from a short no-list. A capability claim needs a native lane or an exact extension seam.

Give the creator the route, engineering required, authority model, gas/hosting/reach tradeoff,
irreversible prerequisites, and verification plan. “Possible” without those qualifiers is not useful.

## Inspect the machine-readable contract

Run:

```bash
abx capabilities --json
abx help <relevant-command>
```

The capability contract reports native deployment lanes, EditionCode/static edition differences,
extension seams, deploy-time choices, and currently unsupported product boundaries. For an existing
collection, also run `abx state`; capability depends on the contract already deployed, not only on
what the newest CLI could deploy today.

Use a deploy command's `--dry-run --json` for a concrete plan. It is the source of truth for the
active chain, artifacts, signer, storage, addresses, transaction count, and measured warnings.

## Use canonical extension seams

A custom mechanic normally lives beside a canonical token rather than replacing it.

| Seam | Wired with | Runs | Can veto? |
|---|---|---|---|
| Custom minter | `abx set-minter --minter 0x…` | before/calling issuance | it controls whether it calls mint |
| Configure hook | `abx set-param-hooks --configure 0x…` | before a governed parameter write persists | yes |
| Transfer hook | `abx set-param-hooks --transfer 0x…` | on mint, transfer, and burn | yes |
| Augment hook | `abx set-param-hooks --augment 0x…` | while token data is assembled | no; computes/adds/overrides data |
| Image/traits renderer | deploy-code renderer flags | while on-chain metadata fields render | a revert can break that read; design never-revert |
| Seed source | `abx set-seed-source` | future code-token mints | supplies mint-time seed input |
| Transfer validator | `--721c` then `set-transfer-validator` | standards-track transfer validation | yes, according to validator |

One external contract may implement several hook/minter roles. Test it against a real deployed clone,
not a mock that approximates ABX callbacks.

ABX scaffolds a Foundry renderer project but does not compile or deploy custom Solidity. The creator
or their contract engineer owns code review, deployment, verification, upgrade policy, and audits.

### Custom minter

Series and editions can authorize one minter contract. Use it for pricing/allocation rules that do not
fit the shared fixed-price minter: auctions, allowlists, raffles, free claims, ERC-20 payment, escrowed
issuance, or other pre-mint logic. The minter eventually calls the token's canonical mint entry point.

A plain 1/1 has no Series minter seam. Decide whether the requested issuance model actually requires
a Series/edition before deploying.

### Configure hook

The configure hook receives the proposed typed parameter write before it persists. Its revert rejects
the write. It can enforce monotonicity, one-time writes, cross-contract authorization, payload shape,
or size bounds. For blob-backed strings/bytes, validate length before reading large data and read the
provided data pointer using the documented SSTORE2 convention.

The previously stored value remains visible during validation, enabling comparisons. A rejected
write may still have paid for preparatory blob storage; front ends should simulate before asking for a
signature.

### Transfer hook

The transfer hook runs for mints (`from == 0`), ordinary transfers, and burns (`to == 0`). Reverting
vetoes the entire operation. It can implement vesting, soulbinding, redemption, escrow settlement,
provenance counters, and lifecycle rules.

It cannot initiate a transfer; it only observes or rejects one. Burn-based mechanics require the
collection to have been deployed burnable. On editions, ids may have many holders, so shared per-id
state cannot model a single current owner.

### Augment hook

The augment hook is a read-time view seam. It may read other contracts, an oracle, block state, or
stored params and return final token-data strings. Use it for live/derived state or computed data that
should not be stored.

Volatile augmentation makes the live view change without an event or stored write. A marketplace still
remains a snapshot until it is rendered again. If a custom Solidity field renderer needs augmented
state, it must read/call the relevant hook/state itself; field-renderer calls do not receive a prepared
token-data object.

## Map mechanics to seams

| Request | Primary route | Prerequisites/limits |
|---|---|---|
| Auction, allowlist, raffle, free claim | custom minter | Series or edition mint authority |
| ERC-20 priced mint | custom minter | payment logic/audit outside ABX |
| Soulbound or timed transfer lock | transfer hook | deploy-code; hook also sees mint |
| Burn-to-redeem/combine | external controller/minter + burnable; optional transfer/augment hooks | ABX provides seams, not the atomic combine implementation |
| Escrow tied to token lifecycle | minter + transfer hook | external value-holding contract |
| Monotonic level/high-water mark | governed param + configure hook | schema and old-value comparison |
| Structured collector configuration | governed param + configure hook | typed payload and bounded size |
| Holder of another token may configure | schema address auth or configure hook | cross-contract read |
| Art reacts to oracle/block/other contract | augment hook or renderer direct read | disclose live/non-deterministic behavior |
| Timed reveal | augment hook or renderer logic | live view versus still refresh distinction |
| On-chain SVG and coherent traits | image + attributes renderers | never-revert Solidity implementations |
| Large raster stored on-chain | `--onchain-image` | measured write cost and endpoint-dependent read reach |
| One program, each token carries its own data | `deploy-code --script` + `<key>:Bytes:Creator` | mint, then set the creator payload with `configure-param --file`; no on-chain size budget on the param itself |
| Royalty-aware transfer validation | ERC-721C/ERC-1155C validator | opt-in at deploy; marketplace compatibility varies |

When several routes work, prefer the smallest authority surface. Use the stock fixed-price minter
instead of custom Solidity for an ordinary sale; use a schema without a hook when static authorization
is sufficient; use an on-chain renderer only when its durability/reach/cost trade is desired.

A transfer hook only observes or vetoes a burn; it does not initiate two burns or mint a replacement.
For combine mechanics, prove the controller's burn authorization and canonical mint call against a
real clone, make the transition atomic and replay-safe, and define pair/history storage. On ERC-721,
`--max` is a lifetime id cap and burns do not reopen slots, so reserve replacement-id headroom or use
a supply policy that does not require new ids. On a burnable edition, a burn frees live per-id supply,
but every copy of an id shares its id-level seed and PostParams.

## Respect deploy-time prerequisites

Ask about mechanics before deployment. These decisions cannot be retrofitted:

- static versus code-capable contract type; hooks/PostParams require SeriesCode or EditionCode;
- ERC-721 versus ERC-1155 edition shape through `--copies`;
- burnability;
- ERC-721C/ERC-1155C enrollment.

Other choices may be mutable but become irreversible when locked: URI configuration, fields, script,
dependencies, hooks, governed values/schema, royalty ceiling, and owner authority. An existing project
may therefore be capable in protocol terms but foreclosed by its current type or locks. Say that
specifically instead of saying ABX as a whole cannot do it.

Use `abx predict` to break address cycles where an external controller needs the token address at its
own construction and the token must reference the controller during deployment. Confirm the guarded
salt/deployer and predicted address before deploying either side.

## Know the supported boundary

The toolkit currently does not provide:

- mainnet deployment or unsupported-chain recipes;
- a secondary-market listing/order-book feature;
- Solidity compilation/deployment through `abx`;
- CLI replacement of a deployed code project's script;
- retrofitting a deploy-time contract type, burnability, token standard, or creator-token enrollment.

Do not recommend another protocol automatically when one of these applies. State the boundary and
stop unless the creator asks for alternatives.

Also distinguish unsupported tooling from possible external engineering. For example, ABX does not
compile a custom hook, but a hook is an intentional supported seam once independently built and
deployed. Conversely, “arbitrary Solidity exists” is not proof that every behavior is safe or
compatible: analyze callback timing, authority, reverts, reentrancy, shared edition state, gas, and
upgradeability.

Before finalizing a custom mechanic, document:

1. canonical token family and deploy-time prerequisites;
2. external contracts and their roles/owners/upgrade paths;
3. callback inputs, state transitions, and every veto path;
4. mint/transfer/burn behavior including editions;
5. parameter schema and authorization;
6. live versus settled/rendered state;
7. locks and the exact guarantee they create;
8. unit, fork, and end-to-end test plan;
9. collector-facing disclosure of remaining powers.
