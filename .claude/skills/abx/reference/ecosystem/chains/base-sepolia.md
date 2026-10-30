# Base Sepolia ecosystem context

Chain ID: `84532`. No additional testnet-specific entries are populated yet.
Use [multichain integrations](../multichain.md) and [ERC-20s and token creation](../tokens.md) for
candidate routes, and [Base context](base.md) for production context when relevant.

Verify this exact testnet's contract addresses, official tool/API support, and available assets.
Production ownership, balances, pools, and indexed datasets do not carry over. Label fixtures and
test tokens explicitly; they demonstrate the integration shape, not production data or liquidity.
Same-chain testnet state is on-chain; an API response remains an off-chain input.
Check `abx capabilities --json` for current ABX eligibility.
