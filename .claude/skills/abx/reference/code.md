# Code projects, renderers, and PostParams

Use this reference for `preview`, `inspect`, `deploy-code`, JavaScript/build projects, Solidity field
renderers, marketplace stills and traits, seeds, dependencies, parameters, and code-project locks.

## Contents

- [Choose the runtime lane](#choose-the-runtime-lane)
- [Design every public surface](#design-every-public-surface)
- [Preview and inspect honestly](#preview-and-inspect-honestly)
- [Plan JavaScript projects](#plan-javascript-projects)
- [Plan Solidity field renderers](#plan-solidity-field-renderers)
- [Use PostParams and hooks](#use-postparams-and-hooks)
- [Handle seeds and dependencies](#handle-seeds-and-dependencies)
- [Verify and freeze](#verify-and-freeze)

## Choose the runtime lane

`deploy-code` selects a code-capable canonical contract. It supports four useful input shapes:

| Shape | Core flags | Typical surfaces |
|---|---|---|
| On-chain JavaScript template | `--script <file>` | on-chain program; hosted or on-chain assembled live document |
| Shared program + per-token payload | `--script` + `--schema <key>:Bytes:Creator` | one chunked engine; after mint, set each token's `Bytes` PostParam with `configure-param --file` |
| Build directory | `--code-dir <dir>` | uploaded application bundle; resolver/live view |
| Solidity-computed fields | `--image-renderer` and/or `--attributes-renderer` | on-chain SVG image and/or traits |
| Hybrid | script plus field renderers | program animation plus Solidity image/traits |

`--script` splits the source into on-chain chunks automatically (default ~22 KB per chunk, the
practical SSTORE2/EIP-170 limit). Pass `--chunk-size <bytes>` to override the split size — smaller
values force a multi-chunk program cheaply, which is the fast way to exercise multi-chunk behavior on
a tiny test script rather than needing a large real one. `abx replace-script`
([operate.md](operate.md#replacing-an-unlocked-script)) accepts the same flag.

There is no fixed supported script-size ceiling. Post-deploy setup (chunks, PostParam schemas,
dependency declarations, on-chain-URI legs, reserve mints) rides one combined transaction when it
fits; a large script splits it into several gas-bounded transactions instead — chunks first, then the
remaining config, mints strictly last. The dry run's `transactions`/`approvals` reports the real
count for the whole plan; if any single one is interrupted mid-sequence, `--resume` finishes it (see
[diagnose.md](diagnose.md#incomplete-deployments)) — every non-mint leg is idempotent, so re-running
resume is always safe.

Without `--copies`, the contract is SeriesCode (ERC-721). With `--copies <n|open>`, it is EditionCode
(ERC-1155): N generated ids, each with multiple copies. EditionCode currently supports scripts,
directory builds (`--code-dir`), dependencies, field renderers, deterministic per-id off-chain stills
(`--image-base`), and `--resume` for an incomplete deployment (see
[diagnose.md](diagnose.md#incomplete-deployments) — the mint leg diffs per id, with a new
`--mint-amount` naming each premint id's intended copy count). Run `abx capabilities --json`
immediately before planning.

For one generated work with 100 copies, use `--max 1 --copies 100`. Omitting `--max 1` leaves the
default multi-id space, producing multiple generated ids with 100 copies available for each id.

A creator who needs parameters or hooks must use a code-capable contract even if the output is a
static-looking SVG or image. This is a deploy-time type decision.

## Design every public surface

A code project is not one URL. Decide each surface separately:

- **Program/animation** — the live JavaScript document or absence of one.
- **Marketplace image** — a rendered still, a deterministic image URL, an on-chain Solidity SVG, or
  an explicit placeholder during development.
- **Marketplace traits** — renderer-computed JSON, resolver/effects output, or intentionally omitted.
- **PostParams** — canonical typed state on the token contract, consumed by the program/renderers.
- **Attachments** — named files served through a resolver's artifacts/data surface.

“The program is on-chain” does not prove that image and traits are on-chain. “The animation works”
does not prove a marketplace thumbnail exists. Write a surface matrix before deployment and verify
each row after minting.

## Preview and inspect honestly

Use `abx preview` while authoring and `abx inspect` before choosing a deployment lane.

Preview uses the canonical runtime envelope, dependency order, and token-data shape with synthetic
inputs. It is a high-fidelity authoring preview, not an end-to-end deployment proof. It does not prove:

- that a chosen dependency resolves on the target chain;
- that the deployed generator or renderer fits an RPC's read allowance;
- that real minted seeds and PostParams are consumed correctly in every state;
- that marketplace metadata contains image and attributes;
- that a hosted resolver/effects/storage path is reachable.

Use `--shoot` for representative frames. Exercise more than the default seed and every user-facing
parameter. Then run `abx inspect` to analyze dependencies, deterministic seed usage, declared traits,
document size, and lane fit. Treat findings as evidence and the deploy dry run/testnet verification as
the final proof.

Avoid unseeded randomness, wall-clock dependence, environment-only assets, and network fetches when
claiming reproducibility. A live-data design is valid; label it live rather than deterministic.

## Plan JavaScript projects

### On-chain program, hosted resolution

Use `--script` with `--public-base-url` when a resolver should assemble the live document and expose
mutable metadata/render surfaces. The script remains on-chain; the public metadata path is HTTP.
This is normally the most interoperable lane for a sale where thumbnails must update continuously.

Run an effects service for derived stills and traits:

- `abx effects` runs locally and blocks; use it for development or a co-located operator.
- `abx deploy-effects --resolver-url <url>` scaffolds a continuously running service.
- `abx render <addr> [ids] --remote <resolver>` performs a one-shot/backfill render.

The renderer must store its bytes in a backend the resolver can retrieve. A hosted resolver cannot
read a laptop-local `fs` store. Managed providers may advertise managed rendering; confirm with
`abx remote <name>` rather than assuming it.

### On-chain program and on-chain live document

Use `--script --onchain-uri` when the generator can assemble the animation document entirely from
on-chain program/dependency bytes. This can remove an always-on resolver for the live program.

Check the deploy dependency report and `abx verify` before calling it chain-complete: a registry
dependency may resolve through a CDN instead of on-chain bytes. Large assembled documents may exceed
some endpoints' `eth_call` allowance; report the measured reach, not “any RPC forever.”

For a JavaScript lane, the marketplace image remains a separate decision. With no resolver watcher,
a still published to a deterministic public `--image-base` is a manual/backfill surface: rerun render
after relevant parameter changes. An on-chain animation plus automatically updating off-chain still
requires an operator watching state.

EditionCode now accepts `--image-base` too: the same `{base}/{id}.png` url-template, one id space
finer — `{id}` is the EditionCode id, and every copy of that id shares the one image (there is no
per-copy addressing). The effect runner never renders an id with zero live copies (no mint-time seed
has been drawn yet for it), so an unminted premint id is skipped, not errored — it renders once the
first copy mints. `--image-base` stays mutually exclusive with `--image-renderer` on both lanes.

### Build directory

Use `--code-dir` for an application bundle whose files are uploaded and addressed as a code artifact.
It requires external storage and public resolution — a backend without directory upload (`fs`, the
local default) is refused; pick `--backend ipfs` or `--backend arweave`. Inspect the built output, not
only the source tree, and verify that every referenced asset is included. The live view 302s through
the gateway, so the gateway must serve HTML (the shared Pinata public gateway does not — use a
dedicated gateway or Arweave). `--code-dir` works with `--copies` too (EditionCode): the same upload,
the same on-chain `code` field, the same gateway rules — `--script` and `--code-dir` remain mutually
exclusive on both lanes.

## Plan Solidity field renderers

`--image-renderer <address>` stores an `IAbxFieldRenderer` pointer for the metadata image field;
`--attributes-renderer <address>` does the same for traits. With `--onchain-uri`, the canonical
metadata renderer calls them on-chain. A renderer-only project needs no JavaScript program and no
effects runner.

Start with `abx scaffold-renderer`, then build, test, and deploy the Solidity project using Foundry.
ABX does not compile or deploy custom Solidity. A real deploy refuses a renderer address with no
code.

Enforce these invariants in renderer tests:

- `render(token, tokenId, field)` must not revert for unminted ids, missing params, boundary values,
  unexpected callers, or retired schema state.
- Return the correct media type and valid complete content: SVG for image, JSON attributes array for
  traits.
- Derive image and traits from the same seed/state model.
- Bound loops and output. Test realistic worst cases through an RPC call, not only local unit gas.
- Treat a renderer or hook address lock as a pointer lock. Use immutable deployments for stronger
  permanence claims; an upgradeable proxy can change behavior behind a locked address.

Solidity image/attributes renderers work on both SeriesCode and EditionCode, including renderer-only
editions. They eliminate off-chain stills only for the fields they compute; a separate JavaScript
animation may still exist.

## Use PostParams and hooks

PostParams are typed, schema-governed state stored on-chain. Use `--schema` at deployment or
`abx set-schema` later, then `abx configure-param` through the governed path. Inspect current type,
authorization, and lock grammar with command help instead of memorizing it.

Model parameters deliberately:

- Define a stable key and type; do not change a key's meaning across versions.
- Choose creator, token-owner/holder, or address authorization to match the actual state model.
- Validate input in the UI and again in a configure hook when the rule must be enforced on-chain.
- Treat string/bytes values as potentially large and price/limit them appropriately.
- Retire or weld a governed parameter only after the current value and defaults are verified.

### Edition shared state

On EditionCode, parameters belong to an **id**, not an individual physical copy. If token id 3 has
100 holders, they all read the same value for id 3. With holder authorization any holder may write it;
the last valid writer wins. This is good for communal state and wrong for “name my personal copy.”
Use one id per personalized work when per-holder state is required.

A holder-writable large string/bytes parameter can also expand the shared id's metadata beyond common
RPC read reach. State this before deployment and use schema validation/hooks to bound it when needed.

### Hooks

SeriesCode and EditionCode expose three configurable hook addresses:

- configure hook: validates/vetoes governed writes before they persist;
- transfer hook: observes every mint, transfer, and burn and may veto the operation;
- augment hook: computes additional/overriding token data during reads.

Hooks are extension seams, not ordinary CLI flags. Build and deploy them outside ABX, wire them with
`abx set-param-hooks`, test against a real clone, and read [capabilities.md](capabilities.md). A
transfer-hook revert fails mints as well as secondary transfers. Freeze the addresses with
`abx lock-param-hooks` only after testing every lifecycle transition.

## Handle seeds and dependencies

Seeds are generated at mint and drive reproducible variation. `abx inspect` identifies common seed
misuse, but test multiple real token-data fixtures. A custom seed source affects future mints and is
an external contract pointer; verify its code/interface and disclose who can change its behavior.

Dependencies are ordered; index 0 is the runtime. A `name@version` reference resolves through the
collection's dependency-registry pointer, while a `0x…` reference reads a data contract directly.
Registry availability is chain-specific. Read the deploy dependency report: a named dependency can
be valid yet served from a CDN, which means the document is not chain-complete.

`lock-dependencies` freezes the reference list and registry pointer, not necessarily the bytes a live
registry entry returns. Use immutable on-chain data contracts for a stronger frozen-dependency claim.

## Verify and freeze

After deploying and minting representative ids:

1. Read `abx state`, `abx tokens --json`, and `abx tokenuri`.
2. Open the animation/live view using actual minted token data.
3. Fetch the marketplace image and inspect `attributes` from token metadata.
4. Run `abx verify` and resolve placeholder, chain-complete, dependency, or render warnings.
5. Change every intended parameter through its authorized path; confirm still refresh behavior.
6. Exercise mint, transfer, and burn paths if hooks or burnability are involved.
7. Verify dependency and renderer addresses and whether their code is upgradeable.
8. Lock only the surfaces the creator has explicitly chosen to freeze.

A fully frozen code-project posture may involve URI/field locks, `lock-script`,
`lock-dependencies`, `lock-param-hooks`, and governed parameter locks. Those locks cover different
state. Describe exactly what each freezes; never summarize them as “the output can never change.”
