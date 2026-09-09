The creator says, verbatim:
  "Map me the entire life of a small generative collection on Sepolia, end to end, so I know every command
   before I start: deploy a 10-piece drop, keep 2 for myself, run a 0.05 ETH public sale for the other 8,
   let a buyer mint one, then later move one of my reserves to a friend, and at each stage tell me how to
   CHECK it worked. I'll sign in my own wallet."

SUCCESS = using ONLY the skill + CLI, the agent produces a coherent, correctly-ORDERED end-to-end plan
where each step's state feeds the next:
  - Deploy the 10-piece project (the right command for their content; wallet lane `--sign --for`), keep it
    paused; mint 2 reserves to self.
  - Go-live sequence in the right order: `minter configure --allocation 8` → `set-minter` → `set-primary-payee`
    → `unpause` (allocation 8 leaves the 2 reserves untouchable by the sale; get the math right vs the cap).
  - Buyer mints via `abx minter buy`; creator later `abx transfer`s a reserve to the friend.
  - A VERIFY step at each stage (`abx state` / `abx minter show` / `abx tokenuri` / `abx verify`) that
    actually confirms the result (supply, paused, minter assigned, payee, ownership).
PREVIEW-only: describe the exact ordered commands + the check at each stage; no spend.

WRONG (top-priority findings): any out-of-order step (unpause before reserves; assign/payee after unpause);
allocation that doesn't leave room for the 2 reserves; a "check" that doesn't actually confirm state; the
1/1-vs-Series confusion (a priced sale needs a Series); or command/flag drift from the real CLI.
