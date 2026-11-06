# Arbitrum One ecosystem context

Chain ID: `42161`. Start with [multichain integrations](../multichain.md) or
[ERC-20s and token creation](../tokens.md), then read local entries relevant to the idea.
Official documentation reviewed 2026-10-30. Entries describe discovery paths, not qualified ABX
adapters. Verify Arbitrum Sepolia (`421614`) separately; no testnet liquidity or feature parity is
implied. Providers may serve other chains outside this ABX-focused scope.

## Camelot — local liquidity context

Consider an artwork responding to a selected pool or liquidity community. Start with Camelot's
[official documentation](https://docs.camelot.exchange/) and separate
[One](https://docs.camelot.exchange/contracts/arbitrum/one-mainnet/) and
[Sepolia](https://docs.camelot.exchange/contracts/arbitrum/sepolia-testnet/) contract lists.
Select the actual AMM generation and pool before choosing interfaces.

**Data:** **on-chain** pool state read through the selected generation's official contract interfaces
can drive same-chain ABX augment/rendering with bounded reads and self-contained fallback output.
**Off-chain** analytics and indexed history suit research or a companion app, rather than HTTP
requests inside the NFT's live view. Apply [durability guidance](../durability.md).

Reading public documentation needs no account. Browser/build-time contract reads need RPC access;
same-chain EVM-to-EVM reads need no application API account. Reuse suitable RPC tooling for authoring,
with provider-specific account/limit requirements. Do not invent a Camelot MCP or require an
analytics signup just to compare ideas. A project-specific read can supply visual
input without rebuilding Camelot's exchange, indexer, or routing.

## GMX — contract-state candidates and companion analytics

For a permanent NFT, first verify whether the desired position/state field has a bounded same-chain
read through GMX's official contract interfaces. This reference does not qualify such a read; omit
the idea if its essential input cannot meet the durability guidance. Inspect oracle provenance,
updates, upgrade powers, and read failures rather than treating all market data as native chain state.

For research or an optional companion dashboard, use the [official SDK overview](https://docs.gmx.io/docs/sdk/overview/)
and [API-backed SDK v2](https://docs.gmx.io/docs/sdk/v2/). **Data:** that route is **off-chain** HTTP,
even when a value originates on-chain. Its documented data setup needs no wallet or key, but the
hosted service must keep running. It is not a default recommendation for NFT live-view data.
Confirm access, limits, chain support, and timestamps; do not rebuild GMX's client.
Trading or account-management flows add separate signatures, permissions, costs, and lifecycle
requirements. Do not introduce those flows for a read-only artwork.

## Chain details that change the plan

- Check live ABX capabilities and provider eligibility. Arbitrum ecosystem coverage says nothing
  about ABX's current support label, sponsored networks, or account permissions.
- ABX has no canonical dependency registry on Arbitrum in the current
  [deployment manifest](https://docs.abx.io/docs/reference/deployments). Choose dependencies
  explicitly using [code.md](../../code.md); do not silently resolve through another chain.
- Arbitrum's [gas estimate](https://docs.arbitrum.io/build-decentralized-apps/troubleshooting-building)
  includes L1 data cost; avoid adding that component twice.
- Review [Solidity differences](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/solidity-support)
  for custom contracts: block-number semantics differ, and `block.prevrandao` is not a useful
  randomness source here. Financial/oracle rules need their own review; artistic read-only data is
  not a proof of suitability for pricing, lending, or liquidation.
