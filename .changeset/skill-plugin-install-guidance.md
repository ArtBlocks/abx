---
'@artblocks/abx-cli': patch
---

The bundled skill no longer runs `abx skill install` as a routine setup step, and defers skill refreshes to the command `abx doctor` reports. A skill loaded from an agent plugin is already installed, so following the old setup steps added a second copy. When the CLI itself is missing, the skill now names `@artblocks/abx-cli` as the package to install, never the unrelated unscoped `abx` package.

`abx doctor` and the update notice now detect a skill served by a Claude Code plugin, including one added from Anthropic's directory on claude.ai and synced to Claude Code. They no longer report it as missing or offer `abx skill install` for it. A stale marketplace plugin copy gets `claude plugin update <plugin>` only when that id is one shell-safe token; any other registry key or manifest name is omitted. A stale synced copy is refreshed by restarting Claude Code, and that instruction stays separate prose rather than part of the command. A standalone copy alongside the plugin is flagged as a duplicate.
