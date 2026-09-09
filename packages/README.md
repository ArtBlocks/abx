# TypeScript packages

The pnpm workspace contains six independently published packages:

| Package | Purpose |
| --- | --- |
| `@artblocks/abx-sdk` | Typed protocol reads, transaction preparation, deployment, reconstruction, and verification |
| `@artblocks/abx-cli` | `abx` command-line interface and bundled end-user agent skill |
| `@artblocks/abx-indexer` | Event-based project reconstruction and SQLite projection |
| `@artblocks/abx-token-api` | Metadata, image, status, and provider control-plane service |
| `@artblocks/abx-storage` | Filesystem, S3-compatible, IPFS, and Arweave adapters |
| `@artblocks/abx-effects` | Reference rendering and effects runner |

The SDK does not sign transactions or select a hosted provider. Higher-level packages compose it into
the reference CLI and services.

## Development

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Run the source CLI with `pnpm abx …`. Build output is generated under each package's `dist/`
directory and is not committed.

When a package changes, add a Changeset with `pnpm changeset`. The release workflow builds packages,
updates versions and changelogs, and publishes with npm trusted publishing.

## Contracts and documentation

`pnpm sync-abis` regenerates `packages/sdk/src/abi/generated.ts` from Foundry output after a
contract change. Never edit that generated file by hand.

The maintained user and protocol reference is [docs.abx.io](https://docs.abx.io), sourced from
`site/content/docs/`.
