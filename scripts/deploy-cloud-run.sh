#!/bin/bash
# deploy-cloud-run.sh — build and deploy the dms image to Cloud Run.
#
# Replaces the VPS `./deploy.sh` for the Cloud Run target. Builds the image
# via Cloud Build, then deploys a new revision of the `dms` service.
#
# Usage:
#   ./scripts/deploy-cloud-run.sh                  # build + deploy
#   ./scripts/deploy-cloud-run.sh --skip-build     # deploy current :latest image
#                                                  # without rebuilding
#   ./scripts/deploy-cloud-run.sh --skip-ci-check  # bypass the CI-green gate
#                                                  # (emergency hotfixes)
#
# Pre-deploy CI gate (added 2026-05-20):
#   The script refuses to deploy when the latest GitHub Actions CI run for
#   the current HEAD commit is `failure`, `cancelled`, or still
#   `in_progress`. This catches "I forgot to push tests are red" and
#   "tests haven't finished yet, deploy will land before signal" cases.
#   Requires `gh` CLI authenticated against this repo. If `gh` is missing,
#   the gate prints a warning and proceeds (so first-time users / local
#   dev aren't blocked by tooling). Pass --skip-ci-check to bypass.
#
# Required state (one-time setup; already done):
#   - gcloud auth login + project speedy-unison-453807-e9 set
#   - Secrets provisioned in Secret Manager via scripts/seed-secrets.sh
#   - Memorystore Redis "app-redis-eu" in europe-west1
#   - VPC connector "dms-vpc-eu" in europe-west1
#   - Artifact Registry repo "dms" in us-central1
#   - Service "dms" exists in Cloud Run europe-west1

set -uo pipefail

SKIP_BUILD=false
SKIP_CI_CHECK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-ci-check) SKIP_CI_CHECK=true; shift ;;
    -h|--help)
      sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

# ── Pre-flight: CI-green gate ────────────────────────────────────────────────
# Reads the GitHub Actions CI conclusion for the current HEAD commit and
# blocks deploy when it's not green. Requires `gh` CLI authenticated; without
# gh, the gate prints a warning and proceeds (don't block local dev tooling).
check_ci_green() {
  if $SKIP_CI_CHECK; then
    echo "⏭️  CI gate skipped via --skip-ci-check"
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "⚠️  gh CLI not installed — skipping CI gate. Install: brew install gh / apt install gh"
    return 0
  fi

  if ! gh auth status >/dev/null 2>&1; then
    echo "⚠️  gh CLI not authenticated — skipping CI gate. Run: gh auth login"
    return 0
  fi

  local HEAD_SHA
  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || {
    echo "⚠️  Not in a git repo — skipping CI gate"
    return 0
  }

  echo "📍 CI gate: checking GitHub Actions for ${HEAD_SHA:0:8}..."
  # Look up the latest CI workflow run for this exact commit. Filter to the
  # "CI" workflow only so a separate audit job (informational/passes anyway)
  # doesn't shadow the result.
  local RUN_JSON
  RUN_JSON=$(gh run list --commit "$HEAD_SHA" --workflow "CI" --limit 1 --json status,conclusion,url,databaseId 2>/dev/null) || {
    echo "⚠️  gh run list failed — skipping CI gate"
    return 0
  }

  # Empty array means GitHub hasn't picked up the push yet (race condition
  # between `git push` and Actions queueing). Hold for a tick rather than
  # silently deploying past CI — but cap the wait so the deploy doesn't
  # hang forever.
  local TRIES=0
  while [ "$(echo "$RUN_JSON" | tr -d '[:space:]')" = "[]" ] && [ $TRIES -lt 6 ]; do
    echo "⏳ No CI run for this commit yet (GitHub still queueing); waiting 10s..."
    sleep 10
    RUN_JSON=$(gh run list --commit "$HEAD_SHA" --workflow "CI" --limit 1 --json status,conclusion,url,databaseId 2>/dev/null) || break
    TRIES=$((TRIES + 1))
  done

  if [ "$(echo "$RUN_JSON" | tr -d '[:space:]')" = "[]" ]; then
    echo "❌ No CI run found for commit ${HEAD_SHA:0:8} after waiting 60s."
    echo "   Did you push to origin? Run: git push origin main"
    echo "   To bypass: ./scripts/deploy-cloud-run.sh --skip-ci-check"
    exit 1
  fi

  # Parse status/conclusion via grep+sed (jq isn't always installed). Format
  # is `[{"status":"completed","conclusion":"success","url":"…"}]`.
  local STATUS CONCLUSION URL
  STATUS=$(echo "$RUN_JSON" | grep -o '"status":"[^"]*"' | head -1 | sed 's/.*"status":"\([^"]*\)"/\1/')
  CONCLUSION=$(echo "$RUN_JSON" | grep -o '"conclusion":"[^"]*"' | head -1 | sed 's/.*"conclusion":"\([^"]*\)"/\1/')
  URL=$(echo "$RUN_JSON" | grep -o '"url":"[^"]*"' | head -1 | sed 's/.*"url":"\([^"]*\)"/\1/')

  case "$STATUS" in
    completed)
      if [ "$CONCLUSION" = "success" ]; then
        echo "✅ CI green for ${HEAD_SHA:0:8}"
        return 0
      fi
      echo "❌ CI conclusion: $CONCLUSION (commit ${HEAD_SHA:0:8})"
      echo "   $URL"
      echo "   To bypass: ./scripts/deploy-cloud-run.sh --skip-ci-check"
      exit 1
      ;;
    in_progress|queued|requested|waiting|pending)
      echo "⏳ CI still running ($STATUS): $URL"
      echo "   Wait for it to finish, or bypass: --skip-ci-check"
      exit 1
      ;;
    *)
      echo "⚠️  Unknown CI status: $STATUS — proceeding"
      ;;
  esac
}

check_ci_green

PROJECT=speedy-unison-453807-e9
REGION=europe-west1
SERVICE=dms
IMAGE="us-central1-docker.pkg.dev/${PROJECT}/dms/dms:latest"
VPC_CONNECTOR=dms-vpc-eu
SERVICE_ACCOUNT="721945682828-compute@developer.gserviceaccount.com"

# ── Pre-flight ────────────────────────────────────────────────────────────────
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1
ACTIVE_ACCT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
[ -z "$ACTIVE_ACCT" ] && { echo "❌ gcloud not authenticated. Run: gcloud auth login"; exit 1; }
[ ! -f .env.local ] && { echo "❌ .env.local missing"; exit 1; }

echo "════════════════════════════════════════"
echo "  Account:   $ACTIVE_ACCT"
echo "  Project:   $PROJECT"
echo "  Region:    $REGION"
echo "  Service:   $SERVICE"
echo "  Image:     $IMAGE"
$SKIP_BUILD && echo "  Mode:      --skip-build (deploying existing :latest)"
echo "════════════════════════════════════════"

# ── Step 1: build ─────────────────────────────────────────────────────────────
if ! $SKIP_BUILD; then
  echo ""
  echo "📍 [1/2] Building image via Cloud Build (~4 min)..."
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a

  gcloud builds submit \
    --config=cloudbuild.yaml \
    --substitutions="_NEXT_PUBLIC_RAZORPAY_KEY_ID=${NEXT_PUBLIC_RAZORPAY_KEY_ID:-},_NEXT_PUBLIC_RECAPTCHA_SITE_KEY=${NEXT_PUBLIC_RECAPTCHA_SITE_KEY:-},_NEXT_PUBLIC_FACEBOOK_ENABLED=${NEXT_PUBLIC_FACEBOOK_ENABLED:-false},_NEXT_PUBLIC_GITHUB_ENABLED=${NEXT_PUBLIC_GITHUB_ENABLED:-false},_NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL:-support@anutech.in}" \
    >/dev/null 2>&1 &
  BUILD_PID=$!
  # Print progress dots while build runs
  while kill -0 $BUILD_PID 2>/dev/null; do printf "."; sleep 5; done
  wait $BUILD_PID
  BUILD_EXIT=$?
  echo ""
  if [ $BUILD_EXIT -ne 0 ]; then
    echo "❌ Build failed. See: gcloud builds list --limit=1"
    exit 1
  fi
  echo "✅ Build succeeded"
else
  echo ""
  echo "⏭️  [1/2] Build skipped"
fi

# ── Step 2: deploy ────────────────────────────────────────────────────────────
# The full --set-secrets and --set-env-vars are pulled from the generated file
# from seed-secrets.sh, OR pasted inline (this is the inline form, easier to
# read and version-control).
echo ""
echo "📍 [2/2] Deploying to Cloud Run..."

# shellcheck disable=SC1091
set -a; source .env.local; set +a

# Build the env-vars string. ^|^ delimiter handles commas in values defensively.
ENV_VARS="ADMIN_EMAIL=${ADMIN_EMAIL:-}|APP_URL=${APP_URL:-}|FROM_EMAIL=${FROM_EMAIL:-}|FROM_NAME=${FROM_NAME:-}|GCP_PROJECT_ID=${PROJECT}|GCP_QUEUE_LOCATION=${GCP_QUEUE_LOCATION:-us-central1}|GCP_QUEUE_NAME=${GCP_QUEUE_NAME:-}|NEXTAUTH_URL=${NEXTAUTH_URL:-}|NEXT_PUBLIC_FACEBOOK_ENABLED=${NEXT_PUBLIC_FACEBOOK_ENABLED:-false}|NEXT_PUBLIC_GITHUB_ENABLED=${NEXT_PUBLIC_GITHUB_ENABLED:-false}|NEXT_PUBLIC_RAZORPAY_KEY_ID=${NEXT_PUBLIC_RAZORPAY_KEY_ID:-}|NEXT_PUBLIC_RECAPTCHA_SITE_KEY=${NEXT_PUBLIC_RECAPTCHA_SITE_KEY:-}|REDIS_HOST=10.70.203.51|REDIS_PORT=6379|RESELLERCLUB_API_URL=${RESELLERCLUB_API_URL:-https://httpapi.com}|SMTP_HOST=${SMTP_HOST:-}|SMTP_PORT=${SMTP_PORT:-587}|SMTP_SECURE=${SMTP_SECURE:-false}|SUPPORT_EMAIL=${SUPPORT_EMAIL:-}|ZOHO_DC=${ZOHO_DC:-.in}|ZOHO_LOCATION_ID=${ZOHO_LOCATION_ID:-}|ZOHO_ORG_ID=${ZOHO_ORG_ID:-}|ZOHO_ORG_STATE=${ZOHO_ORG_STATE:-}"

SECRETS_FLAG="ADMIN_PASSWORD=ADMIN_PASSWORD:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,CRON_SECRET=CRON_SECRET:latest,DIRECTADMIN_ADMIN_USER=DIRECTADMIN_ADMIN_USER:latest,DIRECTADMIN_API_KEY=DIRECTADMIN_API_KEY:latest,DIRECTADMIN_URL=DIRECTADMIN_URL:latest,FACEBOOK_CLIENT_ID=FACEBOOK_CLIENT_ID:latest,FACEBOOK_CLIENT_SECRET=FACEBOOK_CLIENT_SECRET:latest,GITHUB_CLIENT_ID=GITHUB_CLIENT_ID:latest,GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,JWT_SECRET=JWT_SECRET:latest,MONGODB_URI=MONGODB_URI:latest,NEXTAUTH_SECRET=NEXTAUTH_SECRET:latest,RAZORPAY_KEY_ID=RAZORPAY_KEY_ID:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,RECAPTCHA_SECRET_KEY=RECAPTCHA_SECRET_KEY:latest,RESELLERCLUB_ID=RESELLERCLUB_ID:latest,RESELLERCLUB_RESELLER_ID=RESELLERCLUB_RESELLER_ID:latest,RESELLERCLUB_SECRET=RESELLERCLUB_SECRET:latest,SMTP_PASS=SMTP_PASS:latest,SMTP_USER=SMTP_USER:latest,ZOHO_CLIENT_ID=ZOHO_CLIENT_ID:latest,ZOHO_CLIENT_SECRET=ZOHO_CLIENT_SECRET:latest,ZOHO_REFRESH_TOKEN=ZOHO_REFRESH_TOKEN:latest"

gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=5 \
  --timeout=300 \
  --concurrency=80 \
  `# concurrency is paired with lib/mongodb.ts:maxPoolSize (currently 50).` \
  `# Bumping concurrency without raising maxPoolSize will queue requests` \
  `# behind the pool and add latency proportional to query duration.` \
  --service-account="$SERVICE_ACCOUNT" \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress=all-traffic \
  --set-secrets="$SECRETS_FLAG" \
  --set-env-vars="^|^${ENV_VARS}" \
  --quiet 2>&1 | tail -5

# ── Smoke test ────────────────────────────────────────────────────────────────
URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
echo ""
echo "📍 Smoke test:"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "$URL/api/health")
if [ "$HTTP" = "200" ]; then
  echo "  ✅ $URL/api/health → 200 OK"
else
  echo "  ❌ $URL/api/health → HTTP $HTTP"
  echo "  Recent logs: gcloud logging read 'resource.labels.service_name=$SERVICE' --limit=20"
  exit 1
fi

echo ""
echo "✅ Deployed: $URL"
echo "   Roll back with: gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=<previous-revision>=100"
echo "   List revisions: gcloud run revisions list --service=$SERVICE --region=$REGION"
