---
'@artblocks/abx-cli': patch
---

The bundled skill no longer runs `abx skill install` as a routine setup step, and defers skill refreshes to the command `abx doctor` reports. A skill loaded from an agent plugin is already installed, so following the old setup steps added a second copy.

`abx doctor` and the update notice now detect a skill served by a Claude Code plugin. They no longer report it as missing or offer `abx skill install` for it; a stale plugin copy gets `claude plugin update <plugin>`, and a standalone copy alongside the plugin is flagged as a duplicate.
