# Diagnosis and recovery

Use this reference when a command fails, a project is incomplete, metadata is wrong, a render is
missing, storage is propagating, a remote rejects a request, or an agent is tempted to add retries.

## Contents

- [Diagnose one state transition at a time](#diagnose-one-state-transition-at-a-time)
- [State-to-action table](#state-to-action-table)
- [Nonces and serialized writes](#nonces-and-serialized-writes)
- [Incomplete deployments](#incomplete-deployments)
- [RPC and chain failures](#rpc-and-chain-failures)
- [Metadata and resolution failures](#metadata-and-resolution-failures)
- [Storage failures](#storage-failures)
- [Render and effects failures](#render-and-effects-failures)
- [Secret-safe reporting](#secret-safe-reporting)

## Diagnose one state transition at a time

1. Capture the command, exit code, typed error/status, active chain, target address, and signer lane.
   Never capture secret values or complete credential-bearing URLs.
2. Run `abx version` and `abx doctor`; correct binary/skill drift before interpreting behavior.
3. Run the relevant read command (`state`, `tokens`, `tokenuri`, `contracturi`, `status`, `verify`,
   `remote`, or `storage status`) to establish current state.
4. Classify the result as nonterminal, terminal/configuration, terminal/on-chain, or integrity fault.
5. Choose one documented transition. Re-read state after it. Stop when the state changes or a human
   decision is required.

Do not run the same failed write with random flags, switch representations silently, rotate providers
without evidence, or wrap the CLI in an unbounded retry loop.

## State-to-action table

| Observation | Meaning | Next action |
|---|---|---|
| `indexing`, `queued`, `running`, `propagating` | nonterminal work | use the command's `--watch`/status and wait |
| `401` from a remote | token absent/invalid | replace the configured credential, then probe once |
| `403` from a remote | credential lacks scope | fix provider authorization; do not rotate blindly |
| wrong chain id | endpoint/config mismatch | correct `ABX_CHAIN`/RPC; do not deploy another contract |
| no code at address | wrong chain/address or incomplete deploy | verify explorer/chain and deploy state before retrying |
| transaction reverted | on-chain rule rejected the exact call | inspect typed reason/tx; change intent or inputs, not nonce |
| integrity/hash mismatch | served bytes differ from commitment | stop publication; restore committed bytes or explicitly repoint |
| placeholder image | image surface not published/wired | choose renderer, public image base, or resolver/effects path |
| storage accepted but gateway 404 | propagation may be pending | `storage status`; wait if propagating |
| empty historical reconstruction | pruning/range-capped RPC may have answered `[]` | put a full-history endpoint first, then re-index |
| skill version/name warning | agent membrane is stale or duplicated | run the exact project/global `abx skill install` commands shown |

## Nonces and serialized writes

ABX already owns nonce handling. A hot sender reads pending and latest counts once, uses the safe
maximum, increments locally for the sequence, waits for newly deployed code before dependent calls,
pins gas with bounded estimation, and reports a reverted receipt as an error.

The operational rule is therefore simple: **one EOA, one write process at a time**. Two processes can
start from the same nonce before either sees the other's pending transaction. If contention occurred:

1. Stop additional writers.
2. Read nonce coherence with `abx doctor` and check pending/mined transactions on the active chain.
3. Wait for the pending transaction or resolve it using the wallet's standard replacement flow.
4. Re-read project state; resume only the missing documented step.

Do not add “nonce too low” retries, increment a guessed nonce, or send concurrent replacement
transactions from the agent. Those layers fight the CLI's serializer and can duplicate value-bearing
operations.

## Incomplete deployments

A failed multi-transaction code-project setup can leave a valid clone with missing setup legs. Use
`deploy-code --resume <address>` only where the capability output says resume is supported. It reads
the contract and sends only missing work; it is not a general “try deploy again” switch.

Before resume:

- verify the address, chain, contract family, owner, and original artifacts;
- use the same normalized script/dependencies/schema/renderer plan;
- read the resume dry run and confirm every proposed transaction;
- ensure no second writer is operating the same EOA.

EditionCode (`--copies`) targets are supported too — pass the exact same content flags the original
deploy used, minus `--copies` itself (the standard was fixed at creation and is read from chain, not
re-specified). The one difference from a 721 resume: name the intended premint plan with
`--mint-count`/`--mint-amount` if the original deploy premint any ids — the mint leg diffs **per id**
against that id's own on-chain copy count, not a single whole-contract total, and each shortfall sends
as one transaction regardless of how many copies are missing. Getting `--mint-count`/`--mint-amount`
wrong under-reports (an id you meant to premint stays at zero) rather than over-mints (a token cannot
be un-minted, so the diff only ever tops up a shortfall) — but confirm the intended plan with the
human before sending if there is any doubt about what the original deploy meant to premint.

## RPC and chain failures

Use `abx doctor` rather than probing secret endpoints manually. Distinguish:

- connectivity/rate limit: endpoint did not provide a usable response;
- wrong network: endpoint chain id differs from `ABX_CHAIN`;
- shallow history: recent reads work but old logs are unavailable;
- range cap: large `eth_getLogs` queries fail or return misleading empty ranges;
- read-gas cap: a large on-chain `tokenURI` call exceeds that endpoint's allowance;
- stale distributed view: pending nonce or newly deployed code lags the endpoint's own head.

Put the best archive endpoint first. Fallback transports can accept an empty successful answer from a
pruned endpoint and never reach a healthy second endpoint. For large on-chain content, state whose RPC
was measured; do not generalize creator reach to marketplace reach.

If a write simulation or estimate reverts, preserve the exact representation the creator chose. Use a
read-only call/CLI diagnostic to surface the contract reason. Never silently replace an on-chain reader
with an off-chain URL merely to make the command pass.

## Metadata and resolution failures

Start from the contract, not a constructed URL:

1. `abx state <addr>` — contract family, renderer, owner powers, schemas/locks.
2. `abx tokenuri <addr> --token <id>` — actual on-chain URI and decoded metadata.
3. `abx contracturi <addr>` — actual collection URI.
4. `abx verify <addr> --json` — commitments, chain-completeness, placeholders, public bytes.

Then follow the failing surface:

- URI absent/wrong: inspect URI pointer/renderer and deploy configuration.
- Metadata resolves but image fails: inspect image representation and public locator/gateway.
- Animation fails: inspect generated document, dependencies, target token data, and hosting.
- Traits missing: inspect decoded `attributes`, renderer/effects output, and publication—not only
  program console traits.
- Attachments absent: verify resolver artifacts enumeration; bare on-chain metadata cannot enumerate
  arbitrary keys.

Use `refresh` only after the current path is correct. Refreshing a broken URI makes a marketplace fetch
the same broken document again.

## Storage failures

Run `abx storage show --check` with the intended backend overrides. For cloud, inspect both the private
put endpoint and public read base by hostname only; never print credentials. For IPFS, separate pinning
from gateway retrieval. For Arweave, use structured status to distinguish propagation from failure.

Retry policy:

- accepted/deduplicated upload: success; do not upload again;
- propagating locator: wait using status backoff;
- terminal authentication/configuration error: fix configuration before one new attempt;
- integrity mismatch: stop and restore/republish the committed bytes;
- transient provider failure: use the client's bounded retry or retry once after status evidence;
- repeated unknown failure: stop and report the smallest redacted reproduction.

Do not switch backend or public locator without telling the creator; that changes the custody plan.

## Render and effects failures

A still is derived state keyed by current inputs. Diagnose the graph in order:

1. Token/id is minted and indexed.
2. Live document loads for that real id.
3. Dependencies and PostParams resolve.
4. Effects runner is authenticated and receives the job.
5. Render bytes are non-placeholder and uploaded to public storage.
6. Resolver receives/publishes the locator and traits.
7. Token metadata exposes them.

Use `abx render --force` only when an existing render is known bad or stale; a plain render should
idempotently skip an existing current artifact. A PostParam change produces a new inputs hash; verify
the watcher or run the explicit one-shot path. Solidity image renderers have no effects job—diagnose
their on-chain call instead.

`abx artifacts <addr> --token <id> --json` is the direct check for steps 5–7: it reports every
registered effect row (current and stale) against the token's active `inputsHash`, without fetching
and parsing the whole served document. A row present but labeled `stale` means a param changed since
it rendered — re-render, don't assume it's missing. Add `--remote <name|url>` for a hosted project;
the real artifact set lives on the resolver that serves it, not in this node's local projection.

## Secret-safe reporting

Include command name, CLI version, chain key, redacted host labels, contract address, transaction hash,
exit code, typed status/error, and expected versus observed state. Exclude `.env`, keys, tokens, JWKs,
wallet-session URLs, query strings, and raw provider responses containing request headers.

If the same blocking state survives three evidence-based transitions, stop. Report what was proven,
what was ruled out, and the exact external decision or state change required. Repetition is not
progress.
