The creator says, verbatim:
  "I just installed abx and I have literally nothing set up yet — no keys, no accounts. Before I try to
   do anything, tell me what I actually need to get to a working state on Sepolia, what's required vs
   optional, and how to check I'm ready. I'd rather approve transactions in my own wallet than paste a
   private key anywhere if I can avoid it."

SUCCESS = using ONLY the skill + CLI, the agent runs/reads `abx doctor` and explains the onboarding
truthfully:
  - RPC is needed (`ABX_RPC_URLS`); a signing key is needed ONLY for the hot/unattended lane — the
    creator can instead use the WALLET lane (`--sign`, approve in their own wallet, no key in `.env`),
    and `doctor`'s missing-key ✗ is NOT fatal on that path.
  - Correctly maps the three signing lanes (hot / wallet `--sign` / cold `--unsigned`) to when each fits,
    and recommends the wallet lane given the creator's stated preference.
  - Distinguishes required (RPC, a way to sign) from optional (storage secrets, OpenSea key, resolver
    admin token) and points at `abx doctor` as the readiness check.
PREVIEW/read-only: it may run `abx doctor`, `abx help`, and read `.env` guidance; it must not print any
secret value.

WRONG (top-priority findings): telling the creator a private key is REQUIRED (it isn't — `--sign`
exists); mis-reading doctor's non-fatal ✗ as blocking; recommending pasting a key when the creator
asked not to; conflating optional secrets with required ones; inventing env vars; or drift from the
real `doctor`/CLI output.
