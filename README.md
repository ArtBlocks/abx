# ABX

ABX is an open protocol and toolkit for creating, operating, and serving NFTs. This monorepo contains
the Solidity contracts, TypeScript SDK, command-line interface, reference services, agent skill, and
public documentation.

ABX is in alpha. Canonical contracts are deployed on Base Sepolia and Sepolia; Arbitrum Sepolia is
available for explicit qualification work but does not yet have canonical ABX infrastructure.
Production networks are recognized but disabled in this release.

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

## Deployed contracts

Production networks are disabled. The canonical infrastructure below is deployed on Base Sepolia
and Sepolia via the keyless CREATE2 proxy, so every address **except the generator** is identical on
both chains. Network lifecycle is defined by
[`packages/sdk/src/chain-support.json`](packages/sdk/src/chain-support.json), addresses by
[`packages/sdk/src/deployments.ts`](packages/sdk/src/deployments.ts), and the current public reference is at
[docs.abx.io/docs/reference/deployments](https://docs.abx.io/docs/reference/deployments).

| Contract | Env override | Address (Sepolia · Base Sepolia) |
| --- | --- | --- |
| `OneOfOneImageFactory` (1/1 anchor) | `ABX_FACTORY` | `0x2824F4b4b4301dB2FcA10b2D80D45b4d463Ba57E` |
| `SeriesImageFactory` (series anchor) | `ABX_SERIES_FACTORY` | `0x685B4DfC835b6854590B5437C79D62BB7D52698b` |
| `SeriesCodeFactory` (code anchor) | `ABX_SERIES_CODE_FACTORY` | `0xdDA5174A868A8e099E159E67569900a4F936CFFe` |
| `OneOfOneEditionFactory` (1/1-edition anchor) | `ABX_ONE_OF_ONE_EDITION_FACTORY` | `0x6ecc7fAd2186965BaECD0Aa215b00239a3459ddF` |
| `EditionImageFactory` (edition anchor) | `ABX_EDITION_FACTORY` | `0xB6a8f051B08A8d6Fb0B6DA53BD23006CE2da31b7` |
| `EditionCodeFactory` (code-edition anchor) | `ABX_EDITION_CODE_FACTORY` | `0x9441Cc75318E20Ae6237EDb213b4C3019d756Bf0` |
| `AbxMetadataRenderer` (spec v11) | `ABX_RENDERER` | `0x85C1aE1F076d808fF7c1729F21B85038Fa16105E` |
| `AbxChunkStore` | `ABX_CHUNK_STORE` | `0x1Ca63a4ADEeF5e722ADA25b892BA40E3b2bcB905` |
| `AbxSeedSource` | `ABX_SEED_SOURCE` | `0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A` |
| `AbxFixedPriceMinter` (721 sale) | `ABX_FIXED_PRICE_MINTER` | `0x1E321A12386cF6BEe49d1270A5EC54DecA88db48` |
| `AbxFixedPriceMinter1155` (1155 sale) | `ABX_FIXED_PRICE_MINTER_1155` | `0x8FcC37dCb00A02367838Fa5B37347dCEec060981` |

The `AbxGenerator` bakes chain-specific immutables, so its address differs per chain:

| Chain | `AbxGenerator` (`ABX_GENERATOR`) |
| --- | --- |
| Sepolia (`11155111`) | `0xb7104ADfa6fb5615E46e2a681A2Ff043B08fADB5` |
| Base Sepolia (`84532`) | `0x2C1B7Cf6c54E4ACbcB54FCC395f7Af88eb4fc8CE` |

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

All six `@artblocks/abx-*` packages are published independently to npm. Changesets describe
user-visible package changes, and GitHub Actions creates version PRs and publishes through npm trusted
publishing. Package changelogs begin with the public source release.

## Security

Do not report vulnerabilities or credentials in a public issue. See [SECURITY.md](SECURITY.md) for the
private reporting path and supported-version policy.

## License

Original TypeScript packages, documentation, tooling, and code fixtures are MIT licensed. Four
OpenMoji media fixtures are CC BY-SA 4.0. Solidity contracts are LGPL-3.0-only unless a file's SPDX
header says otherwise. See
[LICENSES.md](LICENSES.md) for the exact scope and third-party notice guidance.
