# Multichain integrations

Read only the provider relevant to the idea. Coverage below is the intersection reviewed for ABX:
Ethereum (`1`), Base (`8453`), Arbitrum One (`42161`), not each provider's full network list.
Official documentation reviewed 2026-10-30; recheck the chosen tool and network before use.
Apply [durability guidance](durability.md): official discovery/build tooling does not need to become
a dependency of the finished NFT. Prefer same-chain EVM reads with self-contained fallback output.

## OpenSea — discovery and marketplace context

- **Ideas:** research related collections, plan collector-facing metadata and traits, or link to
  the marketplace from a companion site. Keep the NFT usable without OpenSea; do not recommend live
  floor-price/indexed-trait API calls in its artwork or core eligibility logic.
- **Official route:** [agent tools](https://docs.opensea.io/docs/build-with-ai-agents) link its skill,
  CLI, SDK, and [MCP](https://docs.opensea.io/reference/mcp). Use an existing connection when suitable;
  adding all surfaces supplies no extra capability by itself.
- **Data:** **off-chain** discovery, indexed traits, and marketplace API/MCP results. NFT ownership
  and settlement are **on-chain**, but consuming an indexed response does not give a Solidity hook
  a contract read. For that route use the NFT/protocol's official contract interfaces directly.
- **Footprint:** MCP data tools and REST need an API key; MCP handshake/tool discovery does not.
  [Instant keys](https://docs.opensea.io/reference/api-keys) need no signup but expire; a full key
  involves the developer account flow. The same key serves MCP and REST. Wallet-scoped tools need
  additional wallet authentication. Check current limits and renewal rather than creating keys to
  evade quotas.
- **Before integrating:** verify the [current chains](https://docs.opensea.io/reference/get_chains)
  and exact feature. Keep keys server-side. Use ABX metadata commands for canonical state; use
  OpenSea tools for its projection/orders. Its SeaDrop deployment tools are not an ABX deploy lane.

## Uniswap — swaps, liquidity, and pool-informed art

- **Ideas:** use a selected pool's same-chain state as a visual input computed in the EVM, with
  bounded reads and fallback art. Offer swap links in a companion sales app; the NFT's essential
  rendering should not require a trading API, embedded swap app, or active liquidity position.
- **Official route:** start with the relevant [Uniswap skill](https://developers.uniswap.org/docs/uniswap-ai/skills)
  and [integration choices](https://developers.uniswap.org/docs/get-started/quickstart). Reuse its
  routing, SDKs, and interfaces rather than implementing a swap router.
- **Data:** **on-chain** pool state can live-augment an ABX renderer or inform hook logic on the
  same chain. Use the version's official read interfaces (including
  [v4 StateView](https://github.com/Uniswap/v4-periphery/blob/main/src/lens/StateView.sol) where appropriate).
  **Off-chain** quotes and indexed volume/history suit discovery or a companion app. Do not use
  them as default live-view inputs; consider an actual bounded on-chain snapshot if relevant.
  A pool's instantaneous price is not a manipulation-resistant price oracle.
- **Footprint:** [interface links](https://developers.uniswap.org/docs/trading/custom-interface-links)
  avoid provisioning a developer API key; execution still needs the collector's wallet. The Trading
  API needs a developer key. Browser/build-time contract/SDK reads need RPC access; EVM-to-EVM
  reads do not add an application RPC service. The [iframe embed](https://developers.uniswap.org/docs/trading/embed-app)
  requires origin allowlisting; reserve it for companion apps, with their own availability expectations.
- **Before integrating:** select protocol version, chain, pool, and token addresses from the
  [deployment sources](https://developers.uniswap.org/deployments). Check the exact tool's chain
  support separately. Read-only pool data, swap execution, liquidity positions, and Uniswap v4 hooks
  are distinct integrations; a Uniswap hook is not an ABX parameter hook.

## Art Blocks — existing projects and collector communities

- **Ideas:** discover related artists/projects or design a same-chain collector interaction using
  verified contract state. Link to another work from a companion gallery; do not recommend a hosted
  generator/media iframe as part of a permanent NFT's essential output. Discovery grants no reuse rights.
- **Official route:** use the [Art Blocks skills](https://docs.artblocks.io/developer/mcp-server/skills/)
  and [MCP](https://docs.artblocks.io/developer/mcp-server/quick-start/) for project/token discovery
  and query workflows. [Token, generator, and media APIs](https://docs.artblocks.io/developer/token-and-generator-apis/)
  provide published read paths for research or optional companion displays.
- **Data:** **mixed**. Ownership and some token/script state are **on-chain**, varying by core;
  inspect the [official core interfaces](https://docs.artblocks.io/developer/core-contract/).
  API/MCP discovery, generated media, and computed traits are **off-chain** access paths. A published
  live-view URL is an external service dependency, not preserved artwork or an EVM-readable input.
- **Footprint:** MCP uses OAuth/browser sign-in; do not assume an ABX Services login authorizes it.
  Published token/view URLs can suit a companion display without adding an MCP connection. Verify
  authentication and rate policy for the exact query/API route; do not promise unlimited access.
- **Before integrating:** carry chain, core address, project, and token identity. On a shared Art
  Blocks core, collection-wide `balanceOf` is not a project-specific ownership check. Use the
  official Art Blocks tooling for its contracts; ABX parameter/minter commands target ABX projects.
  A holder gate on a different chain needs a separate proof design.
