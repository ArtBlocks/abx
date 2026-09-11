# `abx-contracts` Solidity package

`contracts/` is the single published Solidity source tree. The Soldeer package includes the
canonical interfaces, implementations, factories, minters, renderer examples, reference hooks and
the real-clone test harness. There is no separately maintained interface copy.

The package version follows protocol compatibility, not the CLI prerelease number. Core ABX v3 is
published as `abx-contracts~3.x`; incompatible interface or behavioral changes require the next
major. Consumers should pin an exact version in `foundry.toml` and deliberately upgrade. Core v2
remains available as `abx-contracts~2.x` for projects that need the earlier generation.

Maintainer verification (no upload):

```sh
cd contracts
forge soldeer push abx-contracts~3.0.0 . --dry-run
```

Publishing is a release action and requires the Soldeer registry token:

```sh
forge soldeer push abx-contracts~3.0.0 .
```

The generated scaffold imports from this package. A release must publish the package before the CLI
version that first references it, then run the scaffold's `forge soldeer install && forge test` in a
clean directory.
