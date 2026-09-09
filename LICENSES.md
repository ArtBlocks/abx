# Licensing

ABX uses different licenses for its Solidity layer and the rest of the repository.

| Scope | License |
| --- | --- |
| `contracts/src/`, `contracts/script/`, and `contracts/test/` | LGPL-3.0-only, except files whose SPDX header names another license |
| TypeScript packages, CLI, site, documentation, scripts, repository tooling, and code fixtures | MIT |
| Four OpenMoji media files listed in `fixtures/README.md` | CC BY-SA 4.0 |

The repository-level [LICENSE](LICENSE) contains the MIT text. [contracts/LICENSE](contracts/LICENSE)
contains LGPL-3.0 and [contracts/COPYING](contracts/COPYING) contains the incorporated GPL-3.0 text.
Solidity files carry SPDX identifiers that control when they differ from the directory default; the
reference hook examples marked MIT are intentionally permissive.

The OpenMoji fixtures are unmodified exports from the pinned 17.0.0 release, renamed for stable test
paths. Their exact sources, checksums, attribution, and license link are recorded in
[`fixtures/README.md`](fixtures/README.md).

Dependencies and copied third-party assets retain their upstream licenses and notices. Generated or
vendored dependency directories are not part of the repository's license grant merely because they
appear in a local checkout.
