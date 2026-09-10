# Setup and safety

Use this reference when installing ABX, selecting a binary or signer, configuring a new environment,
or preparing a real transaction.

## Contents

- [Resolve the tool before the project](#resolve-the-tool-before-the-project)
- [Never expose secrets](#never-expose-secrets)
- [Select the chain explicitly through the environment](#select-the-chain-explicitly-through-the-environment)
- [Choose one signing lane](#choose-one-signing-lane)
- [Prepare without mutating](#prepare-without-mutating)
- [New environment checklist](#new-environment-checklist)

## Resolve the tool before the project

Inside the ABX source repository run `pnpm abx …`; elsewhere run the installed `abx`. A bare global
binary inside the repository may be older than the source. Start with:

```bash
abx version
abx doctor
abx capabilities --json
abx skill install
```

`abx doctor` reports binary provenance, CLI/skill drift, active chain, RPC health and history reach,
wallet readiness, canonical factories, storage, and configured remotes without exposing credentials.
Treat a red check as an actionable setup state, not as permission to improvise a workaround.

The shipped skill is named `abx`. `abx skill install` installs it to `.claude/skills/abx` and
`.agents/skills/abx` by default; `--agent`, `--global`, and `--target` narrow the destination. During
the rename transition the installer moves a recognized `abx-self-host` folder to
`.abx-skill-backups/` before installing the new name. It preserves custom bytes rather than deleting
them. For a custom skills parent, run `abx skill install --target <that-parent>`; do not move or merge
the old folder manually. Restart the agent after installation.

ABX requires Node 22.13 or newer. Prefer a project-local npm dependency for reproducible automation;
use a global install for interactive machine-wide use. Avoid repeated `npx` execution when version
provenance matters because caches can outlive an upgrade.

## Never expose secrets

Do not open, search, quote, or print `.env`. Do not echo variables to test whether they exist. Do not
paste a private key into a command line, generated file, wallet page, bug report, or transcript.

Sensitive values include:

- `ABX_DEPLOYER_PK` and any wallet key;
- credential-bearing `ABX_RPC_URLS*` values;
- `PINATA_JWT`, S3/R2 keys, `ABX_SERVICES_API_KEY`, other remote-provider tokens, effects/admin
  tokens;
- Arweave JWK contents and browser signing-session URLs.

Use `abx doctor`, `abx remote <name>`, `abx storage show --check`, and redacted CLI errors. If a tool
ever emits an unredacted credential-bearing endpoint, stop, rotate the credential, and report the
output bug without repeating the secret.

## Select the chain explicitly through the environment

Read the full `chains` array from `abx capabilities --json`. Base Sepolia is the default; Sepolia is
also supported. Arbitrum Sepolia is experimental and has no canonical ABX contracts yet, so use it
only for explicit qualification with the required address overrides. Production entries are present
but disabled, and the CLI refuses them. There is deliberately no `--chain` flag because silently
ignoring a wrong-chain request could spend on the wrong network.

Before any transaction on an `experimental` or future `beta` network, name the network and support
level, explain what the transaction or transaction group will do, and state the relevant contract,
configuration, and real-funds risks. Qualify the same flow on the paired testnet before production.

Use per-chain RPC variables when operating more than one chain. `abx doctor` checks chain identity,
wide-range `eth_getLogs`, archival reach, and nonce coherence. Put a healthy archive endpoint first:
fallback transports rotate on errors, not on a successful but pruned empty log response.

The local projection and managed Arweave identity remain in `.abx-self-host/` unless
`ABX_DATA_DIR` overrides it. That runtime directory is separate from the renamed `abx` skill and is
not being renamed. Back up the managed Arweave key with `abx storage backup-key`; never print it.

Every WRITE command (`deploy*`, `add`, `index`, `mint`, `set-*`, …) resolves `.abx-self-host`
strictly relative to the current directory — it never searches upward, so it never creates a
project's state somewhere unexpected. A handful of READ commands (`status`, `state`, `verify`,
`doctor`, `capabilities`, `tokens`, `tokenuri`, `contracturi`, `inspect`, `minter show`) DO search
upward, git-style, for an already-existing `.abx-self-host` if the current directory doesn't have
one of its own — bounded at the home directory, a `.git` root, or the filesystem root. Practical
consequence: `cd`-ing into a project's `contracts/` subdirectory before `abx status` still finds
that project; the same `cd` before `abx add`/`abx deploy*` creates a NEW, empty node right there
instead. If a status/verify/etc. answer looks emptier than expected, or a write seems to have
landed in the wrong place, run bare `abx status` — its `data: <path>` line names the exact
directory that answered, including a note when it was found by searching upward — or set
`ABX_DATA_DIR` explicitly rather than guessing. See [Local data
directory](https://docs.abx.io/docs/using-abx/self-hosting#local-data-directory) for the full rule.

## Choose one signing lane

Every write uses one of three lanes:

| Lane | Select | Use when |
|---|---|---|
| Hot | `--send` or default | An environment key may sign unattended |
| Wallet | `--sign --for 0x…` | A human approves in their browser wallet |
| Cold | `--unsigned --for 0x…` | A multisig/offline signer needs prepared transactions |

Run `abx doctor --for <address>` before a wallet or cold operation. On the wallet lane, give the
human the locally generated signing page; never request or handle their key. On the cold lane, verify
chain, sender, target, calldata, value, and ordering before handing transactions over.

`--onchain-image` staging cannot use the cold lane because each chunk transaction depends on the
receipt of the preceding transaction. Use hot or wallet signing. Do not split staging into a homemade
offline sequence.

`ABX_DEPLOYER_PK` may be written with or without a `0x` prefix — the CLI and SDK normalize it. Foundry's
`vm.envUint` does not: a custom forge script that reads the same `.env` needs the `0x` form.

For any one EOA, run one write command at a time. ABX obtains pending and latest nonces once, takes the
safe maximum, increments locally, waits for newly deployed code when a following transaction targets
it, and throws typed reversion errors. Starting concurrent processes bypasses that serialization.

## Prepare without mutating

Use command help and dry runs, not guessed syntax:

```bash
abx help deploy-code
abx deploy-code … --dry-run --json
```

A dry run may read contracts, probe endpoints, analyze files, or verify an address, but it does not
send or store. Address prediction is meaningful only when the salt and deployer are pinned. Use
`abx predict` when another contract or resolver must know the collection address before deployment.

Before any real send, confirm:

- active chain and deploying/owning address;
- contract family and edition arithmetic;
- name, symbol, royalties and royalty ceiling;
- deploy-time options such as burnability and creator-token enrollment;
- custody, public resolution, image/animation/trait surfaces;
- mint amount, value, transaction count, and expected gas;
- every irreversible lock or authority transfer.

Do not make a real send merely because a dry run exited successfully. The dry run is the plan; the
human confirmation authorizes execution.

## New environment checklist

1. Install Node 22.13+ and the desired CLI version.
2. Install the co-versioned skill with `abx skill install`, then restart the agent.
3. Select the testnet using `ABX_CHAIN` if not using Base Sepolia.
4. Add RPC, signer, and storage configuration outside the transcript. For first-party hosted
   services, run `abx auth login --no-open` in a short-yield or resumable session: immediately hand
   its verified browser URL and matching code to the human, then resume that same polling process.
   Let the CLI store `ABX_SERVICES_API_KEY` in ignored `.env` without printing it. Never ask for the
   email OTP or key in chat, start duplicate login sessions, or add standing login instructions to
   `AGENTS.md`/`CLAUDE.md`. The key is long-lived: reuse it across tasks and agent sessions. Run
   `abx auth logout` only for intentional teardown, compromise, rotation, or an unused-key cleanup.
5. Run `abx doctor` and resolve every red check relevant to the chosen lane.
6. Run `abx storage show --check` when bytes will leave the local disk.
7. Run `abx remote <name>` before relying on a configured managed service.
8. Run command help, then a JSON dry run.
9. Confirm the plan and only then execute.
