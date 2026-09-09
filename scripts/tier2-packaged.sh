#!/usr/bin/env bash
#
# tier2-packaged.sh — the publish-faithful check, as a command instead of a paragraph.
#
# This covers published-layout behavior a source-based sandbox cannot: the `files` manifest,
# `bin` resolution, bundled assets, declared dependencies, and the deployment manifest embedded in
# the tarball.
#
#   bash scripts/tier2-packaged.sh            # pack, install, assert, clean up
#   bash scripts/tier2-packaged.sh --keep     # leave the temp consumer for poking at
#
# Runs entirely in a temp dir with a temp HOME, so it can never touch your real ~/.claude or
# node_modules. Read-only against the network (one doctor RPC probe); it signs nothing.
set -euo pipefail

DEV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/abx-tier2-XXXXXX")"
cleanup() { [ "$KEEP" -eq 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0
FAIL=0
ok()   { printf "  \033[38;5;115m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }
note() { printf "    \033[2m%s\033[0m\n" "$1"; }

echo ""
echo "  Tier 2 — publish-faithful packaged check"
note "work dir: $WORK"
echo ""

# 1. Pack every workspace package. `pnpm pack` (NOT `npm pack`) is required: pnpm rewrites
#    `workspace:*` into the real version, and npm does not — an npm-packed tarball fails to install
#    with EUNSUPPORTEDPROTOCOL.
echo "  packing"
mkdir -p "$WORK/tgz"
for p in sdk cli indexer token-api storage storage-arweave effects; do
  (cd "$DEV_ROOT/packages/$p" && pnpm pack --pack-destination "$WORK/tgz" >/dev/null)
done
COUNT=$(ls -1 "$WORK/tgz"/*.tgz | wc -l | tr -d ' ')
[ "$COUNT" -eq 7 ] && ok "packed $COUNT tarballs" || bad "expected 7 tarballs, got $COUNT"

# 2. Install them together into a clean consumer. Passing all seven local tarballs at once keeps the
#    check honest: npm satisfies each @artblocks/* dep from OUR tarball rather than downloading the
#    published sibling, so what runs below is this working tree.
echo "  installing as a consumer"
mkdir -p "$WORK/consumer"
(
  cd "$WORK/consumer"
  npm init -y >/dev/null 2>&1
  npm install "$WORK"/tgz/*.tgz >/dev/null 2>&1
)
ABX="$WORK/consumer/node_modules/.bin/abx"
[ -x "$ABX" ] && ok "bin/abx is executable (bin field + shebang resolve)" || bad "node_modules/.bin/abx missing or not executable"

TEST_HOME="$WORK/home"
mkdir -p "$TEST_HOME"
export ABX_NO_UPDATE_CHECK=1
# `|| true`: a release gate must report EVERY finding, not die on the first one. With `set -e`, a
# non-zero `abx` would otherwise abort the script before it can report every check.
run() { (cd "$WORK/consumer" && env HOME="$TEST_HOME" "$ABX" "$@" 2>&1) || true; }

# 3. A DEFAULT consumer — the six non-Arweave tarballs only, exactly what `npm install
#    @artblocks/abx-cli` pulls in — must install NONE of Turbo's dependency tree. This is the
#    regression gate: `@ardrive/turbo-sdk` -> `x402-fetch` -> `x402` -> `wagmi` drags
#    in the entire browser wallet-connector ecosystem, and `@artblocks/abx-storage` used to list
#    turbo-sdk/arbundles under optionalDependencies — which npm installs by default whenever they
#    install successfully (optionalDependencies only tolerates install FAILURE, e.g. fsevents; it
#    does not skip a package that installs fine everywhere). The fix moved the Turbo/arbundles
#    implementation into the separate, explicitly-installed `@artblocks/abx-storage-arweave`
#    package, which storage reaches only via a lazy `await import()` and declares only as an
#    OPTIONAL peerDependency (peerDependencies, unlike optionalDependencies, are never
#    auto-installed by npm/pnpm unless the consumer installs them too).
echo "  default install excludes the optional Arweave/Turbo dependency tree"
mkdir -p "$WORK/consumer-default"
# The storage-arweave tarball is deliberately excluded — a default `npm install @artblocks/abx-cli`
# never sees it (it's not in any package's dependencies/optionalDependencies, only an OPTIONAL peer
# of @artblocks/abx-storage — see the comment above).
DEFAULT_TGZ=$(ls "$WORK"/tgz/*.tgz | grep -v 'abx-storage-arweave')
(
  cd "$WORK/consumer-default"
  npm init -y >/dev/null 2>&1
  npm install $DEFAULT_TGZ >/dev/null 2>&1
)
BANNED_PATTERN='@ardrive/turbo-sdk|@dha-team/arbundles|^wagmi$|@reown/|@walletconnect/|@metamask/|@coinbase/|@base-org/|^porto$|x402'
FOUND=$(find "$WORK/consumer-default/node_modules" -maxdepth 2 -mindepth 1 -type d 2>/dev/null | sed "s#.*/node_modules/##" | grep -E "$BANNED_PATTERN" || true)
if [ -z "$FOUND" ]; then
  ok "default install has zero Turbo/wagmi/wallet-connector packages"
else
  bad "default install pulled in Turbo/wallet packages it must not"
  note "found: $(printf '%s' "$FOUND" | tr '\n' ' ')"
fi
[ -d "$WORK/consumer-default/node_modules/@artblocks/abx-storage" ] \
  && ok "default install still has @artblocks/abx-storage (fs/cloud/ipfs backends unaffected)" \
  || bad "default install is missing @artblocks/abx-storage entirely"

# 4. Bundled skill path, end to end on the installed artifact.
# `pwd -P` on both sides: macOS resolves /var to /private/var, and $TMPDIR carries a trailing slash,
# so a literal string compare can fail on paths that are the same directory.
PKG="$(cd "$WORK/consumer/node_modules/@artblocks/abx-cli" && pwd -P)"
SKILL_OUT="$(run skill path)"
SKILL_RAW="$(printf '%s' "$SKILL_OUT" | tail -1 | tr -d '\r')"
SKILL_PATH="$([ -d "$SKILL_RAW" ] && (cd "$SKILL_RAW" && pwd -P) || printf '%s' "$SKILL_RAW")"
if [ "$SKILL_PATH" = "$PKG/skill" ]; then
  ok "skill path resolves to <pkg>/skill"
else
  bad "skill path resolved to '$SKILL_PATH' (expected $PKG/skill)"
  note "the bundled skill must resolve from the installed package root"
fi

# Capture first, then match. Piping straight into `grep -q` makes grep exit on the first hit, which
# SIGPIPEs the CLI, which `set -o pipefail` then reports as a failed command.
SKILL_INSTALL_OUT="$(run skill install)"
if printf '%s' "$SKILL_INSTALL_OUT" | grep -q "installed the abx skill"; then
  ok "skill install writes the skill"
  [ -f "$TEST_HOME/.claude/skills/abx/SKILL.md" ] || [ -f "$WORK/consumer/.claude/skills/abx/SKILL.md" ] \
    && ok "SKILL.md landed on disk" || bad "skill install reported success but wrote no SKILL.md"
else
  bad "skill install failed — the canonical install path is broken"
fi

# 5. Bundled renderer scaffold.
if run scaffold-renderer "$WORK/consumer/rr" >/dev/null 2>&1 && [ -f "$WORK/consumer/rr/foundry.toml" ]; then
  ok "scaffold-renderer copies its bundled assets"
else
  bad "scaffold-renderer produced no foundry.toml — bundled assets did not resolve"
fi

# 6. The tarball must carry the CURRENT address manifest, not whatever was last published. Compared
#    against the working tree's own SDK rather than a number pasted here, so it cannot go stale.
EXPECTED_FACTORY=$(cd "$DEV_ROOT/packages/sdk" && node -e "
import('./src/deployments.ts').then(m => console.log(m.DEPLOYMENTS[11155111].factory)).catch(() => {
  const s = require('fs').readFileSync('src/deployments.ts','utf8');
  console.log((/factory:\s*'(0x[0-9a-fA-F]{40})'/.exec(s) || [])[1] ?? '');
});" 2>/dev/null | tail -1)
PACKED_FACTORY=$(cd "$WORK/consumer" && node -e "
import('@artblocks/abx-sdk').then(m => console.log(m.getDeployment(11155111).factory));" 2>/dev/null | tail -1)
if [ -n "$EXPECTED_FACTORY" ] && [ "$PACKED_FACTORY" = "$EXPECTED_FACTORY" ]; then
  ok "packed manifest matches the working tree ($PACKED_FACTORY)"
else
  bad "packed manifest has '$PACKED_FACTORY', tree has '$EXPECTED_FACTORY'"
fi

# 7. Doctor is the first thing a new user runs, so it has to survive on a bare install.
DOCTOR_OUT="$(run doctor)"
if printf '%s' "$DOCTOR_OUT" | grep -q "agent skill"; then
  ok "doctor runs on a bare install"
else
  bad "doctor did not produce its checklist"
fi

# 8. Do the published SDK's .d.ts files still typecheck against a viem resolved fresh from the
#    registry, rather than the repo's own pinned lockfile? Every check above builds from source
#    against OUR lockfile's viem, so a real incompatibility between viem's declared types and
#    ours (a generic reshaped under a semver-compatible bump) would slip past every one of them
#    and land on a consumer's first `npm install`. This is the one place that gets checked.
echo "  typechecking published SDK against consumer's own viem"
# Pin the consumer's TypeScript to the same major.minor this repo declares (root package.json:
# "typescript": "^5.8.0"). The variable under test here is VIEM, not TypeScript — compiling the
# published .d.ts with an older tsc than we author them with would fail on our own syntax and
# report it as a viem incompatibility, which is the one wrong answer this check can give.
(cd "$WORK/consumer" && npm install --save-dev 'typescript@^5.8.0' >/dev/null 2>&1)
mkdir -p "$WORK/consumer/typecheck"
cp "$DEV_ROOT/scripts/fixtures/tier2-viem-typecheck.ts" "$WORK/consumer/typecheck/check.ts"
cat > "$WORK/consumer/typecheck/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    // skipLibCheck is FALSE deliberately (tsconfig is JSONC, so this comment is legal). With it ON,
    // tsc skips every .d.ts — including the SDK's OWN published declarations, which is precisely
    // where a viem generic reshaped under a semver-compatible bump would surface. Leaving it on
    // would check only this fixture's usage and let the real failure through, so the check would
    // pass while claiming something it never verified. If a third-party .d.ts ever makes this
    // unusable, narrow it with an exclude rather than switching it back on.
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["check.ts"]
}
EOF
TSC_LOG="$WORK/typecheck.log"
if (cd "$WORK/consumer/typecheck" && "$WORK/consumer/node_modules/.bin/tsc" -p tsconfig.json) >"$TSC_LOG" 2>&1; then
  ok "published SDK types typecheck against consumer's installed viem"
else
  bad "published SDK types do NOT typecheck against the consumer's installed viem"
  note "a consumer running a plain 'npm install @artblocks/abx-sdk' would get this same type error"
  note "reproduce: bash scripts/tier2-packaged.sh --keep, then: cd <kept consumer>/typecheck && ../node_modules/.bin/tsc -p tsconfig.json"
  note "fix: either update SDK code/types for the new viem, or narrow the 'viem' range in every package.json (see AGENTS.md)"
  sed 's/^/    /' "$TSC_LOG"
fi

# 9. The flip side of check 3: installing `@artblocks/abx-storage-arweave` explicitly must actually
#    unlock the `turbo` provider's dynamic import — not just "not error about a missing package".
#    `$WORK/consumer` has all seven tarballs (including storage-arweave). Calls `arweaveFunding`
#    directly (not through the CLI) with a structurally-valid-but-fake JWK, and only reads
#    `funding.address()` — a pure derivation — so this stays network-free like the rest of tier2.
UNLOCK_OUT=$(cd "$WORK/consumer" && node -e "
import('@artblocks/abx-storage').then(async (m) => {
  const jwk = {kty: 'RSA', n: 'bW9kdWx1cw', e: 'AQAB'};
  const funding = await m.arweaveFunding({gateway: 'https://arweave.net', provider: 'turbo', jwk});
  console.log('RESOLVED ' + (await funding.address()));
}).catch((e) => { console.log('FAILED ' + e.message); });
" 2>&1)
if printf '%s' "$UNLOCK_OUT" | grep -q "^RESOLVED "; then
  ok "installing @artblocks/abx-storage-arweave unlocks the turbo provider (dynamic import resolves)"
else
  bad "installing @artblocks/abx-storage-arweave did not unlock the turbo provider"
  note "$UNLOCK_OUT"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[38;5;115m✓ Tier 2 clean\033[0m — %s checks passed against the packaged artifact\n\n" "$PASS"
else
  printf "  \033[31m✗ Tier 2 FAILED\033[0m — %s passed, %s failed\n\n" "$PASS" "$FAIL"
  [ "$KEEP" -eq 1 ] && note "consumer kept at $WORK/consumer"
  exit 1
fi
