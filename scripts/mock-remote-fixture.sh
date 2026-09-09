#!/usr/bin/env bash
# Start a hermetic managed-provider fixture for contributor agent evaluations:
# local Anvil chain → deployed 1/1 → mock provider backed by the reference resolver.
#
# The fixture records only processes it starts. Re-running replaces the previous owned fixture;
# `--stop` shuts it down. Generated state stays gitignored and tracked scenario files are never
# rewritten.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR="$ROOT/.mock-remote-fixture-store"
STORE_DIR="$STATE_DIR/store"
FACTS_FILE="$ROOT/.mock-remote-fixture.json"
ANVIL_PID_FILE="$STATE_DIR/anvil.pid"
PROVIDER_PID_FILE="$STATE_DIR/provider.pid"
ANVIL_LOG="$STATE_DIR/anvil.log"
PROVIDER_LOG="$STATE_DIR/provider.log"

ANVIL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
CHAIN_ID=11155111
ANVIL_PORT="${ABX_MOCK_ANVIL_PORT:-8545}"
PROVIDER_PORT="${ABX_MOCK_PROVIDER_PORT:-19000}"
KEY=mock_test_key_not_secret

stop_pid_file() {
  local file="$1" marker="$2" pid="" command=""
  [ -f "$file" ] || return 0
  pid="$(tr -dc '0-9' < "$file")"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"$marker"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      for _ in $(seq 1 30); do
        kill -0 "$pid" >/dev/null 2>&1 || break
        sleep 0.1
      done
      if kill -0 "$pid" >/dev/null 2>&1; then
        echo "✗ fixture process $pid did not stop cleanly ($marker)" >&2
        return 1
      fi
    else
      echo "⚠ not stopping PID $pid; it no longer matches this fixture ($marker)" >&2
    fi
  fi
  rm -f "$file"
}

stop_fixture() {
  # Match stable command identity, not the current port overrides: a later invocation may choose
  # different ports and must still stop the fixture recorded by the PID files.
  stop_pid_file "$PROVIDER_PID_FILE" "scripts/mock-remote-service.mts --port"
  stop_pid_file "$ANVIL_PID_FILE" "anvil --silent --chain-id $CHAIN_ID"
  rm -rf "$STATE_DIR"
  rm -f "$FACTS_FILE"
}

case "${1:-}" in
  --stop)
    stop_fixture
    echo "✓ mock remote fixture stopped"
    exit 0
    ;;
  "") ;;
  *) echo "usage: bash scripts/mock-remote-fixture.sh [--stop]" >&2; exit 2 ;;
esac

# Replace only a fixture previously recorded by this script. Never use process-name matching: that
# could terminate an unrelated Anvil node or contributor session.
stop_fixture
mkdir -p "$STORE_DIR"

READY=0
cleanup_on_exit() {
  local status=$?
  if [ "$READY" -ne 1 ]; then stop_fixture; fi
  return "$status"
}
trap cleanup_on_exit EXIT

echo "▸ anvil (chain-id $CHAIN_ID) on :$ANVIL_PORT"
nohup anvil --silent --chain-id "$CHAIN_ID" --port "$ANVIL_PORT" </dev/null >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
printf '%s\n' "$ANVIL_PID" > "$ANVIL_PID_FILE"
for i in $(seq 1 60); do
  if ! kill -0 "$ANVIL_PID" >/dev/null 2>&1; then
    cat "$ANVIL_LOG" >&2
    echo "✗ anvil exited before becoming ready" >&2
    exit 1
  fi
  cast block-number --rpc-url "http://localhost:$ANVIL_PORT" >/dev/null 2>&1 && break
  sleep 0.2
  [ "$i" = 60 ] && { cat "$ANVIL_LOG" >&2; echo "✗ anvil did not become ready" >&2; exit 1; }
done

echo "▸ deploying the creator's 1/1, tokenURI pointed at the provider"
ART="$STORE_DIR/art.svg"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="26" fill="%%23b45309"/></svg>' >"$ART"
DEPLOY_OUT="$(
  ABX_CHAIN=sepolia \
  ABX_RPC_URLS_SEPOLIA="http://localhost:$ANVIL_PORT" \
  ABX_DEPLOYER_PK="$ANVIL_PK" \
  ABX_DATA_DIR="$STORE_DIR" \
  ABX_PUBLIC_BASE_URL="http://127.0.0.1:$PROVIDER_PORT" \
  ABX_DEV_ALLOW_LOCALHOST_URI=1 \
  pnpm -s abx deploy --bootstrap-factory --image "$ART" --name "Amber Circle" --symbol AMBR \
    --description "a single amber circle" 2>&1
)" || { echo "$DEPLOY_OUT"; echo "✗ deploy failed"; exit 1; }
CLONE="$(printf '%s\n' "$DEPLOY_OUT" | grep -oiE 'deployed 0x[0-9a-f]{40}' | head -1 | grep -oiE '0x[0-9a-f]{40}')"
FACTORY="$(printf '%s\n' "$DEPLOY_OUT" | grep -oiE 'ABX_FACTORY=0x[0-9a-f]{40}' | head -1 | cut -d= -f2)"
[ -n "$CLONE" ] && [ -n "$FACTORY" ] || { echo "$DEPLOY_OUT"; echo "✗ could not parse deployed addresses"; exit 1; }

echo "▸ mock provider on :$PROVIDER_PORT (chain=sepolia via anvil, render attached)"
nohup env ABX_RPC_URLS_SEPOLIA="http://localhost:$ANVIL_PORT" ABX_FACTORY="$FACTORY" \
  node --import tsx scripts/mock-remote-service.mts --port "$PROVIDER_PORT" --chain sepolia --key "$KEY" \
  </dev/null >"$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!
printf '%s\n' "$PROVIDER_PID" > "$PROVIDER_PID_FILE"
for i in $(seq 1 60); do
  if ! kill -0 "$PROVIDER_PID" >/dev/null 2>&1; then
    cat "$PROVIDER_LOG" >&2
    echo "✗ mock provider exited before becoming ready" >&2
    exit 1
  fi
  curl -fsS "http://127.0.0.1:$PROVIDER_PORT/health" >/dev/null 2>&1 && break
  sleep 0.3
  [ "$i" = 60 ] && { cat "$PROVIDER_LOG" >&2; echo "✗ mock provider did not become ready" >&2; exit 1; }
done

printf '{"provider":"http://127.0.0.1:%s","key":"%s","chain":"sepolia","chainId":%s,"contract":"%s","factory":"%s"}\n' \
  "$PROVIDER_PORT" "$KEY" "$CHAIN_ID" "$CLONE" "$FACTORY" > "$FACTS_FILE"
READY=1

cat <<EOF

── fixture ready ──────────────────────────────────────────────
  provider     http://127.0.0.1:$PROVIDER_PORT   (key: $KEY)
  chain        sepolia (anvil :$ANVIL_PORT, chainId $CHAIN_ID)
  contract     $CLONE
  factory      $FACTORY
  state        $STATE_DIR
  stop         bash scripts/mock-remote-fixture.sh --stop
──────────────────────────────────────────────────────────────
EOF
