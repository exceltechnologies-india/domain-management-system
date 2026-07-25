#!/usr/bin/env bash
#
# switch-razorpay-mode.sh — flip Razorpay between TEST and LIVE in one command.
#
# On Cloud Run the client checkout key (NEXT_PUBLIC_RAZORPAY_KEY_ID) is baked
# into the JS bundle at BUILD time, so switching modes requires a full rebuild
# + redeploy — it cannot be a runtime toggle. This script does the whole swap:
#   1. reads the chosen mode's key set from .env.local
#   2. writes them into the ACTIVE Razorpay vars in .env.local
#   3. pushes the 3 secret values to Google Secret Manager (via stdin)
#   4. runs the standard deploy (full rebuild bakes the new NEXT_PUBLIC key)
#
# ── One-time setup (operator) ────────────────────────────────────────────────
# Add BOTH key sets to .env.local (never committed — gitignored):
#   RAZORPAY_TEST_KEY_ID=rzp_test_xxxxx
#   RAZORPAY_TEST_KEY_SECRET=xxxxx
#   RAZORPAY_TEST_WEBHOOK_SECRET=xxxxx
#   RAZORPAY_LIVE_KEY_ID=rzp_live_xxxxx
#   RAZORPAY_LIVE_KEY_SECRET=xxxxx
#   RAZORPAY_LIVE_WEBHOOK_SECRET=xxxxx
# (Tip: copy your current live keys into the RAZORPAY_LIVE_* slots.)
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   bash scripts/switch-razorpay-mode.sh test
#   bash scripts/switch-razorpay-mode.sh live
#   bash scripts/switch-razorpay-mode.sh test --no-deploy   # swap keys only
#
set -euo pipefail

MODE="${1:-}"
NO_DEPLOY=false
[ "${2:-}" = "--no-deploy" ] && NO_DEPLOY=true

if [ "$MODE" != "test" ] && [ "$MODE" != "live" ]; then
  echo "Usage: bash scripts/switch-razorpay-mode.sh <test|live> [--no-deploy]"
  exit 1
fi

cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo "❌ .env.local missing"; exit 1; }

# Load env (source in a subshell-safe way)
set -a; source .env.local; set +a

UP=$(echo "$MODE" | tr '[:lower:]' '[:upper:]')
eval "KID=\${RAZORPAY_${UP}_KEY_ID:-}"
eval "KSEC=\${RAZORPAY_${UP}_KEY_SECRET:-}"
eval "WSEC=\${RAZORPAY_${UP}_WEBHOOK_SECRET:-}"

if [ -z "$KID" ] || [ -z "$KSEC" ]; then
  echo "❌ RAZORPAY_${UP}_KEY_ID / RAZORPAY_${UP}_KEY_SECRET not set in .env.local."
  echo "   Add both key sets first (see the one-time setup notes at the top of this script)."
  exit 1
fi

# Safety guard: the key prefix must match the requested mode so you can't
# accidentally push LIVE keys while thinking you're in TEST (or vice-versa).
EXPECT="rzp_${MODE}_"
case "$KID" in
  ${EXPECT}*) : ;;
  *) echo "❌ RAZORPAY_${UP}_KEY_ID does not start with '${EXPECT}' — refusing to switch (mismatched key)."; exit 1 ;;
esac

echo "════════════════════════════════════════"
echo "  Switching Razorpay → ${UP} mode"
echo "  key_id: ${KID}"
echo "  (webhook secret: $([ -n "$WSEC" ] && echo set || echo 'not set — keeping current'))"
echo "════════════════════════════════════════"

# 1. Update the ACTIVE vars in .env.local (used for local dev + baked into the
#    NEXT_PUBLIC client bundle at build time).
python_esc() { printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'; }
perl -pi -e "s/^RAZORPAY_KEY_ID=.*/RAZORPAY_KEY_ID=$(python_esc "$KID")/" .env.local
perl -pi -e "s/^RAZORPAY_KEY_SECRET=.*/RAZORPAY_KEY_SECRET=$(python_esc "$KSEC")/" .env.local
perl -pi -e "s/^NEXT_PUBLIC_RAZORPAY_KEY_ID=.*/NEXT_PUBLIC_RAZORPAY_KEY_ID=$(python_esc "$KID")/" .env.local
[ -n "$WSEC" ] && perl -pi -e "s/^RAZORPAY_WEBHOOK_SECRET=.*/RAZORPAY_WEBHOOK_SECRET=$(python_esc "$WSEC")/" .env.local
echo "✅ .env.local updated (active keys + NEXT_PUBLIC client key)"

# 2. Push the 3 secret values to Google Secret Manager (stdin — never on the CLI).
export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-C:/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe}"
PROJECT="${GCP_PROJECT_ID:-speedy-unison-453807-e9}"
add_secret() { printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project="$PROJECT" >/dev/null && echo "   $1 → new version"; }
echo "→ updating Secret Manager (project $PROJECT)…"
add_secret RAZORPAY_KEY_ID "$KID"
add_secret RAZORPAY_KEY_SECRET "$KSEC"
[ -n "$WSEC" ] && add_secret RAZORPAY_WEBHOOK_SECRET "$WSEC"
echo "✅ Secret Manager updated"

if [ "$NO_DEPLOY" = true ]; then
  echo "⏭  --no-deploy: skipping redeploy. Run 'bash scripts/deploy-cloud-run.sh' to apply."
  exit 0
fi

# 3. Full rebuild + deploy so the new NEXT_PUBLIC client key is baked in.
echo "→ deploying (full rebuild so the client checkout key switches too)…"
bash scripts/deploy-cloud-run.sh
echo "✅ Razorpay is now in ${UP} mode (server + client). Verify on Admin → Payments (mode banner)."
