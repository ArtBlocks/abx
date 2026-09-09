# Contributing to ABX

Thanks for helping improve ABX.

## Before opening a change

Use a GitHub Issue for a bug report or a proposal that needs design discussion. Small fixes can go
directly to a pull request. Security vulnerabilities belong in the private process described in
[SECURITY.md](SECURITY.md), never in a public issue.

Keep pull requests focused. Explain the behavior being changed, how it was verified, and whether it
affects contracts, deployed addresses, package APIs, the CLI, or public documentation.

## Set up

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

No environment variables are required for builds or tests. If you need a non-default network,
signing, storage, or self-hosting configuration, copy the relevant commented entries from
[`.env.example`](.env.example) into an ignored `.env`. Every entry in the template is optional;
prefer browser-wallet `--sign` over storing a private key, even on testnet. Run `pnpm abx doctor`
to see the effective configuration without printing secrets.

Contract work also requires Foundry 1.4.3:

```bash
cd contracts
forge soldeer install
forge test
```

## Project conventions

- Run local CLI code with `pnpm abx …`.
- Add or update tests for behavior changes.
- Update `site/content/docs/` with user-visible changes.
- Add a Changeset with `pnpm changeset` when a published `@artblocks/abx-*` package changes.
- Preserve package boundaries and do not introduce provider-specific behavior into the SDK.
- Do not add planning, strategy, research notebooks, review transcripts, or private triage records.
  Use GitHub Issues and pull requests for work tracking and design discussion.

## Contract changes

Solidity changes require extra care because the SDK embeds both ABIs and creation bytecode.

1. Run the complete Foundry test suite.
2. Run `pnpm sync-abis`.
3. Include regenerated `packages/sdk/src/abi/generated.ts`.
4. Follow [the redeploy checklist](contracts/README.md#changing-a-contract--the-redeploy-checklist)
   if runtime bytecode changes.
5. Update deployment manifests and public deployment docs together.

Do not raise code-size test limits to make a change pass. Treat a deployment-address change as a
public compatibility event.

## Verification

At minimum, run the checks relevant to your change:

```bash
pnpm build
pnpm test
pnpm check:hygiene
pnpm check:audit
pnpm check:publish-drift
```

For public documentation changes, also run `pnpm --dir site build`. For release-facing CLI changes,
also run `pnpm tier2`. For agent-workflow changes, use the
clean-room harness documented in
[contributor/distribution-testing.md](contributor/distribution-testing.md).

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
