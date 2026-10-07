# ERC-721C / ERC-1155C transfer validation

Use this reference only when the creator asks about creator-token standards, transfer validation,
royalty-enforcement compatibility, validator selection, or changing/suspending validation.

## Separate three mechanisms

- **Royalties** declare a receiver and basis points through the token's royalty interface. They do
  not force a marketplace to pay.
- **Creator-token enrollment** opts the collection into ERC-721C or ERC-1155C validation at deploy.
  Transfers consult a validator selected by the owner.
- **ABX transfer hooks** are code-project extension callbacks and may implement arbitrary project
  lifecycle rules. They are not creator-token validators.

These mechanisms can coexist and may each reject a transfer for a different reason. Diagnose the
actual contract state and revert path.

## Enrollment is deploy-time

Pass `--721c recommended|0x…` on the selected deploy command to create the creator-token variant. The
same flag chooses the ERC-1155C twin when `--copies` selects an edition. Absence creates the ordinary
ERC-721/ERC-1155 family.

Enrollment cannot be added or removed after deployment. Ask before spending:

- Does the creator actually want standards-track transfer validation?
- Which validator and security policy should govern transfers?
- Is the intended marketplace/wallet flow compatible on the target chain today?
- Who may later change or suspend the validator?
- Is the stronger restriction worth the interoperability and owner-power tradeoff?

Do not default into enrollment merely because the creator set a royalty. Do not present it as a
guarantee of payment across all marketplaces.

## Select and validate the validator

`recommended` resolves the toolkit's current recommended creator-fee validator for the active chain.
An explicit address must be a deployed validator contract that actually implements the expected
interface and rejects unsupported calls. A Safe, EOA, empty proxy, or permissive fallback is not an
enforcement policy even if it has code.

Let the CLI probe the address. Do not bypass a refusal with a raw transaction. For a custom validator,
review and test:

- transfer behavior for owner, approved operator, marketplace conduit, and ordinary recipient;
- mint and burn behavior where the standard invokes validation;
- upgrade/administration powers and who controls them;
- failure behavior when external registries are unavailable;
- ERC-721 versus ERC-1155 amount/batch semantics;
- interaction with an ABX transfer hook.

Marketplace allowlists, registry addresses, and supported flows change. Use current command output,
the validator's primary documentation, and a testnet transaction rather than a dated compatibility
table in this skill.

## Operate an enrolled collection

Read current enrollment and validator state with `abx state`. Use:

```bash
abx set-transfer-validator <address> recommended
abx set-transfer-validator <address> 0x...
abx set-transfer-validator <address> none
```

Run command help for current syntax and a dry run before writing. Setting `none` suspends the active
validator where supported; it does not convert the contract back to a plain non-C token. Enrollment
and the associated owner power remain part of the contract's permanent type.

Before changing the validator:

1. Read the current validator, owner, royalty, minter, and transfer-hook state.
2. Explain whether the change tightens, loosens, or suspends transfer policy.
3. Test representative transfers using the intended marketplace/operator on testnet.
4. Receive exact human confirmation.
5. Execute once and re-read state.

If a transfer fails, do not clear the validator as a generic repair. Determine whether the failure
comes from the creator-token validator, an ABX transfer hook, token ownership/approval, pause/mint
rules, or the receiving contract. Changing enforcement is a policy decision, not troubleshooting.

## Disclose owner powers precisely

Collectors should know:

- the collection is permanently enrolled in the creator-token variant;
- the current validator address and whether it is upgradeable;
- who can change or suspend that validator;
- whether a separate ABX transfer hook can veto transfers/mints;
- whether hook addresses are locked;
- the royalty rate, receiver, and permanent ceiling.

A locked ABX hook set does not lock the creator-token validator, and creator-token enrollment does not
freeze royalties. List each power separately.
