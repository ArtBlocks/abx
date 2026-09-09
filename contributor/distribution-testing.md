# Simulating the published experience

Experience the `abx` CLI + skill the way a published end user does — from the **current working
tree, before you cut a release** — so we catch gaps in what actually ships, not just what works in
this repo. It's one command.

## Why not just run an agent in this repo?

An agent session in this repo can read the source, public docs, and contributor `CLAUDE.md`. That
*hides* the only thing we're measuring: **is the shipped skill + CLI self-sufficient?** If a cold
agent has to read `packages/` or contributor files to succeed, the distribution has a gap — and running in
the repo makes that gap invisible. So we simulate in a **clean room**.

## One command

```bash
pnpm sandbox            # fresh agent session on the CURRENT codebase, interactive (human + agent)
pnpm sandbox "take sources/donuts-cake.svg to an NFT on Sepolia"   # ... pre-seeded with a first message
pnpm sandbox:cold       # a headless cold agent runs the default scenario, prints a friction scorecard
pnpm sandbox:cold series-deploy   # ... a specific scenario (see contributor/agent-eval/scenarios/)
pnpm sandbox:cold all             # ... every scenario in sequence
```

Each run creates a throwaway, **gitignored `.sandbox/`** containing only what a published user
gets — a bare `abx` on PATH, the skill, the creator's source files under `sources/` (a single
`donuts-cake.svg` for a 1/1 **and** a `series/` folder of images for a multi-token Series, so both
drop types are testable), a minimal `.env` — then launches Claude there. The agent has no path to
the source.

**There is no "re-make" step.** Running the command *is* the refresh: the skill is copied fresh
each time (always current) and `abx` runs the live checkout via a tsx wrapper (code edits are live).
So `pnpm sandbox` always means "fresh agent on the current code, right now."

> For a **real** deploy (not preview), add a funded Sepolia key to `.sandbox/.env`
> (`ABX_DEPLOYER_PK`) or use `abx deploy --sign` with a funded wallet. `abx doctor` says what's
> missing. The sandbox is intentionally **keyless by default**, so a cold agent physically cannot
> spend — preview-only is the safe floor.

> **Hosted resolver in the sandbox.** The clean-room `.env` sets `ABX_RESOLVER_SOURCE=1`, so
> `abx deploy-resolver` emits a **build-from-source** artifact (the CLI vendors the workspace source
> into `deploy/<provider>/` — a self-contained, buildable image) instead of the npm-based one. That
> lets us e2e-test hosting **pre-publish** and keep iterating locally forever without a publish
> step. In production the same command emits the tiny npm image (`npm i -g @artblocks/abx-cli`). Either way the
> artifact is self-contained — the agent never reaches into the repo for a Dockerfile or `packages/`.

## The two modes

- **Interactive — `pnpm sandbox`** (gold standard). A real Claude session rooted in `.sandbox/`,
  you giving intent and the agent driving `abx`. Full isolation for the human+agent pair UX.
- **Cold — `pnpm sandbox:cold [scenario|all]`** (autonomous). A headless agent (`claude -p`) runs
  a **scenario** from the [`agent-eval/`](agent-eval/) suite and prints a scorecard:
  1. Setup/onboarding · 2. Skill clarity · 3. Command discovery & invocation · 4. Readout/error
  quality · 5. Goal achieved? · 6. Top friction · 7. Concrete fixes — overall 1-5. The suite is a
  shared [`rubric.md`](agent-eval/rubric.md) (persona, constraints, scorecard — defined once) plus
  one file per case under [`scenarios/`](agent-eval/scenarios/) (`1of1-deploy` is the default;
  `series-deploy`; `all` runs every one). Add a scenario when a new drop type or owner-op ships.
  Tools are pinned to `abx` + reads
  via a sandbox-scoped `.claude/settings.local.json` (nothing destructive), and the keyless `.env`
  means it can't spend. An agent can call `pnpm sandbox:cold` and read the scorecard from stdout.

## Two fidelity tiers

| Tier | Mechanism | Tests | Catches packaging bugs? |
|---|---|---|---|
| **1 — behavioral** (`pnpm sandbox`) | `abx` = live checkout via a PATH wrapper (tsx) | agent comprehension of the shipped skill + CLI | No |
| **2 — publish-faithful** ([packages and releases](../README.md#packages-and-releases)) | `pnpm pack` the `@artblocks/abx-*` packages → install the tarballs into a clean consumer; install the skill with `abx skill install` or `npx skills add ArtBlocks/abx --skill abx` | the actual shipped artifact: `files` manifest, `bin` resolution, declared dependencies, bundled assets, and deployment manifest | Yes |

Tier 1 is enough to iterate on the skill. Tier 2 is the release gate — only it proves the tarball a
user installs is correct.

**Tier 2 is now a command: `pnpm tier2`.** It packs all six workspace packages with `pnpm pack` (NOT
`npm pack` — only pnpm rewrites `workspace:*` into a real version, so an npm-packed tarball fails to
install at all), installs them together into a throwaway consumer with a throwaway `HOME`, and asserts
the things a unit test cannot see: `bin` resolution, the `files` manifest, that `abx skill install` and
`abx scaffold-renderer` find their bundled assets, that the address manifest baked into the tarball
matches the working tree, and that `doctor` survives a bare install.

Run it before cutting a release. Packaging failures can exist only in the published layout, which
Tier 1 never constructs; the scripted Tier 2 check keeps that verification repeatable.

## Make it part of the dev flow

Run `pnpm sandbox:cold` after any change to the **skill** or the **CLI's commands/flags/readouts**
— it's the regression test for *agent comprehension*, which `tsc` and unit tests can't cover. A
finding here (e.g. the skill documents an invocation the published CLI doesn't have) is as real a
bug as a failing test. The first cold run already caught the skill using `pnpm abx …` (the dev
invocation) where a published user has bare `abx`.

## Cleanup

Each fresh run **wipes the existing `.sandbox/` first** so you always start clean — it confirms
before wiping if one exists (skip with `--yes`, and it auto-proceeds when there's no TTY, e.g. CI).
The wipe is irreversible, so anything you added to `.sandbox/.env` (like a funded key) is lost.

`rm -rf .sandbox` removes the clean room (it's gitignored). Its `abx` wrapper lives only under
`.sandbox/.bin`; the harness prepends that directory to PATH for the launched session and never
changes a global installation. Nothing the simulation writes is committed.
