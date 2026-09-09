#!/usr/bin/env bash
#
# sandbox-clean.sh — the status board and the broom for agent-sweep clean rooms.
#
# `scripts/sandbox.sh` makes gitignored `.sandbox-<name>/` dirs. This script makes their state
# readable and requires an explicit assertion before deleting a room that contains findings:
#
#   · a VOID room (FEEDBACK.md missing or byte-for-byte the untouched template) holds nothing → delete freely
#   · a FILLED room holds findings → it may only be deleted once those findings are ROUTED, which you
#     assert with --routed. There is no way to bulk-delete filled rooms without saying that out loud.
#   · waves are deleted whole, so a half-deleted wave never looks like a run in progress
#   · a room touched in the last ACTIVE window is presumed to have an agent still working in it and
#     is never deleted without --force. A sweep in flight looks exactly like a wave of void rooms —
#     the agents have not written FEEDBACK.md yet — so without this guard `--void` mid-sweep would
#     delete the very run you are waiting on.
#
#   bash scripts/sandbox-clean.sh                    status board only (never deletes)
#   bash scripts/sandbox-clean.sh --void             delete every VOID room (safe — they hold nothing)
#   bash scripts/sandbox-clean.sh --wave w5 --routed delete the whole w5 wave (findings routed)
#   bash scripts/sandbox-clean.sh --all --routed     delete every sandbox
#   bash scripts/sandbox-clean.sh --routed .sandbox-foo .sandbox-bar   delete exactly these
#     (the explicit form is the escape hatch for pre-convention rooms — a sandbox named without a
#      wave prefix cannot be swept by wave, which is one more reason the naming convention is
#      load-bearing rather than cosmetic)
#   bash scripts/sandbox-clean.sh --stale 14         status board, flagging rooms older than 14 days
#     --yes  skip the confirmation prompt (automation)   --json  machine-readable status
#     --force  delete even rooms that look active   --active <min>  the active window (default 20)
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FEEDBACK_TEMPLATE="$ROOT/contributor/agent-eval/feedback-template.md"
[ -f "$FEEDBACK_TEMPLATE" ] || { echo "missing feedback template: $FEEDBACK_TEMPLATE" >&2; exit 1; }
MODE="status"; WAVE=""; ROUTED=0; YES=0; JSON=0; STALE_DAYS=7; FORCE=0; ACTIVE_MIN=20
while [ $# -gt 0 ]; do
  case "$1" in
    --void)     MODE="void"; shift ;;
    --wave)     MODE="wave"; WAVE="$2"; shift 2 ;;
    --wave=*)   MODE="wave"; WAVE="${1#*=}"; shift ;;
    --all)      MODE="all"; shift ;;
    --routed)   ROUTED=1; shift ;;
    --yes|-y)   YES=1; shift ;;
    --json)     JSON=1; shift ;;
    --stale)    STALE_DAYS="$2"; shift 2 ;;
    --stale=*)  STALE_DAYS="${1#*=}"; shift ;;
    --force)    FORCE=1; shift ;;
    --active)   ACTIVE_MIN="$2"; shift 2 ;;
    --active=*) ACTIVE_MIN="${1#*=}"; shift ;;
    -h|--help)  sed -n '3,30p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
    *)  MODE="explicit"; break ;;
  esac
done
EXPLICIT=("$@")

shopt -s nullglob
# `.sandbox` is a literal, not a glob, so nullglob cannot drop it — filter by what actually exists.
ALL=(.sandbox .sandbox-*)
DIRS=()
for d in ${ALL[@]+"${ALL[@]}"}; do [ -d "$d" ] && DIRS+=("$d"); done
if [ ${#DIRS[@]} -eq 0 ]; then echo "no sandboxes — the tree is clean."; exit 0; fi

now=$(date +%s)
VOID=(); FILLED=(); ACTIVE=(); SELECTED=()
declare -a ROWS=()
for d in "${DIRS[@]}"; do
  fb="$d/FEEDBACK.md"
  lines=0; [ -f "$fb" ] && lines=$(wc -l < "$fb" | tr -d ' ')
  # A room is VOID only when FEEDBACK.md is missing or still exactly the scaffolded template. A real
  # report may be shorter than, or coincidentally the same length as, the template; line count cannot
  # safely distinguish it and once caused `--void` to select a valid short report for deletion.
  if [ ! -f "$fb" ] || cmp -s "$fb" "$FEEDBACK_TEMPLATE"; then state="void"; VOID+=("$d"); else state="filled"; FILLED+=("$d"); fi
  # touched inside the active window ⇒ presume an agent is still working in there
  # --active 0 turns the guard off outright (`-mmin -0` still matches a just-created file, so the
  # window has to be short-circuited rather than shrunk).
  if [ "$ACTIVE_MIN" -gt 0 ] && [ -n "$(find "$d" -mmin "-$ACTIVE_MIN" -print -quit 2>/dev/null)" ]; then ACTIVE+=("$d"); state="$state*"; fi
  # GNU stat rejects the BSD form less reliably than BSD stat rejects the GNU form, so try GNU first.
  mt=$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d")
  age=$(( (now - mt) / 86400 ))
  size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
  ROWS+=("$d|$state|$lines|$age|$size")
done

if [ "$JSON" -eq 1 ]; then
  printf '['; sep=""
  for r in ${ROWS[@]+"${ROWS[@]}"}; do IFS='|' read -r n s l a z <<< "$r"
    act=false; case "$s" in *\*) act=true; s="${s%\*}" ;; esac
    printf '%s{"dir":"%s","state":"%s","active":%s,"feedbackLines":%s,"ageDays":%s,"size":"%s"}' "$sep" "$n" "$s" "$act" "$l" "$a" "$z"; sep=","
  done; printf ']\n'; exit 0
fi

printf '\n  %-34s %-7s %-9s %-6s %s\n' "SANDBOX" "STATE" "FEEDBACK" "AGE" "SIZE"
for r in ${ROWS[@]+"${ROWS[@]}"}; do
  IFS='|' read -r n s l a z <<< "$r"
  flag=""; [ "$a" -ge "$STALE_DAYS" ] && flag=" ← stale"
  case "$s" in *\*) flag=" ← touched <${ACTIVE_MIN}m ago (agent may still be running)" ;; esac
  fbtxt="$l lines"; case "$s" in void*) fbtxt="template" ;; esac
  printf '  %-34s %-7s %-9s %-6s %s%s\n' "$n" "$s" "$fbtxt" "${a}d" "$z" "$flag"
done
printf '\n  %d void (hold nothing) · %d filled (findings — route before deleting) · %d active\n\n' "${#VOID[@]}" "${#FILLED[@]}" "${#ACTIVE[@]}"

# Ephemeral funded rooms hold real (testnet) value, so an abandoned one is worth seeing on the board
# rather than discovering later. Read-only.
if ls .sandbox-*/.ephemeral-wallet.json >/dev/null 2>&1; then
  node --import tsx "$(dirname "$0")/sandbox-wallet.ts" report 2>/dev/null || true
fi

case "$MODE" in
  status)
    [ ${#VOID[@]} -gt 0 ] && echo "  delete the void ones:  bash scripts/sandbox-clean.sh --void"
    [ ${#FILLED[@]} -gt 0 ] && echo "  fix or file filled findings, then:  bash scripts/sandbox-clean.sh --wave <prefix> --routed"
    exit 0 ;;
  void)  SELECTED=(${VOID[@]+"${VOID[@]}"}) ;;
  wave)
    [ -n "$WAVE" ] || { echo "--wave needs a prefix (e.g. --wave w5)" >&2; exit 2; }
    for d in "${DIRS[@]}"; do case "$d" in ".sandbox-$WAVE"*) SELECTED+=("$d") ;; esac; done
    [ ${#SELECTED[@]} -gt 0 ] || { echo "no sandboxes match wave '$WAVE'." >&2; exit 1; } ;;
  all)   SELECTED=("${DIRS[@]}") ;;
  explicit)
    for d in ${EXPLICIT[@]+"${EXPLICIT[@]}"}; do
      d="${d%/}"
      [ -d "$d" ] || { echo "no such sandbox: $d" >&2; exit 1; }
      case "$d" in .sandbox|.sandbox-*) SELECTED+=("$d") ;; *) echo "not a sandbox dir: $d" >&2; exit 2 ;; esac
    done ;;
esac

# Never sweep a room out from under a running agent.
if [ "$FORCE" -eq 0 ] && [ ${#ACTIVE[@]} -gt 0 ]; then
  KEPT=(); DROPPED=()
  for d in ${SELECTED[@]+"${SELECTED[@]}"}; do
    skip=0; for a in ${ACTIVE[@]+"${ACTIVE[@]}"}; do [ "$d" = "$a" ] && skip=1; done
    if [ "$skip" -eq 1 ]; then DROPPED+=("$d"); else KEPT+=("$d"); fi
  done
  if [ ${#DROPPED[@]} -gt 0 ]; then
    echo "  ⚠ skipping ${#DROPPED[@]} room(s) touched in the last ${ACTIVE_MIN}m — a sweep in flight looks"
    echo "    exactly like a wave of void rooms. Wait for the agents, or pass --force if you are sure:"
    for d in ${DROPPED[@]+"${DROPPED[@]}"}; do echo "      $d"; done
    echo ""
  fi
  SELECTED=(${KEPT[@]+"${KEPT[@]}"})
  [ ${#SELECTED[@]} -gt 0 ] || { echo "  nothing left to delete."; exit 0; }
fi

# The guard that makes the prose rule real: a filled room can only go with --routed.
UNROUTED=()
for d in ${SELECTED[@]+"${SELECTED[@]}"}; do
  for f in ${FILLED[@]+"${FILLED[@]}"}; do [ "$d" = "$f" ] && UNROUTED+=("$d"); done
done
if [ ${#UNROUTED[@]} -gt 0 ] && [ "$ROUTED" -eq 0 ]; then
  echo "  ✗ refusing — these hold findings that may not be routed yet:" >&2
  for d in ${UNROUTED[@]+"${UNROUTED[@]}"}; do echo "      $d  ($(wc -l < "$d/FEEDBACK.md" | tr -d ' ') lines)" >&2; done
  echo "" >&2
  echo "  Fix them or link them to a public issue, then re-run with --routed to assert it." >&2
  exit 1
fi

echo "  will delete ${#SELECTED[@]}:"
for d in ${SELECTED[@]+"${SELECTED[@]}"}; do echo "      $d"; done
if [ "$YES" -eq 0 ] && [ -t 0 ]; then
  printf "  Continue? [y/N] "; read -r a; case "$a" in y|Y|yes) ;; *) echo "  aborted."; exit 1 ;; esac
fi
# Return any ephemeral wallet's remaining testnet ETH to the treasury BEFORE the room is deleted --
# once the room is gone so is the key, and the funds are unreachable forever. Best-effort ON PURPOSE:
# a sweep pays its own gas so a little dust always stays behind, and a failed sweep must never block
# cleanup over worthless testnet dust. It reports instead, so an unreturned balance is VISIBLE rather
# than silently stranded.
for d in ${SELECTED[@]+"${SELECTED[@]}"}; do
  if [ -f "$d/.ephemeral-wallet.json" ]; then
    echo "  sweeping $d ephemeral wallet back to the treasury"
    node --import tsx "$(dirname "$0")/sandbox-wallet.ts" sweep --file "$d/.ephemeral-wallet.json" 2>&1 | sed 's/^/    /' || true
  fi
done
for d in ${SELECTED[@]+"${SELECTED[@]}"}; do rm -rf "$d"; done
echo "  ✓ removed ${#SELECTED[@]} sandbox(es)."
