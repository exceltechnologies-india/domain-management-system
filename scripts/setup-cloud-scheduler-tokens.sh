#!/bin/bash
# setup-cloud-scheduler-tokens.sh — wire Cloud Scheduler to invoke the
# two Tokens-flow worker endpoints.
#
# This is the operator-facing one-command setup for the Tokens migration
# crons. Idempotent — re-running on an existing job updates its config
# instead of erroring. Safe to invoke during dry-runs / staging /
# production (the workers themselves are dormant until
# HOSTING_MANDATE_FLOW=tokens is set on the Cloud Run service).
#
# Prerequisites:
#   - gcloud authenticated as a principal with cloudscheduler.admin on the
#     speedy-unison-453807-e9 project
#   - CRON_SECRET set in Google Secret Manager (already present — used by
#     other existing crons); this script reads it inline at job-creation
#     time, so the secret is embedded in the job config and applied as the
#     `x-cron-secret` header on every Scheduler-driven invocation
#   - The two worker routes already deployed (Phase 2H: 5fae71a) —
#     `/api/workers/tokens-provision-pending` and
#     `/api/workers/tokens-charge-recurring`
#
# Usage:
#   bash scripts/setup-cloud-scheduler-tokens.sh

set -euo pipefail

PROJECT="speedy-unison-453807-e9"
LOCATION="asia-south1"
APP_URL="https://app.anutech.in"

# Pull CRON_SECRET from Secret Manager. The scheduler job stores it
# embedded in its HTTP headers; rotating CRON_SECRET later means re-running
# this script (or editing both jobs via `gcloud scheduler jobs update`).
echo "──────────────────────────────────────────────────────────────"
echo "Cloud Scheduler setup for Tokens-flow crons"
echo "──────────────────────────────────────────────────────────────"
echo "  Project:  $PROJECT"
echo "  Location: $LOCATION"
echo "  App URL:  $APP_URL"
echo ""

CRON_SECRET=$(gcloud secrets versions access latest --secret=CRON_SECRET --project="$PROJECT" 2>/dev/null || true)
if [ -z "$CRON_SECRET" ]; then
  echo "✗ Could not read CRON_SECRET from Secret Manager."
  echo "  Verify your gcloud principal has secretmanager.versions.access on" \
       "projects/$PROJECT/secrets/CRON_SECRET, then re-run."
  exit 1
fi
echo "✓ CRON_SECRET retrieved from Secret Manager"

# ────────────────────────────────────────────────────────────────────────
# Job 1: tokens-provision-pending — every 10 min
#
# Flow-agnostic as of 2026-07-02 (despite the legacy job name): picks
# up Hostings in status='pending' + empty directAdminUsername created
# by EITHER the Tokens-flow webhook handler (Phase 2C) OR the
# Manual-flow create-order route. Creates the DA user via the existing
# DirectAdmin createUser helper. On success the Hosting flips to
# status='active' + welcome email fires with mandateMode derived from
# the record. Short cadence (10 min) means trial signup →
# DA-account-ready in under 10 min for the customer.
#
# Job name kept as `tokens-provision-pending` to avoid churn on
# existing scheduler references; the underlying worker + service are
# already flow-agnostic.
# ────────────────────────────────────────────────────────────────────────
echo ""
echo "──── Job 1: tokens-provision-pending (every 10 min) ────"
if gcloud scheduler jobs describe tokens-provision-pending \
     --location="$LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  Job exists — updating config"
  ACTION="update"
else
  echo "  Creating new job"
  ACTION="create"
fi
gcloud scheduler jobs "$ACTION" http tokens-provision-pending \
  --project="$PROJECT" \
  --location="$LOCATION" \
  --schedule="*/10 * * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="$APP_URL/api/workers/tokens-provision-pending" \
  --http-method=POST \
  --headers="x-cron-secret=$CRON_SECRET" \
  --attempt-deadline=60s \
  --description="Flow-agnostic DA-provisioning cron (Phase 2E/2H, made flow-agnostic 2026-07-02). Picks up Hostings in status='pending' + empty directAdminUsername for BOTH Tokens-flow and Manual-flow trials; creates DA user; flips status='active'." \
  >/dev/null
echo "  ✓ tokens-provision-pending configured"

# ────────────────────────────────────────────────────────────────────────
# Job 2: tokens-charge-recurring — daily at 22:00 UTC (~03:30 IST next day)
#
# Picks up Hostings whose expiryDate is within today+1d AND have a
# razorpayTokenId stored, and charges them via the stored mandate token
# (merchant-initiated transaction). On success extends expiry +1 year
# (or +1 month for monthly billing); on failure schedules retry with
# [T+1, T+3, T+7] day backoff and abandons after 4 attempts (which then
# also suspends DA + flips Hosting status='expired' + sends suspension
# email per Phase 2F).
#
# Why 22:00 UTC: ~03:30 IST means customers in India see their charge
# attempted in the dead of night, before their bank's batch-rejection
# cutoff if they have a low balance. If you want a different time,
# update the --schedule string (it's a standard cron expression in the
# --time-zone interpretation).
# ────────────────────────────────────────────────────────────────────────
echo ""
echo "──── Job 2: tokens-charge-recurring (daily at 22:00 UTC / ~03:30 IST) ────"
if gcloud scheduler jobs describe tokens-charge-recurring \
     --location="$LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  Job exists — updating config"
  ACTION="update"
else
  echo "  Creating new job"
  ACTION="create"
fi
gcloud scheduler jobs "$ACTION" http tokens-charge-recurring \
  --project="$PROJECT" \
  --location="$LOCATION" \
  --schedule="0 22 * * *" \
  --time-zone="Etc/UTC" \
  --uri="$APP_URL/api/workers/tokens-charge-recurring" \
  --http-method=POST \
  --headers="x-cron-secret=$CRON_SECRET" \
  --attempt-deadline=300s \
  --description="Tokens-flow MIT recurring-charge cron (Phase 2D/2H). Charges Hostings whose expiry is due via stored mandate token. No-op when HOSTING_MANDATE_FLOW != 'tokens'. Refuses unless RAZORPAY_KEY_ID starts with rzp_live_." \
  >/dev/null
echo "  ✓ tokens-charge-recurring configured"

# ─────────────────────────────────────────────────────────────────
# Job 3: retry-mandate-refunds — every 30 min (offset)
# ─────────────────────────────────────────────────────────────────
# Re-attempts the ₹2 trial mandate-validation refunds that failed inline in
# the webhook (Order.mandateRefundStatus='failed'). A just-captured recurring
# -auth payment can transiently reject the refund; this sweep retries it (the
# payment stays refundable) and is idempotent. Runs at :07 and :37 to stay
# clear of the other two jobs.
echo "──── Job 3: retry-mandate-refunds (every 30 min) ────"
if gcloud scheduler jobs describe retry-mandate-refunds \
     --location="$LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  Job exists — updating config"
  ACTION="update"
else
  echo "  Creating new job"
  ACTION="create"
fi
gcloud scheduler jobs "$ACTION" http retry-mandate-refunds \
  --project="$PROJECT" \
  --location="$LOCATION" \
  --schedule="7,37 * * * *" \
  --time-zone="Etc/UTC" \
  --uri="$APP_URL/api/workers/retry-mandate-refunds" \
  --http-method=POST \
  --headers="x-cron-secret=$CRON_SECRET" \
  --message-body='{}' \
  --attempt-deadline=300s \
  --description="Retries failed ₹2 trial mandate-validation refunds (Order.mandateRefundStatus='failed'). Idempotent; no-ops when nothing is failed. Closes the transient-refund-failure money-loss gap." \
  >/dev/null
echo "  ✓ retry-mandate-refunds configured"

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Done. All Tokens-flow Cloud Scheduler jobs are configured."
echo ""
echo "Listing both jobs:"
gcloud scheduler jobs list --project="$PROJECT" --location="$LOCATION" \
  --filter="name:tokens-provision-pending OR name:tokens-charge-recurring OR name:retry-mandate-refunds" \
  --format="table(name.basename(),schedule,state)"
echo ""
echo "Notes:"
echo "  - Job 1 (tokens-provision-pending) is FLOW-AGNOSTIC as of 2026-07-02."
echo "    Runs every 10 min against Hostings in status='pending' regardless"
echo "    of HOSTING_MANDATE_FLOW value. Picks up both Tokens-flow and"
echo "    Manual-flow trials in one pass. Active immediately."
echo ""
echo "  - Job 2 (tokens-charge-recurring) STILL no-ops unless"
echo "    HOSTING_MANDATE_FLOW=tokens is set on the Cloud Run service. The"
echo "    MIT recurring-charge path is intrinsically Tokens-specific (needs"
echo "    a razorpayTokenId on the Hosting record). Under HOSTING_MANDATE_FLOW="
echo "    manual, customers renew via a manual /api/user/hosting/renew flow"
echo "    at day 15+, not by auto-charge."
echo ""
echo "To flip the flag to 'tokens' once UPI Autopay activates (~2026-07-08):"
echo "  gcloud run services update dms \\"
echo "    --project=$PROJECT \\"
echo "    --region=europe-west1 \\"
echo "    --update-env-vars=HOSTING_MANDATE_FLOW=tokens"
echo ""
echo "(Recommended: flip to 'tokens' only on a phased rollout per the"
echo "Phase 5 plan in docs/razorpay-tokens-migration.md — Starter tier"
echo "first, validate, then Standard + Plus.)"
