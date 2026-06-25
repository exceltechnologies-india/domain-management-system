# Razorpay Tokens Migration — Design Document

**Author:** Claude Code (working with Pawan)
**Date:** 2026-06-25
**Status:** DRAFT — awaiting review + Razorpay-doc verification on the
specific API parameters in §4.
**Implementation gate:** scheduled to start AFTER Razorpay live cutover
Steps 4-5 close (post UPI Autopay activation, est. 2026-07-08).

## 1. Background

### 1.1 The conversion-killing UX gap

The hosting "free trial" CTA on `/hosting` tells the customer they will
be charged ₹0 today, then billed yearly after 15 days. When they click
through to checkout, Razorpay's overlay tells them a different story —
the full yearly plan price (e.g., ₹599.88 for Starter) plus a ₹1-₹2
mandate-validation charge.

The discrepancy is not a bug in our display logic. It is a structural
limitation of Razorpay's **Subscriptions API**, which we use to set up
recurring hosting billing. A subscription is tied to a fixed plan
(`plan_T5nE…` IDs created during the live cutover Step 3), and at
authorization time Razorpay's checkout overlay reads the plan price
and shows it to the customer. There is no parameter on
`subscriptions.create()` to override what the customer sees.

### 1.2 What customers expect (the Google / Netflix / Spotify pattern)

Every major Indian recurring-billing product uses a different Razorpay
API path — the **Tokens API** (also called "Recurring Payments via
Customer-Identifier + Token", or "Authorization Payment" in some
Razorpay docs). The flow customers see:

1. Subscribe → Razorpay overlay opens
2. Razorpay shows **₹2** (or some small validation amount) as the
   headline charge — clearly labeled as authorization/mandate setup
3. Customer authorizes → ₹2 debited from bank
4. Within minutes, ₹2 refunded (merchant initiates the refund)
5. Mandate is now live; merchant can charge any amount on any schedule
6. Net cost to customer: ₹0

This is the pattern the operator referenced in the 2026-06-25
conversation that triggered this design doc.

### 1.3 Why now

The Razorpay live cutover (Steps 1-3 done 2026-06-24/25, Steps 4-5
paused on UPI Autopay activation est. 2026-07-08) ships our existing
Subscriptions-API flow into live mode. The ₹2 pattern is a meaningful
product improvement on top of that baseline — not a regression fix.
It is scheduled to start after the live cutover verification closes
so the migration happens against a known-good baseline.

## 2. Current architecture (Subscriptions API)

File-by-file map of how recurring hosting billing works today. This is
what gets replaced.

### 2.1 Cart → Order creation

| File | Responsibility |
|------|----------------|
| [app/hosting/page.tsx:118-141](../app/hosting/page.tsx#L118-L141) | `addTrialToCart` — creates cart item with `price: 0`, `isTrial: true`, `billingCycle: 'yearly'` |
| [app/api/payments/create-order/route.ts:233-273](../app/api/payments/create-order/route.ts#L233-L273) | At checkout, queries `HostingPlan.razorpayPlans[period]`, then calls `RazorpayService.createSubscription(razorpayPlanId, userId, domainName, customerNotify, totalCount, trialDays?)` |
| [lib/razorpay.ts:242-285](../lib/razorpay.ts#L242-L285) | `createSubscription` — wraps `razorpayClient.subscriptions.create({plan_id, customer_notify, total_count, quantity, notes, start_at?})` |

The subscription's `subscription_id` is returned to the frontend, which
opens Razorpay checkout in subscription-authorization mode.

### 2.2 Razorpay-side mandate authorization

Razorpay handles this entirely. The customer sees the plan amount,
authorizes the mandate (varies by payment method — card eMandate / UPI
Autopay / eNACH / Paper NACH). Razorpay charges a small auth amount
(₹1-₹2 for cards, similar for UPI) for mandate validation — Razorpay
auto-reverses this in most cases, but the customer sees it as a
pending charge on their bank statement for 3-5 days.

### 2.3 Webhook events + recurring debit

| Razorpay event | Our handler | Action |
|----------------|-------------|--------|
| `subscription.charged` | [lib/services/payment/webhook-handlers.ts:63-304](../lib/services/payment/webhook-handlers.ts#L63-L304) `handleSubscriptionCharged` | Records RenewalPayment, atomic claim, extends `Hosting.expiryDate`, fires Zoho invoice via Cloud Task |
| `subscription.halted` | [lib/services/payment/webhook-handlers.ts:306-344](../lib/services/payment/webhook-handlers.ts#L306-L344) `handleSubscriptionFailed` | Marks Hosting expired, suspends DA user, flips to manual billing |
| `payment.captured` (one-shot) | [app/razorpay/webhook/route.ts:81-250](../app/razorpay/webhook/route.ts#L81-L250) `handlePaymentCaptured` | For domain registrations + non-trial hosting checkouts; not relevant to subscriptions |

Razorpay manages the recurring schedule. We just listen for `charged`
events. The first `charged` event fires at `start_at` (for trial
subscriptions) or immediately (for non-trial).

### 2.4 Data model

| Field | Where | Meaning |
|-------|-------|---------|
| `HostingPlan.razorpayPlans.monthly` | MongoDB | Razorpay Plan ID for monthly billing of this tier (live: `plan_T5nE…`) |
| `HostingPlan.razorpayPlans.yearly` | MongoDB | Razorpay Plan ID for yearly billing of this tier |
| `Hosting.subscriptionId` | MongoDB | Active Razorpay subscription ID for this hosting account |
| `Hosting.isTrial` | MongoDB | True if account is in 15-day trial; flipped false on first `subscription.charged` |
| `Hosting.expiryDate` | MongoDB | Current paid-through date; extended by `handleSubscriptionCharged` |
| `RenewalPayment` collection | MongoDB | Idempotency anchor — one row per `subscription.charged` event |

## 3. Target architecture (Tokens API)

File-by-file map of what changes. New / modified files marked.

### 3.1 Cart → Order creation

| File | Change |
|------|--------|
| `app/hosting/page.tsx:118-141` | **No change** to `addTrialToCart` — UI still shows ₹0 today, trial still works the same from the user's perspective |
| `app/api/payments/create-order/route.ts:233-273` | **REWRITE** the recurring-hosting branch. New behavior: (a) call `RazorpayService.createCustomer(user)` to get or reuse a customer_id; (b) call `RazorpayService.createRecurringTokenOrder({customer_id, validationAmount: 200, maxAmount: <tier-max>, frequency: 'monthly'/'yearly', expireBy: <30 years out>})` to get an order_id with recurring token options; (c) return order_id + customer_id to frontend |
| `lib/razorpay.ts` | **NEW METHODS**: `createCustomer(user)`, `createRecurringTokenOrder({customer_id, validationAmount, maxAmount, frequency, expireBy})`, `chargeViaToken(customer_id, token_id, amount, receipt)`, `refundPayment(payment_id, amount)` |

### 3.2 Razorpay-side authorization

Customer sees ₹2 (the `validationAmount`) on the Razorpay overlay
instead of the plan price. Razorpay shows the autopay mandate consent
screen with this ₹2 as the headline. Customer authorizes; mandate is
set up.

### 3.3 New webhook flow

| Razorpay event | Our handler | Action |
|----------------|-------------|--------|
| `payment.captured` on a recurring-token order (CIT — customer-initiated transaction) | **NEW BRANCH** in [app/razorpay/webhook/route.ts](../app/razorpay/webhook/route.ts) | (a) Read `token_id` from payment object; (b) store on `Hosting.razorpayTokenId`; (c) immediately call `RazorpayService.refundPayment(payment_id, validationAmount)` to refund the ₹2; (d) flip Hosting status to `active` / extend expiry by trial period |
| `payment.captured` on a merchant-initiated transaction (MIT — recurring charge we triggered) | **NEW BRANCH** | Similar to current `subscription.charged` — record RenewalPayment, extend expiry, fire Zoho invoice via Cloud Task |
| `payment.failed` on MIT | **NEW BRANCH** | Similar to current `subscription.halted` — mark Hosting expired, suspend DA user (after retry exhaustion — see §3.5) |
| `subscription.charged` / `subscription.halted` | **REMOVE eventually** | Keep for backward-compat with existing subscription-mode customers until they all cycle out (~12-18 months) |

### 3.4 New: merchant-driven recurring charge cron

| File | Purpose |
|------|---------|
| `scripts/charge-recurring-hostings.js` (NEW) | Cron entry point. Queries `Hosting.find({ status: 'active', razorpayTokenId: { $exists: true }, expiryDate: { $lte: today + 1 day } })`. For each due Hosting, calls `RazorpayService.chargeViaToken(customer_id, token_id, planAmount, receipt)`. Does NOT update Hosting state directly — relies on the webhook `payment.captured` MIT handler to do that (idempotent). |
| `gcloud scheduler jobs create` config | New job: invoke this cron daily at 04:00 IST. Existing scheduler config in `scripts/setup-cloud-scheduler.sh` (or equivalent — verify location). |

### 3.5 Retry + dunning logic (no longer Razorpay's job)

Razorpay's Subscriptions API handles retries automatically (retries
for ~7 days then halts the subscription). In Tokens mode, **we are
responsible for retries**. Plan:

1. Cron fires charge → fails → record in new `RecurringChargeAttempt`
   collection with `attemptCount`, `nextAttemptAt`
2. Retry schedule: T+0 (initial), T+1 day, T+3 days, T+7 days
3. After 4 failed attempts: mark Hosting expired, suspend DA user,
   send dunning email (re-using existing email templates from
   [lib/services/payment/webhook-handlers.ts:311-343](../lib/services/payment/webhook-handlers.ts#L311-L343))

This is meaningful new logic. Estimated +1 day of work beyond the
core migration.

### 3.6 Data model changes

| Field | Status | Notes |
|-------|--------|-------|
| `Hosting.razorpayCustomerId` (NEW) | New | Razorpay customer_id for this user (one per user, reused across hosting accounts) |
| `Hosting.razorpayTokenId` (NEW) | New | Mandate token issued at CIT authorization; used for all future MIT charges |
| `Hosting.subscriptionId` | Keep | Backward-compat for existing customers; new customers won't have this populated |
| `HostingPlan.razorpayPlans` | Keep | Backward-compat for existing subscription-mode customers; new flow doesn't read this |
| `RecurringChargeAttempt` collection (NEW) | New | Retry-attempt log (see §3.5) |

## 4. Razorpay API specifics

**✅ VERIFIED 2026-06-25 against razorpay-node v2.9.6 TypeScript
definitions** (`node_modules/razorpay/dist/types/`). The shapes below
match exactly what the installed SDK accepts. Corrections from the
draft version:

- Parameter was `expire_by` in the draft → actual SDK uses **`expire_at`**
- Draft used `max_amount: 99999900` (₹9,99,999) generically → actual
  caps are payment-method-specific:
  - **Cards (NPCI cap): `max_amount` between 100 (₹1) and 1500000 (₹15,000)** — hard ceiling, no waiver path
  - **eMandate (netbanking/debitcard): `max_amount` between 500 (₹5) and 100000000 (₹10,00,000), default 9999900 (₹99,999)**
  - UPI Autopay: not exposed as a separate type in razorpay-node v2.9.6 — most likely uses the card-token shape (`RazorpayTokenCard`), inheriting the ₹15,000 cap. **Verify with Razorpay support** once UPI Autopay activates 2026-07-08.
- Draft listed `frequency: 'yearly'` as a possible value → razorpay-node
  comments are explicit: **only `as_presented` and `monthly` are
  supported for card tokens**. No `yearly`, `daily`, or `weekly`.
- `payment_capture` is a **boolean** (`true`/`false`), not an integer
- The MIT charge uses **`razorpay.payments.createRecurringPayment()`** with `token: string` (the token_id) + `recurring: true | 1 | '1'`

### 4.1 Customer creation

```js
const customer = await razorpay.customers.create({
  name: `${user.firstName} ${user.lastName}`.trim(),
  email: user.email,
  contact: user.phone,
  fail_existing: 0,  // Reuse if exists for this email
  notes: { user_id: user._id.toString() },
});
// customer.id is the customer_id we store
```

### 4.2 Recurring-token order (CIT — ₹2 validation transaction)

```ts
// SDK shape: RazorpayAuthorizationCreateRequestBody
const order = await razorpay.orders.create({
  amount: 200,                     // ₹2 in paise — the validation amount
  currency: 'INR',
  customer_id: customer.id,        // REQUIRED — ties this order to the customer
  payment_capture: true,           // BOOLEAN, not 0/1
  receipt: `auth_${orderId}`,
  method: 'card',                  // OR 'emandate' / 'upi' / 'nach' / 'netbanking'
  notes: {
    type: 'mandate_validation',
    user_id: user._id.toString(),
    domain_name: domain,
    intended_tier: 'starter',
    intended_period: 'yearly',
  },
  // Token object — shape varies by payment method (see 4.2.1 + 4.2.2)
  token: {
    // FOR CARDS (RazorpayTokenCard):
    max_amount: 1500000,           // ₹15,000 — NPCI's hard cap for card recurring.
                                   // NO WAIVER PATH. Tiers priced above ₹15,000 cannot
                                   // use card-based mandate; would need eMandate flow.
    expire_at: <epoch in seconds>, // FIELD NAME is `expire_at`, NOT `expire_by`.
                                   // Default if omitted: 10 years from now.
    frequency: 'as_presented',     // Card-only values: 'as_presented' OR 'monthly'.
                                   // 'yearly' NOT supported for cards.
                                   // 'as_presented' = merchant can charge any time, any amount up to max
  },
});
// order.id returned to frontend; opens Razorpay checkout in
// recurring-payment-authorization mode (NOT subscription mode)
```

#### 4.2.1 eMandate variant (netbanking + debit card mandates)

```ts
{
  // RazorpayTokenEmandate shape:
  auth_type: 'netbanking',  // OR 'debitcard' | 'aadhaar' | 'physical'
  max_amount: 9999900,      // Default ₹99,999; range 500 (₹5) to 100000000 (₹10,00,000)
  expire_at: <epoch>,       // Default 10 years
  notes: {...},
  bank_account: {...},      // Optional pre-fill at checkout
  first_payment_amount: 0,  // Optional: charge this amount IN ADDITION to validation amount at auth
}
```

#### 4.2.2 NACH variant (paper / physical mandates)

```ts
{
  // RazorpayTokenNach shape — extends RazorpayTokenEmandate with NACH form metadata:
  ...emandate_fields,
  nach: {
    form_reference1: string,
    form_reference2: string,
    description: string,
  },
}
```

#### 4.2.3 UPI Autopay (not exposed in razorpay-node v2.9.6 types)

The SDK's `RazorpayAuthorizationCreateRequestBody.token` union is
`RazorpayTokenCard | RazorpayTokenEmandate | RazorpayTokenNach` — no
UPI-specific shape. Most likely UPI uses the card-token shape
(`{max_amount, expire_at, frequency}`) with `method: 'upi'` on the
order. **Verify with Razorpay support** once UPI Autopay activates
2026-07-08 — if SDK types are out of date, the actual API may accept
UPI Autopay tokens via the same shape.

### 4.3 Customer pays + we receive the token

Razorpay checkout shows ₹2 + mandate consent. Customer authorizes.
`payment.captured` webhook fires. Payment object contains:

```js
{
  id: 'pay_…',
  amount: 200,
  status: 'captured',
  order_id: 'order_…',
  customer_id: 'cust_…',
  token_id: 'token_…',  // ← The mandate token we store
  // …
}
```

### 4.4 Immediate refund of the ₹2

```js
await razorpay.payments.refund(payment.id, {
  amount: 200,
  speed: 'optimum',  // Fastest available — usually back to bank in minutes for cards, instant for UPI
  notes: { reason: 'mandate_validation_refund' },
});
```

### 4.5 Merchant-initiated transaction (MIT) — the actual subscription charge

```ts
// In scripts/charge-recurring-hostings.js cron:
// Step 1: create an order for the MIT charge
const order = await razorpay.orders.create({
  amount: 59988,                   // ₹599.88 in paise — Starter yearly
  currency: 'INR',
  customer_id: hosting.razorpayCustomerId,
  payment_capture: true,           // BOOLEAN, not 0/1
  receipt: `mit_${hosting._id}_${Date.now()}`,
  notes: { type: 'recurring_charge', hosting_id: hosting._id.toString() },
});

// Step 2: SDK shape RazorpayRecurringPaymentCreateRequestBody — extends
// RazorpayPaymentBaseRequestBody with `token` + `recurring`
const payment = await razorpay.payments.createRecurringPayment({
  email: user.email,
  contact: user.phone,
  amount: 59988,
  currency: 'INR',
  order_id: order.id,
  customer_id: hosting.razorpayCustomerId,
  token: hosting.razorpayTokenId,  // the token_id from CIT (NOT the customer_id)
  recurring: true,                  // ALSO accepts 1 | 0 | '1' | '0' per SDK type
  notes: { hosting_id: hosting._id.toString() },
  description: `Recurring charge for ${hosting.domainName}`,
});
```

`payment.captured` webhook fires (MIT branch) → `handleRecurringTokenCharge`
records RenewalPayment + extends expiry.

### 4.6 Limitations to verify before implementation

- [ ] Does Razorpay enforce a minimum delay between mandate auth (CIT)
      and first MIT charge? (Some processors require 24h.)
- [ ] Card eMandate: does the `max_amount` get re-confirmed by the
      issuing bank periodically? (Some banks require fresh auth after
      `max_amount` change.)
- [ ] UPI Autopay: behavior of `frequency: 'as_presented'` vs
      `frequency: 'monthly'` — `as_presented` may not be supported by
      all NPCI-participating banks. Verify with Razorpay support.
- [ ] eNACH: validation amount minimum (Razorpay may require ₹1+ minimum).
- [ ] Paper NACH: not supported in tokenized flow — would need fallback to
      subscription-mode for the small fraction of customers who pick this.

## 5. Migration plan

### 5.1 Existing customers (subscription-mode)

**Approach: keep both flows running in parallel until natural attrition.**

- Subscription-mode customers (anyone with `Hosting.subscriptionId` set)
  continue to receive `subscription.charged` webhooks; existing handlers
  stay live for them.
- New customers (after migration cutover) use the Tokens flow exclusively.
- No forced migration of existing customers — their mandates work fine
  on the Subscriptions API.
- After 12-18 months when most subscription-mode customers have either
  churned, upgraded, or downgraded (triggering a new mandate setup under
  Tokens), the old `handleSubscriptionCharged` / `handleSubscriptionFailed`
  handlers can be removed.

Adds operational complexity but avoids forcing existing customers to
re-authorize their mandates (which would lose conversions).

### 5.2 Feature flag

`HOSTING_MANDATE_FLOW=tokens` env var (default: `subscriptions` while
rolling out, flipped to `tokens` after verification).

`app/api/payments/create-order/route.ts:233-273` branches on this flag:
- `tokens` → new Tokens flow
- `subscriptions` → existing flow (lets us revert without code change
  if Tokens flow has problems in production)

### 5.3 Phased rollout

| Phase | Scope | Duration | Exit criteria |
|-------|-------|----------|---------------|
| **0** | Implementation + automated tests | 3-4 days | All unit + integration tests pass |
| **1** | Internal test with operator's own account at flag-flipped state | 1 day | Real ₹2 charge + refund visible in Razorpay LIVE dashboard, MIT charge fires successfully via cron |
| **2** | Starter tier only (cheapest, lowest blast radius) | 7 days | No regressions in conversion rate; webhook flow clean; no manual interventions needed |
| **3** | Standard + Plus tiers added | 7 days | Same |
| **4** | Default flag flipped to `tokens` for all new customers; existing customers stay on Subscriptions | Permanent | — |
| **5** | Remove subscription-mode handlers + `HostingPlan.razorpayPlans` field | After ~12 months | Last subscription-mode customer cycles out |

## 6. Testing plan

| Test type | What |
|-----------|------|
| Unit | `RazorpayService.createCustomer`, `createRecurringTokenOrder`, `chargeViaToken`, `refundPayment` — all mocked at Razorpay SDK boundary |
| Unit | New webhook branches (`payment.captured` CIT, `payment.captured` MIT, `payment.failed` MIT, retry-attempt scheduling) — mocked Razorpay SDK |
| Unit | Cron handler in isolation — feed it fake `Hosting` rows due for charge, assert correct `chargeViaToken` calls + idempotency under repeated runs |
| Integration | End-to-end against Razorpay TEST mode: signup → CIT auth → refund → MIT charge → renewal cycle. Verifies the actual Razorpay APIs match our code's assumptions. |
| Manual | Phase-1 (operator's account at flag-flipped state) — see §5.3 |

Existing test surface in `tests/unit/lib/services/payment/webhook-handlers.test.ts` + `tests/integration/api/webhooks-razorpay.test.ts` provides the pattern; new branches plug into the same structure.

## 7. Rollback plan

| Symptom | Action |
|---------|--------|
| Tokens flow returns errors at order creation | Flip `HOSTING_MANDATE_FLOW=subscriptions` via Cloud Run env var update + redeploy. Existing customers unaffected; new signups revert to Subscriptions flow. Resolution time: ~5 min. |
| Tokens flow auth succeeds but MIT charges fail | Same as above (revert flag); also disable the new cron via `gcloud scheduler jobs pause`. Existing customers unaffected. |
| Tokens flow `payment.captured` webhook can't refund the ₹2 (Razorpay refund API error) | Refund manually via Razorpay LIVE dashboard → Payments → Refund. Mandate is still set up, only the auto-refund failed. Customer experience: ₹2 charge stays on statement for 24h until manual refund posts. |
| Mandate token expires / is invalidated by the customer | Existing `handleRecurringTokenFailed` path: mark Hosting expired, dunning email, customer re-auths via the standard renewal-failed flow |

## 8. Effort estimate

| Phase | Effort |
|-------|--------|
| Spec verification against current Razorpay docs (§4) | 0.5 day |
| Implementation: `lib/razorpay.ts` new methods | 0.5 day |
| Implementation: `app/api/payments/create-order/route.ts` Tokens branch | 0.5 day |
| Implementation: webhook handlers (CIT auth → store token + refund; MIT recurring) | 1 day |
| Implementation: cron + retry/dunning logic + `RecurringChargeAttempt` model | 1 day |
| Tests (unit + integration) | 0.5-1 day |
| Phase 1 internal validation | 0.5 day |
| **TOTAL implementation** | **4-5 days** |
| Phase 2-3 (Starter → Standard → Plus rollout) | 14 days calendar, near-zero implementation effort |

## 9. Open questions / risks

1. **(Verify) Does Razorpay support `customer_id`-based recurring on
   ALL the payment methods we want to offer at signup?** Cards: yes via
   eMandate. UPI: yes via Autopay (post 2026-07-08 activation). eNACH:
   yes via netbanking mandate. eSign: probably (post 2026-06-27
   activation). Paper NACH: probably not — would fall back to Subscriptions
   flow for that subset.

2. **(Verify) Max amount per recurring debit on UPI Autopay** — NPCI's
   current cap is ₹15,000 per debit without additional auth. Our most
   expensive tier (Plus yearly) is ₹2246.40 so well within the limit,
   but if we expand tier pricing in the future this becomes a constraint.

3. **(Risk) Refund window race condition**: customer authorizes the ₹2,
   webhook arrives, we initiate refund. If the refund API call fails
   transiently, we have a paid ₹2 with no auto-refund. Manual refund
   from the dashboard mitigates but creates an operator-action item.
   Recommend: refund-failure surfaces in `/admin/integration-health`
   Razorpay card as a new error class.

4. **(Risk) MIT charge fails because the mandate is bank-side suspended**
   (customer's bank account closed, card expired, etc). Need to handle
   `payment.failed` MIT events explicitly. Existing dunning email logic
   from `lib/services/payment/webhook-handlers.ts:311-343` can be
   reused.

5. **(Risk) Concurrent charges** — what if the cron runs twice (e.g., a
   restart mid-execution)? Mitigated by: (a) idempotency on the
   `RecurringChargeAttempt` collection; (b) `payment.captured` MIT
   handler uses the same atomic-claim pattern as the existing
   `claimPendingOrderForProcessing` in
   [lib/services/orders.ts](../lib/services/orders.ts).

6. **(Risk) Customer-visible double-charge perception**: the ₹2 charge
   AND the first MIT charge both show on the bank statement before the
   ₹2 refund posts. Need to set expectations in the post-signup email
   ("you'll see a temporary ₹2 charge that refunds within minutes").

## 10. Related auto-memory entries

- [`reference_razorpay_event_taxonomy`](../../../Users/Pawan1/.claude/projects/c--xampp-htdocs-Domain-Management-Project/memory/reference_razorpay_event_taxonomy.md) — Razorpay's event taxonomy; relevant because the new flow listens for `payment.captured` events (already documented) and we may discover new event names worth adding (`token.confirmed`, etc.)
- [`project_razorpay_upi_autopay_separate`](../../../Users/Pawan1/.claude/projects/c--xampp-htdocs-Domain-Management-Project/memory/project_razorpay_upi_autopay_separate.md) — UPI Autopay / eSign sub-activations; relevant because Tokens flow on UPI rail depends on UPI Autopay being activated (est. 2026-07-08)
- [`project_secret_manager_split`](../../../Users/Pawan1/.claude/projects/c--xampp-htdocs-Domain-Management-Project/memory/project_secret_manager_split.md) — Secret Manager binding; no changes (same `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` used in both flows)

## 11. Decision log

| Date | Decision | Made by |
|------|----------|---------|
| 2026-06-25 | Use Tokens flow (Google pattern) for new customers; keep Subscriptions flow for existing customers via feature flag. Migration starts after Razorpay live cutover Steps 4-5 close (post 2026-07-08). | Pawan (verbal direction in conversation) + Claude (design recommendation) |
| _Pending_ | Verify Razorpay API parameter shapes in §4 against current docs before implementation kickoff | — |
| _Pending_ | Confirm Phase 2 starts on Starter tier only (cheapest blast radius) | — |
| _Pending_ | Confirm `HOSTING_MANDATE_FLOW` env var name + Secret Manager / .env.local placement | — |
