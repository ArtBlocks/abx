# ERC-20s and token creation

Use for token-informed ABX ideas, an existing token community, or a companion fungible token.
Official sources reviewed 2026-10-30. Recheck the selected chain, token identity, and tool/version.
These are discovery routes, not executed ABX integrations. Read only the relevant section.

## Existing tokens as creative inputs

The [ERC-20 standard](https://eips.ethereum.org/EIPS/eip-20) exposes **on-chain** balances, supply,
and allowances. Prefer a same-chain ABX augment hook or renderer turning a chosen wallet's balance
into visual variation, with bounded reads and self-contained fallback art. Use external-state
configure/transfer gates only for an intentional mechanic with lifecycle tests and failure semantics.
Specify whose balance matters: current NFT owner, configuring wallet, or a fixed community treasury.
For extension choices use [capabilities.md](../capabilities.md) and [code.md](../code.md).

| Token / chain scope | Official identity and tooling | Example on-chain input / boundary |
|---|---|---|
| USDC — Ethereum, Base, Arbitrum One; check each testnet separately | [Circle's contract directory](https://developers.circle.com/stablecoins/usdc-contract-addresses), then the token's verified ERC-20 interface | Treasury balance informs an artwork's density. Distinguish native USDC from bridged variants; reserve reports and redemption access are separate issuer/off-chain concerns. |
| ARB — Arbitrum One; verify other deployments separately | [Arbitrum Foundation deployment directory](https://docs.arbitrum.foundation/deployment-addresses), then the verified token interface | A holder's balance selects a palette. ERC-20 balance alone does not establish delegated voting power or governance participation. |
| AERO — Base | [Aerodrome's official contracts and ABIs](https://github.com/aerodrome-finance/contracts) | Treasury or owner balance drives visual variation. AERO and veAERO positions are different assets/interfaces; do not infer locked voting power from an ERC-20 balance. |

Use official deployment directories and interfaces rather than symbols, token search rankings, or
copied addresses. Direct reads need RPC for a browser/build tool; same-chain contract-to-contract
reads need no API account. An **off-chain** token search, price feed, portfolio API, or holder index
is a different route, even when its source is contract state. Keep it in discovery or a companion
app by default. Do not fetch a token's hosted logo/price/portfolio API from a permanent NFT's live
view; prefer verified numeric contract reads or actual captured on-chain bytes. An essential service
requires the explicit lifetime commitment and recovery design in [durability.md](durability.md).

`name`, `symbol`, and `decimals` are optional in ERC-20. Normalize units from the actual token and
avoid unbounded holder enumeration. A current balance is temporary, not proof of sustained ownership;
pool prices, valuations, and eligibility rules need their own trust/manipulation assessment.
Inspect token upgrade/admin/pause powers; an on-chain token is not necessarily immutable. Rendering
fallbacks should keep the NFT usable if reads fail. A gate's fallback must preserve its intended rule.

## Companion token creation — Clanker as one starting reference

ABX creates its NFT collections; fungible token launch and management belong to a separate protocol.
[Clanker's official SDK](https://github.com/clanker-devco/clanker-sdk) and
[official agent skill](https://github.com/clanker-devco/clanker-sdk/blob/main/.cursor/skills/use-clanker-sdk/SKILL.md)
provide one reusable route for creation, liquidity, and post-launch operations. Prefer these over
building a token launcher, pool deployer, or reward client. This is a starting option, not a required
provider: a creator/agent may choose another protocol using the same verification criteria.

- **Coverage:** the official skill lists Ethereum, Base, Arbitrum One, and Base Sepolia among its
  networks. Verify the installed SDK version and actual protocol deployments for the chosen chain;
  this does not establish availability on every ABX chain or paired testnet.
- **Data and ideas:** the resulting ERC-20 and pool state are **on-chain** inputs for same-chain
  ABX art or intentional eligibility. Hosted discovery/media are **off-chain**; keep the NFT's
  output independent of the launch website, SDK, and token image host. A companion token balance can
  affect art without giving the NFT permission to trade or claim rewards.
- **Setup:** the direct SDK flow uses RPC and a wallet client, with gas/funding and transaction
  authority. It does not document a separate Clanker account/API key for that route. Hosted APIs,
  social login, and optional services have separate requirements; consult the
  [current official docs](https://docs.clanker.world). Reuse existing suitable connections and signer;
  never export an ABX-managed key to satisfy a third-party example.
- **Before launch:** verify admin/recipient roles, allocations, liquidity/fees, costs, and required
  metadata or distribution hosting. Use the chosen official tool's simulation/preview and explicit
  transaction review. No companion-token deployment, approval, or funding is implied by ideation.

For a proposal, record the token's chain and official identity, input field and provenance, ABX seam,
live versus captured behavior, resilience, new accounts/credentials, and runtime dependencies. Keep
token launch and ABX NFT deployment as separately reviewed operations, using each protocol's official tools.
