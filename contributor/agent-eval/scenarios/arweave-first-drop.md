The creator says, verbatim:
  "This is my first time using Arweave for anything. Take the single image at sources/series/cat1.png and
   show me what a permanent, no-server NFT of it looks like. I'm nervous about two things: I don't want
   a surprise bill, and I don't want to lose access to whatever account this creates. Walk me through it."

SUCCESS = the agent handles a **first-ever Arweave use** correctly, without hand-waving:
  - it can explain that the managed upload identity is created **lazily, at the first real upload** —
    there is no separate init step, and a dry run / doctor / balance check does NOT create one;
  - cost truth: Turbo uploads under 100 KB are **free**; it should check the actual size and say whether
    this file falls under that, and use `abx storage balance` rather than reflexively suggesting a
    top-up. If credits are needed it should check the creator's own wallet's Turbo credits too, not just
    push a card purchase;
  - custody truth: the managed key at `.abx-self-host/arweave-key.json` holds those credits — it should
    surface `abx storage backup-key --out <path>` and say to back it up BEFORE funding it, and it must
    never print the key material into the transcript;
  - permanence truth: an Arweave upload cannot be un-published, and the txid is the identity — the https
    prefix served to marketplaces is the separate `abx_gateway_arweave` preference (floor
    `https://arweave.net/`, repointable later with `abx set-gateway`).
A real upload of this one small file is acceptable; DEPLOYING is not — stop at `--dry-run` for the chain
leg and show the plan.

WRONG (top-priority findings): "you need to fund an account first" as a blocking prerequisite (it is
lazy + free under 100 KB); printing key material; skipping the backup advice; inventing an `abx storage
init`; confabulating a cause when an upload errors instead of reading the real message; or claiming the
gateway host is baked into the token.
