The creator says, verbatim:
  "Each of my pieces has a high-res master and a little liner-notes PDF that should travel WITH the
   token, not just sit on my website. I've already got them on IPFS. How do I attach them so a
   marketplace or an app can find them, and what URL does someone actually end up fetching?"

SUCCESS = the agent uses the **data plane**: `abx attach <addr> <key> ipfs://<cid>` (one entry per named
file → the token's `artifacts` manifest, each `{key, mimeType, uri}`), and answers the URL question
correctly:
  - what is stored on-chain is the `ipfs://` locator — content-addressed identity — and what a consumer
    fetches is that CID wrapped by the collection's `abx_gateway_ipfs` preference (public floor unless
    the project set one), the SAME projection the image field gets;
  - so moving gateways later is `abx set-gateway`, one tx, and it moves the artifacts too — no re-attach;
  - it should show how to READ the result back (the served document carries the `artifacts` manifest —
    `abx tokenuri <addr> --fetch`), rather than telling the creator to hand-build a gateway URL with curl.
It may also mention that a local file can be uploaded first with `abx storage upload <path>`, which
prints exactly the locator `attach` wants.
PREVIEW ONLY — `--dry-run` / `--unsigned`; nothing sent.

WRONG (top-priority findings): telling the creator to paste an `https://gateway…/ipfs/<cid>` URL into
`attach` when they hold the CID (that welds a host into the on-chain value); using `set-field` for this;
inventing a manifest shape or an `artifacts` flag on deploy; claiming attachments need a hosted resolver;
or hand-assembling a gateway URL with curl instead of reading the served document.
