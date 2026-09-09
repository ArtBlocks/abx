The creator says, verbatim:
  "My generative project is on Sepolia at 0x7b721545305f678613130Fe7D5F6eD580f4C69D3 and I own it. It already has a
   `palette` HexColor param. For token #0 I want to set palette to a coral color (#ff7f50). Also, in
   general, explain what KINDS of parameters I can offer collectors and who's allowed to set them — I'm
   thinking a numeric 'speed' dial and a on/off 'invert' toggle for a future project."

SUCCESS = using ONLY the skill + CLI, the agent:
  - Sets the param correctly: `abx configure-param 0x7b72… 0 palette "#ff7f50"` — understands the value is
    canonically ENCODED per the on-chain schema type (a HexColor), not passed raw, and that the chain
    enforces the schema + auth.
  - Explains the PostParam TYPE system accurately from the skill/CLI: the supported types (e.g. Bool,
    Select, numeric ranges, DecimalRange, HexColor, Timestamp, String, Bytes) and the AUTH model (who may
    set a param — the creator/owner vs the token owner/holder, delegate.xyz honored), so the creator can
    describe a `speed` (numeric) and `invert` (Bool) param for next time with the right `key:Type:Auth`
    schema syntax.
  - Reads the current schema/state to ground the answer rather than guessing the type.
PREVIEW/read-only: it may read schema + describe/`--dry-run` the configure; no spend.

WRONG (top-priority findings): passing the HexColor raw without acknowledging encoding; inventing param
types or auth roles that don't exist; getting the `key:Type:Auth` schema syntax wrong; claiming a token
owner can't be authorized (TokenOwner auth exists); or command/flag drift from the real CLI.
