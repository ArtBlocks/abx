---
"@artblocks/abx-cli": patch
---

Explain OS credential-store access before restoring a creator-wallet grant. Stop after denied or
failed credential reads instead of automatically starting another browser authorization flow.
Keep reusable grants in the OS credential store and document macOS Keychain prompts.
