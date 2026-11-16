---
'@artblocks/abx-cli': patch
---

Name the parameter and code-custody errors a code project reverts with, such as `NotParamAuthorized()`
and `ScriptIsLocked()`, and the edition-only supply errors, when explaining a failed dry run. They are
raised inside delegatecalled libraries and are not part of the token ABIs, so they used to appear as a
raw selector or a generic revert.
