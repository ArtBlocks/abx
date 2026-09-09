#!/usr/bin/env bash
#
# sandbox.sh — "fresh agent on the current codebase, right now."
#
# Creates a throwaway, gitignored .sandbox/ containing a sandbox-local `abx`, the skill, and creator
# files, then launches a Claude Code session with that local bin directory on PATH. It never installs
# or overwrites a global executable.
#
#   pnpm sandbox                 scaffold + drop into an interactive agent session (human pair)
#   pnpm sandbox "<intent>"      ... pre-seeded with a first message
#   pnpm sandbox:cold            scaffold + run the default cold scenario, print a friction scorecard
#   pnpm sandbox:cold <scenario> ... run a specific scenario from contributor/agent-eval/scenarios/
#   pnpm sandbox:cold all        ... run every scenario in sequence
#   bash scripts/sandbox.sh --cold --creative <scenario> [--model X] [--funded]
#                             ... CREATIVE mode: the agent arrives with an artistic BRIEF (not files),
#                             AUTHORS the art, then deploys/previews it. Uses rubric-creative.md +
#                             scenarios/creative/, clears the example-art crutches, grants Write/Edit.
#   bash scripts/sandbox.sh --no-launch   scaffold only (inspect it yourself)
#   bash scripts/sandbox.sh --name <ns> --no-launch [--funded] [--port N]   a NAMESPACED clean-room
#                             (.sandbox-<ns>/, its own port + .env + FEEDBACK.md) — run MANY in
#                             PARALLEL for concurrent agent testing; --funded seeds a real Sepolia
#                             key + the localhost dev-escape (real LOCAL code-project e2e). Each
#                             sandbox ships FEEDBACK.md (the standard scorecard) — collect them after.
#
# A fresh run wipes any existing .sandbox[-<ns>]/ first (it confirms if one exists and you're on a
# TTY; pass --yes to skip the prompt for automation/CI). Namespaced runs only wipe their own dir.
#
# Why a copy (not a symlink) for the skill: a fresh copy each launch is BOTH current and isolated
# (no symlink path back into the source for a cold agent to wander through). Tier-1 fidelity; the
# packaged-artifact check is Tier 2 (npm pack / Verdaccio) — see contributor/distribution-testing.md.
set -euo pipefail

DEV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$DEV_ROOT/.sandbox"
EVAL_DIR="$DEV_ROOT/contributor/agent-eval" # cold-agent suite: rubric.md + scenarios/*.md
RUBRIC="$EVAL_DIR/rubric.md"
SCENARIOS="$EVAL_DIR/scenarios"

MODE="interactive"; YES=0; WITH_STORAGE=0; LIVE=0; FUNDED=0; NAME=""; PORT=""; MODEL=""; CREATIVE=0
EPHEMERAL=""   # non-empty => this room gets its own generated deployer key, funded with this much ETH

while [ $# -gt 0 ]; do
  case "$1" in
    --model)             MODEL="$2"; shift 2 ;;    # cold mode: run the headless agent on a specific model
    --model=*)           MODEL="${1#*=}"; shift ;;
    --creative)          CREATIVE=1; shift ;;      # creative mode: the agent arrives with an IDEA, not files — it AUTHORS the art then deploys it.
                                                   #   uses rubric-creative.md + scenarios/creative/, clears the example art crutches, and grants Write/Edit.
    --cold|--print)      MODE="cold"; shift ;;
    --no-launch)         MODE="scaffold"; shift ;;
    --yes|-y)            YES=1; shift ;;         # skip the wipe confirmation (for automation/CI)
    --with-storage)      WITH_STORAGE=1; shift ;; # seed durable-storage creds (PINATA_JWT) for storage-path testing
    --live)              LIVE=1; WITH_STORAGE=1; shift ;; # seed a FUNDED Sepolia key + use the live rubric → agents do REAL testnet deploys
    --funded)            FUNDED=1; WITH_STORAGE=1; shift ;; # seed a FUNDED Sepolia key + storage, but KEEP the preview rubric (for an orchestrator that drives its own agents)
    --ephemeral)         FUNDED=1; WITH_STORAGE=1; EPHEMERAL="${2:-0.005}"; shift 2 ;; # like --funded, but this room gets its OWN fresh, small-funded key
    --ephemeral=*)       FUNDED=1; WITH_STORAGE=1; EPHEMERAL="${1#*=}"; shift ;;
    --name)              NAME="$2"; shift 2 ;;   # namespaced clean-room .sandbox-<name>/ — run MANY in PARALLEL without collision
    --name=*)            NAME="${1#*=}"; shift ;;
    --port)              PORT="$2"; shift 2 ;;    # the serve/effects port for THIS sandbox (parallel runs need distinct ports)
    --port=*)            PORT="${1#*=}"; shift ;;
    *) break ;;
  esac
done
# --name: run parallel agent sandboxes. Each is an isolated .sandbox-<name>/ (own .env, own local
# .abx-self-host projection since abx is cwd-relative, own port), so N agents test concurrently and
# feedback lands independently. Without --name it's the single shared .sandbox/ (unchanged).
SANDBOX="$DEV_ROOT/.sandbox${NAME:+-$NAME}"
# Port: distinct per parallel sandbox. Default 8787; else derive a stable one from the name so two
# named sandboxes don't collide on `abx serve`/`abx-effects` even if --port is omitted.
if [ -z "$PORT" ]; then
  if [ -n "$NAME" ]; then
    OFFSET=$(printf '%s' "$NAME" | cksum | awk '{print $1 % 60}')  # 0..59
    PORT=$((8800 + OFFSET))
  else
    PORT=8787
  fi
fi
EFFECTS_PORT=$((PORT + 1))
# --live: the cold agent completes a REAL Sepolia deploy (not preview). Seeds ABX_DEPLOYER_PK +
# storage creds and swaps in the live rubric. Testnet only; use deliberately (agents can spend).
[ "$LIVE" -eq 1 ] && RUBRIC="$EVAL_DIR/rubric-live.md"
# --creative: the agent starts from an artistic BRIEF (no supplied art), authors the art, then
# deploys/previews it. Its own rubric + scenario set take precedence (even alongside --funded, where
# the scenario itself decides whether to spend). SKIP_ART_STAGING clears the example-art crutches so
# the agent can't shortcut by deploying a pre-made file — it must create original work.
SKIP_ART_STAGING=0
if [ "$CREATIVE" -eq 1 ]; then
  RUBRIC="$EVAL_DIR/rubric-creative.md"
  SCENARIOS="$EVAL_DIR/scenarios/creative"
  SKIP_ART_STAGING=1
fi
# remaining arg: an interactive seed prompt, OR (cold mode) the scenario name / `all`.
SEED="${*:-}"

# ── 1) the fresh clean room (wiped each run) ──
# A fresh run always starts from a clean .sandbox/. Confirm first if one already exists (an
# interactive TTY only) — you may have added a funded key or files to .sandbox/.env for a real
# deploy, and this wipe is irreversible. --yes (or no TTY, e.g. CI) skips the prompt.
if [ -e "$SANDBOX" ]; then
  if [ "$YES" -eq 0 ] && [ -t 0 ]; then
    printf "⚠ wiping the existing clean room at %s — anything you added there (keys in .env, files) is lost.\n  Continue? [y/N] " "$SANDBOX" >&2
    read -r reply
    case "$reply" in [yY]|[yY][eE][sS]) ;; *) echo "aborted — .sandbox/ left untouched." >&2; exit 1 ;; esac
  fi
  rm -rf "$SANDBOX"
fi
BIN_DIR="$SANDBOX/.bin"
mkdir -p "$SANDBOX/.claude/skills" "$BIN_DIR"
# Sandbox-local wrapper: launched sessions receive BIN_DIR on PATH, while the developer's global
# `abx` installation remains untouched.
cat > "$BIN_DIR/abx" <<EOF
#!/usr/bin/env bash
exec "$DEV_ROOT/node_modules/.bin/tsx" "$DEV_ROOT/packages/cli/src/bin.ts" "\$@"
EOF
chmod +x "$BIN_DIR/abx"
# the shipped skill, copied fresh = always current + fully isolated
cp -R "$DEV_ROOT/.claude/skills/abx" "$SANDBOX/.claude/skills/abx"
# the creator's source files, under sources/ — a single image (donuts-cake.svg), a multi-image
# series/ directory, and a p5 code sketch, so the 1/1, Series, and code drop types are testable.
# CREATIVE mode skips this: the agent invents + authors its OWN art (no pre-made file to shortcut with).
mkdir -p "$SANDBOX/sources"
if [ "$SKIP_ART_STAGING" -eq 0 ] && [ -d "$DEV_ROOT/fixtures" ]; then cp -R "$DEV_ROOT/fixtures/." "$SANDBOX/sources/"; find "$SANDBOX/sources" -name .DS_Store -delete; fi
# In-chain Solidity SVG lane: stage the forkable renderer examples (image + traits) into
# sources/inchain-svg/ so the zero-dependency lane is testable in the clean room — symmetric with the
# p5 sketch, this is the creator's "art" for that lane (nothing else — no how-to README that would
# spoon-feed a black-box agent the command/addresses; the agent derives the lane from the skill, and
# the scenario/creator supplies the deployed addresses). Copied FRESH from the canonical contracts
# location (single source of truth, always current).
RENDERER_EX="$DEV_ROOT/contracts/src/renderers/examples"
if [ -f "$RENDERER_EX/SeedSvgRenderer.sol" ]; then
  mkdir -p "$SANDBOX/sources/inchain-svg"
  cp "$RENDERER_EX/SeedSvgRenderer.sol" "$RENDERER_EX/SeedTraitsRenderer.sol" "$SANDBOX/sources/inchain-svg/" 2>/dev/null || true
  # deployed.json — PROVENANCE ONLY: where these renderer contracts are deployed on-chain. NOT a
  # how-to (no command, no lane, no recommendation — that would spoon-feed the agent the answer the
  # skill teaches). Just the source→address map a real creator's deployment record would hold.
  cat > "$SANDBOX/sources/inchain-svg/deployed.json" <<'MD'
{
  "note": "Deployed instances of the renderer contracts in this folder (example, testnet).",
  "base-sepolia": {
    "SeedSvgRenderer": "0x6fb1EbecC134E1a37Ee2b3780562D267CF2C2BED",
    "SeedTraitsRenderer": "0xabA1b4EfE9b8E8Dd39A3C298472E3806BD559bf3"
  },
  "sepolia": {
    "SeedSvgRenderer": "0x5755C19d4B441c465a45b5373b37F1EF8b806945",
    "SeedTraitsRenderer": "0x7408EadcB1029F671bA1a9C001b78dc52E9BCe8a"
  }
}
MD
  find "$SANDBOX/sources/inchain-svg" -name .DS_Store -delete 2>/dev/null || true
fi
# minimal .env: RPC only (so the tool works) + signing guidance. NOT the full dev .env — that
# would seed PINATA_JWT / resolver tokens and bias the agent toward the wrong custody path.
{
  # RPC endpoints are CHAIN-SCOPED (ABX_RPC_URLS_<CHAIN>); the default chain is Base Sepolia. Seed
  # whatever the dev .env has per chain, else fall back to the keyless public defaults (which the
  # SDK also uses when unset) so the clean room works on the DEFAULT chain out of the box — never
  # a wrong-network URL (the bare ABX_RPC_URLS holding another network's URLs is the classic break).
  # Full-archive endpoint FIRST. The fallback transport rotates on ERROR only, and a PRUNED
  # endpoint answers a deep scan with an empty-but-SUCCESSFUL `[]` -- so it never errors, never
  # rotates, and a reconstruction of an older project silently returns nothing instead of failing
  # over. `abx doctor` flags the wrong order; a regression room that inherits it produces results
  # that look clean and are not. publicnode stays as the fallback, second.
  grep -E '^ABX_RPC_URLS_BASE_SEPOLIA=' "$DEV_ROOT/.env" 2>/dev/null || echo 'ABX_RPC_URLS_BASE_SEPOLIA=https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com'
  grep -E '^ABX_RPC_URLS_SEPOLIA=' "$DEV_ROOT/.env" 2>/dev/null || echo '# ABX_RPC_URLS_SEPOLIA=<your Sepolia RPC URL(s)> — only needed if you set ABX_CHAIN=sepolia'
  # PIN THE ROOM'S CHAIN. Without this the room silently falls back to the SDK default
  # (base-sepolia) no matter what chain the operator scaffolded under, because an exported
  # ABX_CHAIN does not survive into the agent's own shell. That cost a real contract once: a w8
  # room priced its dry run on base-sepolia (~0.006 gwei) and then sent on sepolia (~1.15 gwei) —
  # a ~190x underestimate — so the clone leg confirmed, the setup leg reverted for insufficient
  # funds, and the address was left permanently dead with a spent salt. The room must state its
  # chain rather than inherit an invisible default.
  echo "ABX_CHAIN=${ABX_CHAIN:-base-sepolia}"
  echo '# Signing: add a key ONLY for hot/unattended signing; otherwise use `abx deploy --sign`'
  echo '# (approve in your own wallet — no key needed here), e.g.:  ABX_DEPLOYER_PK=0x...'
  echo '# DEV: `abx deploy-resolver` builds the resolver image from local source (no npm publish'
  echo '# needed) so we can e2e-test hosting pre-publish. In production the same command emits the'
  echo '# npm-based image. This switch is a sandbox-only concession, not something a published user sets.'
  echo 'ABX_RESOLVER_SOURCE=1'
  # Ports for THIS (possibly parallel) sandbox — so co-located resolver + effects runner don't
  # collide across concurrent namespaced runs. `abx serve --port $PORT`; the effects runner reads
  # ABX_EFFECTS_PORT; the runner finds the resolver at ABX_RESOLVER_URL.
  echo "ABX_EFFECTS_PORT=$EFFECTS_PORT"
  echo "ABX_RESOLVER_URL=http://localhost:$PORT"
  # --with-storage: seed durable-storage creds so an agent can actually exercise the off-chain
  # image paths (ipfs directory-base, etc.). Spending stays impossible (no funded key) → deploys
  # are preview/dry-run. Off by default so the pure sim still tests "does it pick the right custody".
  if [ "$WITH_STORAGE" -eq 1 ]; then
    grep -E '^PINATA_JWT=' "$DEV_ROOT/.env" 2>/dev/null && echo '# PINATA_JWT provisioned (ipfs custody testable); arweave/Turbo is keyless + free under 100 KB'
    grep -E '^ABX_REMOTE_SELF_TOKEN=' "$DEV_ROOT/.env" 2>/dev/null || true
  fi
  # --live / --funded: seed a FUNDED Sepolia key so the agent can complete a REAL testnet deploy
  # (hot lane). TESTNET ONLY. Off by default (a keyless sandbox can't spend unsupervised).
  if [ "$LIVE" -eq 1 ] || [ "$FUNDED" -eq 1 ]; then
    # An EPHEMERAL room signs with its OWN generated key (written after this env file is built, by
    # the sandbox-wallet step below) — NOT the shared treasury key. That is what makes parallel
    # funded rooms safe: the old "one funded agent per account and chain" rule existed because two
    # agents on one key race the same nonce, and each failure reads like a product bug.
    if [ -n "$EPHEMERAL" ]; then
      echo '# EPHEMERAL: ABX_DEPLOYER_PK for this room is appended below — its own fresh, small-funded key.'
    else
      grep -E '^ABX_DEPLOYER_PK=' "$DEV_ROOT/.env" 2>/dev/null && echo '# FUNDED: real Sepolia key provisioned → real deploys via the default (hot) lane. Testnet only.'
    fi
    # A code project bakes a resolver base on-chain and refuses localhost — but a funded LOCAL
    # sandbox has no public host, so allow the dev-escape so code-project e2e (deploy→serve→render)
    # can run entirely locally. This mirrors ABX_RESOLVER_SOURCE=1: a sandbox-only concession.
    echo 'ABX_DEV_ALLOW_LOCALHOST_URI=1'
  fi
} > "$SANDBOX/.env"

# --ephemeral: generate this room's OWN deployer key and fund it a little from the treasury.
#
# Two safety steps come FIRST, in this order, and both are load-bearing:
#   1. The singleton preflight. The SDK's `ensure*` helpers bootstrap chain-global singletons on
#      demand at CREATE2-deterministic addresses. Fresh per-room keys do NOT fix that: N rooms that
#      each find one missing all race to deploy the SAME address, one wins, the rest revert, and it
#      reads as a product bug. Refuse to scaffold rather than hand out a room that will do this.
#   2. Funding, which is serial from one treasury key. That is fine — it happens once here, not
#      concurrently during the run, so the treasury's own nonce is never contended.
if [ -n "$EPHEMERAL" ]; then
  WALLET_FILE="$SANDBOX/.ephemeral-wallet.json"
  echo "  ephemeral wallet"
  if ! node --import tsx "$DEV_ROOT/scripts/sandbox-wallet.ts" preflight --chain "${ABX_CHAIN:-base-sepolia}" >/dev/null 2>&1; then
    echo "  ✗ singleton preflight FAILED — not scaffolding a funded room that would race to bootstrap."
    echo "    run: node --import tsx scripts/sandbox-wallet.ts preflight --chain ${ABX_CHAIN:-base-sepolia}"
    exit 1
  fi
  EPH_ADDR=$(node --import tsx "$DEV_ROOT/scripts/sandbox-wallet.ts" new --out "$WALLET_FILE" --chain "${ABX_CHAIN:-base-sepolia}" | tail -1)
  node --import tsx "$DEV_ROOT/scripts/sandbox-wallet.ts" fund --file "$WALLET_FILE" --eth "$EPHEMERAL" | sed 's/^/    /'
  # Appended AFTER the env file is composed, so it wins the last-value-wins dotenv rule even if the
  # treasury key was written above. The key itself never reaches stdout.
  {
    echo ''
    echo "# This room's OWN deployer key ($EPH_ADDR) — generated, small-funded, swept on clean."
    echo "ABX_DEPLOYER_PK=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).privateKey)" "$WALLET_FILE")"
  } >> "$SANDBOX/.env"
  echo "    room signs as $EPH_ADDR (own nonce space — safe to run in parallel)"
fi

# make it read like a creator's project
if [ "$CREATIVE" -eq 1 ]; then
cat > "$SANDBOX/CLAUDE.md" <<MD
# My NFT project

I'm a creator and I arrive with an IDEA, not finished files — this project is nearly empty on
purpose. You will CREATE the art yourself (write the files into this directory) and then take it to an
NFT with the \`abx\` CLI. The \`abx\` CLI is installed and on my PATH, and its skill is available to
you. I do not have — and don't want — the abx source code; treat the tooling as a black box. Run
\`abx\` directly (no \`cd\`). \`sources/inchain-svg/\` holds forkable on-chain-renderer references (an
interface reference, like an SDK) — the ART must be your own original work.

If you need to run a local resolver or effect runner in this workspace, use **port $PORT** for
\`abx serve --port $PORT\` (the effect runner's port is preconfigured in \`.env\`) — this keeps
parallel sandboxes from colliding. When you finish, record what you found in \`FEEDBACK.md\`.
MD
else
cat > "$SANDBOX/CLAUDE.md" <<MD
# My NFT project

I'm a creator. My potential source art is under \`sources/\`. I want to take it to an NFT. The \`abx\`
CLI is installed and on my PATH, and its skill is available to you. I do not have — and don't
want — the abx source code; treat the tooling as a black box. Run \`abx\` directly (no \`cd\`).

If you need to run a local resolver or effect runner in this workspace, use **port $PORT** for
\`abx serve --port $PORT\` (the effect runner's port is preconfigured in \`.env\`) — this keeps
parallel sandboxes from colliding. When you finish, record what you found in \`FEEDBACK.md\`.
MD
fi

# session-scoped permissions: let an agent use abx + read freely, never anything destructive.
# CREATIVE mode also grants Write/Edit + the authoring Bash tools (mkdir/node/python3) so the agent
# can create its own art files; still no rm/push/sudo.
if [ "$CREATIVE" -eq 1 ]; then
cat > "$SANDBOX/.claude/settings.local.json" <<MD
{
  "env": {"PATH": "$BIN_DIR:$PATH"},
  "permissions": {
    "allow": ["Read", "Grep", "Glob", "Write", "Edit", "Bash(abx:*)", "Bash(ABX_CHAIN=sepolia abx:*)", "Bash(ABX_CHAIN=base-sepolia abx:*)", "Bash(cast:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(pwd)", "Bash(curl:*)", "Bash(mkdir:*)", "Bash(node:*)", "Bash(python3:*)"],
    "deny": ["Bash(rm:*)", "Bash(git push:*)", "Bash(sudo:*)"]
  }
}
MD
else
cat > "$SANDBOX/.claude/settings.local.json" <<MD
{
  "env": {"PATH": "$BIN_DIR:$PATH"},
  "permissions": {
    "allow": ["Read", "Grep", "Glob", "Bash(abx:*)", "Bash(ABX_CHAIN=sepolia abx:*)", "Bash(ABX_CHAIN=base-sepolia abx:*)", "Bash(cast:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(pwd)", "Bash(curl:*)"],
    "deny": ["Bash(rm:*)", "Bash(git push:*)", "Bash(sudo:*)"]
  }
}
MD
fi

# ── the standard feedback artifact ──
# Every agent sandbox ships a FEEDBACK.md skeleton (the same 7-section scorecard the cold rubric
# uses) so results are structured + comparable across parallel runs. The agent fills it in place;
# the orchestrator collects `.sandbox-*/FEEDBACK.md`. The canonical template is a separate file so
# the status board can distinguish an untouched report by content, not by a brittle line-count proxy.
# Keep this schema in lockstep with contributor/agent-eval/rubric.md.
cp "$EVAL_DIR/feedback-template.md" "$SANDBOX/FEEDBACK.md"

# ── cold-agent suite helpers: rubric.md + one scenario → a headless, preview-only session ──
# The rubric is the shared frame (persona, constraints, scorecard); each scenarios/<name>.md is
# just the creator's task. We inject the scenario where the rubric's {{SCENARIO}} marker sits, so
# the constraints and scorecard are defined ONCE and can't drift across scenarios.
render_scenario() {                       # $1 = scenario file → resolve runtime fixture placeholders
  local file="$1" facts="$DEV_ROOT/.mock-remote-fixture.json" contract=""
  if ! grep -q '{{MOCK_REMOTE_CONTRACT}}' "$file"; then cat "$file"; return; fi
  [ -f "$facts" ] || {
    echo "✗ scenario needs the mock remote fixture; run: bash scripts/mock-remote-fixture.sh" >&2
    return 1
  }
  contract="$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).contract ?? '')" "$facts")"
  [[ "$contract" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✗ invalid mock fixture contract in $facts" >&2; return 1; }
  sed "s/{{MOCK_REMOTE_CONTRACT}}/$contract/g" "$file"
}
compose_prompt() {                      # $1 = scenario file → prints rubric with the task spliced in
  local scenario=""
  scenario="$(render_scenario "$1")" || return 1
  sed '/{{SCENARIO}}/,$d' "$RUBRIC"     #   everything BEFORE the marker
  printf '%s\n' "$scenario"             #   the scenario, with runtime fixture facts resolved
  sed '1,/{{SCENARIO}}/d' "$RUBRIC"     #   everything AFTER the marker
}
run_scenario() {                        # $1 = scenario name
  local name="$1"
  local file="$SCENARIOS/$name.md"
  local prompt=""
  if [ ! -f "$file" ]; then
    echo "✗ unknown scenario '$name'. Available: $(ls "$SCENARIOS" 2>/dev/null | sed 's/\.md$//' | tr '\n' ' ')all" >&2
    return 1
  fi
  echo "▸ cold agent · scenario '$name'${CREATIVE:+ (creative)} in $SANDBOX (headless; preview-only; abx + reads, nothing destructive)${MODEL:+ · model=$MODEL}…" >&2
  # allowlist makes it autonomous without prompts; the keyless .env means it physically cannot spend.
  # --model optionally exercises the workflow with a different model tier.
  # CREATIVE mode additionally grants Write/Edit + authoring Bash so the agent can create its own art.
  # `Bash(abx:*)` does NOT match an env-prefixed command, so `ABX_CHAIN=sepolia abx …` hits a
  # permission wall — and the chain has no flag by design. The two supported chains are allowlisted
  # explicitly so a scenario can select its stated network.
  local chainprefix="Bash(ABX_CHAIN=sepolia abx:*),Bash(ABX_CHAIN=base-sepolia abx:*)"
  local tools="Read,Grep,Glob,Bash(abx:*),$chainprefix,Bash(cast:*),Bash(ls:*),Bash(cat:*)"
  [ "$CREATIVE" -eq 1 ] && tools="Read,Grep,Glob,Write,Edit,Bash(abx:*),$chainprefix,Bash(cast:*),Bash(ls:*),Bash(cat:*),Bash(mkdir:*),Bash(node:*),Bash(python3:*)"
  prompt="$(compose_prompt "$file")" || return 1
  env PATH="$BIN_DIR:$PATH" claude -p "$prompt" \
    ${MODEL:+--model "$MODEL"} \
    --allowedTools "$tools" \
    --permission-mode acceptEdits
}

# ── 3) launch ──
cd "$SANDBOX"
case "$MODE" in
  scaffold)
    echo "✓ sandbox ready: $SANDBOX ${NAME:+(namespace: $NAME)}"
    echo "  port: $PORT (serve) · $EFFECTS_PORT (effects) · funded: $([ "$LIVE" -eq 1 ] || [ "$FUNDED" -eq 1 ] && echo yes || echo no) · feedback: $SANDBOX/FEEDBACK.md"
    echo "  launch with: (cd $(basename "$SANDBOX") && env PATH=\"$BIN_DIR:\$PATH\" claude)"
    [ -n "$NAME" ] && echo "  parallel: re-run with a different --name to scaffold a sibling sandbox on its own port"
    ;;
  cold)
    [ -f "$RUBRIC" ] || { echo "✗ cold rubric not found: $RUBRIC" >&2; exit 1; }
    SCENARIO="${SEED:-1of1-deploy}"     # default keeps `pnpm sandbox:cold` behaving as before; `all` runs the suite
    if [ "$SCENARIO" = "all" ]; then
      for f in "$SCENARIOS"/*.md; do
        n="$(basename "$f" .md)"
        echo "" >&2; echo "════════════════════ SCENARIO: $n ════════════════════" >&2
        run_scenario "$n" || echo "⚠ scenario '$n' exited non-zero — continuing the suite" >&2
      done
    else
      run_scenario "$SCENARIO"
    fi
    ;;
  interactive)
    echo "▸ fresh agent session in .sandbox/ (current codebase) — Ctrl-D to exit, then use scripts/sandbox-clean.sh." >&2
    if [ -n "$SEED" ]; then PATH="$BIN_DIR:$PATH" exec claude "$SEED"; else PATH="$BIN_DIR:$PATH" exec claude; fi
    ;;
esac
