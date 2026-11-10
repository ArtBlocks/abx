# Project ideation

Start with what the object means and does, who participates, and why they would care. Explore its
data, changing state, participant roles, rules, and relationships with other systems before choosing
its appearance or deployment family. Artwork is one possibility; follow the creator's intent.

For example, consider a shared resource with contribution rules, a record of provenance or claims,
a liquidity position with community-defined interactions, or a charter connected to an externally
launched ERC-20. An object can represent rights or a financial instrument, but real-world rights,
custody, and enforcement need their own design. These are starting points, not a checklist or
promises of ready-made ABX features. Explore beyond them and beyond the documented protocols.

Think in actions as well as data: a governed parameter edit or token transfer can trigger custom
on-chain logic to swap through an AMM, create another asset, or settle an obligation. Configure and
transfer hooks can make contract calls using explicitly arranged funding and authority; augment
hooks only derive data during reads. These actions need not serve a visual outcome.

Discuss the core interaction and value in plain language. Consider what changes, who may change it,
and what happens when a participant or dependency disappears. On-chain, off-chain, and hybrid
designs are all possible; choose deliberately for the intended lifespan, trust, and behavior.
Durability need not mean frozen state. Use [ecosystem.md](ecosystem.md) for relevant integrations,
favoring official third-party tools rather than rebuilding them.

Consider [ABX FS](utilities.md) when preserved files, a project archive, or a static companion site
serve the idea. Its compression, versions, and owner-controlled publishing can remove custom storage work.

Keep exploration separate from implementation. Research and compare concepts until the creator
chooses a direction and asks to implement it; do not start code, create repositories or cloud
resources, or deploy during ideation. Future launch intent or available accounts and wallets do
not select an idea. An explicit request to implement a chosen concept already establishes that
direction; do not ask for it again. Resolve technical feasibility through
[capabilities.md](capabilities.md) before making implementation promises.
