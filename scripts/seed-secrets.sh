#!/bin/bash
# seed-secrets.sh — provision .env.local values to GCP Secret Manager
#
# Reads .env.local, splits the keys into "secrets" (must live in Secret
# Manager) vs "config env vars" (safe to pass as plain --set-env-vars on the
# Cloud Run service), and for each secret:
#   1. Creates the Secret Manager entry if it doesn't exist
#   2. Adds a new version with the value from .env.local
#   3. Grants the Cloud Run service account the secretAccessor role
#
# After provisioning, prints the exact --set-secrets and --set-env-vars
# flags to paste into `gcloud run deploy`.
#
# Usage:
#   ./scripts/seed-secrets.sh                     # provision everything
#   ./scripts/seed-secrets.sh --dry-run           # show what would happen
#   ./scripts/seed-secrets.sh --skip-existing     # don't add new versions
#                                                 # to already-existing secrets
#
# Optional env override:
#   SERVICE_ACCOUNT=...  use a custom Cloud Run SA instead of the project's
#                        default Compute Engine SA

set -uo pipefail

DRY_RUN=false
SKIP_EXISTING=false
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --skip-existing) SKIP_EXISTING=true; shift ;;
    -h|--help)
      sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

# ── Pre-flight ────────────────────────────────────────────────────────────────
command -v gcloud >/dev/null 2>&1 || {
  echo "❌ gcloud CLI is not installed."
  echo "   Install it: https://cloud.google.com/sdk/docs/install"
  exit 1
}

ACTIVE_ACCT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
if [ -z "$ACTIVE_ACCT" ]; then
  echo "❌ gcloud is not authenticated."
  echo "   Run: gcloud auth login"
  exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "❌ No GCP project is set."
  echo "   Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if [ ! -f .env.local ]; then
  echo "❌ .env.local not found in $(pwd)."
  echo "   Run this script from the project root (the directory that contains .env.local)."
  exit 1
fi

# Default Cloud Run service account = project's Compute Engine default SA.
# Caller can override via SERVICE_ACCOUNT=...
if [ -z "$SERVICE_ACCOUNT" ]; then
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null)
  if [ -z "$PROJECT_NUMBER" ]; then
    echo "❌ Could not look up the project number for $PROJECT_ID. Check 'gcloud config get-value project'."
    exit 1
  fi
  SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

echo "════════════════════════════════════════"
echo "  Active account:  $ACTIVE_ACCT"
echo "  GCP project:     $PROJECT_ID"
echo "  Service account: $SERVICE_ACCOUNT"
echo "  .env.local:      $(pwd)/.env.local"
$DRY_RUN && echo "  Mode:            DRY RUN (no changes)"
$SKIP_EXISTING && echo "  Mode:            --skip-existing (won't add versions to existing secrets)"
echo "════════════════════════════════════════"
echo ""

# Enable the API early. Idempotent.
if ! $DRY_RUN; then
  echo "📍 Ensuring Secret Manager API is enabled..."
  gcloud services enable secretmanager.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true
fi

# ── Load .env.local values ────────────────────────────────────────────────────
# shellcheck disable=SC1091
set -a
source .env.local
set +a

# ── Key inventory ─────────────────────────────────────────────────────────────
# SECRETS live in Secret Manager. ENV_VARS are plain config — safe to pass as
# --set-env-vars (visible in the Cloud Run service config). The split is
# conservative: anything that grants access, embeds credentials, or could be
# used to impersonate is a secret, even if it's a "client ID" that's
# technically semi-public.
SECRETS=(
  ADMIN_PASSWORD
  ANTHROPIC_API_KEY
  CRON_SECRET
  DIRECTADMIN_ADMIN_USER
  DIRECTADMIN_API_KEY
  DIRECTADMIN_URL
  FACEBOOK_CLIENT_ID
  FACEBOOK_CLIENT_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  JWT_SECRET
  MONGODB_URI
  NEXTAUTH_SECRET
  RAZORPAY_KEY_ID
  RAZORPAY_KEY_SECRET
  RAZORPAY_WEBHOOK_SECRET
  RECAPTCHA_SECRET_KEY
  RESELLERCLUB_ID
  RESELLERCLUB_RESELLER_ID
  RESELLERCLUB_SECRET
  SMTP_PASS
  SMTP_USER
  ZOHO_CLIENT_ID
  ZOHO_CLIENT_SECRET
  ZOHO_REFRESH_TOKEN
)

ENV_VARS=(
  ADMIN_EMAIL
  APP_URL
  FROM_EMAIL
  FROM_NAME
  GCP_PROJECT_ID
  GCP_QUEUE_LOCATION
  GCP_QUEUE_NAME
  NEXTAUTH_URL
  NEXT_PUBLIC_FACEBOOK_ENABLED
  NEXT_PUBLIC_GITHUB_ENABLED
  NEXT_PUBLIC_RAZORPAY_KEY_ID
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY
  REDIS_HOST
  REDIS_PORT
  RESELLERCLUB_API_URL
  SMTP_HOST
  SMTP_PORT
  SMTP_SECURE
  SUPPORT_EMAIL
  ZOHO_DC
  ZOHO_LOCATION_ID
  ZOHO_ORG_ID
  ZOHO_ORG_STATE
)

# ── Provision secrets ─────────────────────────────────────────────────────────
CREATED=0
UPDATED=0
SKIPPED_EMPTY=0
SKIPPED_EXISTING=0
IAM_FAILED=0

for KEY in "${SECRETS[@]}"; do
  VALUE="${!KEY:-}"
  if [ -z "$VALUE" ]; then
    echo "⚠️  $KEY is empty in .env.local — skipping"
    SKIPPED_EMPTY=$((SKIPPED_EMPTY + 1))
    continue
  fi

  if gcloud secrets describe "$KEY" --project="$PROJECT_ID" >/dev/null 2>&1; then
    # Already exists
    if $SKIP_EXISTING; then
      echo "⏭️  $KEY already exists — skipping (--skip-existing)"
      SKIPPED_EXISTING=$((SKIPPED_EXISTING + 1))
    elif $DRY_RUN; then
      echo "  [dry-run] would add a new version to $KEY"
    else
      printf '%s' "$VALUE" | gcloud secrets versions add "$KEY" --data-file=- --project="$PROJECT_ID" >/dev/null
      echo "🔄 $KEY — new version added"
      UPDATED=$((UPDATED + 1))
    fi
  else
    # New secret
    if $DRY_RUN; then
      echo "  [dry-run] would CREATE secret $KEY"
    else
      gcloud secrets create "$KEY" --replication-policy=automatic --project="$PROJECT_ID" >/dev/null
      printf '%s' "$VALUE" | gcloud secrets versions add "$KEY" --data-file=- --project="$PROJECT_ID" >/dev/null
      echo "✅ $KEY — created"
      CREATED=$((CREATED + 1))
    fi
  fi

  # Bind the Cloud Run SA. Idempotent — gcloud no-ops if the binding exists.
  if ! $DRY_RUN; then
    if ! gcloud secrets add-iam-policy-binding "$KEY" \
        --member="serviceAccount:$SERVICE_ACCOUNT" \
        --role="roles/secretmanager.secretAccessor" \
        --project="$PROJECT_ID" >/dev/null 2>&1; then
      echo "   ⚠️  Failed to bind IAM for $KEY (does $SERVICE_ACCOUNT exist?)"
      IAM_FAILED=$((IAM_FAILED + 1))
    fi
  fi
done

echo ""
echo "════════════════════════════════════════"
echo "  Summary"
echo "════════════════════════════════════════"
echo "  Created:           $CREATED"
echo "  Updated:           $UPDATED"
echo "  Skipped (empty):   $SKIPPED_EMPTY"
echo "  Skipped (exists):  $SKIPPED_EXISTING"
echo "  IAM failures:      $IAM_FAILED"
echo "════════════════════════════════════════"
echo ""

# ── Emit the gcloud run deploy flags ──────────────────────────────────────────
echo "📋 Paste these flags into your \`gcloud run deploy\` command:"
echo ""
echo "  --service-account=$SERVICE_ACCOUNT \\"
echo ""

# --set-secrets
SECRETS_PAIRS=""
for KEY in "${SECRETS[@]}"; do
  if [ -n "${!KEY:-}" ]; then
    SECRETS_PAIRS+="${KEY}=${KEY}:latest,"
  fi
done
SECRETS_PAIRS="${SECRETS_PAIRS%,}"

if [ -n "$SECRETS_PAIRS" ]; then
  echo "  --set-secrets='$SECRETS_PAIRS' \\"
  echo ""
fi

# --set-env-vars
# Use the ^|^ delimiter so values containing commas (rare here, but defensive)
# don't break parsing.
ENV_PAIRS=""
for KEY in "${ENV_VARS[@]}"; do
  if [ -n "${!KEY:-}" ]; then
    ENV_PAIRS+="${KEY}=${!KEY}|"
  fi
done
ENV_PAIRS="${ENV_PAIRS%|}"

if [ -n "$ENV_PAIRS" ]; then
  echo "  --set-env-vars='^|^${ENV_PAIRS}' \\"
  echo ""
fi

echo "  # Plus your VPC connector, image, region, memory, etc."
echo ""

# ── Reminders ─────────────────────────────────────────────────────────────────
echo "✅ Done."
echo ""
echo "📌 Reminders before you go live:"
echo "   • Rotate any credential ever in a previously-pushed Docker image."
echo "   • MongoDB Atlas: allowlist the Cloud Run egress IP (or VPC NAT)."
echo "   • Redis ($REDIS_HOST): create a Serverless VPC Access connector"
echo "     and pass --vpc-connector=NAME --vpc-egress=private-ranges-only."
echo "   • Cloud Scheduler: create jobs for the cron endpoints"
echo "     (pending-sweeper, daily-scheduler, check-unprovisioned, check-hosting-expiry)."
echo "   • Update Razorpay webhook URL after the deploy URL is known."
echo "   • Update OAuth redirect URIs in Google/Facebook/GitHub consoles."
