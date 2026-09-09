# Legacy Solidity source pointers

Current public documentation lives in `site/content/docs/`; contributor test material lives in
`contributor/`. This directory remains only because deployed Solidity source comments cite two paths
under it. Changing those comments would change compiler metadata and CREATE2 creation bytecode without
changing runtime behavior.

- `10-backlog.md` preserves the historical B22 label used in source comments.
- `research/onchain-generator-internals.md` points to the maintained generator documentation.

Do not add new documentation here.
