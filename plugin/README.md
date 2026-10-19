# ABX plugin

The `abx` skill teaches Claude to plan, launch, host, and operate ABX NFT projects with the
[ABX CLI](https://www.npmjs.com/package/@artblocks/abx-cli): static 1/1s, image series, editions,
JavaScript and code drops, and Solidity-rendered projects on supported EVM networks.

Docs: [docs.abx.io](https://docs.abx.io)

## Requirements

The skill runs the `abx` command-line tool, so it needs an environment with a shell, such as
Claude Code, and:

- Node.js 22.13 or later
- `@artblocks/abx-cli`, installed from npm (`npm install -g @artblocks/abx-cli`)

## What it runs and connects to

The plugin contains only instructions; it bundles no code, hooks, or MCP servers. The `abx` CLI
it drives makes these network calls on your behalf:

- **npm registry**: to install `@artblocks/abx-cli` and check for CLI updates.
- **ABX services** (`services.abx.io`, `resolver.abx.io`): managed metadata hosting, token
  resolution, and feedback reports you choose to submit.
- **Blockchain RPC endpoints** for Ethereum, Base, and Arbitrum: public endpoints by default, or
  the RPC URL you configure.
- **Storage providers you select**: Arweave (ArDrive/Turbo) or IPFS (Pinata), when you upload
  media.
- **Block explorers** such as Etherscan, when you verify contracts.

Transactions are signed locally with the wallet or key you configure for the CLI. The plugin
never receives your keys.

## License

MIT
