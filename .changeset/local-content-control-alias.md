---
"@artblocks/abx-sdk": patch
---

Keep the localhost root available as a local resolver control-plane alias when collection content
uses localhost subdomains. Default effects-runner transport can still discover projects and state;
collection subdomains continue to reject control routes, and production content roots stay restricted.
