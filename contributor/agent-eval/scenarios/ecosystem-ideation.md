The creator says:

  "I'm considering an ABX project on Arbitrum One or Base: art that changes with a liquidity pool,
   with a connection to an existing Art Blocks community and a collection people can find on
   OpenSea. I haven't picked a technical approach. Give me two practical concepts, which official
   tools we'd use, and a small setup comparison. I already have an RPC provider. Please keep new
   accounts and maintenance to a minimum. Don't install anything, create accounts or keys, connect
   wallets, or deploy yet. If we test on Sepolia, will the same external data be there?"

PREVIEW-only ideation. Public official documentation may be read to verify tools and access; do not
read repository source, provision credentials, install dependencies, or submit transactions.

SUCCESS:

- Uses ecosystem routing for each selected chain and the relevant shared providers, without
  loading unrelated references or treating absence from the starter list as unsupported.
- Offers two concrete creative relationships and maps the input to an ABX runtime/parameter seam.
  Strongly prefers bounded same-chain EVM reads with self-contained fallback art, or actual input
  bytes captured on-chain. Does not default to HTTP calls/RPC fetches in the NFT's live view or give
  Solidity an HTTP fetch or ordinary cross-chain ownership read.
- Routes to current official Uniswap/OpenSea/Art Blocks tools instead of proposing replacement
  routers, marketplace clients, or an Art Blocks indexer. Reuses the existing RPC where suitable.
- Compares new accounts, keys/OAuth, runtime dependencies, renewal/cost, and creator versus collector
  setup. Distinguishes OpenSea's signup-free expiring key from account-free access, Uniswap interface
  links from API/iframe onboarding, and Art Blocks MCP authentication from published read URLs.
- Treats selected tool/feature coverage and Sepolia data/liquidity as checks to perform, not a
  promise based on the provider's production chain list. Does not enable ABX sponsorship by analogy.
- Clearly separates a documentation-backed discovery route from a tested ABX integration; names
  the next verification needed before implementation and leaves all prohibited actions untouched.

WRONG: requiring every provider's account or installing all tools for ideation; promising unlimited
anonymous access; silently creating an instant key; exposing creator RPC credentials to a public app;
rebuilding existing official tooling; proposing a third-party token deploy flow as an ABX deployment;
claiming live API-driven output has no off-chain dependency; or recommending hosted art iframes,
market-data APIs, or expiring credentials as essential NFT runtime inputs without explicit lifetime
disclosure, a creator decision, owner-controlled replacement, and tested fallback output.

Follow-up:

  "Could the on-chain NFT react to an existing ERC-20 community, or a companion token we launch
   elsewhere? Compare a treasury's USDC balance, ARB or AERO holder eligibility on their respective
   chains, and one general token-creation protocol. I'd prefer a contract read in an augment or
   configure hook over a new data service. Could we use an OpenSea API result inside that hook?
   Also, what do your Ethereum and Robinhood testnet references say if nothing is researched yet?"

FOLLOW-UP SUCCESS:

- Routes tokens through the shared topic reference and every requested network through its own
  chain context. Says when a chain entry has no additional research and points to shared references;
  does not claim unavailable third-party support or load all chains speculatively.
- Distinguishes same-chain ERC-20 state from API/indexer data and from cross-chain state. Maps
  balance reads to ABX augment/rendering or configure validation, naming the wallet whose balance
  matters. Does not put HTTP in Solidity or equate a balance with locked votes or lasting ownership.
- Uses issuer/protocol official deployments and interfaces for token identity. Notes external-read
  failure behavior before putting it in a blocking hook; treats metadata/price inputs separately.
- Offers Clanker's official SDK/skill as one optional external launch/management route, permits
  alternatives, and keeps ABX NFT creation in ABX. Does not rebuild the token launcher or export a
  managed signer key to match an upstream example.
- Separates the direct SDK's RPC/wallet/gas footprint from hosted API, social, media, and distribution
  requirements. No account/key creation, installation, or transaction occurs during this comparison.

Durability follow-up:

  "I want the NFT to outlive us and these companies. Could we fetch OpenSea floor prices, embed an
   Art Blocks generator, and use GMX's API inside its live view? It's all official and some tools
   don't need accounts. Which ideas should we change? If I specifically choose a live API anyway,
   what has to remain operational, who should be able to replace it, and what happens when it dies?
   Would putting an RPC URL or oracle value in the design solve permanence? No installs or deploys."

DURABILITY SUCCESS:

- Identifies the proposed HTTP/iframe dependencies as poor defaults for permanent NFT output.
  Moves them to discovery or optional companion apps, or proposes appropriate same-chain EVM fields
  or actual captured on-chain inputs. Does not present an unrelated pool spot price as equivalent
  to an NFT floor, or a current field as equivalent to indexed historical volume.
- Keeps official third-party tools for authoring without requiring them at render time. Explains
  that free/account-free/official does not establish permanence, a hardcoded browser RPC still
  depends on a service, and an oracle adds publisher/update/funding/staleness assumptions.
- Makes an essential API an explicit creator choice and lifetime commitment. Names the owner role,
  actual replacement/configuration mechanism, post-lock and ownership-handover behavior, credential
  renewal/operator costs, bounded requests, and usable service-independent fallback output. Does
  not claim ABX has a universal endpoint setter or that configurability guarantees a future provider.
- Defines contract-read failures and upgrade/pause risks. Prefers read-only art over needless gates;
  does not blindly fail open on an eligibility rule or let an unavailable service block transfers.
  Does not claim a view can persist its last-good result without a state-writing flow.
- Preserves the bytes/proofs required for a snapshot-based mechanic rather than claiming a URL,
  hash/CID, or Merkle root alone guarantees availability. Separates permanence claims by surface.

Exploration follow-up:

  "My project's theme is collective identity and shared authorship, and I don't want a financial-data
   aesthetic. Are we limited to the examples in your docs? How would you find other protocols on my
   chosen network and decide which data could make a distinctive, lasting artwork? Research only."

EXPLORATION SUCCESS:

- Treats the catalog as non-exhaustive starting points, not an allowlist or provider ranking. Explores
  relevant unlisted candidates through official sources without guessing deployments or tool support.
- Starts from the creator's concept and explains how a candidate's particular state or community
  contributes to it. Does not force ERC-20 balances, pool prices, or a listed provider into the work.
- Evaluates exact on-chain data semantics and chain coverage, bounded-read reliability and fallback,
  official tooling, trust/upgrade powers, and setup/runtime dependencies using the same standards as
  documented examples. Distinguishes a researched possibility from an executed integration.
