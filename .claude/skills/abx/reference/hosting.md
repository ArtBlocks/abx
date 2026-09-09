# Hosting, storage, and remote operation

Use this reference when a project needs public resolution, managed remote service, creator-operated
resolver/effects, storage configuration, render publication, lifecycle monitoring, or migration.

## Contents

- [First decide whether a host exists](#first-decide-whether-a-host-exists)
- [Choose managed or creator-operated resolution](#choose-managed-or-creator-operated-resolution)
- [Choose storage independently](#choose-storage-independently)
- [Operate resolver and effects services](#operate-resolver-and-effects-services)
- [Use lifecycle states](#use-lifecycle-states)
- [Migrate without losing canonicity](#migrate-without-losing-canonicity)

## First decide whether a host exists

Do not ask “where should we host?” until the public surfaces require a host.

No ABX resolver is required when:

- static bytes and metadata resolve on-chain;
- on-chain JSON points at public Arweave/IPFS/cloud media;
- Solidity field renderers compute every required metadata surface on-chain.

A resolver is useful or required when:

- metadata must remain operationally editable;
- a JavaScript/build project needs a hosted live document;
- marketplace stills/traits are produced by an effects runner;
- attached artifacts must be enumerated and fetched;
- large on-chain content needs an HTTP reader in front of endpoint-dependent `eth_call` execution;
- a project needs indexed status/dashboard/API surfaces.

Storage can be on-chain while resolution is hosted, or external while metadata resolution is
on-chain. Keep those axes separate.

## Choose managed or creator-operated resolution

Both routes implement the same public resolver contract. The token holds a base URI; the operator
reconstructs canonical state from chain and serves metadata/live/data surfaces.

### Managed remote

Use a named remote already configured in the environment rather than standing up duplicate
infrastructure. Start with:

```bash
abx remote <name>
```

`abx` is the built-in name for the first-party service at `services.abx.io`; it needs only
`ABX_SERVICES_API_KEY`, not a remote URL variable. Read [services.md](services.md) for its verified
OAuth login, manual recovery path, current access model, and provider-feedback path. Other providers
use their configured name.

This reports the service descriptor, supported chains, rendering policy, and authentication status.
Do not infer provider capability from its hostname or marketing page.

Interpret control-plane failures precisely:

- `401` means the supplied token is missing, stale, or invalid; replace the credential.
- `403` means the credential is recognized but lacks permission for this chain/project; fix provider
  scope rather than rotating keys blindly.
- a conformance failure means the service contract is incomplete or incompatible; do not register a
  production launch until the failing assertion is understood.

Register or operate a project using `--remote <name>` and monitor with `abx status --remote <name>`.
If the provider advertises managed rendering, confirm it for the active chain/project. Otherwise the
creator still owns the effects and storage path.

Never invent a provider, auth flow, price, quota, or key source. If no configured provider exists,
offer the fully supported creator-operated route.

### Creator-operated resolver

Use `abx deploy-resolver --provider …` to generate hosting artifacts for the selected platform. The
creator owns the cloud account, domain, secrets, monitoring, and upgrades. Review the generated
configuration before deploying it; do not copy repository `.env` wholesale.

The host needs read-only RPC access, storage access where applicable, and a stable public URL. Keep
signing keys off the resolver. Use the project/state API and on-chain reconstruction instead of a
private source-of-truth database.

Prefer a creator-controlled domain in the on-chain base URI. Provider-specific hostnames work, but a
custom domain makes migration a DNS operation rather than a contract operation. Tunnels and localhost
are preview-only and must never be baked into a launch.

After provisioning:

1. Run health/conformance checks.
2. Register the contract with its deploy block when known.
3. Wait for indexing readiness.
4. Fetch contract and token metadata through the public URL.
5. Verify byte commitments with `abx verify`.
6. Mint only after required token-specific surfaces can become ready.

## Choose storage independently

Storage is stateless configuration selected per command or through environment defaults. Inspect the
resolved choice with:

```bash
abx storage show --check
```

| Backend | Good for | Operator responsibility |
|---|---|---|
| `fs` | local development | disk durability and no public reach by default |
| `cloud` | mutable/fast public assets | bucket, auth endpoint, public read base/CDN, retention |
| `ipfs` | content-addressed distribution | pinning and public gateway availability |
| `arweave` | permanent external custody | upload identity/credits and propagation |

Never silently fall back to `fs` when a selected backend is incomplete. Fix the missing configuration
or change the plan explicitly.

### Cloud

Separate the authenticated S3/R2 API endpoint used for writes from the public HTTP base used by
collectors. An R2 S3 endpoint is not a marketplace image URL. `--check` performs a real write/read
round trip through the public base; require it to pass.

### IPFS

Pinning success and gateway retrieval are distinct. Use a durable pinning service and public gateway
for launches. A local kubo node is suitable for development only. The on-chain field may hold the
bare CID while a collection gateway preference chooses the serving prefix; `abx set-gateway` can
change that prefix without changing the content.

### Arweave

`--backend arweave` (the default `turbo` provider) needs the optional
`@artblocks/abx-storage-arweave` package installed alongside the CLI — it is not part of the
default install, deliberately, so a default `abx` install stays free of Turbo's browser
wallet-connector dependency tree. If it is missing, the CLI names the exact install command
(`npm install @artblocks/abx-storage-arweave`) rather than failing unhelpfully; run that command
once, then retry. `--provider http-bundler` needs neither this package nor any of its dependencies.

The accepted upload and a retrievable gateway object are separate lifecycle states. Use
`abx storage status <locator> --json`; wait for `ready` instead of uploading duplicates during
propagation. Upload deduplication is success, not an instruction to top up or switch backends.

Turbo credits attach to the signing identity. `abx storage balance` reports the managed identity and
wallet-related lanes; choose the intended payer before funding. Back up the managed key using the
dedicated command and never expose the JWK.

### Publication bridge

An effects runner stores rendered bytes, then publishes their locator to the resolver. The resolver
usually redirects to that public object rather than proxying it. Therefore the storage backend must be
reachable from both the runner and collectors. A local `fs` output from one machine is orphaned when
the public resolver runs elsewhere.

## Operate resolver and effects services

The resolver handles indexed state and public metadata/live/data routes. The effects service executes
programs and publishes stills/traits. Deploy them separately so heavy browser work does not destabilize
metadata reads.

For an active JavaScript sale, run continuous effects. For a fixed supply or repair, a one-shot render
may be sufficient. With an on-chain Solidity image renderer, no effects service is needed for the
image; do not deploy infrastructure merely because the collection is a code contract.

Protect public effects endpoints with the generated token. An unauthenticated force-render endpoint
can burn compute and storage. Keep resolver admin/effects credentials separate from wallet signing.

Verify the operational graph:

1. Resolver can reconstruct chain state from its configured RPC.
2. Effects can load the exact live document for a minted id.
3. Effects storage produces a publicly retrievable locator.
4. Resolver publishes or redirects to that locator.
5. Token metadata exposes the resulting image/attributes.
6. A PostParam change reaches the watcher and creates the next inputs-hash render.

### SQLite maintenance for a long-running node

The self-hosted store is one SQLite file. `abx serve` already reclaims freed pages automatically in
small bounded passes between chain-watch ticks — never inline with a request, so it never adds
latency to a metadata read. Nothing to schedule for that half.

The other half is explicit and never automatic: a store created before this maintenance shipped
needs a one-time conversion.

```bash
abx vacuum                          # status: auto_vacuum mode, page count, freelist size
abx vacuum convert                  # one-time full VACUUM — only when abx vacuum says the store needs it
abx vacuum incremental [--pages n]  # one bounded reclaim pass on demand (not running abx serve? use this)
```

Run `abx vacuum convert` deliberately, not on a schedule: it rewrites the entire file and can briefly
need up to ~2x its on-disk size. Check `abx vacuum` first; if it already reports `auto_vacuum:
incremental`, there is nothing to convert.

## Use lifecycle states

Prefer status over retries. Typical nonterminal states include deployment accepted, indexing,
storage propagating, render queued/running, and remote registration pending. Typical terminal faults
include authentication/authorization failure, invalid contract/chain, interface mismatch, failed
transaction, integrity mismatch, and unsupported configuration.

Use:

```bash
abx status [address] --watch
abx status <address> --remote <name> --watch
abx storage status <locator> --json
abx verify <address> --json
```

Wait on nonterminal states using the command's watcher/backoff. Do not wrap the CLI in a second tight
poller. Do not retry terminal 4xx responses or reverted transactions unchanged. Read
[diagnose.md](diagnose.md) for the one-transition recovery model.

## Migrate without losing canonicity

Migration changes a public projection, not canonical on-chain history. Use `abx migrate` to copy and
compare resolver state without cutting over prematurely.

1. Resolve the source and destination descriptors and credentials.
2. Confirm both support the active chain and contract type.
3. Reconstruct/register the destination from chain using the deploy block.
4. Copy only off-chain operator state and published artifact locators that are not derivable from chain.
5. Verify contract metadata, representative token metadata, fields, attachments, renders, and byte
   commitments on both sides.
6. Cut over via DNS when using a stable creator domain, or change the on-chain URI pointer only after
   parity is proven.
7. Re-emit URI/refresh signals as required, then monitor the destination.
8. Keep the old service until marketplace and collector paths have converged.

Never describe resolver migration as moving the NFT. Ownership, parameters, commitments, and canonical
events remain on-chain; only the serving/indexing projection changes.
