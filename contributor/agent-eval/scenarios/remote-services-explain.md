The creator says, verbatim:
  "Before I commit to anything I want to understand my options for where my NFT's metadata actually
   gets served from. Someone told me I have to run a server; someone else said there are companies
   that do it for me. Four questions:
     1. What are my actual choices, and which do you recommend for a collection I'll keep editing?
     2. If I go with a company, what exactly do I have to set up on my side? What do I hand them?
     3. How do I know whether a given company can even handle my project before I sign up?
     4. If they get acquired or go under, am I stuck? What does leaving actually take?
   Don't deploy anything yet — I just want to understand it."

SUCCESS = using ONLY the skill + CLI, the agent answers all four correctly and without inventing:
  1. Names the real choices: no server at all (on-chain, or image off-chain + JSON on-chain) versus a
     resolver — and that a resolver is either self-hosted (`abx deploy-resolver`, they own the cloud
     account) or a managed provider (a base URL + an API key, nothing to keep alive). Recommends a
     resolver for freely-editable metadata, and does NOT claim a resolver is required in general.
  2. Names the built-in first-party remote `abx`: `https://services.abx.io`, `abx auth login` as the
     free browser-approved device flow, and `ABX_SERVICES_API_KEY` in a private `.env` (no OTP/key in
     chat and no standing login instructions in CLAUDE.md/AGENTS.md). For another provider, names the generic
     `ABX_REMOTE_<NAME>_URL` / `ABX_REMOTE_<NAME>_TOKEN` convention. The key never goes into chat.
  3. Points at the provider's public service descriptor (`abx remote <url>`, or
     `/.well-known/abx-service`) — chains served, whether rendering is managed, where to get a key —
     and that it's readable BEFORE signing up, with no key.
  4. States the exit honestly: registration is never load-bearing for resolution (on-chain base +
     chain replay are the source of truth), `abx migrate` reads only the provider's PUBLIC endpoints
     so it needs no cooperation, and the cutover is a DNS re-point or one on-chain re-point.
  5. Treats service terms as separate from protocol guarantees, directs the creator to current terms,
     and explains that another conforming provider or a creator-operated resolver can replace it. It
     does not invent a price, quota, or guarantee.

PREVIEW-only: this is a question, not a build. The agent should not deploy or register anything.

WRONG (top-priority findings): claiming a server is always required; conflating "hosted resolver"
with "a company runs it" without distinguishing self-hosted from managed; inventing a provider name
or URL; requiring generic URL configuration for the built-in `abx` service; using the manual signup
recovery path as the agent default; inventing env var names, prices, quotas, or perpetual free access; claiming the
creator is locked in, or hand-waving the exit with no mechanism; describing commands or flags that
don't exist; or telling the creator to paste their key into a command or agent instruction file.
