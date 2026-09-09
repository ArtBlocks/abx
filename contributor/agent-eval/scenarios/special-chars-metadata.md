The creator says, verbatim:
  "My piece is titled  Bob's "Café" & Friends <3  — yes, with the apostrophe, the quotes, the ampersand,
   the accented é, and a little emoji 🎨 — and the description is a full paragraph with line breaks and a
   quote in it. I want that EXACT text as the on-chain name and description of my 1/1 (sources/donuts-cake.svg
   is the art). Show me what would deploy and reassure me the metadata won't break."

SUCCESS = using ONLY the skill + CLI, the agent handles the special characters correctly:
  - Constructs the deploy command quoting the name/description properly for the shell (the literal text
    survives into the flag values — apostrophe, double-quotes, &, é, emoji, line breaks).
  - Runs a `--dry-run` and reads back the readout to confirm the exact text is captured (not truncated at
    the quote, not mangled).
  - Is confident/correct that the served metadata JSON stays VALID — the toolkit escapes the values so
    `"`/`<`/`&`/unicode don't break the JSON (this is a toolkit guarantee, not something the creator
    hand-escapes). It should NOT tell the creator to strip or avoid the characters.
PREVIEW-only: dry-run + describe; no spend.

WRONG (top-priority findings): telling the creator to remove/avoid the quotes/emoji/ampersand; a command
where the shell/flag parsing truncates the name at the first quote; claiming the characters will break the
NFT or the JSON; producing metadata that would be invalid JSON (unescaped `"`/control chars); or advising a
workaround the toolkit makes unnecessary.
