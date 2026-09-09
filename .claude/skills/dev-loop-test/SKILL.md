---
name: dev-loop-test
description: Run isolated agentic regression sweeps of the ABX CLI and end-user skill. Use when asked to regression-test the CLI or skill, verify a fix end to end with real agents, run a parallel agent sweep, validate a release candidate, or reproduce an agent-workflow bug under controlled conditions.
---

# Agentic regression sweeps

Use the clean-room harness to test what a published user receives: a bare `abx` command, the bundled
end-user skill, and sample creator files. The test agent must not read repository source, contributor
instructions, or unpublished documentation.

## Procedure

1. Run `pnpm sandbox:status` and close or preserve any existing runs intentionally.
2. Select scenarios from `contributor/agent-eval/scenarios/`. Include a known-good control, the changed
   behavior, a neighboring path, a misuse case, and a diagnosis case.
3. Scaffold every room before starting agents:

   ```bash
   bash scripts/sandbox.sh --name <run>-<scenario>-<model> --no-launch [--funded] [--with-storage] [--yes]
   ```

   The room owns its CLI wrapper at `.sandbox-<name>/.bin/abx`. Launch the agent through the command
   printed by the scaffold, or prepend that directory to the agent's `PATH`; never install a global
   development wrapper.

4. Give each agent only its absolute sandbox path, the appropriate rubric, and the scenario text.
   For scenarios containing `{{MOCK_REMOTE_CONTRACT}}`, read the address from the generated,
   gitignored `.mock-remote-fixture.json` and substitute it before dispatch. Run independent rooms
   in parallel when resources permit.
5. Compare the agent's claim with observable output, served metadata, or on-chain state. Completion
   is not a pass if the result is wrong.
6. Reproduce each finding from the source tree. Fix it with tests or open a public GitHub Issue with a
   minimal reproduction. Security findings use the private process in `SECURITY.md`.
7. Remove completed rooms with `scripts/sandbox-clean.sh`; preserve any report that has not been
   fixed or linked to an issue.

Scenario selection guidance: [reference/situations.md](reference/situations.md).

## Lanes

| Lane | Setup | Proves |
| --- | --- | --- |
| Preview | default | setup, command discovery, dry runs, readouts |
| Funded testnet | `--funded` | real deploys, mints, writes, and gas behavior |
| Storage | `--with-storage` | configured external storage paths |
| Remote service | sandbox-scoped remote URL/token | provider discovery and control-plane behavior |

Never point a regression room at mainnet. Use at most one funded agent per account and chain unless
nonce contention is itself under test. Seed only variables required by the scenario; never copy the
repository `.env` wholesale or print a credential.

## Validity checks

A run is invalid when:

- its `FEEDBACK.md` is still the untouched template;
- the agent read repository source or paths outside its sandbox;
- the working-tree CLI changed while the run was in progress;
- the room used a stale global CLI instead of its wrapper;
- two rooms collided on ports or shared mutable runtime state;
- environment duplicates caused the effective configuration to differ from the intended one.

The current dotenv behavior is last-value-wins, but a regression room should still contain one
definition per key so its configuration is unambiguous.

## Reporting

For each scenario record the model, lane, outcome, evidence, and reproducible finding. Rank incorrect
or unsafe results above mere friction. A useful report separates what the agent did from what it said
and links every accepted finding to a fix or public issue.

Clean up only after that routing is complete:

```bash
pnpm sandbox:status
bash scripts/sandbox-clean.sh --void
bash scripts/sandbox-clean.sh --wave <run-prefix> --routed
```
