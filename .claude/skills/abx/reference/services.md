# First-party services and feedback

Use this reference for the public ABX service, API-key login, hosted resolver/rendering, or feedback.
For provider-independent hosting and migration, also read [hosting.md](hosting.md).

## Contents

- [First-party service](#first-party-service)
- [Creator RPC](#creator-rpc)
- [Creator wallet and sponsorship](#creator-wallet-and-sponsorship)
- [Feedback targets](#feedback-targets)

## First-party service

The documented endpoints are:

- documentation: `https://docs.abx.io`
- service catalog, account, and control: `https://services.abx.io`
- public token data: `https://resolver.abx.io` (discover it from the catalog; do not hardcode it)
- OAuth discovery: `https://services.abx.io/.well-known/oauth-authorization-server`
- manual signup fallback: `https://services.abx.io/signup`

The first-party provider has the built-in remote name `abx`:

```bash
abx remote abx
```

It needs `ABX_SERVICES_API_KEY` in the project's ignored `.env`; it does not need
`ABX_REMOTE_ABX_URL`. When the key is absent, use:

```bash
abx auth login
```

The CLI starts the OAuth device flow and shows a verified browser URL plus a matching short code.
The human signs in with the ABX account email and approves in that browser. An existing browser
session avoids another email code. The same approval provisions or reuses the account's creator
wallet. The CLI polls at the provider-declared interval, receives the API key, and writes it directly
to ignored `.env` without printing it. The browser never receives the key. Do not ask the human to
paste an OTP or key into chat. A new first-party key requires the human to accept the current Art
Blocks User Terms in the browser; do not accept them on the human's behalf. Existing keys do not
require re-acceptance. `--no-open` leaves the browser handoff as a link; `--force` is required
to replace an existing local credential, but does not revoke the displaced provider key. For normal rotation,
run `abx auth logout` and then `abx auth login`; reserve `--force` for recovery. The CLI refuses
tracked or unignored `.env` files.

The issued API key is long-lived and remains valid until it is revoked. Reuse the stored key across
tasks and agent sessions; do not start a new login merely because a task or conversation ended. If
`abx remote abx` authenticates successfully, no login is needed. `abx auth login` also detects an
already loaded credential and reuses it instead of issuing another.

In an agent runner, start `abx auth login --no-open` with a short initial yield or a resumable
background session. Relay the printed URL and code immediately while that same process keeps polling,
then resume it after human approval. Do not start another login or add an outer retry loop. If the
runner cannot yield control while a command waits, ask the human to run the command in their terminal.

Logout only for intentional teardown, suspected compromise, deliberate rotation, or to free an
active-key slot. When revoking, do not only delete the local value:

```bash
abx auth logout          # first-party service
abx auth logout <name>   # another OAuth-capable named remote
```

Logout discovers the provider's RFC 7009 endpoint, revokes the current key, and only then removes the
matching `.env` assignment. If the key came from a shell or another environment source, the CLI
revokes it and tells the human where it still needs to be unset. A repeated logout with no active
local credential is safe.

An account may have up to five active keys. The service stores hashes, so it can list key metadata
but cannot recover a lost secret. Use `abx auth keys` to inspect active keys and
`abx auth revoke-key <key-id>` to revoke an unused non-current key. Use `abx auth logout` for the
current key. Only create another key when a separate environment actually needs its own credential.

Use `/signup` only as the manual recovery path. It shows the raw key once, so the human—not the
agent—must place it in `.env`. An already verified email reuses its account and may receive another
key, subject to the same limit.

Availability, pricing, and quotas are service policy rather than protocol guarantees. Confirm current
terms before making a durable hosting choice and keep the exit route explicit: the same remote-service
contract supports another provider or a creator-operated resolver/effects deployment.

Before depending on hosted behavior, inspect the live descriptor with `abx remote abx`; do not infer
capabilities from this file. A remote is a provider catalog and may advertise different HTTPS
origins for token resolution, control, account operations, and creator wallets. Trust the advertised
interface endpoint, not a guessed hostname. Use `--remote abx` on commands that accept a managed
resolver and verify the resulting public surfaces as described in [hosting.md](hosting.md).

## Creator RPC

When `ABX_SERVICES_API_KEY` is present and the creator has not set `ABX_RPC_URLS_<CHAIN>` or
`ABX_RPC_URLS`, the CLI selects the built-in `abx` remote as its default creator-RPC provider. It
uses the endpoint only when the remote's public descriptor advertises `abx-creator-rpc/v1`, bearer
authentication, a route template, and the active chain. The shipped public endpoints remain
failovers. The bearer key is sent only to the exact advertised endpoint and is never placed in its
URL.

This is provider-neutral discovery. `ABX_RPC_REMOTE=<name-or-url>` selects another compatible
catalog; a named remote uses its matching `ABX_REMOTE_<NAME>_TOKEN`, while a catalog URL uses
`ABX_REMOTE_SELF_TOKEN`. If discovery fails or the interface does not cover the active chain, ABX
never guesses a route and keeps the public fallbacks. Inspect `abx remote <name-or-url>` for the
live advertisement and current service policy; quotas and availability are not protocol
guarantees.

This endpoint exists for private creator workflows such as deploying, verifying, and checking
project state. **Never publish the endpoint or API key, embed either in browser code, or use it as a
project website's RPC.** A public application must use its own account with Alchemy, QuickNode,
Infura, or an equivalent provider. Excessive traffic or public-site use may result in suspension of
the API key or account. A creator can always opt out by setting their own `ABX_RPC_URLS_<CHAIN>` or
`ABX_RPC_URLS`; that explicit choice wins outright.

## Creator wallet and sponsorship

An account with a verified email has one persistent creator wallet. Its API key cannot sign.
`--embedded` discovers `abx-creator-wallet/v1` and reuses that wallet. `--sponsor` is a legacy alias
for this same automatic lane. Use `abx auth wallet` to provision/show the address before a dry run.

The default payment policy is automatic: when the provider advertises self-payment on the active
network and the wallet can cover native transaction value plus quoted fees, it pays its own gas.
Otherwise, eligible zero-value calls use sponsorship. Non-zero native value always requires enough
funds for value plus fees. Balances belong to each network; never infer funding from another chain
or from ERC-20 balances. Older providers retain sponsored-only behavior until they advertise self-payment.

One Privy agent grant authorizes wallet use, including transfers and gas spending. The CLI stores
its rotating grant in the OS credential store for up to 30 days unless revoked. Do not ask for a
separate grant when payment changes, or another browser approval when a grant is reusable. Manage
or revoke grants at `https://services.abx.io/authorize`. Review exact actions before sending; an agent
grant is not a per-transaction human approval.

Before sending, inspect live descriptor/account capabilities, run command help and a JSON dry run,
and summarize the active chain, creator-wallet address, native value, transaction group, estimated
fees and permanent choices. Honor an explicit bring-your-own signer choice. Repeat production risks
and prove the same flow on the paired testnet before production.

The CLI independently checks the service-returned payload against its local intent, including the
wallet, chain, recipient, calldata, value, gas limit, payer and native fee ceilings. A mismatch must
stop before signing. Fees on Base include estimated L1/operator charges in the funding reserve;
these rollup fees can change. The chosen payer and fee bounds are shown before submission.

Receipt-dependent staged content uses the same wallet serially, quoting each transaction before it
is prepared. `deploy-contract` routes exact creation bytecode through the keyless CREATE2 proxy;
pass ownership explicitly because the constructor caller is the proxy. ABX does not compile or audit it.

Once prepared, payment mode and fee ceilings cannot change. Never retry an uncertain result or
switch payers after submission. Preserve the operation ID and use `abx auth operation <operation-id>`
for read-only reconciliation. A provider-confirmed transaction remains submitted even if another
RPC cannot find its receipt; inspect the hash rather than replaying it.

`--send`, `--sign`, and `--unsigned` remain first-class alternatives. Funding cannot bypass a disabled
wallet, revoked authorization, unsupported network or provider policy. Sponsorship eligibility is
separate from network/protocol support and wallet self-payment.

## Feedback targets

`abx feedback` has two deliberately separate targets:

| Intent | Command | Recipient |
|---|---|---|
| ABX protocol, contracts, CLI, SDK, skill, or docs | `abx feedback` | core ABX team |
| A remote provider's resolver, rendering, auth, or operations | `abx feedback --remote <name>` | that provider |

For first-party hosted-service feedback use `--remote abx`. A third-party remote can advertise the
optional `abx-service-feedback/v1` interface and operate its own feedback store. Never send
provider-specific incidents through core feedback merely because both first-party targets currently
share infrastructure.

Discovery and report previews are public. Submission (`--yes`) and `--mine` require the same key
created by `abx auth login`; login once rather than creating a separate feedback credential. Run the
command without report flags to inspect its live schema and instructions. To report, provide the
required structured flags; use `--detail-file` or `--context-file` rather than fragile shell quoting
for longer content. The CLI shows the exact destination and payload first. Review and redact the
preview with the human, then repeat with `--yes` only after explicit approval.

```bash
# Preview core feedback; nothing is sent.
abx feedback --area cli --kind bug --summary "Concise summary" --detail-file report.md

# After the human approves this exact preview.
abx feedback --area cli --kind bug --summary "Concise summary" --detail-file report.md --yes

# Provider-specific preview.
abx feedback --remote abx --component rendering --kind bug --summary "Concise summary"

# Review reports previously submitted with the current key.
abx feedback --mine
abx feedback --remote abx --mine
```

Do not attach `.env`, credentials, wallet/session URLs, full transcripts, or unrelated source files.
Prefer the smallest reproduction and relevant version/chain/address context. The API key authenticates
the reporter; hosted-service entitlement is evaluated separately. It never grants transaction-signing
authority.

Use the CLI instead of hand-written HTTP or retry loops. The device flow already handles pending,
slow-down, and transient polling responses until its fixed expiry. Treat `401` as missing/invalid credentials,
`403` as recognized credentials without the required entitlement, and schema/interface errors as a
request or provider-contract mismatch. Read [diagnose.md](diagnose.md) and make one state transition.
