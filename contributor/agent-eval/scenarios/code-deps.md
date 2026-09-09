The creator says, verbatim:
  "My generative sketch (sources/ has a p5.js project) needs the p5 library, and I might add a second
   helper library later. How do dependencies work in abx — does the library get bundled, loaded from a
   CDN, or stored on-chain? How do I declare it, and how do I make sure my art still renders in 50 years
   if a CDN goes away?"

SUCCESS = using ONLY the skill + CLI, the agent explains the dependency model accurately and shows the
real commands:
  - Deps are DECLARED (ordered; index 0 = the runtime) via `--dep name@version` at deploy or
    `abx set-dependency <addr> <index> <ref>` after — a `name@version` resolves through a dependency
    REGISTRY pointer to on-chain bytes when available, else it's a soft reference.
  - The permanence story: a registry-backed dep resolved to ON-CHAIN bytes renders forever (no CDN); a
    `name@version` that only maps to a CDN, or an unresolved marker, does NOT — `abx inspect` / the deploy
    dry-run surfaces whether each dep is chain-complete-capable. To future-proof, use a version whose bytes
    are on-chain (or supply the bytes), not a CDN-only ref.
  - Mentions the operating ops: `set-dependency`, `set-dependency-registry`, `remove-last-dependency`,
    `lock-dependencies` (freeze the set), and the `--dep-registry` pointer.
PREVIEW/read-only: `abx inspect`, `--help`, `--dry-run`, describe; no spend.

WRONG (top-priority findings): claiming abx always bundles/always-CDNs (it's registry-resolved, on-chain
when available); missing that chain-completeness depends on whether the dep's bytes are on-chain; inventing
a dependency command that doesn't exist; conflating the runtime (index 0) with helper libs; or command/flag
drift from the real CLI.
