# Agent regression scenarios

Each file in `scenarios/` is pasted into one rubric:

- `rubric.md`: isolated preview/read-only runs
- `rubric-live.md`: funded testnet runs
- `rubric-creative.md`: the agent authors the asset before testing the workflow

The rubric is the agent prompt. Scenario text should express a realistic creator request and an
observable success condition without prescribing CLI commands.

## Existing-contract scenarios

Scenarios that operate an existing collection need a fresh per-run address. Replace placeholder or
previous-run addresses before dispatch because:

1. A run may consume the required starting state.
2. A collection from a retired testnet factory may correctly report as a prior generation.

Provision with the working-tree CLI and confirm the starting state with `abx state <address>`.
Maintained live fixtures belong in automated tests, not scenario prose.

## Isolation rules

- State the chain when it is not the default. The harness explicitly allows
  `ABX_CHAIN=sepolia abx …` and `ABX_CHAIN=base-sepolia abx …`.
- Do not let a parallel room run `abx skill install --global`; it writes outside the room and can
  change what sibling runs observe.
- Do not copy the repository `.env` into a room. Seed only the variables its lane requires.
- Treat an untouched `FEEDBACK.md` as an incomplete run, not a passing result.

The contributor workflow, lane selection, reporting rules, and cleanup commands are in
`.claude/skills/dev-loop-test/SKILL.md`.
