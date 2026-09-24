---
'@artblocks/abx-cli': patch
---

Remove ABX's artificial 3,000,000-gas ceiling from sponsored transactions. Sponsored calls now use
the network estimate and remain subject to the active chain and provider sponsorship policy.
