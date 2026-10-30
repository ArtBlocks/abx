# Ecosystem discovery and integration planning

Use this reference when a creator wants ideas involving existing protocols, communities, or tools.
For public context, see [Ecosystem integrations](https://docs.abx.io/docs/using-abx/guides/ecosystem-integrations).
These are discovery routes, not tested ABX adapters or a promise of third-party compatibility.

## Load by chain set and intent

Read the selected chain's context, then only the topic/provider relevant to the idea. Shared
providers are described once; chain notes add local context rather than copying their instructions.

| Requested network | References |
|---|---|
| Ethereum (`1`) | [Ethereum context](ecosystem/chains/ethereum.md) |
| Sepolia (`11155111`) | [Sepolia context](ecosystem/chains/sepolia.md) |
| Base (`8453`) | [Base context](ecosystem/chains/base.md) |
| Base Sepolia (`84532`) | [Base Sepolia context](ecosystem/chains/base-sepolia.md) |
| Arbitrum One (`42161`) | [Arbitrum context](ecosystem/chains/arbitrum.md) |
| Arbitrum Sepolia (`421614`) | [Arbitrum Sepolia context](ecosystem/chains/arbitrum-sepolia.md) |
| Robinhood Chain (`4663`) | [Robinhood context](ecosystem/chains/robinhood.md) |
| Robinhood Chain Testnet (`46630`) | [Robinhood testnet context](ecosystem/chains/robinhood-testnet.md) |

Topic routes: [multichain integrations](ecosystem/multichain.md) cover marketplaces, liquidity, and
existing generative art; [ERC-20s and token creation](ecosystem/tokens.md) cover specific tokens and
an external launch protocol. These examples are non-exhaustive starting points, not an allowlist or
provider ranking. Explore protocols beyond this catalog that fit the creator's theme, community, or
distinctive mechanics. Evaluate their actual on-chain data, semantics, reliability, official tools,
and setup/runtime costs; explain why each input belongs in this particular project. An unlisted
provider is unresearched here, not unsupported. Verify new candidates against official sources and
the same durability criteria. Read `abx capabilities --json` for current ABX network eligibility;
third-party coverage does not enable an ABX network or sponsorship lane.

## Turn an idea into a bounded plan

1. Apply the [durability guidance](ecosystem/durability.md): prefer same-chain EVM reads and
   self-contained output. Keep discovery/build tools separate from the finished NFT's dependencies.
   Start from the project's theme, audience, and distinctive mechanic. Explain how each proposed
   input supports that concept; do not force a familiar token, provider, or financial theme into an
   unrelated work. Keep ideation separate from account creation or transaction execution.
2. Check available connections and project dependencies through their supported discovery/status
   surfaces. Reuse suitable existing tooling and accounts. Do not inspect credential files to make
   this inventory.
3. Prefer the provider's official skill, MCP, CLI, SDK, API, or contract interfaces for its part of the
   workflow. Link to current installation/authentication instructions instead of copying them here.
   Add only the project-specific glue; do not rebuild an existing client, router, indexer, or signer.
4. Classify the ABX part using [capabilities.md](capabilities.md). An external API read or marketplace
   order is not an ABX command. Keep ABX operations in its CLI and the provider's operations in its
   official tools; do not let a third-party deploy flow silently replace the chosen ABX collection.
5. Before implementation, verify the specific chain, contract/version, token or project identity,
   current tool support, and the read/write authority. Testnet availability, liquidity, and datasets
   need separate evidence. A documentation review is not an executed integration test.

## Input provenance and ABX execution

Label each proposed input **on-chain**, **off-chain**, or **mixed**, including the actual access path.

| Input route | Where it can drive ABX behavior |
|---|---|
| On-chain, same-chain contract read | Preferred for live renderer/augment output. Configure or transfer validation requires an intentional gate and lifecycle tests; a display input should not block transfers |
| Off-chain API/indexer, even if sourced from contracts | Discovery/build tooling or an optional companion app. Prefer capturing the actual bounded input on-chain over putting HTTP calls in the NFT's live view |
| Mixed: on-chain state plus hosted metadata/media | Separate the durable NFT output from hosted enrichment. Any essential service is a lifetime dependency requiring explicit creator choice and the recovery design below |

Specify the contract and field, or API and timestamp, plus whether the input is live or captured.
For contract integrations use official interfaces, bounded reads, and usable fallback output.
Do not assume a renderer's `msg.sender` is the NFT owner. A mutable external read can affect hook
liveness as well as art; inspect upgrade/pause powers. A browser's hardcoded RPC fetch is still a
network dependency; prefer computing the input in the EVM. A pool spot value alone is not a
manipulation-resistant price oracle.

## Account and dependency footprint

For each proposed route, include a short row in the creator's plan:

| Route | Setup delta | Authority and cost | Runtime dependency / exit |
|---|---|---|---|
| Provider + official tool + exact chain | Reuse existing connection, no signup, new account, API key, OAuth, RPC, or unknown | Reads versus signatures/approvals; fees, limits, expiry, and renewal to verify | Build-time, optional companion, or lifetime NFT dependency; responsible owner, replacement controls, and behavior if it disappears |

Count accounts, credentials, and hosted dependencies separately. A signup-free key still needs
storage and renewal; an account-free HTTP endpoint is still an availability dependency. Distinguish
creator setup from what every collector must do. Prefer the least setup that meets the actual goal,
not an account-free route that recreates the provider's service or hides extra maintenance.

Use public docs, interfaces, or a local fixture for early comparison. Introduce a new connection,
credential, paid plan, or wallet permission only when the chosen workflow needs it and the creator's
authorization covers it. Record credential references and expiry, never secret values, in handoffs.

## Integration boundaries to resolve

- **Live or captured:** do not recommend HTTP-dependent NFT live views by default. Prefer EVM reads
  or actual input bytes captured on-chain; a URL/hash alone does not preserve them. Required external
  APIs need explicit lifetime-dependency disclosure and owner-controlled replacement plus a tested
  fallback, as described in [durability.md](ecosystem/durability.md). Read [code.md](code.md) for lanes.
- **Source chain:** a contract cannot directly read another chain's NFT ownership. Multichain
  APIs can assist discovery but do not supply a trustless cross-chain proof or shared state.
- **Compatibility:** marketplace indexing, royalties, signed listings, transfer validators, and
  lending eligibility are separate checks. Read [creator-token.md](creator-token.md) when relevant.
- **Writes:** a quote, unsigned transaction, or tool connection is not approval to trade, approve a
  spender, lend, bridge, or deploy. Keep the existing ABX confirmation and reconciliation rules.
