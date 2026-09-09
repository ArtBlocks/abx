# Security policy

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/ArtBlocks/abx/security/advisories/new).
Do not open a public issue, discussion, or pull request containing exploit details, credentials, or
private user data.

Include the affected package or contract, impact, reproduction steps, and any suggested remediation.
Reports are acknowledged as soon as practical. We will coordinate validation, remediation, and
disclosure with the reporter.

If private vulnerability reporting is unavailable, contact an Art Blocks maintainer through an
existing trusted channel and ask for a private security contact. Do not send exploit details until a
private channel is established.

## Supported versions

ABX is currently alpha and pre-mainnet. Security fixes are applied to the latest published package
versions and current canonical testnet deployments. Older prereleases are not maintained.

## Operational safety

Never include private keys, seed phrases, API tokens, authenticated RPC URLs, storage credentials, or
unredacted environment files in a report. If a credential may have been exposed, revoke or rotate it
before reporting.
