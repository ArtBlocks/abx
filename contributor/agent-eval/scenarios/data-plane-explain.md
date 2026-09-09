The creator says, verbatim:
  "People keep telling me an NFT is 'just a picture.' For my project I want the token to actually carry
   more than that — the image, sure, but also the raw source files, a hi-res version, and a short text
   README. Does abx let one NFT hold multiple named files like that? If so, how does a collector or a
   marketplace actually see and fetch them? Explain how it works, in plain terms, before I do anything."

SUCCESS = using ONLY the skill (no source), the agent explains the token DATA PLANE / `artifacts`
manifest: a token anchors named, typed artifacts, each an entry of {key, mimeType, uri}; the served
token JSON carries an `artifacts` array that is the COMPLETE listing of the token's files; the
image/animation are just reserved members of that same set; each entry is independently fetchable
(a `/data/<key>` route on a resolver, or the on-chain renderer emits the manifest). It explains you
attach one file per named field (via `set-field <key>`), and is HONEST about the split: a generic
marketplace renders the image/animation today, while a data-plane-aware consumer reads the whole
`artifacts` set — adoption grows the visibility, the token carries the files regardless.

WRONG (findings): claiming an NFT can only hold one image; inventing capabilities or flags; describing
a mechanism that contradicts the skill/CLI; conflating this with a hosted-resolver-only feature (it
works on-chain via the renderer too); or being unable to locate any data-plane explanation in the
skill at all (a finding — this is a shipped capability the skill should cover).
