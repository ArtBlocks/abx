---
'@artblocks/abx-cli': patch
'@artblocks/abx-sdk': patch
---

Breaking only for SDK callers that directly prepared an unsupported sponsored `to: null` request;
drop-in for existing hot, wallet, and unsigned deployments. Route sponsored custom-contract
deployments through ABX's existing keyless CREATE2 proxy, expose the exact signer-bound salt and
predicted address, verify code after confirmation, and document the proxy constructor-caller boundary.
