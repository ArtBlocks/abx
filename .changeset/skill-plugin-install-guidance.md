---
'@artblocks/abx-cli': patch
---

The bundled skill no longer runs `abx skill install` as a routine setup step, and defers skill refreshes to the command `abx doctor` reports. A skill loaded from an agent plugin is already installed, so following the old setup steps added a second copy.
