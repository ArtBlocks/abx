# Changesets

This folder drives automated npm releases of the `@artblocks/abx-*` packages via
[Changesets](https://github.com/changesets/changesets). See `.github/workflows/release.yml`.

## Shipping a change

1. Make your change on a branch.
2. `pnpm changeset` — pick the affected package(s) and bump level, write a one-line summary. This
   creates a `.changeset/<name>.md` file. Commit it with your change.
   **Lead the body with an audience line** whenever the bump touches the SDK or another package
   integrators consume: who breaks and who doesn't, in one sentence — e.g.
   *"Breaking for signers (deploy* signatures changed); drop-in for read-only consumers."*
   Downstream teams triage version bumps from exactly this line (it flows into the package
   CHANGELOG and the Version Packages PR), so writing it once here saves every integrator an
   audit round trip.
3. Open a PR. On merge to `main`, the release workflow opens (or updates) a **Version Packages** PR
   that bumps versions and regenerates each package's `CHANGELOG.md`.
4. Merge the **Version Packages** PR → the workflow publishes the bumped packages to npm.

Publishing goes through `pnpm -r publish`, which rewrites `workspace:*` dependency ranges to the
concrete published version in each tarball (a plain `npm publish` would ship an uninstallable
`workspace:*`).

## Choosing a version

ABX follows the same compatibility rules before and after `1.0`. A `0.x` version is not permission
to hide a breaking change in a minor release.

| Bump | Use it for | Examples |
| --- | --- | --- |
| **Patch** | Backward-compatible fixes and maintenance that do not add a public capability | Bug fixes, security or dependency updates, performance fixes |
| **Minor** | Backward-compatible public capabilities | A supported network, command, option, export, or project mechanic |
| **Major** | A change that can break a supported consumer or existing workflow | Removing or renaming an API, rejecting previously valid input, or changing established command behavior |

Documentation-only and repository-internal changes do not need a Changeset unless they alter a
published package. When uncertain, describe the affected consumer and compatibility impact in the
PR; choose the larger bump rather than understating a break. Review the generated Version Packages
PR before merging it, then confirm every version it names is available from npm after publication.

## Release channels

The packages publish stable versions from `main` to npm's `latest` dist-tag. Normal changes should
use the four-step flow above; do not enter prerelease mode for routine releases.

For a deliberate prerelease cycle, enter Changesets prerelease mode with a named npm dist-tag:

```sh
pnpm changeset pre enter alpha
```

Commit that state before merging changes intended for the prerelease line. Existing packages then
publish under `alpha`, not `latest`. To graduate that line, run `pnpm changeset pre exit`, merge the
resulting Version Packages PR, and confirm that npm's `latest` dist-tag points to the stable release.

## Requirements: OIDC trusted publishing (no token)

Releases authenticate to npm with a short-lived **OIDC** token from GitHub Actions — there is no
`NPM_TOKEN` secret. Each package must have a **trusted publisher** configured once on npmjs.com
(Package → Settings → Trusted Publisher → GitHub Actions), identical for all six except the package
name:

| Field | Value |
| --- | --- |
| Organization or user | `ArtBlocks` |
| Repository | `abx` |
| Workflow filename | `release.yml` _(filename only, with extension — case-sensitive)_ |
| Environment | _(leave blank)_ |
| Allowed actions | `npm publish` |

Packages to configure: `@artblocks/abx-sdk`, `@artblocks/abx-indexer`, `@artblocks/abx-storage`,
`@artblocks/abx-storage-arweave`, `@artblocks/abx-token-api`, `@artblocks/abx-effects`, and
`@artblocks/abx-cli`.

Notes:

- The workflow pins **pnpm 10** and omits `registry-url` on purpose — both are load-bearing for OIDC
  (see the header of `.github/workflows/release.yml`).
- Provenance attestations are generated automatically for trusted-publisher releases.
