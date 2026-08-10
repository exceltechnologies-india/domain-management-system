#!/bin/bash
# deploy-cloud-run.sh — build and deploy the dms image to Cloud Run.
#
# Replaces the VPS `./deploy.sh` for the Cloud Run target. Builds the image
# either LOCALLY on this VPS via `docker build` + `docker push` (default —
# avoids Cloud Build cost) or via Cloud Build (--cloud-build), then deploys
# a new revision of the `dms` service.
#
# Usage:
#   ./scripts/deploy-cloud-run.sh                  # local docker build → push
#                                                  # → deploy (default)
#   ./scripts/deploy-cloud-run.sh --cloud-build    # use Cloud Build instead
#                                                  # of local docker (slower
#                                                  # to start, no VPS load,
#                                                  # but costs money)
#   ./scripts/deploy-cloud-run.sh --skip-build     # deploy current :latest image
#                                                  # without rebuilding
#   ./scripts/deploy-cloud-run.sh --skip-ci-check  # bypass the CI-green gate
#                                                  # (emergency hotfixes)
#   ./scripts/deploy-cloud-run.sh --preview=<tag>  # deploy as a NEW revision
#                                                  # with --no-traffic --tag=<tag>
#                                                  # instead of cutting over
#                                                  # production. Gets its own
#                                                  # URL (https://<tag>---dms-
#                                                  # <hash>.<region>.run.app);
#                                                  # 100% of real traffic stays
#                                                  # on the current revision.
#                                                  # Skips the git deploy-tag
#                                                  # step (that's for real
#                                                  # releases only).
#
# Local-build prerequisites (one-time, done 2026-06-17):
#   - Docker installed on the VPS (docker-ce 29+)
#   - User in `docker` group (so we don't need sudo each command)
#   - `gcloud auth configure-docker us-central1-docker.pkg.dev` run once so
#     Docker uses gcloud as the credential helper for the artifact-registry
#     hostname (config at ~/.docker/config.json)
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

# ── Deployment log ────────────────────────────────────────────────────────────
# Append one structured line per deploy attempt to `deployments.log` at the
# repo root. Captures who triggered, what commit, which Cloud Run revision
# (when reachable), final status, and total elapsed seconds. Override the
# path via `DEPLOY_LOG=path ./scripts/deploy-cloud-run.sh`.
#
# Gitignored by default — per-machine history. Cloud Build + Cloud Run
# logs already live in Cloud Logging; this file is the *summary index*:
# "what shipped when, and what was the revision name for rollback."
DEPLOY_LOG="${DEPLOY_LOG:-deployments.log}"
DEPLOY_START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DEPLOY_START_SEC=$SECONDS
DEPLOY_HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
DEPLOY_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
DEPLOY_ACTOR=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1 || echo "unknown")
DEPLOY_REVISION="unknown"
DEPLOY_STAGE="init"
DEPLOY_LOGGED=false

log_deploy() {
  local status="$1"
  local duration=$(( SECONDS - DEPLOY_START_SEC ))
  printf 'ts=%s commit=%s branch=%s actor=%s revision=%s status=%s stage=%s duration_s=%d\n' \
    "$DEPLOY_START_TS" \
    "${DEPLOY_HEAD_SHA:0:12}" \
    "$DEPLOY_BRANCH" \
    "$DEPLOY_ACTOR" \
    "$DEPLOY_REVISION" \
    "$status" \
    "$DEPLOY_STAGE" \
    "$duration" \
    >> "$DEPLOY_LOG"
  DEPLOY_LOGGED=true
}

# Catch every exit path — success writes its own line explicitly (below) and
# sets DEPLOY_LOGGED=true; the trap fires on early-exit cases (CI gate fail,
# build fail, smoke-test fail, etc.) so no deploy attempt is silently lost.
trap 'rc=$?; if [ "$DEPLOY_LOGGED" = "false" ]; then log_deploy "failed_exit_${rc}"; fi' EXIT

SKIP_BUILD=false
SKIP_CI_CHECK=false
BUILD_MODE=local   # `local` (docker build on this VPS) or `cloud` (gcloud builds submit)
PREVIEW_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-ci-check) SKIP_CI_CHECK=true; shift ;;
    --cloud-build) BUILD_MODE=cloud; shift ;;
    --local-build) BUILD_MODE=local; shift ;;
    --preview=*) PREVIEW_TAG="${1#--preview=}"; shift ;;
    --preview) PREVIEW_TAG="$2"; shift 2 ;;
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

DEPLOY_STAGE="ci_gate"
check_ci_green

# All overridable via env var (defaults are the real production target) —
# used to deploy an experimental preview into a DIFFERENT GCP project
# without touching this file's production defaults, e.g.:
#   DEPLOY_PROJECT=other-project DEPLOY_VPC_CONNECTOR= DEPLOY_SERVICE_ACCOUNT=other-sa@... \
#     ./scripts/deploy-cloud-run.sh --preview=x
# An empty DEPLOY_VPC_CONNECTOR means "don't attach a VPC connector at all"
# (fine — Redis/rate-limiting is a soft dependency, see lib/rate-limit.ts).
PROJECT="${DEPLOY_PROJECT:-speedy-unison-453807-e9}"
REGION="${DEPLOY_REGION:-europe-west1}"
SERVICE=dms
IMAGE="us-central1-docker.pkg.dev/${PROJECT}/dms/dms:latest"
VPC_CONNECTOR="${DEPLOY_VPC_CONNECTOR-dms-vpc-eu}"
SERVICE_ACCOUNT="${DEPLOY_SERVICE_ACCOUNT:-721945682828-compute@developer.gserviceaccount.com}"

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
echo "  Build:     ${BUILD_MODE}$($SKIP_BUILD && echo " (skipped via --skip-build)")"
if [ -n "$PREVIEW_TAG" ]; then
  echo "  Mode:      PREVIEW (tag=$PREVIEW_TAG) — no-traffic, production untouched"
fi
echo "════════════════════════════════════════"

# ── Step 1: build ─────────────────────────────────────────────────────────────
DEPLOY_STAGE="build"
if ! $SKIP_BUILD; then
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a

  if [ "$BUILD_MODE" = "local" ]; then
    # Local docker build on this VPS, then push to Artifact Registry. The
    # build runs synchronously so the user sees Docker's normal layered
    # output. ~12-18 minutes on a 2-vCPU box; the cost is VPS CPU/egress
    # rather than Cloud Build minutes. Falls back to Cloud Build if `docker`
    # is missing — keeps emergency hotfixes unblocked when running from a
    # workstation that doesn't have Docker.
    if ! command -v docker >/dev/null 2>&1; then
      echo "⚠️  --local-build requested but Docker is not installed."
      echo "    Either install Docker or rerun with --cloud-build."
      exit 1
    fi
    echo ""
    echo "📍 [1/2] Building image locally via Docker..."
    SHORT_SHA="${DEPLOY_HEAD_SHA:0:8}"
    docker build \
      --build-arg "NEXT_PUBLIC_RAZORPAY_KEY_ID=${NEXT_PUBLIC_RAZORPAY_KEY_ID:-}" \
      --build-arg "NEXT_PUBLIC_RECAPTCHA_SITE_KEY=${NEXT_PUBLIC_RECAPTCHA_SITE_KEY:-}" \
      --build-arg "NEXT_PUBLIC_FACEBOOK_ENABLED=${NEXT_PUBLIC_FACEBOOK_ENABLED:-false}" \
      --build-arg "NEXT_PUBLIC_GITHUB_ENABLED=${NEXT_PUBLIC_GITHUB_ENABLED:-false}" \
      --build-arg "NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL:-support@anutech.in}" \
      --tag "$IMAGE" \
      --tag "us-central1-docker.pkg.dev/${PROJECT}/dms/dms:${SHORT_SHA}" \
      .
    BUILD_EXIT=$?
    if [ $BUILD_EXIT -ne 0 ]; then
      echo "❌ Local docker build failed."
      exit 1
    fi
    echo "✅ Local build succeeded"
    echo ""
    echo "📍 [1b/2] Pushing image to Artifact Registry..."
    docker push "$IMAGE"
    PUSH_EXIT=$?
    docker push "us-central1-docker.pkg.dev/${PROJECT}/dms/dms:${SHORT_SHA}" >/dev/null 2>&1 || true
    if [ $PUSH_EXIT -ne 0 ]; then
      echo "❌ Image push failed."
      exit 1
    fi
    echo "✅ Image pushed: $IMAGE (also tagged :$SHORT_SHA)"
  else
    echo ""
    echo "📍 [1/2] Building image via Cloud Build (~4 min)..."
    gcloud builds submit \
      --config=cloudbuild.yaml \
      --substitutions="_NEXT_PUBLIC_RAZORPAY_KEY_ID=${NEXT_PUBLIC_RAZORPAY_KEY_ID:-},_NEXT_PUBLIC_RECAPTCHA_SITE_KEY=${NEXT_PUBLIC_RECAPTCHA_SITE_KEY:-},_NEXT_PUBLIC_FACEBOOK_ENABLED=${NEXT_PUBLIC_FACEBOOK_ENABLED:-false},_NEXT_PUBLIC_GITHUB_ENABLED=${NEXT_PUBLIC_GITHUB_ENABLED:-false},_NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL:-support@anutech.in}" \
      >/dev/null 2>&1 &
    BUILD_PID=$!
    while kill -0 $BUILD_PID 2>/dev/null; do printf "."; sleep 5; done
    wait $BUILD_PID
    BUILD_EXIT=$?
    echo ""
    if [ $BUILD_EXIT -ne 0 ]; then
      echo "❌ Build failed. See: gcloud builds list --limit=1"
      exit 1
    fi
    echo "✅ Build succeeded"
  fi
else
  echo ""
  echo "⏭️  [1/2] Build skipped"
fi

# ── Step 2: deploy ────────────────────────────────────────────────────────────
# The full --set-secrets and --set-env-vars are pulled from the generated file
# from seed-secrets.sh, OR pasted inline (this is the inline form, easier to
# read and version-control).
DEPLOY_STAGE="deploy"
echo ""
echo "📍 [2/2] Deploying to Cloud Run..."

# shellcheck disable=SC1091
set -a; source .env.local; set +a

# Sticky operator-toggled flags — preserve current Cloud Run values across
# full deploys.
#
# Why: this script uses `--set-env-vars` (which REPLACES the full env-var
# map on the new revision, not merges). For flags that the operator
# toggles in production via `gcloud run services update --update-env-vars`
# (notably HOSTING_MANDATE_FLOW for the Tokens/Subscriptions/Manual
# selector), a naive `--set-env-vars` deploy reverts the flag to whatever
# this script's shell sees — which is usually unset → default
# 'subscriptions'. That silent revert bit us at 2026-06-29 06:28Z
# (revision dms-00209-ldb flipped HOSTING_MANDATE_FLOW from 'manual' back
# to 'subscriptions' mid-launch). Fix: query the active revision's
# current value and use that as the deploy-time value, so deploys are
# idempotent against operator flag flips. Falls back to shell env / file
# default if the service doesn't exist yet (first deploy).
read_current_env_var() {
  local var_name="$1"
  gcloud run services describe "$SERVICE" \
    --project="$PROJECT" \
    --region="$REGION" \
    --format=json 2>/dev/null \
  | node -e "
    let buf = '';
    process.stdin.on('data', c => buf += c);
    process.stdin.on('end', () => {
      try {
        const env = JSON.parse(buf).spec.template.spec.containers[0].env;
        const hit = env.find(e => e.name === '$var_name');
        if (hit && hit.value !== undefined) process.stdout.write(hit.value);
      } catch {}
    });
  " 2>/dev/null
}

CURRENT_HOSTING_MANDATE_FLOW=$(read_current_env_var "HOSTING_MANDATE_FLOW")
# Resolution order: current Cloud Run value (highest — preserves operator
# flag flips) → shell env (e.g. operator exports HOSTING_MANDATE_FLOW
# before invoking this script) → 'subscriptions' (safest default for
# first-time deploys before any operator decision).
HOSTING_MANDATE_FLOW="${CURRENT_HOSTING_MANDATE_FLOW:-${HOSTING_MANDATE_FLOW:-subscriptions}}"
echo "   HOSTING_MANDATE_FLOW resolved to: ${HOSTING_MANDATE_FLOW}"

# Same sticky-flag pattern for the trial-abuse kill switch. Operator
# may flip TRIAL_ABUSE_DISABLED=true at runtime to bypass abuse
# defenses during launch-day testing (see lib/trial-abuse.ts ::
# isTrialAbuseDisabled). Without preservation, the next full deploy
# would silently drop the bypass mid-test. Default is empty (unset),
# meaning abuse defenses are ACTIVE.
CURRENT_TRIAL_ABUSE_DISABLED=$(read_current_env_var "TRIAL_ABUSE_DISABLED")
TRIAL_ABUSE_DISABLED="${CURRENT_TRIAL_ABUSE_DISABLED:-${TRIAL_ABUSE_DISABLED:-}}"
echo "   TRIAL_ABUSE_DISABLED resolved to: ${TRIAL_ABUSE_DISABLED:-<unset>}"

# Build the env-vars string. ^|^ delimiter handles commas in values defensively.
# Empty DEPLOY_REDIS_HOST means "omit REDIS_HOST/PORT entirely" — lib/rate-limit.ts
# treats a missing host as "not configured" and fails open immediately, vs.
# pointing at an unreachable private IP (e.g. no VPC connector in this target
# project) which would fail open only after a real connection timeout per request.
REDIS_HOST="${DEPLOY_REDIS_HOST-10.70.203.51}"
REDIS_ENV_SEGMENT=""
if [ -n "$REDIS_HOST" ]; then
  REDIS_ENV_SEGMENT="REDIS_HOST=${REDIS_HOST}|REDIS_PORT=${DEPLOY_REDIS_PORT:-6379}|"
fi

# Override when the actual serving URL differs from .env.local's dev value
# (e.g. a Cloud Run preview deploy) — otherwise auth/redirect logic that
# builds URLs from these bakes in localhost and sends users back to your
# machine instead of the deployed app.
APP_URL_RESOLVED="${DEPLOY_APP_URL:-${APP_URL:-}}"
NEXTAUTH_URL_RESOLVED="${DEPLOY_NEXTAUTH_URL:-${NEXTAUTH_URL:-}}"

# Cross-service URLs — override when the target Billing/DSP instance for
# this deploy isn't the same one .env.local points at locally (e.g. this
# Customer Panel preview should talk to a Billing preview, not localhost).
BILLING_API_URL_RESOLVED="${DEPLOY_BILLING_API_URL:-${BILLING_API_URL:-}}"
DSP_API_URL_RESOLVED="${DEPLOY_DSP_API_URL:-${DSP_API_URL:-}}"
DSP_SUPPORT_URL_RESOLVED="${DEPLOY_DSP_SUPPORT_URL:-${DSP_SUPPORT_URL:-}}"
NEXT_PUBLIC_DSP_SUPPORT_URL_RESOLVED="${DEPLOY_DSP_SUPPORT_URL:-${NEXT_PUBLIC_DSP_SUPPORT_URL:-}}"

ENV_VARS="ADMIN_EMAIL=${ADMIN_EMAIL:-}|APP_URL=${APP_URL_RESOLVED}|BILLING_API_URL=${BILLING_API_URL_RESOLVED}|BILLING_INTEGRATION_API_KEY=${BILLING_INTEGRATION_API_KEY:-}|BILLING_PROVISION_API_KEY=${BILLING_PROVISION_API_KEY:-}|BILLING_COMMAND_API_KEY=${BILLING_COMMAND_API_KEY:-}|DSP_API_URL=${DSP_API_URL_RESOLVED}|DSP_INTEGRATION_API_KEY=${DSP_INTEGRATION_API_KEY:-}|DSP_SUPPORT_URL=${DSP_SUPPORT_URL_RESOLVED}|NEXT_PUBLIC_DSP_SUPPORT_URL=${NEXT_PUBLIC_DSP_SUPPORT_URL_RESOLVED}|SSO_SHARED_SECRET=${SSO_SHARED_SECRET:-}|DIRECTADMIN_IP=${DIRECTADMIN_IP:-}|FROM_EMAIL=${FROM_EMAIL:-}|FROM_NAME=${FROM_NAME:-}|GCP_PROJECT_ID=${PROJECT}|GCP_QUEUE_LOCATION=${GCP_QUEUE_LOCATION:-us-central1}|GCP_QUEUE_NAME=${GCP_QUEUE_NAME:-}|HOSTING_MANDATE_FLOW=${HOSTING_MANDATE_FLOW}|NEXTAUTH_URL=${NEXTAUTH_URL_RESOLVED}|NEXT_PUBLIC_FACEBOOK_ENABLED=${NEXT_PUBLIC_FACEBOOK_ENABLED:-false}|NEXT_PUBLIC_GITHUB_ENABLED=${NEXT_PUBLIC_GITHUB_ENABLED:-false}|NEXT_PUBLIC_RAZORPAY_KEY_ID=${NEXT_PUBLIC_RAZORPAY_KEY_ID:-}|NEXT_PUBLIC_RECAPTCHA_SITE_KEY=${NEXT_PUBLIC_RECAPTCHA_SITE_KEY:-}|${REDIS_ENV_SEGMENT}RESELLERCLUB_API_URL=${RESELLERCLUB_API_URL:-https://httpapi.com}|SMTP_HOST=${SMTP_HOST:-}|SMTP_PORT=${SMTP_PORT:-587}|SMTP_SECURE=${SMTP_SECURE:-false}|SUPPORT_EMAIL=${SUPPORT_EMAIL:-}|TRIAL_ABUSE_DISABLED=${TRIAL_ABUSE_DISABLED}|ZOHO_DC=${ZOHO_DC:-.in}|ZOHO_LOCATION_ID=${ZOHO_LOCATION_ID:-}|ZOHO_ORG_ID=${ZOHO_ORG_ID:-}|ZOHO_ORG_STATE=${ZOHO_ORG_STATE:-}|ZOHO_TAX_ID_GST18=${ZOHO_TAX_ID_GST18:-}|ZOHO_TAX_ID_IGST18=${ZOHO_TAX_ID_IGST18:-}"

SECRETS_FLAG="ADMIN_PASSWORD=ADMIN_PASSWORD:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,CRON_SECRET=CRON_SECRET:latest,DIRECTADMIN_ADMIN_USER=DIRECTADMIN_ADMIN_USER:latest,DIRECTADMIN_API_KEY=DIRECTADMIN_API_KEY:latest,DIRECTADMIN_URL=DIRECTADMIN_URL:latest,FACEBOOK_CLIENT_ID=FACEBOOK_CLIENT_ID:latest,FACEBOOK_CLIENT_SECRET=FACEBOOK_CLIENT_SECRET:latest,GITHUB_CLIENT_ID=GITHUB_CLIENT_ID:latest,GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,JWT_SECRET=JWT_SECRET:latest,MONGODB_URI=MONGODB_URI:latest,NEXTAUTH_SECRET=NEXTAUTH_SECRET:latest,RAZORPAY_KEY_ID=RAZORPAY_KEY_ID:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,RECAPTCHA_SECRET_KEY=RECAPTCHA_SECRET_KEY:latest,RESELLERCLUB_ID=RESELLERCLUB_ID:latest,RESELLERCLUB_RESELLER_ID=RESELLERCLUB_RESELLER_ID:latest,RESELLERCLUB_SECRET=RESELLERCLUB_SECRET:latest,SMTP_PASS=SMTP_PASS:latest,SMTP_USER=SMTP_USER:latest,ZOHO_CLIENT_ID=ZOHO_CLIENT_ID:latest,ZOHO_CLIENT_SECRET=ZOHO_CLIENT_SECRET:latest,ZOHO_REFRESH_TOKEN=ZOHO_REFRESH_TOKEN:latest,META_CAPI_ACCESS_TOKEN=META_CAPI_ACCESS_TOKEN:latest"

DEPLOY_ARGS=(
  --image="$IMAGE"
  --region="$REGION"
  --platform=managed
  --allow-unauthenticated
  --memory=1Gi
  --cpu=1
  --min-instances=0
  --max-instances=5
  --timeout=300
  --concurrency=80
  --service-account="$SERVICE_ACCOUNT"
  --set-secrets="$SECRETS_FLAG"
  --set-env-vars="^|^${ENV_VARS}"
  --quiet
)
# concurrency is paired with lib/mongodb.ts:maxPoolSize (currently 50).
# Bumping concurrency without raising maxPoolSize will queue requests
# behind the pool and add latency proportional to query duration.

if [ -n "$VPC_CONNECTOR" ]; then
  DEPLOY_ARGS+=(--vpc-connector="$VPC_CONNECTOR" --vpc-egress=all-traffic)
fi

if [ -n "$PREVIEW_TAG" ]; then
  # Cloud Run refuses --no-traffic when the service doesn't exist yet (there's
  # no existing revision for traffic to stay pinned to). On a genuinely first
  # deploy there's no production traffic to protect anyway, so just do a
  # normal deploy and skip the tag/no-traffic flags for this one call.
  if gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
    # New revision gets its own URL and zero production traffic — the
    # currently-serving revision keeps 100% until someone explicitly shifts
    # traffic (or does a normal, non-preview deploy).
    DEPLOY_ARGS+=(--no-traffic --tag="$PREVIEW_TAG")
  else
    echo "ℹ️  Service '$SERVICE' doesn't exist yet in $PROJECT — first deploy, --preview tag skipped (nothing to protect)."
    PREVIEW_TAG=""
  fi
fi

gcloud run deploy "$SERVICE" "${DEPLOY_ARGS[@]}" 2>&1 | tail -5

# ── Smoke test ────────────────────────────────────────────────────────────────
DEPLOY_STAGE="smoke_test"
DEPLOY_REVISION=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.latestReadyRevisionName)' 2>/dev/null || echo "unknown")
if [ -n "$PREVIEW_TAG" ]; then
  # Tagged-revision URLs follow https://<tag>---<service>-<hash>.<region>.run.app.
  # Derive it from the service's base URL rather than hardcoding the hash.
  BASE_URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
  URL="${BASE_URL/https:\/\//https://${PREVIEW_TAG}---}"
else
  URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
fi
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
if [ -n "$PREVIEW_TAG" ]; then
  echo "✅ Preview deployed (production traffic untouched): $URL"
  echo "   Revision: $DEPLOY_REVISION (tag: $PREVIEW_TAG, --no-traffic)"
  echo "   Promote to production later with:"
  echo "     gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=$DEPLOY_REVISION=100"
else
  echo "✅ Deployed: $URL"
  echo "   Revision: $DEPLOY_REVISION"
  echo "   Roll back with: gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=<previous-revision>=100"
  echo "   List revisions: gcloud run revisions list --service=$SERVICE --region=$REGION"
fi

log_deploy "success"
echo "   Logged to: $DEPLOY_LOG"

# ── Git tag the deploy ───────────────────────────────────────────────────────
# Annotated tag per successful deploy: `deploy-<YYYYMMDD-HHMMSSZ>-<short-sha>`,
# with the structured log line in the tag message. Browsable in GitHub's tags
# UI; `git log deploy-X..deploy-Y` shows what shipped between releases.
#
# Skip if not in a git repo (e.g. running from a release tarball), if the
# commit is "unknown" (we couldn't resolve HEAD earlier), or if `git tag` /
# `git push` fails — the deploy already succeeded, tag noise is cosmetic.
# Set `DEPLOY_SKIP_TAG=true` to opt out entirely.
if [ -z "$PREVIEW_TAG" ] && [ "${DEPLOY_SKIP_TAG:-false}" != "true" ] && [ "$DEPLOY_HEAD_SHA" != "unknown" ]; then
  TAG_NAME="deploy-$(date -u -d "$DEPLOY_START_TS" +%Y%m%d-%H%M%SZ 2>/dev/null || date -u +%Y%m%d-%H%M%SZ)-${DEPLOY_HEAD_SHA:0:8}"
  TAG_MSG="status=success revision=$DEPLOY_REVISION actor=$DEPLOY_ACTOR duration_s=$(( SECONDS - DEPLOY_START_SEC )) branch=$DEPLOY_BRANCH commit=$DEPLOY_HEAD_SHA url=$URL"
  if git tag -a "$TAG_NAME" -m "$TAG_MSG" "$DEPLOY_HEAD_SHA" 2>/dev/null; then
    if git push origin "$TAG_NAME" >/dev/null 2>&1; then
      echo "   Tagged:   $TAG_NAME (pushed to origin)"
    else
      echo "   Tagged:   $TAG_NAME (local only — push failed; run: git push origin $TAG_NAME)"
    fi
  else
    echo "   ⚠️  Tag '$TAG_NAME' creation failed (already exists?) — skipping"
  fi
fi
