#!/usr/bin/env bash
#
# End-to-end regression for the remote resolver and migration flow. It uses a local Anvil chain and
# the real Docker image to verify registration, authentication, metadata resolution, conformance,
# migration between independent resolvers, and deregistration.
#
#   deploy an off-chain-custody clone on a local Anvil chain  →
#   bring up the resolver container with a fresh, empty volume  →
#   GET the tokenURI            → expect 404 code "not_registered"
#   POST without the token      → expect  401                  (auth holds)
#   POST /v1/projects           → indexes it + bridges the image's gateway URL & off-chain traits
#   GET the tokenURI            → image, attributes, and provenance resolve correctly
#   GET /d/<chainId>/<addr>     → per-contract dashboard (200); reindex POST without token → 401 (gated)
#   abx remote --conformance    → descriptor + auth + the register loop
#   bring up a SECOND resolver (the destination) with a fresh, empty volume  →
#   GET its tokenURI            → expect 404 code "not_registered" (it knows nothing yet)
#   `abx migrate --from <src> --to <dest>`  → reads the SOURCE's PUBLIC api + chain, bridges the
#                                 off-chain state (description / traits / image locator) to the dest
#   GET the dest's tokenURI     → identical metadata
#   DELETE /v1/projects/…/:a    → GET again → 404 "not_registered" (remove works)
#
# It runs the actual container, so it ALSO catches image-packaging regressions (e.g. a
# missing workspace package.json that breaks module resolution at runtime).
#
# Requires Docker Desktop running + foundry's `anvil`. SKIPS (exit 0) if either is
# missing, so it's safe in any CI. Run it with:  pnpm test:e2e
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

skip() { echo "SKIP (e2e-remote-resolver): $1"; exit 0; }
fail() { echo "✗ FAIL: $1"; exit 1; }

command -v anvil >/dev/null 2>&1 || skip "anvil not installed (foundry) — install foundry to run this e2e"
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not running (start Docker Desktop)"

# Anvil's well-known funded account #0 (test-only key; safe to hardcode for a local chain).
ANVIL_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_PORT=8545
RESOLVER_PORT=8787
# The migration DESTINATION resolver (second container). Overridable: 8788 is also the effects
# runner's default port, so a dev with a runner (or an `abx preview`) up would otherwise see this
# fixture die on "address already in use" — a local collision, not a regression.
DEST_PORT="${ABX_E2E_DEST_PORT:-8788}"
CHAIN_ID=11155111   # anvil masquerades as Sepolia so the toolkit's chain config applies
ADMIN_TOKEN="e2e-$(date +%s)-secret-not-a-real-token"
IMAGE="abx-self-host-e2e"
CONTAINER="abx-e2e-resolver"
DEST_CONTAINER="abx-e2e-resolver-dest"
DATA_DIR="$(mktemp -d)"      # the deployer's LOCAL store/config (separate from the resolver)
ANVIL_LOG="$(mktemp)"

# Pin the PER-CHAIN RPC var too, for every host-side `pnpm abx` below. The bare ABX_RPC_URLS each
# invocation sets is NOT enough: the repo's .env is auto-loaded and a per-chain
# `ABX_RPC_URLS_SEPOLIA` there is AUTHORITATIVE over the bare var (see resolveRpcUrls) — so a dev
# with the normal multi-chain setup would silently deploy to REAL Sepolia with anvil's test key
# ("insufficient funds", have 0). Exporting it here makes the run hermetic no matter the dev's .env.
# (The containers are unaffected — they get explicit `-e` flags and never see the host .env.)
export ABX_RPC_URLS_SEPOLIA="http://localhost:$ANVIL_PORT"

cleanup() {
  set +e
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" >/dev/null 2>&1
  docker rm -f "$CONTAINER" "$DEST_CONTAINER" >/dev/null 2>&1
  rm -rf "$DATA_DIR" "$ANVIL_LOG"
}
trap cleanup EXIT

echo "▸ starting anvil (chain-id $CHAIN_ID) on :$ANVIL_PORT"
anvil --silent --chain-id "$CHAIN_ID" --port "$ANVIL_PORT" >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 50); do
  cast block-number --rpc-url "http://localhost:$ANVIL_PORT" >/dev/null 2>&1 && break
  sleep 0.2
  [ "$i" = 50 ] && fail "anvil did not become ready"
done

echo "▸ deploying a clone on anvil (OFF-CHAIN custody: image committed as keccak256, bytes in fs)"
# Off-chain custody (not --onchain-uri) exercises the cross-resolver path: the image
# is committed on-chain as a keccak256 hash, the bytes live in the deployer's local fs custody,
# and the CID/locator that addresses them is NOT on-chain. A fresh remote resolver therefore can't
# point `image` anywhere durable on its own — it needs the locator bridged to it (tested below).
# ABX_DEV_ALLOW_LOCALHOST_URI=1 is the DEV/TEST-ONLY escape that lets the off-chain path bake a
# localhost base here (the user-facing --allow-localhost flag was removed — localhost on-chain
# resolves for no one, so it's never a real deploy path). The assertions below read the
# RESOLVER's /t endpoint (reconstructed from chain), not the on-chain tokenURI, so the baked
# localhost base is just there to let the off-chain deploy past the public-URL guard.
# ABX_RPC_URLS pins the deploy to anvil; the chainId guard also catches a wrong-network endpoint.
SVG="$DATA_DIR/donut.svg"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="brown"/></svg>' >"$SVG"
DEPLOY_OUT="$(
  ABX_CHAIN=sepolia \
  ABX_RPC_URLS="http://localhost:$ANVIL_PORT" \
  ABX_DEPLOYER_PK="$ANVIL_PK" \
  ABX_DATA_DIR="$DATA_DIR" \
  ABX_DEV_ALLOW_LOCALHOST_URI=1 \
  pnpm -s abx deploy --bootstrap-factory --image "$SVG" --name "E2E Donuts" --symbol E2E --description "remote-resolver e2e" 2>&1
)" || { echo "$DEPLOY_OUT"; fail "deploy failed"; }

CLONE="$(printf '%s\n' "$DEPLOY_OUT" | grep -oiE 'deployed 0x[0-9a-f]{40}' | head -1 | grep -oiE '0x[0-9a-f]{40}')"
[ -n "$CLONE" ] || { echo "$DEPLOY_OUT"; fail "could not parse deployed clone address"; }
# The on-chain image commitment (keccak256) — the key we bridge a durable IPFS locator for.
IMG_HASH="$(printf '%s\n' "$DEPLOY_OUT" | grep -oiE 'image keccak256 0x[0-9a-f]{64}' | head -1 | grep -oiE '0x[0-9a-f]{64}')"
[ -n "$IMG_HASH" ] || { echo "$DEPLOY_OUT"; fail "could not parse the image keccak256 commitment"; }
FAKE_CID="bafkreie2edonutdonutdonutdonutdonutdonutdonutdonutdonutab"
# The durable, production-safe locator the deployer bridges: a gateway HTTPS URL (not ipfs://),
# which is what renders in browsers/wallets/marketplaces.
FAKE_IMG="https://e2e-gw.mypinata.cloud/ipfs/$FAKE_CID"
# Capture the freshly-deployed factory and DECLARE it via env for `abx migrate` below. The toolkit
# is stateless (no config.json): anvil masquerades as Sepolia (chainId 11155111) but lacks the
# manifest's real Sepolia factory, so the deploy deployed a fresh one and printed an `ABX_FACTORY=`
# hint. migrate needs the REAL local factory (not the manifest's) to reconstruct + bridge canonical.
ABX_FACTORY_LOCAL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oiE 'ABX_FACTORY=0x[0-9a-f]{40}' | head -1 | cut -d= -f2)"
[ -n "$ABX_FACTORY_LOCAL" ] || { echo "$DEPLOY_OUT"; fail "could not capture the deployed factory address"; }
echo "  clone: $CLONE  ·  image keccak256: ${IMG_HASH:0:14}…  ·  factory: ${ABX_FACTORY_LOCAL:0:10}…"

echo "▸ building + starting the resolver container (FRESH empty volume, admin token set)"
docker build -q -t "$IMAGE" . >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$RESOLVER_PORT:8787" \
  -e ABX_CHAIN=sepolia \
  -e ABX_RPC_URLS="http://host.docker.internal:$ANVIL_PORT" \
  -e ABX_RESOLVER_ADMIN_TOKEN="$ADMIN_TOKEN" \
  -e ABX_PUBLIC_BASE_URL="http://localhost:$RESOLVER_PORT" \
  "$IMAGE" >/dev/null

R="http://localhost:$RESOLVER_PORT"
for i in $(seq 1 50); do
  curl -fsS "$R/health" >/dev/null 2>&1 && break
  sleep 0.3
  [ "$i" = 50 ] && { docker logs "$CONTAINER"; fail "resolver did not become healthy (container crashed?)"; }
done

TOKEN_PATH="/t/$CHAIN_ID/$CLONE/0"

echo "▸ 1/10 GET $TOKEN_PATH  → expect 404 not_registered (resolver doesn't know it yet)"
BEFORE="$(curl -s "$R$TOKEN_PATH")"
echo "$BEFORE" | grep -q '"code": "not_registered"' || fail "expected code not_registered before registering, got: $BEFORE"

echo "▸ 2/10 POST without the bearer token  → expect 401"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$R/v1/projects" \
  -H 'content-type: application/json' -d "{\"chainId\":$CHAIN_ID,\"address\":\"$CLONE\"}")"
[ "$CODE" = "401" ] || fail "expected 401 for missing token, got $CODE"

echo "▸ 3/10 POST /v1/projects (with token, bridging the image locator + off-chain traits)"
# The bridge: ship the durable gateway HTTPS locator for the on-chain image hash + off-chain
# operator traits. This is exactly what `abx add <clone> --remote` sends after an off-chain deploy.
ADD="$(curl -s -X POST "$R/v1/projects" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"chainId\":$CHAIN_ID,\"address\":\"$CLONE\",\"fromBlock\":\"0\",\"description\":\"remote-resolver e2e\",\"contentLocators\":{\"$IMG_HASH\":\"$FAKE_IMG\"},\"attributes\":[{\"trait_type\":\"Flavor\",\"value\":\"Chocolate\"}]}")"
echo "$ADD" | grep -q '"ok": true' || fail "register did not succeed: $ADD"

echo "▸ 4/10 GET $TOKEN_PATH  → expect resolved metadata (the fix)"
AFTER="$(curl -s "$R$TOKEN_PATH")"
echo "$AFTER" | grep -q '"code": "not_registered"' && fail "still not_registered after registering: $AFTER"
echo "$AFTER" | grep -q '"name"' || fail "resolved metadata missing a name field: $AFTER"

echo "▸ 5/10 metadata checks: image → gateway HTTPS URL (not localhost/ipfs://), clean attributes, status"
# (a) the image must be the bridged gateway HTTPS URL — NOT a raw ipfs:// and NOT this node's localhost.
echo "$AFTER" | grep -qF "\"image\": \"$FAKE_IMG\"" || fail "image is not the bridged gateway URL: $AFTER"
echo "$AFTER" | grep -q 'localhost' && fail "image (or a field) still points at localhost: $AFTER"
echo "$AFTER" | grep -qE '"image": "ipfs://' && fail "image served as a raw ipfs:// (won't render): $AFTER"
# (b) attributes are REAL creator traits only — the bridged off-chain trait shows, the old ABX
#     pollution (version / factory-verified / royalty) must be gone from the trait array.
echo "$AFTER" | grep -q '"Flavor"' || fail "bridged off-chain trait 'Flavor' missing from attributes: $AFTER"
echo "$AFTER" | grep -qE 'ABX Core Version|Canonical \(factory-verified\)' && fail "ABX facts still polluting attributes: $AFTER"
# (c) provenance uses the explicit status enum (image is 'anchored', not the removed 'unverified').
echo "$AFTER" | grep -q '"status"' || fail "abx_provenance missing the new 'status' field: $AFTER"
echo "$AFTER" | grep -q 'verifiedAgainstChain' && fail "old 'verifiedAgainstChain' still present: $AFTER"

echo "▸ 6/10 dashboard is namespaced + read-only, and actions are bearer-gated"
DASH="$(curl -s -o /dev/null -w '%{http_code}' "$R/d/$CHAIN_ID/$CLONE")"
[ "$DASH" = "200" ] || fail "per-contract dashboard /d/$CHAIN_ID/$CLONE not served (got $DASH)"
REIDX="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$R/v1/projects/$CHAIN_ID/$CLONE/reindex")"
[ "$REIDX" = "401" ] || fail "reindex action is NOT bearer-gated (expected 401 without token, got $REIDX)"

echo "▸ 6b/10 shipped CLI conformance check (descriptor + auth + the register loop)"
# Deregister first so the fixture's own register→deregister loop starts clean, then re-register
# exactly as step 3 did (the fixture's loop deregisters at the end).
CONFORMANCE_OUT="$(pnpm -s abx remote "$R" --conformance \
  --remote-token "$ADMIN_TOKEN" --chain-id "$CHAIN_ID" --address "$CLONE" --from-block 0 2>&1)" \
  || { echo "$CONFORMANCE_OUT"; fail "shipped CLI conformance check failed against the reference container"; }
echo "$CONFORMANCE_OUT" | grep -q '✓ conformant' || { echo "$CONFORMANCE_OUT"; fail "shipped CLI conformance check did not report conformant"; }
# The fixture deregistered the project — restore step 3's registration (with the bridge) so the
# migrate lane below still reads the same served state.
curl -s -X POST "$R/v1/projects" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"chainId\":$CHAIN_ID,\"address\":\"$CLONE\",\"fromBlock\":\"0\",\"description\":\"remote-resolver e2e\",\"contentLocators\":{\"$IMG_HASH\":\"$FAKE_IMG\"},\"attributes\":[{\"trait_type\":\"Flavor\",\"value\":\"Chocolate\"}]}" >/dev/null

# ── MIGRATE: move the off-chain state to a SECOND resolver, reading the source's PUBLIC api ──
echo "▸ 7/10 bring up the DESTINATION resolver (second container, fresh empty volume)"
docker run -d --name "$DEST_CONTAINER" -p "$DEST_PORT:8787" \
  -e ABX_CHAIN=sepolia \
  -e ABX_RPC_URLS="http://host.docker.internal:$ANVIL_PORT" \
  -e ABX_RESOLVER_ADMIN_TOKEN="$ADMIN_TOKEN" \
  -e ABX_PUBLIC_BASE_URL="http://localhost:$DEST_PORT" \
  "$IMAGE" >/dev/null
D="http://localhost:$DEST_PORT"
for i in $(seq 1 50); do
  curl -fsS "$D/health" >/dev/null 2>&1 && break
  sleep 0.3
  [ "$i" = 50 ] && { docker logs "$DEST_CONTAINER"; fail "destination resolver did not become healthy"; }
done

echo "▸ 8/10 GET the destination's tokenURI  → expect 404 not_registered (it knows nothing yet)"
DBEFORE="$(curl -s "$D$TOKEN_PATH")"
echo "$DBEFORE" | grep -q '"code": "not_registered"' || fail "destination should not know the contract before migrate, got: $DBEFORE"

echo "▸ 9/10 abx migrate --from <src> --to <dest>  (reads the SOURCE's public api + chain; no direct channel)"
# The migrating operator's machine: same chain (anvil) + same local config/data dir as the deploy
# (so the factory is known). It needs the dest's admin token to write through its control plane;
# the SOURCE is only READ over its public api. The source's image is a durable gateway URL, so it's
# carried as-is (no re-pin needed) — proving the public-api → public-api state transfer.
MIGRATE_OUT="$(
  ABX_CHAIN=sepolia \
  ABX_RPC_URLS="http://localhost:$ANVIL_PORT" \
  ABX_DATA_DIR="$DATA_DIR" \
  ABX_FACTORY="$ABX_FACTORY_LOCAL" \
  ABX_REMOTE_SELF_TOKEN="$ADMIN_TOKEN" \
  pnpm -s abx migrate "$CLONE" --from "$R" --to "$D" 2>&1
)" || { echo "$MIGRATE_OUT"; fail "abx migrate failed"; }
echo "$MIGRATE_OUT" | grep -qi "resolver indexed" || { echo "$MIGRATE_OUT"; fail "migrate did not report the destination indexed"; }

echo "       GET the destination's tokenURI  → expect identical metadata (portable from public endpoints)"
DAFTER="$(curl -s "$D$TOKEN_PATH")"
echo "$DAFTER" | grep -q '"code": "not_registered"' && fail "destination still not_registered after migrate: $DAFTER"
# Same durable gateway image (carried from the source's public api), NOT localhost / raw ipfs://.
echo "$DAFTER" | grep -qF "\"image\": \"$FAKE_IMG\"" || fail "destination image is not the migrated gateway URL: $DAFTER"
echo "$DAFTER" | grep -q 'localhost' && fail "destination image (or a field) points at localhost: $DAFTER"
# Same off-chain trait + description, carried via the source's public api (the resolvers never talked).
echo "$DAFTER" | grep -q '"Flavor"' || fail "off-chain trait 'Flavor' did not migrate to the destination: $DAFTER"
echo "$DAFTER" | grep -q 'remote-resolver e2e' || fail "off-chain description did not migrate to the destination: $DAFTER"

echo "▸ 10/10 DELETE then GET  → expect 404 not_registered again (remove works)"
curl -s -X DELETE "$R/v1/projects/$CHAIN_ID/$CLONE" -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null
GONE="$(curl -s "$R$TOKEN_PATH")"
echo "$GONE" | grep -q '"code": "not_registered"' || fail "expected code not_registered after delete, got: $GONE"

echo "✓ PASS — control plane + conformance fixture + resolver-to-resolver migration work end to end against the real image."
