The creator says, verbatim:
  "I updated the description and a trait on my collection yesterday, and the transaction went through, but
   OpenSea still shows the OLD description and trait. Did my change not work? How do I get the marketplace
   to show the new metadata?"

SUCCESS = using ONLY the skill + CLI, the agent diagnoses the update→display path correctly:
  - Confirms the on-chain/served state actually reflects the change (`abx state`, `abx tokenuri`, or the
    resolver's served JSON) BEFORE blaming anything — the change likely DID work; the marketplace is
    stale-cached.
  - Explains the refresh path: ABX emits ERC-4906 on URI/metadata changes so 4906-aware marketplaces
    self-refresh; `abx refresh <addr>` is the nudge (OpenSea via OPENSEA_API_KEY, else it prints the
    links to click). Marketplace caches can lag regardless — that's their side, not a broken update.
  - Distinguishes on-chain vs hosted-resolver metadata (a hosted resolver must have re-indexed;
    `abx index`/`--remote` nudge) from a genuine no-op.
PREVIEW/read-only: describe the exact commands; no spend.

WRONG (top-priority findings): declaring the update failed without checking that state actually changed;
inventing a "resubmit the transaction" step; missing `abx refresh` / ERC-4906; conflating a stale
MARKETPLACE cache with a broken on-chain write; recommending a redeploy; or command/flag drift.
