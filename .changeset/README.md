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

## Pre-release (alpha) mode

We are in **`alpha`** pre-release mode (`pre.json`), so version bumps stay `0.1.0-alpha.N`. The npm
`latest` dist-tag points at the current alpha, so `npx abx` resolves it.

To graduate to a stable line:

```sh
pnpm changeset pre exit   # leave alpha mode
git commit -am "chore: exit alpha pre-release mode"
```

Then merge the resulting Version Packages PR (the next bump drops the `-alpha.N` suffix).

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
`@artblocks/abx-token-api`, `@artblocks/abx-effects`, `@artblocks/abx-cli`.

Notes:

- The workflow pins **pnpm 10** and omits `registry-url` on purpose — both are load-bearing for OIDC
  (see the header of `.github/workflows/release.yml`).
- Provenance attestations are generated automatically for trusted-publisher releases.
