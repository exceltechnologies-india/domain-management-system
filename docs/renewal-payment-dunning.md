# Renewal-payment dunning

Chases customers who **started** a hosting renewal payment and never finished it.

Shipped as Primary Billing Integration Phase 2 (`9b681fe`, 2026-09-02). The route is
`app/api/cron/renewal-payment-dunning/route.ts`.

---

## The problem it solves

A customer whose hosting is coming up for renewal clicks **Renew** in the dashboard. That
hits `/api/user/hosting/renew`, which mints a fresh `pending` Order and a Razorpay order,
then opens the checkout.

If they close the tab without paying, **nothing happens after that.** The renew route has no
dedup and no expiry, so the Order simply sits at `status: 'pending'` forever, and until this
cron existed nobody ever followed up. The hosting quietly lapses.

That customer is the most recoverable one you have — they had already decided to pay.

### What this is *not*

It is **not** the pre-expiry reminder system, which already exists and already runs:
`daily-scheduler` → `process-service-expiry`, driven by `REMINDER_DAYS`.

Those reminders key off the **service's expiry date** and know nothing about a half-finished
payment. This cron keys off an **abandoned checkout**. The two populations overlap but the
messages are different, and only one of them can say "you started paying and didn't finish".

It is also unrelated to UPI Autopay / mandate customers, who are charged automatically by
`tokens-charge-recurring` and never see a checkout to abandon.

---

## What it does

Finds Orders where all of the following hold:

| Field | Value |
|---|---|
| `status` | `pending` |
| `orderType` | `renewal` |
| `dunningAbandonedAt` | not set |
| `createdAt` | older than the first stage |

and emails an escalating payment reminder at each stage it has newly reached.

**Default stages: 24h, 72h, 168h** (1 day, 3 days, 7 days after the order was created).

After the **last** stage is sent, `dunningAbandonedAt` is stamped and the order is never
chased again.

### What it deliberately does not do

It **does not change the order's `status`**. A long-abandoned order stays `pending` forever.
Deciding whether those should eventually be voided is a separate, still-unscoped question
(item "Phase 3" in `TASKS.md`) — changing `status` semantics touches order history and
reporting broadly and deserves its own decision.

It also never charges anyone or cancels anything. It only sends email.

### Idempotency

`dunningLastStageHours` on the Order records the highest stage already emailed. A re-run, an
overlapping invocation, or a manual trigger will not re-send a reminder the customer already
received. Running the job more often than necessary is harmless.

An order with no `userEmail` on file is skipped **without** advancing the counter, so it
becomes eligible again if the address is later filled in.

---

## Scheduling it

The route is **not self-starting**. It needs a Cloud Scheduler job, created by:

```bash
bash scripts/setup-cloud-scheduler-billing.sh
```

The script is idempotent — re-run it to change the schedule or after rotating `CRON_SECRET`.

It **preflights the endpoint** and refuses to create a job pointing at a 404. This matters:
the route currently lives on the `primary-billing-integration` branch and is **not on
`main`**, so the correct order is:

1. Merge `primary-billing-integration` → `main`
2. Deploy
3. *Then* run the setup script

Creating the job before deploying would produce one that fails silently on every run — Cloud
Scheduler logs it, but the reminders that were supposed to start flowing simply never do.

### Why every 6 hours

The stages are hour-granularity but a full day apart, so four checks a day is ample. The
cadence only bounds how *late* a reminder can be — worst case ~6h after a stage is reached.
A tighter schedule buys nothing; a daily one would let the 24h reminder land up to a day late.

The job runs at 02:00 / 08:00 / 14:00 / 20:00 IST, staying clear of the Tokens-flow jobs.

---

## Tuning the cadence

`RENEWAL_DUNNING_HOURS` is a JSON array of hours, ascending. The last value is the final
reminder.

```bash
gcloud run services update dms \
  --project=speedy-unison-453807-e9 \
  --region=europe-west1 \
  --update-env-vars='RENEWAL_DUNNING_HOURS=[12,48,120]'
```

`deploy-cloud-run.sh` treats it as a **sticky** value: it reads the live Cloud Run setting and
prefers it over the shell/file value, so tuning it in production survives later deploys.
(Without that, `--set-env-vars` would replace the whole env map and silently revert you to the
code default — the same failure that flipped `HOSTING_MANDATE_FLOW` mid-launch on 2026-06-29.)

Leave it unset for the `[24, 72, 168]` default in `config/automation.ts`.

---

## Verifying and operating it

Trigger a run without waiting for the schedule:

```bash
gcloud scheduler jobs run renewal-payment-dunning \
  --location=asia-south1 --project=speedy-unison-453807-e9
```

Read the result:

```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND textPayload:"[RenewalDunning]"' \
  --project=speedy-unison-453807-e9 --limit=20 --freshness=10m
```

The response reports `sent`, `abandoned` and `skipped` counts. **A run with no abandoned
checkouts returns `sent: 0` — that is success, not a failure.** Expect that to be the common
case; abandoned renewal checkouts are a low-volume population, which is why the route is a
simple inline find-and-notify rather than the cron + Cloud Tasks worker split used for the
high-volume crons.

Pause the reminders without deleting the job:

```bash
gcloud scheduler jobs pause renewal-payment-dunning \
  --location=asia-south1 --project=speedy-unison-453807-e9
```

Auth is `x-cron-secret` (timing-safe) **or** an admin session, so an admin can also hit the
endpoint directly from a logged-in browser to test.

---

## Related

- `scripts/setup-cloud-scheduler-tokens.sh` — the Tokens-flow jobs (provisioning, recurring
  charge, mandate-refund retry). Kept separate so the two areas re-provision independently.
- `TASKS.md` → "Primary Billing Integration" → post-Phase-2 audit, item 6.
- `config/automation.ts` → `RENEWAL_DUNNING_HOURS`, and `REMINDER_DAYS` for the unrelated
  pre-expiry reminders.
