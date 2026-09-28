---
'@artblocks/abx-cli': patch
'@artblocks/abx-sdk': patch
---

Preserve `maxInvocations` as an exact uint256 value instead of narrowing it through a JavaScript
number. Reuse an existing hosted-service credential on login and add self-service API-key listing
and revocation for accounts at their active-key limit.
