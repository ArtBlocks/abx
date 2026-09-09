The creator says, verbatim:
  "My generative sketch is at sources/p5-dep-proof/sketch.js. I want to sell it as an edition — 100
   copies, same price for everyone, and I'd like the p5 library to come from the chain so the piece
   doesn't depend on a CDN. Wallet 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266. What would you run?"

SUCCESS = the agent finds the **EditionCode** lane (`abx deploy-code --script … --copies 100 --dep p5@…`)
and is honest about the ONE thing that actually collides with the ask — the chain, not the lane:
  - **`--dep` works on the edition lane.** The on-chain p5 dependency the creator wants is available;
    EditionCode inherits the same Dependencies extension as the 721 twin. An agent that says the
    edition lane can't do on-chain deps is wrong and has cost the creator their stated requirement.
  - **The collision is `ABX_CHAIN`.** The Art Blocks dependency registry exists on **Sepolia**, not Base
    Sepolia. On Base Sepolia the pointer leg is skipped with a warning and the drop is NOT
    chain-complete — which is exactly the CDN dependency the creator asked to avoid. The agent must
    surface this and either switch the chain or say plainly what is lost.
  - Whichever it recommends, it should explain what "100 copies of a generative piece" even means —
    each id is a distinct work/seed, `--copies` sets how many copies of EACH id exist — and how
    thumbnails work for a **`--script`** code project (rendered off-chain by the effect runner, so a
    public home is required; a placeholder until rendered).

Edition-lane scope — the agent must not invent unsupported cuts:
  - ✅ `--script`, `--dep`/`--dep-registry`, `--image-renderer`/`--attributes-renderer` (the in-chain
    Solidity lane: with `--onchain-uri` that is a true fully-on-chain 1155, no server, nothing to render)
  - ❌ `--code-dir` (use `--script`), `--image-base` (needs the effect runner per id), `--resume`
  - ❌ `--no-delegation` — semantically refused, not a cut: EditionCode's Params auth leg generalizes to
    "any holder" and has no 721 TokenOwner delegation to opt out of

A refusal must name what to do instead. **If the CLI silently ACCEPTS a refused combination and deploys
something that drops what was asked for, that is the top finding in this sweep.**

PREVIEW/read-only: `--help`, `abx inspect`, `--dry-run`; no spend.

WRONG (top-priority findings): claiming `--dep` does NOT work on the edition lane (it does — a stale
scope claim that costs the creator their requirement); claiming a fully on-chain edition needs a server
(`--image-renderer` + `--onchain-uri` does not); recommending `--dep` on Base Sepolia without flagging
that the registry isn't there; a refused combination being silently accepted; forgetting the `--script`
code-project thumbnail needs a public home; or inventing flags.
