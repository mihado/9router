#!/usr/bin/env bash
# scripts/upstream-recheck.sh
#
# Security re-check for upstream syncs. Run after every `git fetch upstream` / merge,
# before building or publishing. Implements the checklist in docs/SECURITY-REVIEW.md
# and the gaps in docs/SECURITY-DOC-AUDIT.md.
#
# Post-hardening invariants:
#   - No tunnel subsystem (cloudflared, tailscale)
#   - No default password (INITIAL_PASSWORD mandatory)
#   - No stale upstream references (9router.com, decolua/9router)
#   - No Google Analytics / third-party beacons
#   - No ChangelogModal fetch → dangerouslySetInnerHTML path
#
# Combines structural (ast-grep) and text (ripgrep) checks.
#
# Usage:
#   ./scripts/upstream-recheck.sh                  # full scan
#   ./scripts/upstream-recheck.sh --diff <ref>     # show changed files + full scan
#
# Requires: ast-grep (sg) and ripgrep (rg) on PATH.
# Install:  brew install ast-grep ripgrep

set -euo pipefail

REF=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --diff) REF="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# //; s/^#//'; exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SG="${SG:-sg}"
RG="${RG:-rg}"

command -v "$SG" >/dev/null 2>&1 || { echo "Error: ast-grep (sg) not found. Install: brew install ast-grep"; exit 1; }
command -v "$RG" >/dev/null 2>&1 || { echo "Error: ripgrep (rg) not found. Install: brew install ripgrep"; exit 1; }

RED=$'\033[0;31m'
GRN=$'\033[0;32m'
YEL=$'\033[0;33m'
CYN=$'\033[0;36m'
BOLD=$'\033[1m'
NC=$'\033[0m'

FAIL=0
N=0

hdr()    { N=$((N+1)); printf '\n%s[%02d]%s %s\n' "$CYN" "$N" "$NC" "$1"; }
pass()   { printf '  %spass%s: %s\n' "$GRN" "$NC" "$1"; }
fail()   { printf '  %sFAIL%s: %s (known, accepted)\n' "$RED" "$NC" "$1"; FAIL=1; }
block()  { printf '  %sBLOCK%s: %s — do not build/publish\n' "$RED" "$NC" "$1"; FAIL=1; }
warn()   { printf '  %sWARN%s: %s\n' "$YEL" "$NC" "$1"; }
manual() { printf '  %smanual%s: %s\n' "$YEL" "$NC" "$1"; }

rg_ok()  { "$RG" -q "$@" 2>/dev/null; }
sg_ok()  { [ -n "$("$SG" run "$@" 2>/dev/null || true)" ]; }

echo "${BOLD}${CYN}═══ 9router upstream-sync re-check ═══${NC}"
echo "Repo: $REPO_ROOT"
[ -n "$REF" ] && { echo "Diff: $REF..HEAD"; git -C "$REPO_ROOT" diff --name-only "$REF"..HEAD 2>/dev/null | head -30 | sed 's/^/  /'; }

# ── 1. GA/beacons (must stay removed) ──
hdr "Third-party beacons (GA, gtag, @next/third-parties)"
rg_ok 'gtag|googletagmanager|google-analytics|@next/third-parties' "$REPO_ROOT/src/" && block "detected" || pass "absent"
pass "deps check: @next/third-parties in package.json" && { rg_ok '@next/third-parties' "$REPO_ROOT/package.json" && block "present in deps" || pass "not in deps"; }

# ── 2. Tunnel subsystem (must stay deleted) ──
hdr "Tunnel subsystem (cloudflared, tailscale)"
for f in \
  "src/lib/tunnel/" \
  "src/app/api/tunnel/" \
  "src/lib/appUpdater.js" \
  "src/app/api/version/update/"; do
  [ -e "$REPO_ROOT/$f" ] && block "$f still present" || pass "absent  $f"
done

# ── 3. Default password (must stay deleted) ──
hdr "Default password (INITIAL_PASSWORD mandatory)"
rg_ok 'DEFAULT_PASSWORD|"123456"' "$REPO_ROOT/src/" && block "found in src/" \
  || pass "no DEFAULT_PASSWORD or '123456' in src/"
sg_ok -p 'process.env.$KEY || "123456"' --lang js "$REPO_ROOT/src/" && block "structural fallback" \
  || pass "no process.env || \"123456\" structural fallback"

# ── 4. MITM defaults ──
hdr "MITM defaults"
rg_ok 'mitmEnabled.*true' "$REPO_ROOT/src/shared/services/initializeApp.js" "$REPO_ROOT/src/lib/" 2>/dev/null \
  && block "defaults to true" || pass "default-off"

# ── 5. Egress to 9router.com ──
hdr "Egress to 9router.com"
rg_ok '9router\.com' "$REPO_ROOT/src/" && block "in src/" || pass "absent from src/"
rg_ok '9router\.com' "$REPO_ROOT/.env.example" && fail "still in .env.example (GAP-4)" \
  || pass "absent from .env.example"

# ── 6. Skills external URLs ──
hdr "Skills — upstream references (informational)"
echo "  Skills reference upstream raw URLs (serve to AI agents):"
"$RG" -n 'decolua/9router|9router\.com' "$REPO_ROOT/skills/" 2>/dev/null | head -10 | sed 's/^/    /' || true
echo "  $(rg -ln 'decolua/9router|9router\.com' "$REPO_ROOT/skills/" 2>/dev/null | wc -l | tr -d ' ') skill files with upstream refs"

# ── 7. ChangelogModal removed (must stay removed — fetch+innerHTML XSS path) ──
hdr "ChangelogModal"
for f in "src/shared/components/ChangelogModal.js"; do
  [ -e "$REPO_ROOT/$f" ] && block "$f still present" || pass "absent  $f"
done

# ── 8. Stale i18n/README readmes ──
hdr "Stale readmes (i18n/, README.zh-CN.md)"
for f in "i18n/" "README.zh-CN.md" "skills/README.md" "cli/README.md"; do
  [ -e "$REPO_ROOT/$f" ] && block "$f still present" || pass "absent  $f"
done

# ── 9. dangerouslySetInnerHTML sites ──
hdr "dangerouslySetInnerHTML sites"
echo "  All sites (verify sanitization):"
"$RG" -n 'dangerouslySetInnerHTML' "$REPO_ROOT/src/" 2>/dev/null | sed 's/^/    /' || true

# ── 10. Stale references repo-wide ──
hdr "Stale 9router.com / decolua references (repo-wide)"
"$RG" -n '9router\.com|decolua/9router' "$REPO_ROOT/" \
  --glob '!pnpm-lock.yaml' --glob '!node_modules' --glob '!.next' \
  --glob '!docs/SECURITY-REVIEW.md' --glob '!docs/SECURITY-DOC-AUDIT.md' \
  --glob '!docs/ARCHITECTURE.md' --glob '!docs/*' \
  --glob '!README.md' --glob '!AGENTS.md' --glob '!DOCKER.md' \
  --glob '!scripts/*' \
  --glob '!gitbook/*' \
  2>/dev/null | head -30 | sed 's/^/    /'
echo "  $(rg -ln '9router\.com|decolua/9router' "$REPO_ROOT/" --glob '!pnpm-lock.yaml' --glob '!node_modules' --glob '!.next' --glob '!docs/*' --glob '!scripts/*' --glob '!gitbook/*' --glob '!README.md' --glob '!AGENTS.md' --glob '!DOCKER.md' 2>/dev/null | wc -l | tr -d ' ') files outside gitbook/docs with stale refs"

# ── 11. Lockfile + build ──
hdr "Lockfile + build"
manual "Run: pnpm install --frozen-lockfile && docker build ."

# ── SSRF guard ──
hdr "SSRF guard"
manual "Verify src/shared/utils/ssrfGuard.js still has string-only guard"

# ── Auth surface ──
hdr "Auth surface"
manual "Review src/dashboardGuard.js allowlist for new unauthenticated routes"

# ═══ Summary ═══
echo ""
echo "${BOLD}${CYN}═══ Summary ═══${NC}"
if [ "$FAIL" -gt 0 ]; then
  printf '%sBLOCK: %d regressions found — do not build/publish%s\n' "$RED" "$FAIL" "$NC"
  exit 1
else
  printf '%sAll automated checks passed%s\n' "$GRN" "$NC"
  printf '%sManual checks remain — see checklist items above%s\n' "$YEL" "$NC"
  exit 0
fi
