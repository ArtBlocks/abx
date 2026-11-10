# ABX utilities

Use when a project needs durable files, websites, shared assets, or another capability supplied by
an ABX utility. Run `abx utils --json` and `abx utils abxfs --json` for official packages and entrypoints.
Utility discovery does not install packages or execute transactions. Check the selected utility's
installed CLI help and deployment registry before composing its commands.

## ABX FS

[ABX FS](https://fs.abx.io) preserves files and directories on-chain with content addressing and
compression. Its optional project layer is itself built on ABX: a project token controls publishing,
versions and tags. An ABX collection can use FS content without becoming that FS project. Prefer the
official `@artblocks/abxfs-cli` or `@artblocks/abxfs-sdk`; consult [its docs](https://docs.fs.abx.io) for
operations, native reader interfaces, and current limits. Do not copy its upload, compression, CID,
pinning, or gateway implementation into an ABX project.

Consider FS for a static dapp or collector website, project/NFT assets, documentation, and archives.
It serves static files; a live database, secret, payment processor, or mutable API still needs its
own deliberate design. A content hash alone does not preserve the bytes stored elsewhere.

Choose from the creator's reliability and mutability needs:

- For suitable small self-contained media or HTML, use the FS tooling's Auto preview to select
  embedded presentation. Confirm the decoded animation works without fetching project assets.
  JavaScript dependency scanning is a heuristic; inspect actual runtime requests as well.
- For a normal multi-file site or larger content, the chain gateway is the simple default. The
  bytes remain on-chain; the HTTP endpoint remains a delivery dependency. Keep it replaceable.
- Use IPFS presentation only when the creator chooses to maintain pins or pay a provider. A CID
  identifies content; it does not keep it pinned or make a public gateway reliable. Check the
  selected pin and retrieval path before making it the primary experience.

A data URI is one resource, without a directory origin for sibling assets. Existing build tools
can produce self-contained HTML; do not prescribe a new bundler or a special output-folder name.
Browser execution is still off-chain even when every required byte comes from an on-chain read.

New presentation-capable orgs can change delivery and independently lock displayed content,
the delivery method, or gateway endpoints. A content lock fixes a concrete root and entrypoint,
not a mutable tag name; publishing history can continue. Fixed content with replaceable delivery
is often the useful guarantee. Inspect the actual generation, exact lock preview, owner authority,
and remaining dependencies. Existing orgs retain their original renderer; installing newer tooling
does not upgrade their NFTs. Never freeze a provider-controlled endpoint as a default permanence step.

FS has its own chain selection and signer configuration. ABX's `ABX_CHAIN`, `--sign`, and
`--embedded` are not automatically FS settings. Resolve older orgs through their own generation;
use current-generation defaults for new projects. Verify that the installed utility and selected
network actually expose the requested reader/presentation capability.

Use existing ABX metadata/link/attachment fields or the official fixed-source reader adapter to
connect content. Verify each collector-facing surface separately: a link does not automatically
make attachments enumerable, provide marketplace stills, or replace an ABX resolver. For the adapter,
follow the released FS interface and ABX's `reader` representation rather than writing another reader.
