# ABX

ABX is an open protocol and toolkit for creating, operating, and serving NFTs. This monorepo contains
the Solidity contracts, TypeScript SDK, command-line interface, reference services, agent skill, and
public documentation.

ABX tooling is prerelease software. Base Sepolia and Sepolia are supported, Robinhood Chain Testnet
is experimental, and production deployments on Base and Robinhood Chain are beta. Ethereum comes
later.

## Quickstart

Give this prompt to your coding agent:

> Read https://docs.abx.io/docs/using-abx/quickstart, install the ABX skill, and help me launch ⟨describe your project⟩.

Or install the CLI directly:

```bash
npm install -g @artblocks/abx-cli
abx doctor
```

The complete user guide, protocol reference, deployment addresses, and API documentation are at
[docs.abx.io](https://docs.abx.io).

## Networks

| Environment | Available | Next |
| --- | --- | --- |
| Testnet | Base Sepolia (default), Sepolia, Robinhood Chain Testnet (experimental) | — |
| Production | Base, Robinhood Chain (beta) | Ethereum |

Production beta transactions use real funds and create irreversible state; prove the same flow on the
paired testnet first. Experimental networks are for deliberate qualification. For live support
status, risks, and canonical contract addresses, see
[Networks and deployments](https://docs.abx.io/docs/reference/deployments).
The machine-readable sources of truth are
[`chain-support.json`](packages/sdk/src/chain-support.json) and
[`deployments.ts`](packages/sdk/src/deployments.ts).

## Repository

| Path | Contents |
| --- | --- |
| [`contracts/`](contracts) | Foundry project: token implementations, factories, renderers, minters, scripts, and tests |
| [`packages/sdk/`](packages/sdk) | Provider-neutral TypeScript SDK |
| [`packages/cli/`](packages/cli) | `abx` CLI and the bundled end-user agent skill |
| [`packages/indexer/`](packages/indexer) | Event-based reference indexer |
| [`packages/token-api/`](packages/token-api) | Reference metadata and control-plane service |
| [`packages/storage/`](packages/storage) | Filesystem, S3-compatible, and IPFS storage adapters, plus the Arweave backend's config/identity logic |
| [`packages/storage-arweave/`](packages/storage-arweave) | Optional ArDrive Turbo (Arweave) uploader — installed explicitly, never a default install's dependency |
| [`packages/effects/`](packages/effects) | Reference rendering/effects runner |
| [`site/`](site) | Source for the public documentation site |
| [`contributor/`](contributor) | Contributor-only distribution tests and cold-agent regression suite |
| [`fixtures/`](fixtures) | Shared media and code inputs for CLI and cold-agent regression tests |

The public docs site is the authoritative prose reference. Contract behavior is ultimately defined by
the deployed bytecode and source; package behavior is defined by source and tests. The repository does
not maintain a second set of narrative specifications.

## Development

Requirements:

- Node.js 22.13 or newer
- pnpm 10 (pinned by `packageManager`)
- Foundry 1.4.3 for contract development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test

cd contracts
forge soldeer install
forge test
```

Run the working-tree CLI with `pnpm abx …`; a bare `abx` may resolve to a globally installed
release. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing contracts, generated ABIs,
documentation, or published packages.

## Packages and releases

The `@artblocks/abx-*` packages are published independently to npm. Changesets describe user-visible
package changes, and GitHub Actions creates version PRs and publishes through npm trusted publishing.
Package changelogs begin with the public source release.

## Security

Do not report vulnerabilities or credentials in a public issue. See [SECURITY.md](SECURITY.md) for the
private reporting path and supported-version policy.

## License

Original TypeScript packages, documentation, tooling, and code fixtures are MIT licensed. Four
OpenMoji media fixtures are CC BY-SA 4.0. Solidity contracts are LGPL-3.0-only unless a file's SPDX
header says otherwise. See
[LICENSES.md](LICENSES.md) for the exact scope and third-party notice guidance.
