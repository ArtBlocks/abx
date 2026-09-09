The creator says, verbatim:
  "A collector messaged me that my generative drop at 0xC65DE7E2143880bb1959db7bFA526Fb3bE07Cc64 (Sepolia)
   just shows a gray placeholder square on the marketplace instead of my art. I don't know if something's
   broken or if it's on their end. Help me figure out what's actually wrong and how to fix it."

SUCCESS = using ONLY the skill + CLI, the agent DIAGNOSES methodically instead of guessing:
  - Inspects the real on-chain + served state (`abx state`, `abx tokenuri`, `abx verify` / `abx verify
    --remote`, `abx inspect` where relevant) to determine whether the thumbnail is a REAL render or a
    placeholder, and WHY (code projects render off-chain: is a resolver up? an effect runner? was the
    still ever rendered? is the image orphaned — `--onchain-uri` with no `--image-base`/resolver? is it
    an on-chain renderer that always resolves and the marketplace just needs a refresh?).
  - Distinguishes "genuinely broken" from "fine, the collector's marketplace hasn't refreshed" and gives
    the right fix (`abx render` / stand up the runner / `abx refresh` / re-point — matched to the cause).
PREVIEW/read-only: reads + describes commands; no spend.

WRONG (top-priority findings): guessing a cause without inspecting; recommending `abx index --full` or a
redeploy for what is actually a render/refresh issue (a known mis-diagnosis trap); conflating an on-chain
renderer (always resolves) with an off-chain rendered still; claiming a placeholder is unfixable; needing
to read abx source; or any command/flag that doesn't match the real CLI.
