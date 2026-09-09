The creator says, verbatim:
  "I have one piece of art at sources/donuts-cake.svg and I want the whole journey mapped out: get it
   onto Sepolia as a single 1/1, minted to me, and then put it up for sale at 0.1 ETH. I'll approve
   transactions in my own wallet (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266). Show me the exact
   ordered commands end to end before I spend anything."

SUCCESS = using ONLY the skill + CLI, the agent maps the full 1/1 lifecycle with the WALLET lane:
  - Deploy: `abx deploy --image sources/donuts-cake.svg --name … --symbol … [--onchain-image --compress
    fastlz] --sign --for 0xf39F…` — it should note an SVG this small is a great fully-on-chain candidate
    (no server, renders forever) and that `--for` pins the owner on the wallet lane.
  - Mint: whether deploy mints #0 (express) or defers (`--no-mint` then `abx mint`) — for a self-mint,
    minting at deploy is fine; explain the choice.
  - Sell: the fixed-price go-live — `abx minter configure <addr> --price 0.1 --allocation 1` →
    `set-minter` → `set-primary-payee` → `unpause` (a 1/1 is supply 1, so allocation 1).
  - Use `abx predict`/`--dry-run` to preview the address + plan, and pin the salt if quoting an address.
PREVIEW-only: describe the exact ordered commands; do not send.

WRONG (top-priority findings): recommending off-chain storage / a resolver for a tiny SVG (fully
on-chain is the right call, no server); dropping `--for` on the wallet lane; quoting a predicted
address without pinning the salt; a broken/dropped step in the sell sequence (see sell-fixed-price);
inventing flags; or command/flag drift from the real CLI.
