---
'@artblocks/abx-token-api': patch
---

Drop-in for everyone; only non-canonical token URLs change.

Token routes only answer for a token's canonical decimal id. `/t/…/01`, `/t/…/0x1` and `/t/…/+1`
used to be accepted as in-range ids and answered `{"minted": false}`, even when token 1 was minted.
They now return `404 not_registered`, the same as any other id outside the supply cap.
