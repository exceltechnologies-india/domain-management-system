# Project Audit

**Last full rescan:** 2026-05-21 (post-Batch-1 rescan; security + quality + perf)
**Scope:** ~490 TS/TSX source files, 136 API routes, 17 services in `lib/services/` (incl. the 4 payment-provisioner modules), ~12 Mongoose models, 534 tests (434 unit + 100 integration).

This document tracks **currently-open** findings. The full historical pass log (HIGH-4 service-layer migrations, MEDIUM-1 any-types reduction across 15 passes, MEDIUM-4 ESLint hardening, MEDIUM-5 integration-test scaffolding, MEDIUM-6 CI gating) is preserved in git history — refer to `git log --oneline --all` and the commit messages.

## Resolved (high-level — see git log for details)

- ✅ **CRITICAL-1** — git/repo + branch protection (2026-05-14)
- ✅ **CRITICAL-3** — security module under test coverage (98.93% lines)
- ✅ **CRITICAL-4** — CSP `unsafe-eval` / `unsafe-inline` isolated to iframe-only flows
- ✅ **HIGH-1** — monolithic service wrappers split into focused modules
- ✅ **HIGH-2** — state-machine logic out of routes
- ✅ **HIGH-3** — `/api/v1/*` versioning surface live
- ✅ **HIGH-4 (User)** — every `User.X(...)` callsite outside `lib/services/users.ts` migrated (~93 → 0).
- ✅ **HIGH-5** — `Pending*` collection sweepers + auto-retry cron (2026-05-20)
- ✅ **HIGH-6** — security module consolidation
- ✅ **MEDIUM-1** — `any` types 845 → 10 (99% reduction; remaining 10 are intentional with eslint-disable + rationale)
- ✅ **MEDIUM-2** — structured logger, zero `console.*` outside `lib/*-logger.ts`
- ✅ **MEDIUM-3** — large React components decomposed
- ✅ **MEDIUM-4** — ESLint hardened (`no-explicit-any`, `no-unused-vars`, `no-floating-promises`); 134 floating-promise sites fixed
- ✅ **MEDIUM-5** — integration-test scaffolding via `mongodb-memory-server`
- ✅ **MEDIUM-6** — CI lint + test + tsc + integration + audit gating; `deploy-cloud-run.sh` blocked behind CI-green
- ✅ **MEDIUM-7** — Cloud Run replaces single-instance PM2
- ✅ **MEDIUM-8** — atomic deploy with rollback path
- ✅ **MEDIUM-9** — repo-root clutter cleaned
- ✅ **LOW-1** — `npm audit` gated in CI (high+ threshold)
- ✅ **LOW-2** — structured logging
- ✅ **LOW-3** — DB migration history
- ✅ **LOW-4** — Mongoose model index audit
- ✅ **Batch 1 (2026-05-20)** — [H3] Zoho axios timeout, [M8] 20 unused deps removed, [M9] `npm audit` cleared, [M10] AdminLayout dedup, [L1] `/api/debug/check-expiry` removed, [L4] stale TODOs resolved (commit `bb91b5d`).
- ✅ **Batch 2 (2026-05-20)** — [L1] N+1 in admin users-services, [L2] stale `User` import, [L3] chat model version pinned, [M4] raw upstream errors no longer echoed, [M5] `findOrderDomain` helper, [M6] NextAuth session-user type-narrowing removed (commit `273f6ff`).
- ✅ **Security batch (2026-05-20)** — [H1] IDOR on invoice-pay, [H2] chat rate-limit, [H3] trial-abuse race, [M1] cron auth helper, [M2] CSRF middleware coverage extended, [M3] User secrets `select:false` (commit `66d8b84`).
- ✅ **[H1] Order/Hosting/SupportTicket service-layer migration** (commits `eb7d82b`, `be62b59`, `1cd47d2`) — All direct `Order.*` / `Hosting.*` / `SupportTicket.*` / `new Order(` / `new Hosting(` / `new SupportTicket(` calls in `app/api/**` migrated to service helpers. 60+ routes touched across 3 passes (read-side → write-heavy → Hosting + SupportTicket close). 17 new helpers added in `lib/services/orders.ts`, 11 in `lib/services/hostings.ts`, 2 in `lib/services/support-tickets.ts`.
- ✅ **[H2] `provisionCartItems` decomposed** (commit `fa95307`) — The 1054-line `lib/services/payment/provisioner.ts` is now four focused modules: `provisioner.ts` (255 lines, orchestrator), `provisioner-hosting.ts` (388 lines), `provisioner-domain.ts` (460 lines, 4 inner handlers), `provisioner-verification.ts` (193 lines).
- ✅ **[M1] Service-layer integration tests** (commit `ad0c7b4`) — New `tests/integration/services/` suite with 75 tests across orders/hostings/users/support-tickets/domains. Locks in the `select: false` defaults on `password` / `resetToken` so a future accidental removal surfaces here. 434 unit + 100 integration = 534 tests passing.
- ✅ **Batch 1 verification 2026-05-21** (revision `dms-00032-zqf`) — `/api/health` 200 OK, zero error-level Cloud Run logs in 15-min post-deploy window.
- ✅ **Rescan Batch 1 (2026-05-21 fast wins)** — [L1] dead OAuth social-profile code deleted from [callbacks.ts](lib/auth-config/callbacks.ts) (93 commented lines + the surrounding `any`-typed carrier replaced with a typed shape); [L2] `admin/log-error` swapped to `authorizeCronRequest` (drops the local `crypto` import + inline timing-safe check); [L3] unused `import User from "@/models/User"` removed from `admin/backup` + `admin/users/reset-password`; [M3] `Order` pre-save invoice/PO suffix swapped from `Math.random().toString(36).substring(2,5)` (~46k values) to `crypto.randomBytes(4).toString("hex")` (~4B values) — closes the collision class behind `findInvoiceNumberConflicts`; [M4] orphan models `DNSRecord.ts` + `TLDPricingCache.ts` deleted (zero importers outside their own tests); [M11] `.lean()` added to `listExpiredActiveHostings`, `listDueServiceHostingCandidates`, `listUserHostingsByDomain`, `listAllHostingsForDirectAdminDiag`; [M16] `getHostingById`'s `populate("userId")` narrowed to a 6-field projection; [L8] admin/pending-domains O(N·M) `.some()` swapped for a pre-built `Set<string>`. Tests: 425 unit + 100 integration green (425 = 434 − 9 deleted DNSRecord/TLDPricingCache tests).

## Deliberately deferred (by user)

- **CRITICAL-2** — Rotate credentials baked into pre-Secret-Manager Docker layers.
- **Day-9 roadmap** — Rotate GCP service account key.

Per user instruction (2026-05-20), key/credential rotation is out of scope. Not surfaced as a next step.

---

## Open issues (rescan 2026-05-21)

Issues are listed by severity. Each has a file pointer, one-line problem, one-line fix, and a rough effort estimate. See "Recommended order" at the bottom for batching.

_Batch 1 (fast wins) closed: [L1], [L2], [L3], [M3], [M4], [M11], [M16], [L8]._

### HIGH

#### [H1] Guest checkout binds purchases to any registered email (no challenge)
**File:** [app/api/payments/guest/verify/route.ts:149-192](app/api/payments/guest/verify/route.ts)
**Problem:** `getUserByEmail(guestEmail)` returns a victim's existing registered user; verify continues and writes the Order/Hosting/Domain under `userId: guestUser._id` (the victim) when `!guestUser.isGuest`. A funded attacker can attach services + WHOIS data + a DA account to any known email's user record.
**Fix:** If `getUserByEmail` returns a non-guest user, reject with 409 ("Email belongs to a registered account — please sign in") before any provisioning.
**Effort:** ~30 min + integration test.

#### [H2] No rate-limit on guest order-create / guest verify
**Files:** [app/api/payments/guest/create-order/route.ts:36](app/api/payments/guest/create-order/route.ts), [app/api/payments/guest/verify/route.ts:23](app/api/payments/guest/verify/route.ts)
**Problem:** Unauthenticated POSTs that each hit Razorpay create-order / payment-fetch. No rate-limit. Abuser can spam Razorpay order creation and burn through quota / generate fake-order noise.
**Fix:** Add `rateLimiters.api.checkKey(ipKey("guest_checkout"))` at the top of both handlers; return the same 429 + Retry-After envelope `chat` uses.

#### [H3] `/api/user/hosting/stats` fans out N parallel DA `getUserConfig` calls
**File:** [app/api/user/hosting/stats/route.ts:50-66](app/api/user/hosting/stats/route.ts)
**Problem:** Per request: `DirectAdminService.listUsers()` followed by `Promise.all(daUserList.map(u => getUserConfig(u)))`. Any logged-in user can amplify a single HTTP request into hundreds of DA RPC calls; no rate limit. Self-DoS on DirectAdmin under enumeration.
**Fix:** Scope the DA scan to users where `User.directAdminUsername` is set; or cache `email → username` in Redis with TTL; add `rateLimiters.api.checkKey('stats:' + user._id)`.

#### [H4] `auth/register` is the last `new User(...)` callsite in `app/api/**`
**File:** [app/api/auth/register/route.ts:111](app/api/auth/register/route.ts)
**Problem:** Calls `new User({…}).save()` directly — the only model-bypass left after the H1 service-layer migration close.
**Fix:** Add `createUserWithCredentials(payload)` to `lib/services/users.ts` (existing `createUser` takes an untyped `Record<string, unknown>` and is used for guest-checkout; this needs a typed-payload variant), route the register flow through it.

#### [H5] Missing indexes on `Order.razorpayPaymentId` / `razorpayOrderId` / `zohoInvoiceId`
**File:** [models/Order.ts:125-132,276](models/Order.ts) (no `index: true` on these three fields)
**Problem:** Nine hot-path service helpers query by these fields (every Razorpay webhook, every payment-verify idempotency check, the Zoho retry cron). All COLLSCAN at runtime.
**Fix:** Add `OrderSchema.index({ razorpayPaymentId: 1 })`, `({ razorpayOrderId: 1 })`, `({ zohoInvoiceId: 1 }, { sparse: true })`.
**Effort:** ~10 min + a one-shot index-sync migration script.

#### [H6] `provisionCartItems` per-item loop is serial — 5-item carts take 5× latency
**File:** [lib/services/payment/provisioner.ts:90-129](lib/services/payment/provisioner.ts)
**Problem:** `for (const item of cartItems)` awaits each RC `registerDomain` (~2-5s) + DA `createUser` serially. The per-item helpers were extracted with a pure-return contract specifically to enable fan-out; we just didn't enable it.
**Fix:** Replace the for-loop with `Promise.all(cartItems.map(item => dispatchItem(item)))` — same dispatch logic, same return shape.

#### [H7] `check-unprovisioned` cron drains deferred hostings serially
**File:** [app/api/cron/check-unprovisioned/route.ts:47-55](app/api/cron/check-unprovisioned/route.ts)
**Problem:** `for (const pending of deferred) await provisionPendingHosting(pending)` — up to 50 DA `createUser` calls in series. With DA cold (~2s each) the cron tick approaches 100s and risks blowing the Cloud Tasks visibility timeout.
**Fix:** `Promise.allSettled` with concurrency cap 5–10.

### MEDIUM

#### [M1] Raw RC/DA error strings echoed via `registrationResults` in payment-verify response
**File:** [lib/services/payment/provisioner-hosting.ts:357-385](lib/services/payment/provisioner-hosting.ts), [lib/services/payment/provisioner-domain.ts:284,372,442](lib/services/payment/provisioner-domain.ts)
**Problem:** Same pattern that prior [M4] closed for renew/sync routes — the post-payment surface was missed. `payments/verify` returns these strings verbatim under `registrationResults` and `failedDomains[].error`. ResellerClub / DirectAdmin error strings can carry retry-token or upstream-state fragments.
**Fix:** Map non-503 errors to a generic "Provisioning failed — support has been notified" in the per-item helpers; keep raw details in `serverLogger`.

#### [M2] No rate-limit on `/api/user/hosting/renew` and `/upgrade`
**Files:** [app/api/user/hosting/renew/route.ts:19](app/api/user/hosting/renew/route.ts), [app/api/user/hosting/upgrade/route.ts](app/api/user/hosting/upgrade/route.ts)
**Problem:** Authenticated but no per-user throttle on routes that call `RazorpayService.createOrder` + DB insert on every hit. A logged-in user can mint unlimited pending Razorpay orders.
**Fix:** `rateLimiters.api.checkKey('renew:' + user._id)` before the createOrder call.

#### [M3] Invoice / PO number collision risk in `Order` pre-save hook
**File:** [models/Order.ts:320-335](models/Order.ts)
**Problem:** `INV-{6-char ms-timestamp}-{3-char base36 random}` — only ~46k random suffixes, and the timestamp granularity collides under burst load. The existing `findInvoiceNumberConflicts` helper + `admin/orders/invoice-conflicts` admin tool exist precisely because this hits in production.
**Fix:** Replace `Math.random().toString(36).substring(2,5)` with `crypto.randomBytes(4).toString("hex")`; same for `purchaseOrderNumber`.

#### [M4] Orphan Mongoose models — `DNSRecord` + `TLDPricingCache`
**Files:** [models/DNSRecord.ts](models/DNSRecord.ts), [models/TLDPricingCache.ts](models/TLDPricingCache.ts)
**Problem:** Zero importers anywhere in `app/`, `lib/`, `scripts/`, or `tests/`. DNS goes through ResellerClub/DA APIs directly; TLD pricing is cached in-process via `lib/tld-pricing-cache.ts`.
**Fix:** Delete both files; add a migration to drop the collections if they exist in prod.

#### [M5] Inconsistent 429 envelope across rate-limited routes
**Files:** Only `app/api/chat/route.ts`, `app/api/user/invoices/[id]/pdf/route.ts`, `app/api/domains/transfer/route.ts` set `Retry-After`. ~10 other rate-limited routes (`auth/activate`, `auth/register`, `auth/forgot-password`, `auth/resend-activation`, `domains/search`, `user/support` POST + reply, `user/hosting/trial-otp/{send,verify}`) return 429 with no header.
**Problem:** Clients can't honour an upstream cooldown they can't read; UI shows "try again" without a wait time.
**Fix:** Extract a `rateLimitResponse(rl, message)` helper in `lib/rate-limit.ts` returning a uniform `NextResponse` with `Retry-After`, sweep the callsites.

#### [M6] Two parallel auth-check styles across routes
**Pattern:** `getServerSession(authOptions)` (3+ files) and `getToken({ req, secret: AUTH_SECRET })` (9 files: `user/services/status`, `user/domains`, `user/domains/nameservers`, `admin/razorpay-mode`, `admin/domains/{nameservers,sync,dns}`, etc.) both yield the same user.
**Problem:** No rule about which to use; inconsistency makes auth-bug grep harder.
**Fix:** Pick one (recommend `getToken` for App Router perf) and add a `requireUser(request)` / `requireAdmin(request)` helper in `lib/auth.ts`; sweep the other style out.

#### [M7] Service-coverage gap — 8 service modules with zero tests
**Directories:** `lib/services/{payments,settings,system-logs,domain-watches,ip-checks,renewal-payments,hosting-plans,pending-domains}.ts` + the entire new `lib/services/payment/{post-tasks,idempotency,verification,verification-error,renewal,upgrade}.ts` group.
**Problem:** The 5-file `tests/integration/services/` suite (M1) only covers orders/users/hostings/support-tickets/domains.
**Fix:** Add `payments.test.ts` (post-tasks Zoho-claim/release branches, idempotency.handleAlreadyProcessedPayment) and `settings.test.ts` first — those carry the most logic.

#### [M8] `daily-scheduler` lock+enqueue loops are serial
**File:** [app/api/cron/daily-scheduler/route.ts:142-178,181-221](app/api/cron/daily-scheduler/route.ts)
**Problem:** Up to 500+500 sequential `findOneAndUpdate` + Cloud Tasks `createHttpTask` calls. At ~80ms each that's ~80s/run.
**Fix:** Chunk + `Promise.all` (concurrency ~20).

#### [M9] `check-domain-watch` worker hits RC sequentially
**File:** [app/api/workers/check-domain-watch/route.ts:44-94](app/api/workers/check-domain-watch/route.ts)
**Problem:** Up to 100 `ResellerClubAPI.searchDomain` calls in series per cron tick.
**Fix:** `Promise.allSettled` with concurrency 5 (RC rate-limit-friendly).

#### [M10] N+1 in `handleRenewalPayment` hosting loop
**File:** [lib/services/payment/renewal.ts:126-215](lib/services/payment/renewal.ts)
**Problem:** Each cart item makes a sequential `findUserHosting` + DA `unsuspendUser` + `hosting.save()` + provisioned-email.
**Fix:** Pre-fetch all hostings for the user once (`listHostingsForUser`), build a `Map<domainName, Hosting>`, `Promise.all` the DA + save + email per item.

#### [M11] Several Hosting list helpers missing `.lean()`
**File:** [lib/services/hostings.ts:115-131,181-187,213-219,225-228](lib/services/hostings.ts)
**Problem:** `listExpiredActiveHostings`, `listDueServiceHostingCandidates`, `listUserHostingsByDomain`, `listAllHostingsForDirectAdminDiag` callers only read fields and never mutate. Hydrating full Mongoose docs is wasted memory under cron batch sizes (500).
**Fix:** Append `.lean<IHosting[]>()`.

#### [M12] `renewal.ts` still imports + uses `Order` model directly
**File:** [lib/services/payment/renewal.ts:6,46](lib/services/payment/renewal.ts)
**Problem:** Carve-out from H1 — the H1 close swept `app/api/**` but not `lib/services/payment/**`. Single remaining direct call.
**Fix:** Route through `findOrderByRazorpayOrderId` or a new helper.

#### [M13] No timeout on cross-worker `fetch` in `daily-scheduler`
**File:** [app/api/cron/daily-scheduler/route.ts:234-240](app/api/cron/daily-scheduler/route.ts)
**Problem:** `fetch(workerWatchUrl, …)` has no `AbortSignal.timeout`; a hung domain-watch worker stalls the daily cron Cloud Run slot.
**Fix:** `signal: AbortSignal.timeout(60_000)`.

#### [M14] No timeout on Razorpay SDK calls
**File:** [lib/razorpay.ts:30-33](lib/razorpay.ts)
**Problem:** `new Razorpay({key_id, key_secret})` ships with no `timeout`. A hung Razorpay slot blocks payment-verify. Mirrors the resolved Zoho axios timeout but for the Razorpay SDK.
**Fix:** Monkey-patch the underlying axios client (`razorpay.api.timeout`), or wrap critical calls with `Promise.race` + abort.

#### [M15] No timeout on WhatsApp Graph fetch
**File:** [lib/whatsapp.ts:59](lib/whatsapp.ts)
**Problem:** Graph API call with no `AbortSignal.timeout` — runs inside worker hot paths (`process-service-expiry`).
**Fix:** `signal: AbortSignal.timeout(15_000)`.

#### [M16] `populateUser` on `getHostingById` pulls full User doc
**File:** [lib/services/hostings.ts:29](lib/services/hostings.ts) (`populate("userId")` with no projection)
**Problem:** Used by `process-service-expiry` worker which only reads `email/firstName/lastName/whatsappNumber`.
**Fix:** `.populate("userId", "email firstName lastName whatsappNumber")`.

### LOW

#### [L1] Dead commented-out social-profile fetch in `signIn` callback
**File:** [lib/auth-config/callbacks.ts:179-272](lib/auth-config/callbacks.ts)
**Problem:** ~93 lines of `/* … */`-blocked Google People + Facebook Graph fetch code, both tagged `DISABLED:` since the OAuth verification was never pursued.
**Fix:** Delete the two blocks plus their `DISABLED:` headers; if re-enable is on the table, restore from git history.

#### [L2] `admin/log-error` still uses inline timing-safe cron check
**File:** [app/api/admin/log-error/route.ts:15-22](app/api/admin/log-error/route.ts)
**Problem:** Missed by the [M1] sweep that consolidated 9 cron routes onto `authorizeCronRequest`. Still hand-rolls `crypto.timingSafeEqual` + a local `crypto` import.
**Fix:** Swap to `authorizeCronRequest(req)`.

#### [L3] Unused `import User from "@/models/User"` in two admin routes
**Files:** [app/api/admin/backup/route.ts:5](app/api/admin/backup/route.ts), [app/api/admin/users/reset-password/route.ts:5](app/api/admin/users/reset-password/route.ts)
**Problem:** Value-import never read (only `getUserWithPassword`/`getUserById` are used). ESLint `no-unused-vars` should be catching them.
**Fix:** Delete the two imports.

#### [L4] `findUserOrder` / `getOrderByIdOrOrderId` use `$or: [{_id}, {orderId}]`
**File:** [lib/services/orders.ts:240-257](lib/services/orders.ts)
**Problem:** Accepts either form via $or. A user-supplied 24-hex `orderIdOrId` that happens to also equal a `orderId` field value (currently unlikely but a latent footgun) would match either record. The `userId` filter still scopes it.
**Fix:** Branch on `mongoose.Types.ObjectId.isValid` and pick exactly one filter — don't OR them.

#### [L5] PendingDomain bulk-upsert keyed on `domainName` alone
**File:** [lib/services/payment/provisioner-verification.ts:144-152](lib/services/payment/provisioner-verification.ts)
**Problem:** `filter: { domainName }` with `$set: { userId, orderId, … }`. If two users sequentially fail to register the same name, the second run silently overwrites the first user's PendingDomain row (incl. `userId`).
**Fix:** Include `userId` (or `orderId`) in the filter; or refuse upsert when the existing row has a different `userId`.

#### [L6] Admin `hosting/actions` echoes raw catch-message
**File:** [app/api/admin/hosting/actions/route.ts:110-114](app/api/admin/hosting/actions/route.ts)
**Problem:** Top-level catch passes `error.message` to `secureErrorResponse`. Admin-gated so blast radius is small, but DA / Mongo fragments still cross the trust boundary.
**Fix:** Return generic "Hosting action failed", keep raw `message` in `serverLogger.error`.

#### [L7] `createOrder` / `createOrderInSession` / `createUser` payload type is `Record<string, unknown>`
**File:** [lib/services/orders.ts:544,558](lib/services/orders.ts), [lib/services/users.ts:489](lib/services/users.ts)
**Problem:** Wide-open payload; callers lose the compile-time guard the service-layer migration was supposed to deliver.
**Fix:** Introduce typed `CreateOrderInput` / `CreateUserInput` interfaces mirroring the schema; tighten the helpers.

#### [L8] O(N·M) `.some()` in admin pending-domains merge
**File:** [app/api/admin/pending-domains/route.ts:113-116](app/api/admin/pending-domains/route.ts)
**Problem:** Same pattern fixed in the prior rescan's resolved [L1] (admin users-services).
**Fix:** Pre-build `Set<string>` of lowercased names.

#### [L9] Admin pending-domains route lacks pagination
**File:** [app/api/admin/pending-domains/route.ts:73-78](app/api/admin/pending-domains/route.ts)
**Problem:** No `limit`/`skip`; loads every non-archived row + every in-flight Order. Will OOM the admin UI past a few thousand rows.
**Fix:** Add `page`/`perPage` query params + `.skip().limit()`.

#### [L10] `Domain` model lacks `next_action_at` index — daily-scheduler COLLSCAN on the domain side
**File:** [models/Domain.ts](models/Domain.ts) (no index on `next_action_at` or `processing_until`)
**Problem:** `daily-scheduler` runs the same eligibility query against Domain as it does against Hosting; Hosting has `({ next_action_at: 1 })` indexed ([models/Hosting.ts:134](models/Hosting.ts)) but Domain doesn't.
**Fix:** `DomainSchema.index({ next_action_at: 1, processing_until: 1 })`.

#### [L11] `Order.userName` / `Order.paymentId` are legacy / write-only
**File:** [models/Order.ts:14,16](models/Order.ts)
**Problem:** `userName` is written by `order-creator.ts` and only read by a one-off back-fill branch; `paymentId` is only read in `order.razorpayPaymentId || order.paymentId` fallback chains (4 sites). Both ride along on every Order forever.
**Fix:** Confirm-and-drop migration; `razorpayPaymentId` is the source of truth.

---

## Recommended order

### ~~Batch 1 — fast wins~~ ✅ shipped (see Resolved section)

### Batch 2 — security / hardening (~3 hours)
[H1] guest-checkout email-claim challenge, [H2] guest rate-limit, [M1] raw-error echoing, [M2] renew/upgrade rate-limit, [M5] uniform 429 envelope, [L6] admin error generification.

### Batch 3 — perf / latency (~3 hours)
[H5] Order indexes, [H6] provisioner fan-out, [H7] cron-unprovisioned concurrency, [M8] daily-scheduler concurrency, [M9] check-domain-watch concurrency, [M10] renewal N+1, [M13] cross-worker timeout, [M14] Razorpay timeout, [M15] WhatsApp timeout, [L10] Domain index.

### Batch 4 — quality / coverage (multi-session)
[H3] hosting-stats scope reduction, [H4] auth/register service migration, [M6] auth-style consolidation, [M7] service-test expansion (8 modules), [M12] renewal.ts service migration, [L4] $or footgun, [L5] PendingDomain key, [L7] typed payloads, [L9] admin pagination, [L11] legacy Order fields.

### Strengths to preserve

- Service-layer pattern in [lib/services/](lib/services/) for User / Order / Hosting / SupportTicket — every direct call in `app/api/**` routed through it (as of H1 close).
- 534 tests across unit + integration suites — runtime ~40s unit, ~20s integration.
- `provisionCartItems` decomposed into 4 focused modules; each per-item branch is independently testable.
- Mongoose timestamps + Hosting index audit complete; structured logging; CSP iframe-isolated for Razorpay.
- Atomic Cloud Run deploy with `deploy-cloud-run.sh` CI-gate + smoke test.
- Auto-retry cron drains deferred hostings when DA recovers; admin "Retry" + cron share the same `provisionPendingHosting` code path.
