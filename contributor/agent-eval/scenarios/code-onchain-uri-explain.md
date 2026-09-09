The creator says, verbatim:
  "Everyone talks about 'fully on-chain' generative art and I want to know if this tool does it, in
   plain English, using only your guide — don't deploy anything. Answer me four things: (1) Can I make my
   generative NFT fully on-chain with this tool, and how — is it one flag? (2) What does 'chain-complete'
   actually MEAN, and what could silently break it so I THINK I'm fully on-chain but I'm not? (3) When
   would I NOT be able to go fully on-chain, and what's the fallback? (4) Is the marketplace thumbnail
   also on-chain, or is that a separate thing I have to handle? If a command has a `--help`, quote the
   relevant line. And be honest: tell me which of these the guide leaves unclear."

SUCCESS = using ONLY the skill + `abx <command> --help` (treat abx as a black box — NO source, NO
deploy, NO spend of any kind), the agent answers all four correctly and cites where in the skill/help it
found each:
  1. Identifies the fully-on-chain lane as a single flag on the code-deploy command, and that this lane
     does NOT need a public resolver base URL (the tokenURI is served from the chain).
  2. Explains "chain-complete" = the tokenURI and its animation/document come back entirely from on-chain
     bytes, with no server, gateway, or CDN in the graph — AND names the silent breaker: a dependency
     that resolves only to a CDN (not on-chain) puts a URL back in the graph, so the drop is no longer
     fully on-chain even though it "deployed." The dependency's on-chain availability is the hinge.
  3. Names the fallback when fully-on-chain isn't possible: the off-chain resolver lane / directory-build
     mode (resolver- or gateway-served), and notes the directory param-delivery size budget (~8KB via the
     URL) as a real constraint.
  4. Correctly separates the thumbnail: the `image` / marketplace still is produced by the effects runner,
     NOT the on-chain tokenURI — `abx verify` flags it as a placeholder until a render exists. "Fully
     on-chain" here means the tokenURI + animation, not the static thumbnail.
  - For each of the four, says whether the guide answered it cleanly or left a gap, quoting the exact skill
    text / `--help` line used.

WRONG / findings: the model can't locate the fully-on-chain lane from the skill; conflates "chain-complete"
with merely "deployed on a blockchain"; misses that a CDN-only dependency silently breaks it; claims the
thumbnail is also on-chain; can't name a fallback; or the skill genuinely has no discoverable answer for
one of the four (that's the most valuable finding). This is a READ-ONLY comprehension task: no deploy, no
mint, no transaction, no spend — `abx ... --help` and reading the skill only. Never print secrets.
