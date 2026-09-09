# ABX contributor guide for coding agents

ABX is a polyglot monorepo:

- `contracts/`: Foundry/Solidity contracts and tests.
- `packages/`: pnpm TypeScript workspace containing the SDK, CLI, indexer, token API, storage
  adapters, and effects runner.
- `site/`: maintained public documentation. Content lives in `site/content/docs/`.
- `.claude/skills/abx/`: the end-user skill bundled into `@artblocks/abx-cli`.
- `.claude/skills/dev-loop-test/`: contributor-only cold-agent regression workflow.
- `contributor/agent-eval/`: regression scenarios and rubrics used by the development loop.

The public docs site is the only maintained prose reference. Do not create parallel vision,
architecture, roadmap, backlog, research, or review documents in the repository. Put proposed work in
GitHub Issues and durable behavior in code, tests, and `site/content/docs/`.

## Working-tree commands

Use `pnpm abx …` when testing local CLI changes. A bare `abx` can resolve to a globally installed
published release. The clean-room harness is the deliberate exception: `pnpm sandbox` wires its bare
`abx` to the checkout.

Before handing off a TypeScript change:

```bash
pnpm build
pnpm test
```

Before handing off a Solidity change:

```bash
cd contracts
forge test
```

## Contract changes

Any change to `contracts/src/**/*.sol`, including comments or SPDX/NatSpec, changes Solidity
metadata and is incomplete until generated ABI and creation-bytecode output is synchronized:

1. Run `forge test`.
2. Run `pnpm sync-abis` from the repository root.
3. Commit `packages/sdk/src/abi/generated.ts` with the source change.
4. Follow [the contract redeploy checklist](contracts/README.md#changing-a-contract--the-redeploy-checklist).
5. Keep source, generated output, deployment manifests, and public deployment docs in one change.

If runtime bytecode changes, redeploy on every supported chain and source-verify every new address,
including factory-created implementations. Renderer runtime changes also require a
`SPEC_VERSION` bump and matching CLI current-renderer check. Token runtime changes require a
`CORE_VERSION` bump, matching SDK `isCurrent*` probes, and preservation of superseded factories in
`ANCHOR_GENERATIONS`. Comment- or metadata-only changes do not require redeployment.

Never raise a contract-size guard to make a change pass, and never run repo-wide `forge fmt`; see the
contract guide for the deployed-source and CREATE2 consequences.

## Documentation and releases

- Update `site/content/docs/` in the same change as user-visible behavior.
- Add a Changeset for changes to a published package. Do not hand-edit released changelog entries.
- Keep the end-user skill aligned with the CLI. Its version is stamped during the release workflow.
- Never commit `.env`, private keys, provider credentials, local runtime state, build output, packed
  tarballs, or agent-session transcripts.

## Feedback and future work

Use public GitHub Issues for reproducible bugs and scoped proposals. Use GitHub's private security
advisory flow for vulnerabilities. A test finding is not complete until it is reproduced and either
fixed with tests or linked to an issue; do not add an internal backlog or triage ledger to the repo.
