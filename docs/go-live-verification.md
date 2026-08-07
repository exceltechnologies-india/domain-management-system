# Go-Live Verification Runbook — Razorpay tokens-trial flow

Purpose: a single, ordered checklist to take the platform from **TEST mode** to
**verified-live**, so real customers are only accepted after every money-path
leg is proven end-to-end. Authored 2026-08-04 (`dms-00458`) after the day-15
MIT-charge 404 finding.

> **Do NOT accept real customers until every ✅-gate below passes.** Two of the
> gates are Razorpay-account *activations* that take days-to-weeks — start them
> first (Phase 0), then run Phases 1–5 in one sitting once they land.

Live revision at authoring: `dms-00457-lbk`. Rollback anchor:
`restore-2026-08-01-pre-sub-reseller` / `dms-00452-z2x` (see `RESTORE_POINTS.md`).

---

## Phase 0 — Razorpay account activations (BLOCKING, do first)

These are dashboard requests processed by Razorpay/NPCI/partners; nothing in the
app can proceed until they're ACTIVATED.

- [ ] **Recurring Payments / "charge-at-will" for Cards** — the day-15 MIT charge
  (`POST /v1/payments/create/recurring`). **Currently NOT active** — proven by a
  real test-mode charge returning HTTP 404 (see `dms-00458-mit`). This is the
  newest blocker; request it explicitly (it's separate from the eMandate rails).
- [ ] **UPI Autopay** recurring (if UPI mandates are offered) — Account & Settings → UPI/QR.
- [ ] Confirm the already-activated rails still show ACTIVATED: Cards eMandate,
  Netbanking eNACH, eSign (activated 2026-07-11 per memory).

**Gate:** all required recurring rails show ACTIVATED in the **live** dashboard.

---

## Phase 1 — Prove recurring charging works (still in TEST mode, before cutover)

Do this the moment Recurring Payments activates, WITHOUT switching to live — it's
the cheapest place to confirm the fix landed.

1. Create a fresh test-mode trial signup (real Checkout mandate auth) so you have
   an authorized token + customer. Note the `razorpayCustomerId` +
   `razorpayTokenId` from the Order (admin → Orders, or the hosting detail modal).
2. Run the **MIT-charge harness** with those ids:
   ```bash
   RUN_MIT_CHARGE_TEST=1 \
   MIT_TEST_CUSTOMER=cust_xxx MIT_TEST_TOKEN=token_xxx \
   MIT_TEST_AMOUNT=599.88 MIT_TEST_EMAIL=you@example.com MIT_TEST_CONTACT=10digits \
   npx vitest run --config=vitest.integration.config.ts \
     tests/integration/razorpay-mit-charge.verify.test.ts
   ```
   - ✅ **PASS:** returns a `pay_…` + `order_…` (charge captured). Recurring works.
   - ❌ **FAIL (404):** recurring still not active — do not proceed; chase Razorpay.

**Gate:** the harness returns a `pay_…` in test mode.

---

## Phase 2 — TEST → LIVE cutover (operator)

1. [ ] **Switch keys to live:** `bash scripts/switch-razorpay-mode.sh live`
   (rotates the 3 Razorpay secrets in Secret Manager + rebuilds so the
   build-time `NEXT_PUBLIC_RAZORPAY_KEY_ID` is the live key). Then deploy:
   `bash scripts/deploy-cloud-run.sh`.
2. [ ] **Verify the live key is active:** admin → Integration Health should show
   `razorpayMode: live`; the checkout overlay shows no "Test Mode" ribbon.
3. [ ] **Regenerate live plans** if not already: `node scripts/razorpay-regenerate-plans-live.js`
   (refuses unless `RAZORPAY_KEY_ID` starts with `rzp_live_`; dry-run first).

**Gate:** app is serving on `rzp_live_*` and health is green.

---

## Phase 3 — Live mandate + refund + rails (one real ₹2 signup)

Use a controlled test account + a real card/UPI you own.

1. [ ] **Do one real trial signup.** Confirm the mandate overlay shows the
   expected **recurring** rails (Card eMandate, and UPI Autopay / Netbanking /
   eSign if activated) — only recurring-capable activated rails appear.
2. [ ] **Confirm the ₹2 auto-refund posts:** the payment shows
   `amount_refunded=200` / `refund_status:full` on the Razorpay dashboard, and
   the Order's `mandateRefundStatus=processed`. If it shows `failed`, the new
   retry sweep (`/api/workers/retry-mandate-refunds`) will reconcile it within
   30 min once Cloud Scheduler is wired (Phase 5) — or trigger it manually.
3. [ ] **Confirm provisioning:** hosting goes `pending → active` within ~10 min
   (DA account created); welcome email arrives.

**Gate:** ₹2 charged + refunded, hosting active, emails sent.

---

## Phase 4 — Live day-15 conversion (the real charge + renew, or suspend)

This charges the **real yearly amount** (e.g. ₹599.88), so use your controlled
account and be ready to refund.

1. [ ] **Fast-forward the trial:** set that hosting's `expiryDate` to today
   (one-off DB update on the specific test hosting; note the original value).
2. [ ] **Trigger the charge worker** (now allowed — live key):
   ```bash
   curl -X POST https://app.anutech.in/api/workers/tokens-charge-recurring \
     -H "x-cron-secret: $CRON_SECRET" -H "Content-Type: application/json" -d '{}'
   ```
3. [ ] **Verify SUCCESS path:** response `counts.succeeded=1`; the hosting's
   `expiryDate` extends **+1 year**; a `RecurringChargeAttempt` row is
   `succeeded`; the customer is charged the yearly amount on the Razorpay
   dashboard; hosting stays `active`.
4. [ ] **(Optional) Verify SUSPEND path:** with a card set to decline, one failed
   attempt (first-charge rule = 1 attempt) → `abandoned` → DA suspended +
   `status=expired` + dunning email. (Already unit-tested; live-confirm only if
   you want to see the email fire.)
5. [ ] **Refund the real yearly test charge** from the Razorpay dashboard.

**Gate:** a real MIT charge succeeds and extends expiry +1 year.

---

## Phase 5 — Wire the crons + final cleanup

1. [ ] **Wire Cloud Scheduler:** `bash scripts/setup-cloud-scheduler-tokens.sh`
   — creates all three jobs (provision-pending, charge-recurring,
   **retry-mandate-refunds**). Confirm all three list as ENABLED.
2. [ ] **Confirm a paid one-shot order** (domain / paid hosting) issues a **Zoho
   invoice** in live (trials correctly issue none).
3. [ ] **Wipe live test artifacts:** the controlled test user + its DA account,
   via the standard scoped-delete (`scripts/purge-test-users.js --apply`).
4. [ ] **Confirm `HOSTING_MANDATE_FLOW=tokens`** on the live Cloud Run service.

**Gate:** crons ENABLED, invoice verified, test data wiped.

---

## Done = genuine end-to-end green

All gates ✅ ⇒ safe to accept real customers on the tokens trial: signup →
₹2 mandate + refund → provision → active → day-15 MIT charge → +1-year renewal
(or suspend on failure), with the refund-retry + provisioning + charge crons all
running. Anything red ⇒ hold, fix, re-run that phase.

**When you're ready to run this, ping me at each phase and I'll help execute the
app-side steps (harness, worker triggers, DB checks, verification queries) — the
Razorpay-dashboard + real-card legs are yours.**
