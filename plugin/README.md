# ABX

Launch, host, and operate NFT projects with [ABX](https://abx.io), an open protocol and toolkit for
creating, operating, and serving NFTs on EVM networks.

This plugin teaches Claude the ABX workflow: which project kind fits what you're making — a static
1/1, an image series, an edition, a JavaScript/code drop, or a Solidity-rendered project — and then
how to scaffold, deploy, verify, serve, and mint it. It also covers storage, sales and minters,
PostParams, hooks, locks, and migrations, and it maps the CLI's typed errors to the fix for each one.

## Use it

The plugin runs the [`abx` CLI](https://www.npmjs.com/package/@artblocks/abx-cli), so install that
first. It needs Node 22.13 or newer:

```bash
npm install -g @artblocks/abx-cli
abx doctor
```

Then ask Claude for what you want — "help me launch a 500-piece generative series on Base" or "why
did my deploy fail" — in any Claude surface that can run shell commands, such as Claude Code. Claude
reads capability and on-chain output from the CLI rather than answering from memory, so it plans
against what the protocol actually supports on the network you pick.

ABX is adding EVM networks. Check the
[network table](https://docs.abx.io/docs/reference/deployments) before deploying.

## Data

The plugin is prose only. It contains no server, sends nothing on its own, and collects no telemetry.
Everything that leaves your machine is a command the `abx` CLI runs, using the configuration you
already gave it: reads and transactions go to your RPC provider, project content goes to the storage
backend you choose, and optional hosted features talk to ABX services after you sign in with
`abx auth login`.

Private keys, wallet sessions, and provider credentials stay local to your CLI configuration. The
plugin instructs Claude never to read or print them.

The full guide, protocol reference, and deployment addresses are at [docs.abx.io](https://docs.abx.io).
