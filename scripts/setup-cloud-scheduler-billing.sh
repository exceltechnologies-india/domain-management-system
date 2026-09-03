#!/bin/bash
# setup-cloud-scheduler-billing.sh — wire Cloud Scheduler to invoke the
# Primary Billing Integration cron endpoints.
#
# Companion to scripts/setup-cloud-scheduler-tokens.sh, which owns the
# Tokens-flow jobs. Kept separate so the two feature areas can be
# re-provisioned independently.
#
# Idempotent — re-running on an existing job updates its config instead of
# erroring, so this is safe to run repeatedly (e.g. after rotating
# CRON_SECRET, or to change a schedule).
#
# Prerequisites:
#   - gcloud authenticated as a principal with cloudscheduler.admin on the
#     speedy-unison-453807-e9 project
#   - CRON_SECRET present in Google Secret Manager (shared with the other
#     crons); read inline here and embedded in the job's headers
#   - THE ROUTES MUST ALREADY BE DEPLOYED. This script preflights that and
#     refuses to create a job pointing at a 404 — see below.
#
# Usage:
#   bash scripts/setup-cloud-scheduler-billing.sh

set -euo pipefail

PROJECT="speedy-unison-453807-e9"
LOCATION="asia-south1"
APP_URL="https://app.anutech.in"

echo "──────────────────────────────────────────────────────────────"
echo "Cloud Scheduler setup for Primary Billing crons"
echo "──────────────────────────────────────────────────────────────"
echo "  Project:  $PROJECT"
echo "  Location: $LOCATION"
echo "  App URL:  $APP_URL"
echo ""

# ────────────────────────────────────────────────────────────────────────
# Preflight: is the route actually deployed?
#
# Why this exists (and why the tokens script doesn't have it): the dunning
# route shipped on the `primary-billing-integration` branch and does NOT
# exist on main. Creating a Scheduler job before that branch merges and
# deploys produces a job that quietly 404s on every run — Cloud Scheduler
# reports the failure, but only in its own logs, and the reminders that
# were supposed to start flowing simply never do. Failing loudly here is
# far better than a job that looks configured and does nothing.
#
# The endpoint requires `x-cron-secret`, so an unauthenticated probe should
# answer 401. 404 means not deployed. Anything else is unexpected and worth
# a human look before we point a scheduler at it.
# ────────────────────────────────────────────────────────────────────────
preflight() {
  local path="$1" name="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$APP_URL$path" || echo "000")
  case "$code" in
    401|403)
      echo "  ✓ $name is deployed (unauthenticated probe returned $code, as expected)"
      ;;
    404)
      echo "  ✗ $name returned 404 — the route is NOT deployed at $APP_URL$path"
      echo ""
      echo "    The renewal-payment-dunning route lives on the"
      echo "    'primary-billing-integration' branch and is not on main."
      echo "    Merge and deploy that branch first, then re-run this script."
      echo "    Creating the job now would schedule a permanent 404."
      return 1
      ;;
    000)
      echo "  ✗ $name could not be reached (network error / timeout)."
      echo "    Check connectivity to $APP_URL and re-run."
      return 1
      ;;
    *)
      echo "  ✗ $name returned an unexpected $code (expected 401)."
      echo "    Investigate before scheduling — a job pointing at a broken"
      echo "    endpoint will fail silently every run."
      return 1
      ;;
  esac
}

echo "──── Preflight ────"
if ! preflight "/api/cron/renewal-payment-dunning" "renewal-payment-dunning"; then
  exit 1
fi

CRON_SECRET=$(gcloud secrets versions access latest --secret=CRON_SECRET --project="$PROJECT" 2>/dev/null || true)
if [ -z "$CRON_SECRET" ]; then
  echo "✗ Could not read CRON_SECRET from Secret Manager."
  echo "  Verify your gcloud principal has secretmanager.versions.access on" \
       "projects/$PROJECT/secrets/CRON_SECRET, then re-run."
  exit 1
fi
echo "✓ CRON_SECRET retrieved from Secret Manager"

# ────────────────────────────────────────────────────────────────────────
# Job: renewal-payment-dunning — every 6 hours
#
# Chases renewal Orders left in status='pending' because the customer
# opened the Razorpay checkout from /api/user/hosting/renew and never
# completed payment. Sends escalating reminder emails at the
# RENEWAL_DUNNING_HOURS stages (default 24h / 72h / 7d after the order was
# created), then marks the order abandoned and stops.
#
# This is DISTINCT from the pre-expiry reminders driven by
# daily-scheduler -> process-service-expiry, which key off the service's
# expiry date and know nothing about a half-finished payment. This job
# chases the customer who already decided to pay and didn't finish — the
# most recoverable population there is.
#
# Why GET (the tokens jobs use POST): the route exports GET, since it takes
# no body and is safe to re-invoke.
#
# Why every 6 hours: the escalation stages are hour-granularity but a whole
# day apart, so four checks a day is ample — it just bounds how late a
# reminder can be (worst case ~6h after a stage is reached). A tighter
# cadence buys nothing; a daily one would make the 24h reminder land up to
# a day late. Runs at 02/08/14/20 IST to stay clear of the tokens jobs.
#
# The route is idempotent per stage: `dunningLastStageHours` records the
# last stage emailed, so a re-run (or an overlapping invocation) will not
# re-send a reminder the customer already got.
# ────────────────────────────────────────────────────────────────────────
echo ""
echo "──── Job: renewal-payment-dunning (every 6 hours) ────"
if gcloud scheduler jobs describe renewal-payment-dunning \
     --location="$LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  Job exists — updating config"
  ACTION="update"
else
  echo "  Creating new job"
  ACTION="create"
fi
gcloud scheduler jobs "$ACTION" http renewal-payment-dunning \
  --project="$PROJECT" \
  --location="$LOCATION" \
  --schedule="0 2,8,14,20 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="$APP_URL/api/cron/renewal-payment-dunning" \
  --http-method=GET \
  --headers="x-cron-secret=$CRON_SECRET" \
  --attempt-deadline=300s \
  --description="Renewal-payment dunning (Primary Billing Phase 2). Emails customers who opened the renewal checkout and never paid, at the RENEWAL_DUNNING_HOURS stages (default 24h/72h/7d), then marks the order abandoned. Idempotent per stage. Distinct from the pre-expiry reminders driven by daily-scheduler." \
  >/dev/null
echo "  ✓ renewal-payment-dunning configured"

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Done. Primary Billing Cloud Scheduler jobs are configured."
echo ""
gcloud scheduler jobs list --project="$PROJECT" --location="$LOCATION" \
  --filter="name:renewal-payment-dunning" \
  --format="table(name.basename(),schedule,state)"
echo ""
echo "Verify it works without waiting for the schedule:"
echo "  gcloud scheduler jobs run renewal-payment-dunning \\"
echo "    --location=$LOCATION --project=$PROJECT"
echo ""
echo "Then check the run result (look for [RenewalDunning] lines):"
echo "  gcloud logging read \\"
echo "    'resource.type=cloud_run_revision AND textPayload:\"[RenewalDunning]\"' \\"
echo "    --project=$PROJECT --limit=20 --freshness=10m"
echo ""
echo "Notes:"
echo "  - A run with no abandoned checkouts is a no-op and reports"
echo "    sent:0 — that is success, not a failure."
echo "  - To change the reminder cadence, set RENEWAL_DUNNING_HOURS on the"
echo "    Cloud Run service (a JSON array of hours, e.g. '[12,48,120]'):"
echo "      gcloud run services update dms --project=$PROJECT \\"
echo "        --region=europe-west1 \\"
echo "        --update-env-vars='RENEWAL_DUNNING_HOURS=[12,48,120]'"
echo "    deploy-cloud-run.sh preserves that value across deploys."
echo ""
echo "  - To pause the reminders without deleting the job:"
echo "      gcloud scheduler jobs pause renewal-payment-dunning \\"
echo "        --location=$LOCATION --project=$PROJECT"
