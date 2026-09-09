#!/usr/bin/env bash
#
# End-to-end regression for the `--sign` browser-wallet lane with on-chain staging. It verifies a
# multi-transaction signing session against local Anvil with no environment key in the wallet-lane
# deploy:
#
#   Phase A (hot lane):   deploy --onchain-image with the env key  → bootstraps the shared
#                         factory/renderer/chunk-store AND regression-tests the refactored
#                         staging path (writeContent through the lane-agnostic sender).
#   Phase B (wallet lane): UNSET every signing key, then deploy --onchain-image --sign
#                         --for <acct0>. A headless wallet (scripts/headless-wallet.mjs)
#                         connects once and signs the staging tx + the deploy tx. Verify the
#                         clone resolves its image fully ON-CHAIN (abx tokenuri) AND that its
#                         on-chain owner == the pinned --for wallet (not some other connected
#                         wallet) — the bug where the connected wallet silently became owner.
#   Phase C (guard):      deploy --for <acct1> --sign, but connect the WRONG wallet (acct0).
#                         The session must REFUSE it (server 409) — never queue a signature for
#                         a wallet the deploy wasn't prepared for.
#
# Requires foundry's `anvil`. SKIPS (exit 0) if missing. Run:  pnpm test:e2e:wallet
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

skip() { echo "SKIP (e2e-wallet-sign): $1"; exit 0; }
fail() { echo "✗ FAIL: $1"; exit 1; }

command -v anvil >/dev/null 2>&1 || skip "anvil not installed (foundry)"

ANVIL_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ACCT0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"   # the key above
ANVIL_ACCT1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"   # a DIFFERENT anvil account (mismatch test)
ANVIL_PORT=8545
SIGN_PORT=8799
CHAIN_ID=11155111   # anvil masquerades as Sepolia so the toolkit's chain config applies
RPC="http://localhost:$ANVIL_PORT"
DATA_DIR="$(mktemp -d)"
WORK="$(mktemp -d)"
ANVIL_LOG="$(mktemp)"
SVG="$WORK/art.svg"

cleanup() {
  set +e
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" >/dev/null 2>&1
  [ -n "${DEPLOY_PID:-}" ] && kill "$DEPLOY_PID" >/dev/null 2>&1
  rm -rf "$DATA_DIR" "$WORK" "$ANVIL_LOG"
}
trap cleanup EXIT

# A small SVG → fastlz-compresses to a single chunk (single-mode staging = 1 staging tx).
cat > "$SVG" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7c5cff"/><circle cx="32" cy="32" r="18" fill="#ffcf8b"/></svg>
SVG

echo "▸ starting anvil (chain-id $CHAIN_ID) on :$ANVIL_PORT"
anvil --silent --chain-id "$CHAIN_ID" --port "$ANVIL_PORT" >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 50); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
  [ "$i" = 50 ] && fail "anvil did not become ready"
done

export ABX_CHAIN=sepolia
export ABX_RPC_URLS="$RPC"
export ABX_DATA_DIR="$DATA_DIR"

# ── Phase A — hot lane: bootstrap shared infra + regression-test refactored staging ──
echo "▸ A/3  hot lane: deploy --onchain-image (bootstraps factory/renderer/chunk-store)"
A_OUT="$(ABX_DEPLOYER_PK="$ANVIL_PK" pnpm -s abx deploy \
  --image "$SVG" --onchain-image --compress fastlz \
  --name "Hot OnChain" --symbol HOT 2>&1)" || { echo "$A_OUT"; fail "hot-lane onchain-image deploy failed (staging refactor regression)"; }
CLONE_A="$(printf '%s\n' "$A_OUT" | grep -oiE 'deployed 0x[0-9a-f]{40}' | head -1 | grep -oiE '0x[0-9a-f]{40}')"
[ -n "$CLONE_A" ] || { echo "$A_OUT"; fail "hot-lane deploy printed no clone address"; }
echo "       hot clone: $CLONE_A"

# Capture the freshly-bootstrapped shared infra and DECLARE it via env. The toolkit is stateless
# (no config.json): on anvil — which masquerades as Sepolia (chainId 11155111) but has none of the
# manifest's real Sepolia contracts — Phase A deploys a fresh factory/renderer/chunk-store and
# prints `ABX_X=0x..` hints. Exporting them makes Phase B/C REUSE them (env overrides the manifest)
# instead of re-deploying — a re-deployed chunk store would add an unsigned tx and break the
# headless wallet's exact tx count.
grab() { printf '%s\n' "$A_OUT" | grep -oiE "$1=0x[0-9a-f]{40}" | head -1 | cut -d= -f2; }
export ABX_FACTORY="$(grab ABX_FACTORY)"
export ABX_RENDERER="$(grab ABX_RENDERER)"
export ABX_CHUNK_STORE="$(grab ABX_CHUNK_STORE)"
[ -n "$ABX_FACTORY" ] && [ -n "$ABX_RENDERER" ] && [ -n "$ABX_CHUNK_STORE" ] \
  || { echo "$A_OUT"; fail "could not capture bootstrapped factory/renderer/chunk-store to reuse via env"; }
echo "       reuse via env → factory ${ABX_FACTORY:0:10}…  renderer ${ABX_RENDERER:0:10}…  chunkStore ${ABX_CHUNK_STORE:0:10}…"
A_URI="$(pnpm -s abx tokenuri "$CLONE_A" 2>&1)" || { echo "$A_URI"; fail "tokenuri read failed for hot clone"; }
printf '%s\n' "$A_URI" | grep -qi 'decoded on-chain JSON' || { echo "$A_URI"; fail "hot clone did not resolve its tokenURI on-chain"; }
echo "       ✓ hot-lane on-chain staging + deploy resolves on-chain"

# Capture the sign URL the way a backgrounding AGENT should: read the file the CLI writes the
# instant the server is ready — no parsing stdout, no racing a one-shot monitor.
capture_sign_url() {  # $1 = url file, $2 = deploy log (for diagnostics)
  local f="$1" logf="$2" url="" i
  for i in $(seq 1 60); do
    [ -s "$f" ] && url="$(cat "$f")" && break
    sleep 0.5
  done
  [ -n "$url" ] || { echo "--- deploy log ---"; cat "$logf"; fail "--sign-url-file was never written (agent could not capture the URL)"; }
  printf '%s' "$url"
}

# ── Phase B — wallet lane, NO env key, signer pinned to --for ──
echo "▸ B/3  wallet lane: deploy --onchain-image --sign --for $ANVIL_ACCT0  (NO env signing key)"
SIGN_URL_FILE="$WORK/sign-url"
env -u ABX_DEPLOYER_PK \
  pnpm -s abx deploy \
    --image "$SVG" --onchain-image --compress fastlz \
    --name "Wallet OnChain" --symbol WAL --sign --for "$ANVIL_ACCT0" --port "$SIGN_PORT" --sign-url-file "$SIGN_URL_FILE" \
  > "$WORK/deploy_b.log" 2>&1 &
DEPLOY_PID=$!
SIGN_URL="$(capture_sign_url "$SIGN_URL_FILE" "$WORK/deploy_b.log")"
echo "       captured sign URL from --sign-url-file → $SIGN_URL"

# Drive the sign session as a headless browser wallet (acct0, matching --for): sign stage + deploy.
node scripts/headless-wallet.mjs "$SIGN_URL" "$RPC" "$ANVIL_PK" 2 \
  || { echo "--- deploy log ---"; cat "$WORK/deploy_b.log"; fail "headless wallet failed to drive the sign session"; }

wait "$DEPLOY_PID" || { echo "--- deploy log ---"; cat "$WORK/deploy_b.log"; fail "wallet-lane deploy process exited non-zero"; }
DEPLOY_PID=""

CLONE_B="$(grep -oiE 'deployed 0x[0-9a-f]{40}' "$WORK/deploy_b.log" | head -1 | grep -oiE '0x[0-9a-f]{40}')"
[ -n "$CLONE_B" ] || { cat "$WORK/deploy_b.log"; fail "wallet-lane deploy printed no clone address"; }
echo "       wallet clone: $CLONE_B"
[ -n "$(cast code "$CLONE_B" --rpc-url "$RPC")" ] || fail "wallet clone has no code on-chain"

B_URI="$(pnpm -s abx tokenuri "$CLONE_B" 2>&1)" || { echo "$B_URI"; fail "tokenuri read failed for wallet clone"; }
printf '%s\n' "$B_URI" | grep -qi 'decoded on-chain JSON' || { echo "$B_URI"; fail "wallet clone did not resolve its tokenURI on-chain (staging didn't land)"; }
printf '%s\n' "$B_URI" | grep -qi 'image' || { echo "$B_URI"; fail "wallet clone tokenURI has no image"; }

# Ownership guard: the on-chain owner must be the pinned --for wallet, not another connection.
OWNER_B="$(cast call "$CLONE_B" 'owner()(address)' --rpc-url "$RPC")"
[ "$(printf '%s' "$OWNER_B" | tr 'A-F' 'a-f')" = "$(printf '%s' "$ANVIL_ACCT0" | tr 'A-F' 'a-f')" ] \
  || fail "owner is $OWNER_B, expected pinned --for $ANVIL_ACCT0 (the silent-owner bug)"
echo "       ✓ on-chain owner == pinned --for wallet ($ANVIL_ACCT0)"

# ── Phase C — guard: connecting the WRONG wallet must be refused ──
echo "▸ C/3  guard: deploy --for $ANVIL_ACCT1, connect the WRONG wallet (acct0) → expect refusal"
SIGN_URL_FILE_C="$WORK/sign-url-c"
env -u ABX_DEPLOYER_PK \
  pnpm -s abx deploy \
    --image "$SVG" --onchain-image --compress fastlz \
    --name "Mismatch" --symbol MIS --sign --for "$ANVIL_ACCT1" --port "$SIGN_PORT" --sign-url-file "$SIGN_URL_FILE_C" \
  > "$WORK/deploy_c.log" 2>&1 &
DEPLOY_PID=$!
SIGN_URL_C="$(capture_sign_url "$SIGN_URL_FILE_C" "$WORK/deploy_c.log")"
echo "       captured sign URL → $SIGN_URL_C"

# acct0 connecting to a deploy pinned for acct1 must be rejected by the session (server 409).
node scripts/headless-wallet.mjs "$SIGN_URL_C" "$RPC" "$ANVIL_PK" reject \
  || { echo "--- deploy log ---"; cat "$WORK/deploy_c.log"; fail "the wrong wallet was NOT refused (signer guard broken)"; }
echo "       ✓ wrong wallet refused by the sign session"

# The deploy was cancelled by the refusal; it must not have produced a contract.
wait "$DEPLOY_PID" 2>/dev/null || true
DEPLOY_PID=""
if grep -oiE 'deployed 0x[0-9a-f]{40}' "$WORK/deploy_c.log" >/dev/null; then
  cat "$WORK/deploy_c.log"; fail "a contract was deployed despite the wrong-wallet refusal"
fi
echo "       ✓ no contract deployed for the refused session"

echo ""
echo "✓ PASS — --sign signs staging + deploy in one session (no env key); owner pinned to --for; wrong wallet refused."
