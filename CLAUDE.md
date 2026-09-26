# Project conventions for Claude Code

This file holds workspace-level instructions that apply to every session in this repo.

## Audit-cycle workflow (MANDATORY)

When working through an audit cycle backed by a markdown file (the active one is `TASKS.md`; historical ones may exist as `rescan-3.md`, `audit.md`, etc.), the audit MD is the source of truth for what is done, in flight, and pending. After **every** shipped batch you must:

1. Update the status table in the audit MD: mark the item ✅ Done (or 🔄 In progress / ⏸ Deferred as appropriate). Include the short commit hash next to the status when the batch has landed.
2. Refresh the "suggested batching" / next-batches list at the top so completed items are struck through or removed and the numbering still reads cleanly.
3. Refresh the summary line at the top (e.g. "N vertical slices shipped (X RC + Y DA + …)") so a future reader sees the current count without reading the whole table.
4. Commit the audit-MD update — either bundled with the batch's code commit, or as a follow-up `docs:` commit referencing the batch.

Do this **every time**, not just at end-of-session. The audit file going stale is the single fastest way to lose track of what has shipped vs what is still pending across multi-batch cycles.

If multiple audit MDs are active (e.g. an older `audit.md` plus the newer `TASKS.md`), update the one that owns the batch and leave the others alone.

### Flipping In-Flight → Done in TASKS.md (reviewer dashboard parser)

The senior reviewer dashboard at task.anutech.in parses TASKS.md entries by **title text**. When an In-Flight entry's title stays verbatim and only the `[ ]` flips to `[x]`, the dashboard reconciles the hourglass to a check on the ORIGINAL day's row — but registers NO event for the day the fix actually shipped. Today's-view ends up showing 0 events even though work landed.


**The rule**: when flipping an In-Flight item to ✅ Done, ADD a NEW `[x]` "Recently Shipped" entry above it with a distinct title (e.g. prefixed with "FIXED:" or rewritten to describe the resolution). Keep the original In-Flight row in place too — flip its `[ ]` to `[x]` and append a "✅ RESOLVED on YYYY-MM-DD" prefix to the body for the audit trail. Result: yesterday's row reconciles ⏳ → ✅ AND today's view shows the freshly-shipped resolution event. Both reviewers see the full report-in → resolution-out arc.


NEVER delete completed tasks — audit trail. The dashboard, the codebase history, and the project memory all rely on the historical entries staying in place. (See auto-memory `feedback_tasks_flip_dual_entry`.)

## HARD RULE — Never let secrets reach git

**Single biggest "cost-per-mistake" rule in this repo.** A MongoDB Atlas password leaked into the initial commit and stayed in git history until 2026-06-29 — cleanup cost was a history rewrite + force-push of 147 tags + password rotation + Secret Manager v2 + Cloud Run redeploy. Don't repeat.

**Enforcement (defence in depth):**

1. **Pre-commit hook** at `.husky/pre-commit` calls `scripts/check-staged-for-secrets.sh` BEFORE eslint/tsc. The script greps staged hunks (ADDED lines only) for: MongoDB URIs with embedded credentials, Razorpay live/test key SECRETS (24+ chars after `rzp_live_/rzp_test_` — Key IDs are shorter and OK), Anthropic API keys (`sk-ant-`), AWS access keys (`AKIA…`), GCP service-account `private_key` JSON fields, PEM `BEGIN PRIVATE KEY` blocks, and env-var-shape secret assignments (`KEY/SECRET/TOKEN/PASSWORD = "long-random"`). Blocks the commit on any match.


2. **`.gitignore`** covers `.env`, `.env.*` (except `.env.example`), `gcp-key.json`, `service-account*.json`, `*.json.key`, and `scripts/*-backup-*.json`. Don't loosen these without re-adding what you removed.


3. **Two-store discipline** (see auto-memory `project_secret_manager_split`): `.env.local` is for local dev + build-time-public values; Google Secret Manager holds the production runtime secrets. Updating one without the other will silently break the OTHER environment. Always pair them when rotating.


**When to override (`--no-verify`):**
Only for confirmed false positives — e.g., an intentional test fixture string that triggers the regex. NEVER skip to commit a real secret. If you skipped and a real secret slipped, you owe a history rewrite + a rotation, not a quiet fix-forward.


**If you find a leaked credential already in history:** rotate the live credential FIRST (Atlas/Razorpay/whichever console), then `gcloud secrets versions add NAME --data-file=-` for the runtime store, then force a new Cloud Run revision (env-var nudge or full redeploy), THEN rewrite git history + force-push. The order matters — rewriting history while the leaked credential is still live just hides it from new clones without actually securing anything.



## Trial order invoice policy (operator decision 2026-06-30) — SUPERSEDED 25 Sep 2026

> **DMS issues no invoices at all any more** (see "Billing moves to ResellerOS" below). This section
> is kept as history; `createPrimaryInvoice` no longer exists. A trial still gets no bill.


**Do NOT generate an invoice for ₹0 trial signups.** The Order row gets persisted (`amount: 0, status: 'pending', orderType: 'hosting_trial'`) as the audit trail; the Hosting row gets created with `isTrial: true` and `billingType: 'manual'`; the welcome email fires when the DA-provisioning cron flips the Hosting to active. None of that emits a tax invoice.

The customer's FIRST tax invoice fires at day 15+ when the trial converts via the renewal flow (`/api/user/hosting/renew` → Razorpay one-shot order → `/api/payments/verify` → `createPrimaryInvoice` in `lib/services/billing/createPrimaryInvoice.ts`). At that point the renewal Order has the real ₹599.88 (Starter yearly) / ₹1,500 (Standard yearly) / ₹2,246.40 (Plus yearly) amount, and the invoice issued matches the actual charge.

**Why this is correct**: Indian GST requires a tax invoice only for a taxable supply with consideration > 0. Issuing ₹0 invoices would clutter the books, complicate revenue reporting, and create unnecessary reconciliation work for the finance team. AWS / Netflix / Spotify / GoDaddy all follow the same pattern — invoice fires at first real charge, not at trial signup.

**Enforcement**: `createPrimaryInvoice` in `lib/services/billing/createPrimaryInvoice.ts` short-circuits at the top with `if (!orderAmount || orderAmount <= 0 || orderType === 'hosting_trial') return skipped;`. The guard fires before any claim logic so neither an accidental zero-amount caller nor a future code path that hands a trial Order can issue an invoice. The guard is belt-and-suspenders — current callers (`payments/verify` + `payments/guest/verify`) only fire on a real Razorpay payment, which always has amount > 0; the guard defends against future regressions.


If a customer ASKS for a trial-period invoice: there is none. Canned response: *"No invoice is issued for the free trial period since there's no charge. Your first invoice will be generated automatically when your trial converts on day 15 — that's when your card / UPI mandate is charged for the first time."*

## Billing moves to ResellerOS — DMS issues no bills (OWNER DECISION, 24 Sep 2026)

**This overrides the "one issuer, ungated, do not add a switch" rule in the Zoho section below.** Later the same day the owner decided: *"DMS does not do its own billing anymore. Period. All bills will be generated by ResellerOS itself. DMS has a copy of original bill from ResellerOS as a reference. So no duplicate bills or different number series needed."* And: *"Renewals subscription will be handled by ResellerOS. Period. Our DMS will only fetch that renewal bill from ResellerOs and show it."*

- **Shipped (`8bf941e`):** the Razorpay Tokens recurring charger (`chargeRecurringHosting`, cron `tokens-charge-recurring`) is gated OFF unless `DMS_TOKEN_RECURRING_ENABLED === "1"`. It is disabled, not deleted — owner: *"disable for now. Until we need it someday later"*. ResellerOS collects renewals through Razorpay Subscriptions; both running would be two systems able to debit the same renewal, with no dedup between them. Do not re-enable it without the owner asking.
- **BUILT 25 Sep 2026 — DMS issues no bills.** `createPrimaryInvoice`, the TI/... allocator
  (`lib/billing/invoiceNumber.ts`) and the legacy `INV-…` branch of the `models/Order.ts` pre-save hook were
  removed in ONE commit, with the three admin invoice actions (re-sync-invoice, `lib/invoice-retry.ts` + the
  customer's "Generating · Retry" pill + `/api/user/invoices/sync`, and `api/workers/issue-invoice` with its
  enqueue in `handleSubscriptionCharged`). Pinned by `tests/unit/lib/billing/no-dms-bills-scan.test.ts`.
  A payment DMS still takes on its own keys (the old cart, a DMS subscription renewal, `/renew`, an admin
  provision with a price) is FLAGGED, never billed: `flagPaymentWithoutBill` (`lib/billing/no-dms-bills.ts`)
  writes `invoiceFailedAt` + a reason saying "raise the bill in ResellerOS", and the order is listed read-only
  on Admin → Invoices diagnostics and the Integration-health Invoicing card. Existing TI/INV invoices keep
  their numbers and stay viewable. **Not built:** recording ResellerOS's invoice on DMS as a foreign reference.
  **Left in place, callerless:** `claimOrderForPrimaryInvoice` / `recordPrimaryInvoiceForOrder` /
  `releasePrimaryInvoiceClaim` / `listFailedInvoiceOrders` in `lib/services/orders.ts` (their integration tests
  pin the double-billing guard); the scan fails if anything calls them.
- DMS's cart stays for purchases made from inside the customer panel; their bill still comes from ResellerOS.
- **Hosting prices are ResellerOS's, not ours.** Owner: *"Use the prices of hosting set in ResellerOS completely. Ignore and disregard the prices of DMS from now on."* The source is `LANDING_PLANS` in the ResellerOS repo (`production/src/site/lib/data/hosting-landing.ts`). The prices in our `hostingplans` collection are no longer authoritative: do not build on them, "fix" them, or treat a mismatch with ResellerOS as ResellerOS's bug. **Built 24 Sep 2026** — see "Hosting is charged at ResellerOS's price + GST" below.
- No migration is needed: the owner confirmed DMS had no live customers (testing only).

Full record, open questions and build list: ResellerOS repo, `Todos.md` §0A.

## DMS has no public pages — ResellerOS's frontend is the one in use (OWNER DECISION, 24 Sep 2026)

Owner: *"Remove the frontend pages of DMS completely since we are using the frontend page of ResellerOS now."* Deleted: `/`, `/about`, `/contact`, `/privacy`, `/terms-and-conditions`, `/cancellation-refund`, `/data-deletion`, `/hosting`, `/domains-home`, `/domains/search`, `/domains/bulk-search`, and `components/marketing/`. Do not rebuild any of them without the owner asking.

- **Every one of those URLs is now a 307 to ResellerOS**, for every visitor including admins (there is no DMS copy left to show an admin). The map is `RESELLEROS_OWNED_PAGES` in `lib/reseller-os.ts`; the redirect runs in `middleware.ts` before any session lookup.
- **`NEXT_PUBLIC_RESELLEROS_URL` is now REQUIRED.** Without it those URLs 404 — including the Razorpay policy pages. `scripts/deploy-cloud-run.sh` refuses to build without it (pinned by `tests/unit/scripts/deploy-requires-reselleros-url.test.ts`). Production is deliberately untouched until the owner supplies the production ResellerOS address.
- **In-panel buying** is two dialogs in the customer panel, opened by `?buy=hosting` / `?buy=domain` (`lib/purchase/buy-dialog.ts`, `components/purchase/`, mounted in `UserLayout`). Since 25 Sep 2026 (decision 30) a paid choice opens `PanelCheckout`, which orders through ResellerOS — see "Further owner decisions" below. Only the ₹0 trial line (`lib/purchase/hosting-cart-item.ts`) still goes into DMS's cart. The domain dialog is the same `DomainSearch` component with `onSelectDomain`.
- **Kept on purpose:** `/cart`, `/checkout`, `/login`, `/register`, `/sso`, `/payment-success`, the panel, and **`/hosting/error`** — the control-panel SSO failure page, not marketing. Exact-path matching keeps it apart from `/hosting`.
- **`/data-deletion` now redirects to ResellerOS `/privacy`**, which has no data-deletion section. Owner's choice; if Facebook login is switched on, Meta will want a data-deletion URL.
- **The dead page controls are REMOVED (decision 15, done 25 Sep 2026).** Admin → Page management's publish/draft switches for the deleted pages and its homepage-design switch are gone, with everything that existed only for them: `config/managed-pages.ts`, `lib/services/page-visibility.ts`, `app/api/admin/pages`, and `homeVariant` in `lib/services/appearance.ts` and `api/admin/appearance`. The screen is now **Admin → Appearance** (same URL, `/admin/page-management`) and keeps the controls that style pages DMS still serves: footer template, frontend colour theme, GSTIN + social links in the footer. Pinned by `tests/unit/app/admin/page-management-dead-controls.test.ts`. The Mongo `page_visibility` / `home_variant` settings rows, if present, are now read by nothing; they were left in place (no migration for dead data).
- **Found, not removed (not in decision 15):** two more controls on that screen also change nothing now. The **Support widget** switch + WhatsApp number (`components/SupportWidget.tsx` was mounted only on the deleted marketing pages, so nothing renders it), and the **Phone number (Call Us)** toggle (its only reader, `components/ContactInfo.tsx`, is mounted nowhere). Ask the owner before removing them.
- **Price question — answered.** See the next section.

## Hosting is charged at ResellerOS's price + GST (OWNER DECISION, 24 Sep 2026)

Asked whether ₹49.99/month includes GST (DMS's reading) or not (ResellerOS's), the owner: *"ResellerOS is correct price one. Use that."* So a Starter year is **₹600 + ₹108 GST = ₹708**, not ₹599.88.

- **One function prices every hosting charge:** `hostingCharge()` in `lib/pricing/hosting-price.ts` — ResellerOS's formula, `round(yearly ? price×12 : price×2)` then `round(× 1.18)`. Starter ₹708/yr · ₹118/mo, Standard ₹1,770 · ₹295, Plus ₹2,650 · ₹441. It returns `null` for a plan ResellerOS does not sell, and every caller refuses rather than guess. Mongo `hostingplans.price` is not an input to any charge.
- **Callers:** the panel dialog and cart lines, `create-order` and the guest `create-order` (which now re-price hosting server-side via `lib/pricing/reprice-hosting.ts`; before this they charged whatever price the browser sent), `api/user/hosting/renew` + `renew-info`, `upgrade` + `upgrade-info` (proration on `perMonthRate()`), and the expiry worker's pending renewal.
- **Downstream is unchanged on purpose:** DMS still treats an order `amount` as GST-inclusive (cart summary, checkout, invoices via `lib/billing/gst.ts`), so charging the inclusive figure shows ₹600 taxable + ₹108 GST everywhere with no change there.
- **A cart holding the old price is refused**, `409 PRICE_CHANGED` with the new figure and "nothing was charged", not silently re-priced.
- **DMS opens no Razorpay Subscriptions for hosting** (`dmsCreatesHostingSubscriptions()`, off unless `DMS_HOSTING_SUBSCRIPTIONS_ENABLED=1`). Its Razorpay plans are `renewalPrice` and `renewalPrice × 12` — yearly = 12 × monthly — which cannot express ResellerOS's year at 6 × its monthly-billing rate, and a subscription is a DMS-collected renewal (decision 4 gave renewals to ResellerOS). Paid hosting is one payment for its period; a trial always takes the no-mandate flow and converts through `/renew`. A trial in a cart with other items is refused BEFORE the trial claim is recorded. Do not re-enable subscriptions without new Razorpay plans at ResellerOS prices.
- **Fixed on the way — both were customer-visible:** the expiry worker raised yearly renewals at the per-MONTH figure (₹49.99 for a year) and emailed that amount to the customer, and fell back to Starter's price for any plan it did not recognise. A plan with no ResellerOS price now gets no renewal order and no email with an invented amount — it is suspended as before and logged with an ACTION line.
- **Known gap:** `config/hosting-plans.ts` is still a copy of ResellerOS's `LANDING_PLANS` (pinned equal by `tests/unit/lib/purchase/purchase.test.ts`). Reading the prices from ResellerOS over the engine API would remove the copy.

## Further owner decisions, 24 Sep 2026 — what they mean for DMS

Asked and answered the same day; the questions, the options offered and the exact answers are
in the ResellerOS repo, `Todos.md` §0A ("Decisions 12–18"). None of these is built yet unless it
says so — each waits for the owner's go-ahead.

- **Money goes to ResellerOS's Razorpay account**, including purchases made inside this panel.
  The panel dialogs do so since 25 Sep 2026 (above). `/cart` + `/checkout` (`api/payments/create-order`)
  still take a PAID cart on DMS's own keys if one reaches them; nothing in the panel now feeds
  them a paid line except the cart page's own upsell/cross-sell widgets. Open — see TASKS/Todos.
- **A bill shown in this panel is ResellerOS's own PDF.** DMS renders no bill of its own. **Built 25 Sep 2026:**
  the Invoices page reads them server-side through ResellerOS's `/api/v1` (`lib/reselleros/bills.ts`, key
  `RESELLEROS_BILLING_API_KEY`), matched on the account email. DMS's pre-25-Sep invoices stay listed below as
  history.
- ~~If ResellerOS is down during an in-panel purchase: take the payment, bill later.~~
  **SUPERSEDED by decision 30 (25 Sep 2026): ResellerOS creates every Razorpay order.** The
  `?buy=hosting` / `?buy=domain` dialogs call `/api/user/panel-order`, which asks ResellerOS's
  `POST /api/dms/panel-order` (`lib/reselleros/panel-order.ts`) and opens Razorpay with the key
  and order id it returns. If ResellerOS cannot be reached the purchase is REFUSED. DMS records
  nothing on success: ResellerOS's webhook records the payment and provisions through the engine.
  No queue or retry was ever built for decision 16, so there was nothing to remove. The ₹0 trial
  still goes through DMS's cart (ResellerOS's panel-order refuses trials).
- **The three admin invoice actions are to be REMOVED** — re-sync invoice
  (`app/api/admin/orders/[id]/re-sync-invoice`), invoice retry (`lib/invoice-retry.ts` and its
  pill), the issue-invoice worker (`app/api/workers/issue-invoice`). The owner chose removal over
  "fetch from ResellerOS": bill problems are handled in ResellerOS. Do this in the same change that
  stops `createPrimaryInvoice`, so there is never a window with two issuers or none.
- **Admin → Page management's dead controls — REMOVED 25 Sep 2026** (visibility of deleted pages,
  homepage design). See "DMS has no public pages" above.
- **Production ResellerOS address: `https://reselleros.anutech.in`** — the value for
  `NEXT_PUBLIC_RESELLEROS_URL`. Production deploys only on an explicit go.
- **`tokens-charge-recurring` is to be paused in Cloud Scheduler** — the owner will run
  `gcloud scheduler jobs pause tokens-charge-recurring --location=asia-south1 --project=speedy-unison-453807-e9`.
  Until then the code gate (`DMS_TOKEN_RECURRING_ENABLED`) keeps it from charging anyone.
- **`hosting.provision` is BUILT and OFF (decision 25, 24 Sep 2026).** A sale made on ResellerOS
  is provisioned HERE (this app stays the only DirectAdmin writer for a sale), into the buyer's DMS
  account. `lib/integrations/engine-handlers-provision.ts`. **Usernames are deterministic per
  domain** (`daUsernameFor`) and DirectAdmin is READ before any create — an account already on the
  domain is adopted, never duplicated; do not switch this back to the random `generateDaUsername`
  the other provisioners use. Package from the catalogue, test-mode payments held, own gate
  `ENGINE_HOSTING_PROVISION_LIVE=1`.
- **`hosting.provision` can create a free TRIAL account (built 25 Sep 2026, same gate, still OFF).**
  So ResellerOS's trial stops writing to DirectAdmin itself and this engine stays the only writer.
  Payload: `{ planId: "starter", trial: true, paymentMode: "trial", cycle?: "monthly"|"yearly"
  (default yearly), trialRef?: string, customer: {…same as paid…}, sourceRef }`, subject = the domain;
  `months` is ignored. Rules, all refused with nothing written: `trial:true` and `paymentMode:"trial"`
  only together (a sale cannot claim trial; a trial is never a live/test payment); Starter only
  (`isTrialPlan`); one trial per customer — `findPriorTrial` on email, phone and domain, and a read
  error REFUSES. The trial being provisioned is excluded by exact id: `trialRef` = the ExternalTrial
  `ref` ResellerOS recorded (its lead id), and this command's own Hosting row
  (`orderId: rsos-trial:<sourceRef>`), so neither a first run nor a retry blocks itself. The row:
  `isTrial`, 15 days, `billingType: "manual"`, `billingCycle` from `cycle`, `autoRenew: false`,
  `next_action_at` 2 days before expiry, `orderId`/`paymentId` `rsos-trial:<sourceRef>`; no Order
  (a paid provision writes none either), result carries `trial: true, amount: 0`. Username,
  adopt-before-create, DMS account + set-your-password email and the reconciler are the paid path's.
  Tests: `tests/unit/lib/integrations/engine-handlers-provision-trial.test.ts`. **Known:** such a row is
  picked up by DMS's existing trial-end machinery (reminders via `next_action_at`, and at expiry the
  worker suspends it) — the same as any DMS trial. **Since 25 Sep 2026 the worker raises NO renewal
  order** (see "Renewals go to ResellerOS" below).
- **`hosting.provision` was run against the live DirectAdmin on 24 Sep 2026 and works:** test,
  create, replay and no-duplicate all passed. The test account it made (`rsospf34b2` /
  `rsosprovtest2409.in`) was deleted from server1 on 25 Sep 2026. So were its local records: the
  test user, its hosting row and the `live-da-test-*` engine commands. server1 keeps the three
  packages and has no users. It found two bugs, both fixed:
  - `createPackage` must send `add=Save`; `action=create` is read as a listing request.
  - `unwrapDAError` must unwrap a `DirectAdminError`, or every DA refusal reads as "Unknown".

  DirectAdmin answers a missing user with **HTTP 200** and `error=1&text=Unable to show user`.
  **Run a live probe in vitest's NODE environment** (`// @vitest-environment node`): the default
  jsdom environment gives axios the browser adapter, which loses the reply and reproduces
  "Unknown" for a reason that has nothing to do with the code. A container not rebuilt
  after the fix gave the identical symptom too — `docker compose up -d --build` before believing
  a live result. Between them, that cost an hour.
  **server1's IP is 35.207.233.155.** It is the only address in server1's own IP list. As of
  25 Sep 2026 `DA_FALLBACK_IP` and `.env.local` say so; before that they said 34.93.167.160.
- **The live / production DMS (Cloud Run) is a SEPARATE project, not ours** (owner, 25 Sep 2026:
  "Ignore the Live DMS or Production DMS. That is a separate project from ours"). Work here is on
  this repo and its local container. Do not deploy to, reconfigure, or report on the production
  service, its env vars or its data.
- **The free hosting trial is Starter only, on monthly AND yearly** (owner, 24 Sep 2026). Both
  server gates enforce the plan: the eligibility route and create-order, via
  `lib/pricing/trial-plan.ts`. The panel dialog alone is not the rule. A monthly trial exists only
  on the no-card path. It records `billingCycle: "monthly"` on the Hosting. (`renew` / `renew-info`,
  which charged one month for it, were deleted on 25 Sep 2026 — renewals are ResellerOS's.) A Hosting with no `billingCycle` (every row
  before that date) renews yearly, as it always did. A monthly trial is refused where a YEARLY
  mandate or subscription would be set up; never convert it silently. Checkout no longer tells
  trial customers their card is "saved for automatic yearly billing": no trial path running takes
  a card.
- **One free trial per customer ACROSS BOTH APPS — DMS holds the shared record** (24 Sep 2026).
  DMS cannot reach ResellerOS, so DMS keeps the union:
  - its own trials (orders and hostings);
  - `ExternalTrial` rows, one per trial started on the ResellerOS site.

  `lib/trials/trial-history.ts` `findPriorTrial` matches any one of: email (any case), phone
  (last 10 digits), or domain. It THROWS on a database error, and every caller refuses the trial
  (fail closed).

  Engine route `/api/integrations/engine/trials`:
  - **GET, read key:** ResellerOS asks it before starting a trial.
  - **POST, command key:** ResellerOS records its trial, idempotent on the lead id.

  Both DMS gates (eligibility and create-order) consult it too.
- **A buyer's DMS account gets a "set your password" email at creation** (`engine-customer.ts`,
  shared by both commands), as guest checkout did (removed 25 Sep 2026). It is their only way in: ResellerOS has no
  customer portal, so there is no hand-off for a customer to start. (Earlier text in this file said
  they "arrive by the engine-sso hand-off" — that is how staff reach a panel, not how a customer
  reaches their own.)
- **`domain.register` is BUILT and OFF (Phase 9, decisions 21-24, 24 Sep 2026).**
  `lib/integrations/engine-handlers-register.ts` + `engine-register-policy.ts`. Registers under the
  customer's own details into a DMS account for them (found or created by email, with a
  "set your password" email — see the entry above), within a spend limit: live payment, paid ≥
  ResellerClub cost, ≤ `ENGINE_DOMAIN_REGISTER_MAX_PER_DAY` (5) and
  `ENGINE_DOMAIN_REGISTER_MAX_RUPEES_PER_DAY` (₹10,000) in 24 h. A refusal starts `[held]` and is a
  wait-for-a-person, not a failure. Live only when `ENGINE_DOMAIN_REGISTER_LIVE=1` — its OWN gate in
  `engine-mode.ts` `OWN_LIVE_GATES`, deliberately not `LIVE_ELIGIBLE_COMMANDS`, so opening it puts
  nothing else live. Do not set it without the owner (steps in ResellerOS `Todos.md` §0A).
- **`domain.renew` is BUILT and OFF, with its own gate and spend limit (owner, 25 Sep 2026:
  renewals are automatic once the customer has paid the renewal in ResellerOS, at the live
  ResellerClub price).** `lib/integrations/engine-handlers-domain.ts`. It used to be permanently
  live-ineligible because nothing capped spending; it now reuses `decideSpend` from
  `engine-register-policy.ts`. Payload: `years` (1-10), `expiryBefore` (epoch seconds, sent to
  ResellerClub verbatim — the double-renewal defence is unchanged), `coverRupees` (rupees paid
  before GST, required), `paymentMode` (`"live"`/`"test"`, required), `sourceRef` (optional,
  the ResellerOS quote id). Held (`[held]`, nothing spent) on a test-mode payment, an unreadable
  or stale RENEWAL cost (`renewdomain` × years), `coverRupees` below that cost, or its OWN daily
  caps `ENGINE_DOMAIN_RENEW_MAX_PER_DAY` (5) / `ENGINE_DOMAIN_RENEW_MAX_RUPEES_PER_DAY`
  (₹10,000), counted from the last 24 h of `domain.renew` commands only
  (`engine-spend-usage.ts`). Live only when `ENGINE_DOMAIN_RENEW_LIVE=1` — its own entry in
  `OWN_LIVE_GATES`, separate from the register gate. Do not set it without the owner.
- **`hosting.renew` is BUILT and OFF (owner, 25 Sep 2026: a hosting renewal paid in ResellerOS must
  reach DMS, or the expiry worker suspends an account the customer paid for).**
  `lib/integrations/engine-handlers-hosting-renew.ts`. Subject = the hosting's domain (lower-case).
  Payload: `months` (1-36, required), `expiryBefore` (epoch SECONDS, required — the
  `hostings[].expiryDate` the caller read from `/api/integrations/engine/services`, floored),
  `paymentMode` (`"live"`/`"test"`, required), `sourceRef` (optional, the ResellerOS quote id).
  Finds the one non-terminated Hosting for the domain; a test-mode payment is `[held]`; the same
  expiryBefore defence as `domain.renew` (already extended → refused, earlier → refused, nothing
  written), then a compare-and-set sets `expiryDate` = expiryBefore + `months` calendar months in
  UTC (clamped: 31 Jan + 1 = 28/29 Feb), `next_action_at` = expiry − 15 days,
  `last_reminder_sent` = null (as `lib/services/payment/renewal.ts` does). A `suspended`/`expired`
  row is then unsuspended by calling the `hosting.unsuspend` handler and set `active`; if that
  fails the renewal is still reported, with `unsuspended: false` and `unsuspendError`. Result:
  `hostingId, domain, expiryBefore, expiryAfter (ISO), months, unsuspended, unsuspendError,
  sourceRef`. Reconciler: expiry moved past expiryBefore → done. No spend limit — it spends no
  rupee at any provider. Live only when `ENGINE_HOSTING_RENEW_LIVE=1` — its own `OWN_LIVE_GATES`
  entry. Do not set it without the owner.
- **Decisions 19–21 (the ResellerOS site cart), 24 Sep 2026.** ResellerOS now charges a domain
  at the LIVE ResellerClub price, re-checked at payment, and writes one provisioning request per
  product, each domain row carrying the exact name. The owner chose **automatic registration
  after payment** (decision 21, against the recommendation of staff registering). It is the
  next build: it will reach this repo as the engine's `domain.register` command, behind a
  switch that stays OFF until the owner approves a first real registration. `LIVE_COMMANDS_ENABLED`
  and the spend-control question in ResellerOS `Todos.md` §0.1 still apply to it.

## Zoho Books removed — our GST engine is the only invoice issuer (OWNER DECISION, 24 Sep 2026)

**This is a user decision, not a refactor.** On 24 Sep 2026 the owner (Pardeep) asked for Zoho Books to be removed completely: *"Remove the Zoho completely. Mark it as user decision."* Do not reintroduce Zoho Books — as a fallback, a sync, a contact mirror or anything else — without the owner asking for it. If a future need looks like it wants an accounting system, raise it with the owner first; do not build it.

What that means in code:

- ~~**One issuer.** `createPrimaryInvoice` (our GST engine, `TI/YYYY-YY/NNNNN`) issues every invoice.~~ **Superseded 25 Sep 2026: DMS issues no invoices; the engine is deleted** (see "Billing moves to ResellerOS"). Historical text follows. It was ungated and had **no fallback**. The `ZOHO_INVOICE_FALLBACK_ENABLED` flag is gone. Two invoice series under one GSTIN can no longer happen going forward.
- **A failure is flagged, never papered over.** When the engine throws, the caller writes a SystemLog row and `markInvoiceCreationFailed` stamps `invoiceFailedAt` + `invoiceFailureReason` on the Order (this replaces the old `zohoInvoiceId: 'creation_failed'` sentinel). It shows in admin integration-health (**Invoicing** card) and Admin → Invoices diagnostics, the customer's invoices page retries it (`lib/invoice-retry.ts`, throttled 5 min, plus a "Retry" pill), and an admin can press Re-sync (`app/api/admin/orders/[id]/re-sync-invoice`).
- **Renewal invoices** go through the Cloud Tasks worker `app/api/workers/issue-invoice` (renamed from `sync-zoho-invoice`). Queue: `GCP_INVOICE_QUEUE_NAME`, else `GCP_QUEUE_NAME`.
- ~~**Prerequisite:** `COMPANY_STATE` must be set~~ **Removed 26 Sep 2026** (owner: "remove the unused ones"): with the engine gone nothing read it. The deploy-script requirement, `CompanyProfile.state` and the env entries are deleted.
- **Historical Zoho invoices.** Orders Zoho invoiced before the removal carry `invoiceProvider: 'zoho'` (stamped by Mongo migration `009_retire_zoho_invoice_fields`). That value is read-only history: it is what stops any retry issuing a second invoice for those payments. Their PDFs are re-rendered by DMS from the order (as a Proforma copy — the tax split lived in Zoho). Measured at removal: production held **2 orders, both Zoho-invoiced test orders**.
- **Double-billing guards** in the re-sync route, the issue-invoice worker, `idempotency.ts` and the engine's own claim all refuse ANY `invoiceProvider` — primary or historical zoho.
- **GSTR-1:** from 24 Sep 2026 only our `TI/...` series is issued. Zoho's numbers remain valid for the periods they were used.

**Deploy order.** Run `npm run migrate` (applies 009) with the deploy of this code. If the migration runs late, nothing double-invoices: the engine's claim (`claimOrderForPrimaryInvoice`) also refuses any order still carrying a raw `zohoInvoiceId`, and the retry paths only touch orders with `invoiceFailedAt` — both pinned by tests. The two historical orders would just show as uninvoiced in admin diagnostics until it runs.

## Primary-invoice refunds — credit notes are MANUAL (operator decision 2026-09-03)

Our primary GST engine mints tax invoices (`TI/YYYY-YY/NNNNN`) but has **no credit-note counterpart**. Building a reverse-numbering series was deliberately deferred: no primary invoice exists in production yet, there is no in-app refund at all (`handleRefundPayment` in the admin payment page is an empty stub — every real refund is issued by hand from the Razorpay dashboard), and the only automated refund is the ₹2 mandate-validation reversal on a trial order, which never gets an invoice in the first place.

**Consequence:** a refund against a primary-issued invoice leaves a real GST obligation that a human must discharge.

**The flow:** `refund.processed` in `app/razorpay/webhook/route.ts` branches on ANY `invoiceProvider` (primary, or a historical Zoho invoice — whose credit notes Zoho used to raise automatically) BEFORE the benign no-invoice skip, logs at ERROR with the order id / `TI/...` number / refund id / rupee amount / ACTION line, and stamps `creditNotePending` (+ refund id, amount in paise, timestamp) on the Order. `app/api/admin/integration-health` lists every flagged order on the **Invoicing** card.

**Operator action when a `[CREDIT-NOTE]` entry appears:** raise a credit note by hand against the named invoice for the named amount, then clear `creditNotePending` on the Order. (Owner, 24 Sep 2026: no credit-note engine for now — the only refunded-invoice candidates were test orders.)

**Do NOT time-window that health check.** Every other source there is bounded by `since` because stale errors stop being actionable; this one is the opposite — GST credit notes must be issued by **30 November following the end of the financial year**, so an outstanding one gets *more* urgent with age. Ageing it out is the exact failure the check exists to prevent.

Building the engine properly (its own Counter, reverse-numbered series, PDF, wiring into the refund handler) stays open as item 3 of the post-Phase-2 audit in `TASKS.md` — do it when real refund volume justifies it, not before.

## ⚠️ Migration 008 is written and NOT applied to production (2026-09-21)

`scripts/db/migrations/008_drop_domain_orderid_unique.ts` drops the unique
constraint on `Domain.orderId`. Until it runs, **every multi-domain order loses
every domain after the first**: one order id is written to each domain row, the
unique index rejects the second insert with E11000, the catch swallows it, and
the order still reports success. Money taken, domain really registered at
ResellerClub, no `Domain` row — so it is invisible to renewals, expiry
reminders and the dashboard.

It has been applied to the LOCAL database only, and verified there: before, two
inserts sharing an orderId stored one of two; after, three of three.
`resellerClubOrderId` keeps its unique index and still refuses duplicates —
that is the constraint that actually guards against recording a double
registration, and it must not be dropped.

```bash
npm run migrate:status     # confirm 008 is pending
npm run migrate            # apply
# then, separately, confirm the index really changed:
#   db.domains.getIndexes()  ->  orderId_1 present, WITHOUT unique
```

Verify in a separate step, not the same one. The migration drops and recreates
an index on a live collection; a run that drops without recreating leaves
order-scoped lookups doing a collection scan, and the only way to know is to
look.

**Do not "fix" this by re-adding `unique: true` to the model.** The field is
one-to-many by definition — one of our orders holds many domains.

## The admin shell is mounted by the route layout, not by pages (2026-09-21)

`app/admin/layout.tsx` renders `<AdminLayout>` once for the whole /admin
subtree. Before it existed, all 25 admin pages rendered the shell themselves,
so every client-side navigation destroyed and rebuilt the sidebar — with
`AdminLayoutSkeleton`'s `bg-blue-900` (pre-restyle) sidebar flashing in
between. Measured: the sidebar node was replaced, and at some frames there was
no sidebar in the DOM at all.

- **A new admin page renders its content only.** Do not add `<AdminLayout>`.
- The 25 existing pages still wrap themselves, and that is fine: a context flag
  (`components/admin/AdminShellContext.tsx`) makes `AdminLayout` and
  `AdminLayoutSkeleton` render as passthroughs when a shell is already above
  them. Removing those wrappers is safe cleanup, one page at a time — a page
  with the wrapper and one without produce the same tree.
- **Do not make the passthrough unconditional.** `AdminLayoutSkeleton` is used
  outside /admin too, where there is no shell and it must still draw chrome.
  Both directions are pinned in `tests/unit/components/admin/AdminShell.test.tsx`.

## DMS runs in two shapes — check which one before changing a public page (2026-09-21)

`NEXT_PUBLIC_RESELLEROS_URL` decides whether this app is the whole product or
the hosting/domain panel behind ResellerOS. Set, `/` 307s to ResellerOS and
every brand/home link points there; unset, DMS is standalone with its own
homepage, exactly as before. Unset is the default on purpose — turning a
working frontpage off must be a deployment decision, not a side effect of
merging.

- **One source of truth for the value**: `resellerOsUrl()` in
  `lib/reseller-os.ts`. It returns `null`, never `""` — an empty base makes an
  href *relative*, which is not a broken link but one that silently points back
  at DMS. Do not add a `?? ""`.
- **Two enforcement points, deliberately**: `middleware.ts` (for the status)
  and `app/page.tsx` (the guarantee). `app/` has a `loading.tsx`, so a redirect
  decided during render lands after streaming has started and degrades to a
  `200` carrying a one-second `<meta http-equiv="refresh">`. Measured, not
  assumed.
- **It is a build arg, in BOTH Dockerfile stages.** `NEXT_PUBLIC_*` is inlined
  by `next build`. The builder copy feeds the client bundle (the links); the
  runner copy feeds the server component (the redirect). Declaring it in the
  builder only is exactly what happened first — the logo moved and `/` went on
  serving the homepage. Setting it on a running container does nothing.
- **Do not reintroduce a homepage link.** Brand marks get their href from
  `Logo`'s default, which follows the front door. Pass an explicit `href` only
  where the target genuinely is not home (the signed-in nav → the panel).
- **The legal/marketing pages redirect; they must never 404.** `/privacy`,
  `/terms-and-conditions`, `/cancellation-refund`, `/contact` and `/about` go
  to their ResellerOS equivalents for non-admins (map in `lib/reseller-os.ts`).
  Razorpay requires a merchant's policy pages to be publicly reachable, so
  "hide them" has to mean "they live at one origin instead of two". Admins
  still get DMS's copy so the pages stay checkable.
- **Do not widen that map to the purchase funnel.** `/hosting`, `/domains/*`,
  `/cart` and `/checkout` are the only working way to buy hosting or a domain
  today. Taking them over leaves no way to sell.

## Domain renewal is gated, and the gate is load-bearing (2026-09-21)

`POST /api/domains/renew` spends real registrar balance. It now requires
ownership (`findOrderByDomainForUser` + `findOrderDomain`, the repo-wide idiom)
**and** a verified Razorpay payment, both before `rcRenewDomain`.

Before that it had neither, and the modal *fabricated* the payment id, so any
signed-in customer could renew any domain in the account for free. It also
never passed `razorpayOrderId`/`razorpayPaymentId`, which the Order schema
marks required — so `createOrder` threw on every run, *after* the registrar had
been charged, and the customer was told it failed.

There is no retail renewal price for domains in this codebase, so nothing can
produce the payment the route now demands and the UI routes to support instead.
**Do not "fix" that by relaxing the gate.** ~~Finish it the other way: set a
markup, then mirror `app/api/user/hosting/renew/route.ts`.~~ **Superseded 25 Sep 2026:** renewals
are ResellerOS's. The Renew button now shows the customer's ResellerOS renewal bill
(`components/billing/RenewViaResellerOs.tsx`) and ResellerOS's `domain.renew` engine command
renews at the registrar. This route is no longer reached from the UI (kept; gated).

## Guest checkout and DMS autopay are REMOVED (owner: "Remove both", 25 Sep 2026)

`/checkout/guest`, `api/payments/guest/*`, `lib/guest-token.ts`, `api/payments/create-subscription` and
`api/payments/cancel-subscription` are deleted; so are the cart's "Continue as Guest" option and the
middleware bypasses for them. Both took payment on DMS's own Razorpay account. A visitor signs in or
creates an account; the cart is kept. Existing subscription/order data is untouched. Do not rebuild them.
`/razorpay-checkout` + `components/RazorpayCheckoutFrame.tsx` stay: they only open a checkout, and the
panel's ResellerOS-created order uses them.

## Renewals go to ResellerOS — DMS raises no renewal order (built 25 Sep 2026)

Owner: *"Renewals subscription will be handled by ResellerOS. Period."*

- **Renew buttons** (hosting page, domains page, the trial countdown's convert button) open
  `RenewViaResellerOs`: the customer's PENDING ResellerOS quote(s) with ResellerOS's Pay link, or "no
  renewal bill yet — ResellerOS emails one before expiry; contact support". It takes no payment. Quotes
  carry no domain in ResellerOS's API, so every pending quote is offered rather than a guessed one
  (`lib/reselleros/renewal-choice.ts`).
- **Deleted:** `HostingRenewalModal`, `DomainRenewalModal`, `api/user/hosting/renew`, `renew-info`.
- **The expiry worker** (`api/workers/process-hosting-expiry`, which also handles a trial's end) still
  suspends exactly as before, but raises no renewal Order and sends no DMS amount; it sends the
  suspension email + WhatsApp. Paying the ResellerOS renewal runs `hosting.renew` / `domain.renew` here,
  which move the expiry and unsuspend.
- **Renewal reminders carry no DMS price (26 Sep 2026, owner: "Point to the ResellerOS quote").**
  `process-service-expiry` still sends the expiry reminder, but `sendServiceReminderEmail` takes a `renewal`
  link (`lib/reselleros/renewal-reminder-link.ts`, built on `lib/reselleros/bills.ts` with the same fail-closed
  email match): one pending ResellerOS quote → its `payment_url`; several → the Invoices page; none → "being
  prepared, emailed by our billing system"; ResellerOS unreadable → still sent, no price and no link. The dead
  `sendRenewalInvoiceEmail` (a DMS `invoiceAmount`) is deleted. Scan: `tests/unit/lib/email/reminder-no-dms-price.test.ts`.
- **Left alone, found:** ~~`process-service-expiry` reminder emails still quote `service.price`~~ (fixed above); ~~`cron/renewal-payment-dunning` still chases DMS renewal orders raised before this date~~
  (DELETED 26 Sep 2026, owner: "Switch it off" — with its email, `RENEWAL_DUNNING_HOURS`, its deploy-script
  sticky var and `scripts/setup-cloud-scheduler-billing.sh`; the Order `dunning*` fields and index stay for
  old rows);
  `api/domains/renew` is unreached from the UI.

## The DMS /cart pays through ResellerOS; create-order and verify are DELETED (owner, 25 Sep 2026)

Owner: "Route through ResellerOS". The cart stays (HostingUpsell, DomainCrossSell, saved carts, several items).
`/checkout` hands a PAID cart to `components/purchase/PanelCheckout.tsx` (`{ kind: "cart" }`) → `/api/user/panel-order`
→ ResellerOS `/api/dms/panel-order`. `lib/reselleros/cart-lines.ts` maps each line: hosting → `hosting:<plan>` +
cycle (one hosting line per cart, linked to a real domain); domain → `domain:<tld>`, qty 1, the exact name (a
multi-year line or a TLD needing registry details is refused); anything else is refused BY NAME. The same mapper
runs in the browser (to show the refusal first) and on the server (the authority). Razorpay opens with
ResellerOS's key; on success the page shows "Payment received" and empties the cart; nothing is recorded in DMS.

~~The ₹0 trial is the only purchase DMS still starts itself~~ **Since 26 Sep 2026 the panel trial starts IN
RESELLEROS** (owner: "Move it to ResellerOS"): `api/user/hosting/start-trial` keeps the lone-trial / Starter /
cycle / trials-switch / trial-abuse gates, then calls ResellerOS `POST /api/dms/start-trial`
(`lib/reselleros/start-trial.ts`, same `DMS_PANEL_API_KEY`, never retried). ResellerOS runs the site's trial code
(one trial per customer across both apps, checked against DMS's shared record — `ExternalTrial` /
`findPriorTrial` / the engine trials endpoint all STAY), emails a confirm link, and the DMS engine's
`hosting.provision` trial mode creates the account once the customer confirms. The panel says "Check your email
to confirm; your trial account is created once you confirm." DMS creates no trial Order or Hosting any more;
`lib/services/payment/manual-trial-provisioner.ts` is deleted. The Convert button then finds ResellerOS's quote.
**The trial PRE-check asks ResellerOS too (26 Sep 2026, owner: "Ask ResellerOS instead").**
`api/user/hosting/trial-eligibility` keeps the trials switch, trial-abuse and Starter/plan-exists layers, but the
one-trial-per-customer answer now comes from ResellerOS `POST /api/dms/trial-eligibility`
(`lib/reselleros/trial-eligibility.ts`) — the same function its `startHostingTrial` runs, so the button and the
start cannot disagree. Identity is the SESSION's email/phone; a domain is sent only when it is a real name.
Anything but a clear 200 (503, 400/401, timeout, unreachable, no key) → `eligible:false`, code `CANNOT_CHECK`,
"can't check right now" — never eligible, never DMS's own answer. One 300 ms retry only on connection-refused.
`userHasPriorTrialOrder` is deleted; the razorpayPlans.yearly requirement on the pre-check went with it. `api/payments/create-order` and
`api/payments/verify` are deleted with every module only they used. The Tokens-CIT and Razorpay-Subscriptions
trial branches went with create-order (reachable only with `DMS_HOSTING_SUBSCRIPTIONS_ENABLED=1`, now gone). The
payment.captured webhook stays for orders created before this date.

**Sections above that describe `create-order`, `verify`, `repriceHostingItems` or `dmsCreatesHostingSubscriptions`
are history** — those files no longer exist.

## GUARD — DMS takes no payment on its own Razorpay keys (25 Sep 2026)

`tests/unit/lib/no-dms-razorpay-payments.test.ts` fails if the Razorpay SDK is imported, or `orders.create` /
`subscriptions.create` / `payments.capture` / `payments.createRecurringPayment` is called, outside:
`lib/razorpay-client.ts` (the shared client) and
in `lib/razorpay.ts` only `chargeViaToken` — the gated charger for EXISTING Tokens the owner asked to keep.
Its only caller is `recurring-charge-service.ts`, behind `DMS_TOKEN_RECURRING_ENABLED` (the test asserts the
gate). `RazorpayService.createOrder`, `createSubscription` and — since 26 Sep 2026 — `createCustomer` and
`createRecurringTokenOrder` (the new-mandate methods, with their live harness) are deleted, so no new token can
be created. **No Razorpay PLAN is created either** (26 Sep 2026, owner: "Stop creating plans"): the admin
package edit (`api/admin/hosting/packages` PATCH) no longer makes a monthly + yearly plan on a renewal-price
change, and `RazorpayService.createPlan` is deleted. `scripts/razorpay-regenerate-plans-live.js` is deleted too
(round 6), so `plans.create(` is refused everywhere, with no exception.
Existing `hostingplans.razorpayPlans` ids are left as they are. Do not widen the allow-list without the owner.

**Dead code removed 26 Sep 2026** (owner: "Delete dead DMS code"): `app/api/domains/renew` (unreached since the
Renew button points at ResellerOS), `lib/services/payment/verification.ts` (its last importer),
`createCompletedOrder`, `cartItemsFromOrderDomains` and `validateNoRestrictedDomains` in
`lib/services/payment/order-creator.ts` (last caller was `/api/payments/verify`). `finalizePendingOrder` stays:
the payment.captured webhook uses it for orders made before 25 Sep.

## A hosting upgrade is a REQUEST billed by ResellerOS (owner, 25 Sep 2026)

`HostingUpgradeModal` sends "Request upgrade" → `POST /api/user/hosting/upgrade` →
`lib/reselleros/upgrade-request.ts` → ResellerOS `POST /api/dms/upgrade-request` (same `DMS_PANEL_API_KEY`).
Identity from the session; the server's prorated figure (ResellerOS prices, incl. GST, int) goes as
`estimateRupees` and is shown to the customer as an ESTIMATE. Nothing is created in DMS and no payment is
taken; staff send a quote and change the plan once it is paid. A timeout is not retried: the customer is
told it may have been recorded. `upgrade-info` still only computes the estimate.

## Other persistent conventions

- Do not surface credential/key rotation as a next step — the user has opted out for this project (see auto-memory `feedback_key_rotation_skip`). **Exception**: active leaks discovered via security review override this preference; rotate immediately, don't ask twice.


- Do not force-restart the DirectAdmin/hosting server or aggressively roll IPs — the Cloud Run NAT IP must stay whitelisted at all 4 DA layers (see auto-memory `project_da_whitelist_layers`).


- After triggering a deploy via `scripts/deploy-cloud-run.sh`, tail the output so the user sees progress (see auto-memory `feedback_deploy_progress`).


- **Always use the local Docker build path** when deploying. `bash scripts/deploy-cloud-run.sh` already defaults to local — do NOT pass `--cloud-build`, and do NOT propose Cloud Build (`gcloud builds submit`) as an alternative. Cloud Build on `E2_HIGHCPU_8` was costing ~$0.08/deploy and ~10 deploys/day adds up; the VPS already runs 24/7 so local builds are free at the margin. If Docker is missing on the host running the script, fix Docker — don't fall back to Cloud Build. The `--cloud-build` flag and `cloudbuild.yaml` stay in the repo only as an emergency escape hatch for machines that don't have Docker (see auto-memory `feedback_local_build_only`).
