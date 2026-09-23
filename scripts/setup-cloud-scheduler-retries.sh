#!/usr/bin/env bash
#
# Add retries to the Cloud Scheduler jobs that can safely take them.
#
# ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# Measured 2026-09-23: all eight DMS Scheduler jobs have `retryConfig.retryCount`
# blank. Cloud Scheduler treats unset as ZERO retries, so one transient failure
# — a cold start, a 503, a network blip — loses that entire run, and nothing
# tells anybody. AGENTS.md L1 is this exact incident in the sibling project: one
# night of backups lost, found two days later by reading logs.
#
# ─── WHY IT ONLY TOUCHES THREE OF THEM ────────────────────────────────────────
# AGENTS.md L3: before putting a retry in front of anything, ask what the
# endpoint does when it HALF succeeds. If a second run is not idempotent, the
# retry is not the change — the idempotency is. Each job below was read before
# being classified, and the three that are NOT here are listed with their
# reasons so nobody "completes" this script by adding them.
#
# ─── SAFE, AND WHY ────────────────────────────────────────────────────────────
#
#   pending-sweeper      0 writes, no task dispatch. It reads three collections
#                        and sends one admin digest. Worst case on a retry is a
#                        SECOND digest email to the admin — noise, not damage —
#                        and only if it died after sending. If it died before,
#                        the retry is pure win.
#
#   check-unprovisioned  Same shape: 0 writes, reports only.
#
#   daily-scheduler      Writes and dispatches, and is STILL safe — because of
#                        the lock, not in spite of it. It claims each row with
#                        an atomic findOneAndUpdate setting `processing_until`
#                        for LOCK_DURATION_MS = 10 minutes. A retry inside that
#                        window finds already-claimed rows locked and skips
#                        them, processing only what the first run never reached.
#                        That is exactly what a retry should do.
#                        THE CONSTRAINT: the retry must finish INSIDE the lock.
#                        --max-retry-duration is capped at 5m below, well under
#                        10 minutes, so a late retry cannot re-process a row
#                        whose lock has expired. If LOCK_DURATION_MS ever drops,
#                        this cap has to drop with it.
#
# ─── DELIBERATELY NOT INCLUDED ────────────────────────────────────────────────
#
#   tokens-charge-recurring   CHARGES CUSTOMER CARDS. This is L3's canonical
#                             case. A half-succeeded run has charged some
#                             customers and not others, and Cloud Scheduler
#                             cannot tell that from a total failure — it retries
#                             any non-2xx. Until the charge path is proven
#                             idempotent per customer, a retry here risks
#                             double-charging. Make it idempotent first; the
#                             retry is not the change.
#
#   tokens-provision-pending  Provisions hosting. Same question, unanswered.
#
#   check-hosting-expiry      Dispatches a Cloud Task per expired hosting with
#                             NO lock of its own (unlike daily-scheduler). A
#                             retry re-dispatches for every hosting the first
#                             run already queued, so safety depends entirely on
#                             the worker being idempotent — which was not
#                             verified. Left alone rather than assumed.
#
# ─── NOTE ON THE DUPLICATE JOBS ───────────────────────────────────────────────
# `daily-expiry-check` (us-central1) hits the SAME endpoint as `daily-scheduler`
# (europe-west1), and `hosting-expiry-check` likewise duplicates
# `check-hosting-expiry`. This script does not touch the us-central1 pair,
# because the duplicates should be REMOVED rather than configured — see
# Todos.md. Adding retries to a job nobody knows exists makes it harder to find.
#
# Usage:  bash scripts/setup-cloud-scheduler-retries.sh [--dry-run]
set -euo pipefail

PROJECT="speedy-unison-453807-e9"

DRY_RUN="no"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="yes"

echo "──────────────────────────────────────────────────────────────"
echo "  Cloud Scheduler retries — DMS"
echo "  Project:  $PROJECT"
echo "  Dry run:  $DRY_RUN"
echo "──────────────────────────────────────────────────────────────"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not on PATH."
  echo "Run this in Cloud Shell (console.cloud.google.com, terminal icon) — it needs no install."
  exit 1
fi

# name|location|attempts|min-backoff|max-backoff|max-retry-duration
JOBS=(
  "pending-sweeper|europe-west1|3|30s|300s|900s"
  "check-unprovisioned|europe-west1|3|30s|300s|900s"
  # 5m total, deliberately inside daily-scheduler's 10-minute row lock.
  "daily-scheduler|europe-west1|2|30s|120s|300s"
)

for spec in "${JOBS[@]}"; do
  IFS="|" read -r NAME LOC ATTEMPTS MINB MAXB MAXDUR <<< "$spec"

  echo ""
  echo "──── $NAME ($LOC) ────"

  if ! gcloud scheduler jobs describe "$NAME" \
       --location="$LOC" --project="$PROJECT" >/dev/null 2>&1; then
    echo "  SKIP — no such job. Nothing is created here on purpose: this script"
    echo "         configures retries, it does not decide that a job should exist."
    continue
  fi

  CURRENT=$(gcloud scheduler jobs describe "$NAME" \
    --location="$LOC" --project="$PROJECT" \
    --format="value(retryConfig.retryCount)" 2>/dev/null || echo "")
  echo "  current retryCount: ${CURRENT:-<unset — means ZERO retries>}"
  echo "  setting:            attempts=$ATTEMPTS backoff=$MINB..$MAXB total<=$MAXDUR"

  if [[ "$DRY_RUN" == "yes" ]]; then
    echo "  (dry run — nothing changed)"
    continue
  fi

  gcloud scheduler jobs update http "$NAME" \
    --project="$PROJECT" \
    --location="$LOC" \
    --max-retry-attempts="$ATTEMPTS" \
    --min-backoff="$MINB" \
    --max-backoff="$MAXB" \
    --max-retry-duration="$MAXDUR" \
    --quiet

  AFTER=$(gcloud scheduler jobs describe "$NAME" \
    --location="$LOC" --project="$PROJECT" \
    --format="value(retryConfig.retryCount)" 2>/dev/null || echo "")
  echo "  now:                ${AFTER:-<still unset — CHECK THIS>}"
done

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Done. Verify in a separate command, not from the output above:"
echo ""
echo "  gcloud scheduler jobs list --project=$PROJECT --location=europe-west1 \\"
echo "    --format='table(name.basename(), retryConfig.retryCount, retryConfig.maxRetryDuration)'"
echo ""
echo "A retry is only half of L1. The other half is still open: nothing is told"
echo "when one of these fails after exhausting its retries, and a 500 nobody"
echo "reads is a silent failure with extra steps."
echo "──────────────────────────────────────────────────────────────"
