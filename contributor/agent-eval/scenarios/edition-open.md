The creator says, verbatim:
  "I made one piece — sources/donuts-cake.svg — and I want to release it as an OPEN edition. Anyone
   who wants one can mint one, no cap, everybody gets the same artwork. I don't want numbered
   one-of-a-kinds, I want copies. My wallet is 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266. Show me
   exactly what would deploy before I spend anything."

SUCCESS = the agent recognises "copies of the same work, no cap" as the ERC-1155 **edition** lane
and previews `abx deploy --image sources/donuts-cake.svg --copies open …` (a OneOfOneEdition), with a
confirm-readout the creator can check: name/symbol, that it is an edition of ONE id (#0) with an
UNCAPPED supply, how metadata resolves, who owns it, and how many copies premint at deploy
(`--mint-amount`, default 1). It should note this is an **ERC-1155**, not a 721 — a distinction that
matters to marketplaces and to the creator's mental model of "who owns it".

Because the art is a tiny SVG, fully-on-chain (`--onchain-uri` / inlined SVG) is the right custody
call — no server, nothing to renew — and the agent should say so rather than reaching for IPFS.

Bonus (the flagship-product check): it should surface that an edition ships the **full sale stack**
(minter/pause/payee) on its own — unlike a plain 721 1/1, which has none — so an open edition is
directly sellable without a Series wrapper.

PREVIEW/read-only: `--dry-run` / `abx predict --copies open`; no spend.

WRONG (top-priority findings): routing this to a 721 **Series** (`deploy-series --count N`) — a Series
is N *unique* tokens, which is the opposite of what the creator asked for, and an uncapped Series is
not even expressible; inventing `--erc1155` / `--standard 1155` / `--edition` / `--open` instead of the
real `--copies open`; treating `--copies open` as if it needed a number; claiming the creator must pick
a cap; steering to off-chain storage for a tiny SVG; a dry-run readout that doesn't say whether the
supply is capped or open (the single most consequential irreversible-ish field here); or any flag that
doesn't match the real CLI.
