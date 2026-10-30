# Durable ecosystem integrations

Use when selecting an ecosystem input for an NFT's art, metadata, or hooks. Prefer designs whose
essential output remains usable when the creator, website, SDK, and hosted API are gone. Official
tooling is valuable for authoring; being official, free, or account-free does not make a runtime
service permanent. See the public [ecosystem guide](https://docs.abx.io/docs/using-abx/guides/ecosystem-integrations).

## Rank the implementation choices

1. **Same-chain EVM reads and self-contained output.** Compute state through the appropriate
   Solidity renderer or augment hook using official contract interfaces. Keep required program,
   media, and input bytes on-chain where feasible. Reading state in the EVM avoids a per-view
   application API/RPC request; callers still need ordinary access to the chain.
2. **Captured on-chain input.** If discovery requires an API or another chain, consider storing the
   actual bounded input and relevant provenance on-chain, then render from it. State the source,
   capture time/block, trust assumptions, and loss of live updates. A hash, media URL, IPFS CID, or
   Merkle root alone does not preserve the bytes/proofs needed to render or exercise the mechanic.
3. **Optional companion experience.** Put discovery, trading links, hosted artwork embeds, and
   analytics in a separate site/app when useful. Its disappearance must not break the NFT's core
   output or lifecycle. Keep companion-app capability separate from NFT permanence claims.
4. **Essential live service only by explicit creator choice.** Do not recommend HTTP calls or
   third-party iframes inside an NFT's live view as a default integration. If the intended work
   actually requires them, explain the lifetime commitment and satisfy the exception design below.

An on-chain JavaScript program or `--onchain-uri` does not make its network fetches permanent.
Replacing an HTTP API with a hardcoded browser RPC endpoint retains a service dependency; prefer
passing state computed in the EVM into the artwork. An oracle/attestation is also a dependency:
identify its publishers, update funding, stale-data policy, and trust model before recommending it.

## Make on-chain reads resilient

- Verify chain, contract/version, official interface, and the selected field's semantics. Inspect
  upgrade/admin/pause powers and replaceability; a fixed address does not imply immutable behavior.
  Do not substitute a pool spot price for an NFT floor or current state for indexed historical volume.
- Bound external calls, gas, returndata, loops, and output. Catch expected read failures and return
  a useful, self-contained default; do not let a disappearing/reverting dependency blank the NFT.
  A view cannot persist a new last-good value: that requires a separately authorized state update.
- Prefer read-only visual effects over external-state gates unless the creator needs a gate.
  Configure/transfer hooks need deliberate failure semantics that preserve the intended rule;
  silently failing open can defeat eligibility. Test mint, transfer, burn, and parameter writes.
- Exercise absent code, reverts, malformed/large responses, zero balances/liquidity, and changed
  dependencies. Test stale oracle data if applicable. Never assume ABX catches a custom hook's revert.
- Distinguish permanence from frozen output: a robust live on-chain read can still change as the
  chain changes. A pool's current spot state and a temporary balance are not secure financial oracles.

## Required external API: lifetime commitment and recovery

Before implementation, clearly tell the creator: **this service must remain available for as long
as the NFT promises this live behavior**. Show the EVM/snapshot alternative and get an explicit
choice of the service-dependent design. API-key rotation and owner configurability reduce some
failure modes; neither guarantees that a replacement service or its data will exist forever.

Record a concrete design, rather than merely saying "configurable" or "has a fallback":

| Requirement | Decision to make and verify |
|---|---|
| Lifetime operation | Endpoint, data/schema, media, proxy, key/OAuth renewal, fees, limits, and who operates/pays for each dependency |
| Owner-controlled replacement | Which owner/admin role can change provider/endpoint and compatible response handling; distinguish collection owner from token holder, and test ownership handover |
| Recovery after locking | Identify the actual parameter/configuration or custom extension that provides updates. Verify it remains usable after planned URI/script/hook/parameter locks; do not imply ABX has a universal endpoint setter |
| Complete failure | Bounded timeouts/retries and meaningful self-contained fallback output when service, credentials, media, or network disappear; art-data service failures must not block mint/transfer |
| Data integrity | Missing, stale, or incompatible responses cannot corrupt canonical state; label captured/stale values honestly and disclose who can change them |

Keep secrets out of NFT code and public on-chain parameters. A server-side credential proxy creates
another lifetime operator dependency. Decentralized/content-addressed storage still needs a stated
availability plan for externally stored bytes; an address alone is not a permanence guarantee.

Verify by disabling the service and credentials, changing the provider through the named owner role,
and exercising the fallback after planned locks. If those requirements cannot be met, recommend the
EVM/snapshot design or keep the feature in an optional companion app.
