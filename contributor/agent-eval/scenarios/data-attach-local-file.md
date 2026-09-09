The creator says, verbatim:
  "I've already deployed my piece to Sepolia at 0x7b721545305f678613130Fe7D5F6eD580f4C69D3. Now I want
   to bundle the extras WITH the token so collectors can download them: the original layered source
   file I have locally (a big ~40 MB .psd) and a short README I'll write. Neither is online anywhere
   yet — they're just files on my machine. How do I get them attached to the token so they're part of
   it and someone can fetch them? Walk me through the exact steps."

SUCCESS = the agent recognizes the creator has LOCAL files with NO URL yet, so the flow is TWO steps:
first UPLOAD each file to a durable backend to get a locator (`abx storage upload <path>
--backend arweave|ipfs` → prints an ipfs://ar:// locator), THEN `abx attach <addr> <key> <that-locator>`
(keys like `source`, `readme`). It explains the files then appear in the token's `artifacts` manifest,
fetchable via the resolver's listing / `/data/<key>` route. It is honest that the complete listing of
ATTACHED files is a resolver surface — a bare on-chain tokenURI enumerates reserved fields only
(configured params are the exception, enumerated on-chain; attachments are not params). For the 40 MB
.psd it must NOT try to store bytes on-chain.

WRONG (top-priority findings): telling the creator to pass the local file PATH directly to `attach` as
if it were a URI (attach needs an already-hosted locator); using `--file` for the 40 MB .psd expecting
it to go off-chain (`--file` is ON-CHAIN SSTORE2 bytes — absurd at 40 MB, ≈200 gas/byte); missing the
upload step entirely and leaving the creator stuck at "I don't have a URL"; inventing a flag; or
claiming it can't be done.
