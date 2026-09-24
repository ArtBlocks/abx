# First-party services and feedback

Use this reference for the public ABX service, API-key login, hosted resolver/rendering, or feedback.
For provider-independent hosting and migration, also read [hosting.md](hosting.md).

## Contents

- [First-party service](#first-party-service)
- [Creator wallet and sponsorship](#creator-wallet-and-sponsorship)
- [Feedback targets](#feedback-targets)

## First-party service

The documented endpoints are:

- documentation: `https://docs.abx.io`
- service: `https://services.abx.io`
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
The human completes name, email, one-time-code verification, and approval in that browser. The CLI
polls at the provider-declared interval, receives the API key, and writes it directly to ignored
`.env` without printing it. The browser never receives the key. Do not ask the human to paste an OTP
or key into chat. `--no-open` leaves the browser handoff as a link; `--force` is required to replace
an existing local credential, but does not revoke the displaced provider key. For normal rotation,
run `abx auth logout` and then `abx auth login`; reserve `--force` for recovery. The CLI refuses
tracked or unignored `.env` files.

The issued API key is long-lived and remains valid until it is revoked. Reuse the stored key across
tasks and agent sessions; do not start a new login merely because a task or conversation ended. If
`abx remote abx` authenticates successfully, no login is needed.

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

Use `/signup` only as the manual recovery path. It shows the raw key once, so the human—not the
agent—must place it in `.env`. An already verified email reuses its account and may receive another
key, subject to the service's active-key limit. `abx auth logout` revokes an unused current key and
frees its active-key slot.

Availability, pricing, and quotas are service policy rather than protocol guarantees. Confirm current
terms before making a durable hosting choice and keep the exit route explicit: the same remote-service
contract supports another provider or a creator-operated resolver/effects deployment.

Before depending on hosted behavior, inspect the live descriptor with `abx remote abx`; do not infer
capabilities from this file. A remote is a provider catalog and may advertise different HTTPS
origins for token resolution, account operations, and creator wallets. Trust the advertised
interface endpoint, not a guessed hostname. Use `--remote abx` on commands that accept a managed
resolver and verify the resulting public surfaces as described in [hosting.md](hosting.md).

## Creator wallet and sponsorship

An account with a verified email can use one persistent ABX creator wallet. The
`ABX_SERVICES_API_KEY` identifies the account but cannot sign. `--sponsor` discovers the provider's
`abx-creator-wallet/v1` endpoint, provisions or reuses the wallet, starts a Privy device authorization,
and asks the human to match one code before an agent may
sign the exact transaction group. Tokens and signing material stay in memory for that command and
are discarded afterward.

This is a beta on Base Sepolia and, when explicitly advertised, Base mainnet. Treat the live
descriptor and account capabilities as the authority: documentation describes the lane, but does
not guarantee that sponsorship is active for a particular account, chain, or moment. When the
creator has not selected another signer, prefer this lane for an eligible Base Sepolia operation.
On Base mainnet, recommend it only after the exact flow succeeds on Base Sepolia and repeat the
production-network warning before confirmation. Before using it:

1. run `abx auth login` if the account has no API key;
2. inspect `abx capabilities --json` and the command help;
3. run the same command with `--dry-run --json`;
4. summarize the network, creator-wallet address, transaction group, zero value, permanent choices,
   and beta status;
5. after approval, repeat with `--sponsor`.

The initial lane accepts zero-value factory/contract calls up to the live network and provider
policy. ABX does not impose an additional per-transaction gas ceiling. It does not support direct
CREATE or staged `--onchain-image` writes. Never add retries around a sponsored write. An `unknown`
outcome means the provider may have submitted it: preserve the operation ID and reconcile status
before any new send.

Sponsorship is optional service policy, not protocol support. `--send`, `--sign`, and `--unsigned`
remain first-class bring-your-own alternatives. Honor an explicit choice of any of them. If the
provider does not advertise the chain, the account is ineligible, or the transaction group exceeds
policy, select one of those lanes rather than refusing the underlying operation. Do not use
sponsorship on a production network unless the live descriptor, account capabilities, and command
all explicitly support it. Never infer Base mainnet eligibility merely because the CLI recognizes
the lane.

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
