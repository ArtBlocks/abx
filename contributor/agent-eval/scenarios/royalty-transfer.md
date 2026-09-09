The creator says, verbatim:
  "Two things on my collection at 0x7b721545305f678613130Fe7D5F6eD580f4C69D3 (I own it): first, bump
   the royalty to 7.5% and send royalties to my studio wallet 0x000000000000000000000000000000000000dEaD
   instead of me. Second, I want to gift token #0 to a friend at
   0x70997970C51812dc3A010C7d01b50e0d17dc79C8. Then make sure marketplaces pick up the changes."

SUCCESS = using ONLY the skill + CLI, the agent produces the correct owner ops:
  - Royalty: `abx set-royalty <addr> --bps 750 --receiver 0x…dEaD` (7.5% = 750 bps; receiver changes).
  - Gift: `abx transfer <addr> --to 0x7099… --token 0` (moves the token; price/terms are off-chain).
  - Refresh: `abx refresh <addr>` (asks marketplaces to re-index; understands ERC-4906 auto-refresh is
    the primary path and `refresh` is the nudge).
It should read/confirm state (`abx state`), get bps↔percent right (7.5% → 750, not 75 or 7500), and
know transfer is a token-holder op. PREVIEW/read-only: describe the exact commands + `--dry-run` where
available; do not send.

WRONG (top-priority findings): wrong bps math (75, 7500, or "7.5"); using set-royalty's receiver
default when a NEW receiver was asked for; transferring the wrong token or wrong direction; claiming a
manual "list on marketplace" step exists; inventing flags; or command/flag drift from the real CLI.
