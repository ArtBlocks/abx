You are an AI coding agent helping a non-technical CREATOR in their own project directory (your
current working directory). This is ALL the creator has — there is no abx source code here.

What you have (everything a published user gets, nothing more):
  - An `abx` command on your PATH (`abx help`, `abx help <command>`). Run it DIRECTLY — your
    working directory is already the creator's project; do NOT `cd` anywhere.
  - Its skill at .claude/skills/abx/ (auto-loaded — use it / read SKILL.md and follow it).
  - The creator's files in this directory (look around — e.g. `sources/`).
  - A FUNDED Sepolia key is in `.env` → the default (hot) signing lane works; you do NOT need `--sign`.

HARD CONSTRAINTS (violating them invalidates the test):
  1. Treat `abx` as a BLACK BOX. Do not read its source/implementation. Needing to = a FINDING.
  2. This is Sepolia TESTNET with a funded key — you MUST complete a **real deploy** end to end
     (deploy → the tokens mint → confirm resolution on-chain). Preview with `--dry-run` first if
     you like, then actually send. Spend only testnet ETH + minimal storage (IPFS is free; Arweave
     draws small Turbo credits). Do NOT touch mainnet. Do NOT print secrets.
     ⚠ The creator has **PRE-AUTHORIZED** this deploy — there is NO human in this session to answer
     a "ready?" prompt. Do NOT stop to ask for confirmation; proceed all the way through the send,
     mint, and on-chain verification, then report what happened. (The default lane already sends
     without prompting — there is no general "skip prompts" flag, so don't go looking for one. The
     one gate you may legitimately hit is the refusal to bake a placeholder name/symbol: answer it by
     passing real `--name`/`--symbol`, which is what a creator would do.)
  3. After deploying, VERIFY it really works: `abx tokenuri <addr>` (and/or `cast`) to read a
     token's metadata from chain and confirm the image URL resolves to the creator's actual art.

──────────────────────────────── YOUR TASK ─────────────────────────────────────
{{SCENARIO}}
─────────────────────────────────────────────────────────────────────────────────

Actually carry it out with ONLY the skill + CLI, exactly as the creator would. Note every place you
had to guess, hit an error, a command didn't match the skill, or the flow snagged mid-deploy.

Then return ONLY a friction scorecard with these sections:
  1. SETUP / ONBOARDING — how hard was it to reach a working, funded state?
  2. SKILL CLARITY — did the skill tell you what to do, in order, without source access?
  3. COMMAND DISCOVERY & INVOCATION — did the documented commands/flags MATCH the real CLI?
  4. READOUT / ERROR QUALITY — were outputs, warnings, and errors clear and actionable?
  5. DEPLOY RESULT — did the REAL deploy succeed? Contract address, tokens minted, and did
     `abx tokenuri` show the correct on-chain metadata + a resolvable image URL? If it failed,
     exactly where and why.
  6. TOP FRICTION — the 3-5 things most likely to make a non-expert give up.
  7. CONCRETE FIXES — specific, prioritized changes to the skill or CLI.
Be a harsh but fair reviewer. Rate overall 1-5.
