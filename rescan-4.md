# Rescan-4 — Whole-Project Audit (2026-05-22)

Fresh audit after rescans 1–3 closed every known H/M/L bug. Different mandate: architecture, code-quality, frontend, schema drift, operational, and DX concerns that prior bug-hunting passes deprioritised.

All four HIGH findings have been verified against the actual code, not just trusted from the audit agent.

---

## Status

| Batch | Findings | Status | Commit(s) |
|---|---|---|---|
| Batch 7a | H1 — cart store NextAuth migration | ✅ Closed | `c4aec87` |
| Batch 7b | H2 — PendingDomain compound unique + prod migration | ✅ Closed | `45e8e85`, `caece03` |
| Batch 7c | H3 — Bearer-token cleanup (38 files, −917 lines) | ✅ Closed | `6bdd43b` |
| Batch 7d | H4 — Mongo `maxPoolSize` 10 → 50 + Cloud Run pairing | ✅ Closed | `9b60a9f` |
| Batch 7e | M2 + M3 + M5 + M7 + M9 + M10 + M11 + M12 + M15 + L2 | ✅ Closed | `8aee422` |
| Batch 7f | L3 + L4 + L5 + L6 + L7 + L9 + L10 + L11 | ✅ Closed | `5ee9c94` |
| Batch 7g | M1 slice 1 — RC `registerDomain` anti-corruption (13 tests) | ✅ Closed | `67390e4` |
| Batch 7h | M1 slice 2 — DA `createUser` anti-corruption (7 tests) | ✅ Closed | `6391de2` |
| Batch 7i | M1 slice 3 — RC `renewDomain` + /domains/renew 202-on-pending | ✅ Closed | `2fca12a` |
| Batch 7j | M1 slice 4 — inner/outer RC fragment vocab unified | ✅ Closed | `c31bf1e` |
| Batch 7k | M1 slice 5 — DA `suspendUser` + expiry-worker not-found skip | ✅ Closed | `292802c` |
| Batch 7l | M1 slice 6 — DA `unsuspendUser` + 4 callsite migrations | ✅ Closed | `90ac494` |
| Batch 7m | M1 slice 7 — RC `transferDomain` + user-actionable 400 on registry-reject | ✅ Closed | `facfb87` |
| Batch 7n | M1 slice 8 — DA `getUserConfig` + sync-worker inline-parser removed | ✅ Closed | `23fda8e` |
| Batch 7o | M1 slice 9 — DA `deleteUser` + admin/hosting/actions sweep | ✅ Closed | `ba451f2` |
| Batch 7p | M1 slice 10 — RC `getDomainOrderId` + `getDomainDetails` (4 callsites, 18 new tests) | ✅ Closed | `c76ce35` |
| Batch 7q | M1 slice 11 — RC `getDNSRecords` (2 callsites, 9 new tests) | ✅ Closed | `a4b4422` |
| Batch 7r | M1 slice 12 — DA `changePackage` + upgrade-flow + admin route (7 new tests) | ✅ Closed | `26d201f` |
| Batch 7s | M13 partial — delete dead `error.message.includes` chain in verification-error.ts (-65 LOC) | ✅ Closed | `299f84c` |
| Batch 7t | L1 — typed Razorpay SDK client (10 `as unknown as` casts → 1) | ✅ Closed | `9b6d018` |
| Batch 7u | M14 partial — extract pure cart-validation helpers + 21 unit tests | ✅ Closed | `0011477` |
| Batch 7v | M14 continued — store-level cart tests (addItem/removeItem cascade, getters, syncWithServer) — 20 new tests | ✅ Closed | `12d2cbd` |
| Batch 7w | L8 — React error boundaries (FloatingCart + ChatWidget + CartPage) | ✅ Closed | `2339a2a` |
| Batch 7w.2 | L12 partial — enable `plugin:jsx-a11y/recommended` (lint surface, 144 warnings flagged) | ✅ Closed | `7c466b5` |
| Batch 7x | M6 partial — demote 14 leaf components from `'use client'` to server | ✅ Closed | `0f35e5f` |
| Batch 7y | S2 — pre-commit hooks (husky + lint-staged + tsc --noEmit) | ✅ Closed | `2660cfe` |
| Batch 7z | S3 partial — `validatedBody` / `validatedQuery` helpers + 5-route sweep (10 new tests) | ✅ Closed | `067da79` |
| Batch 7z.2 | S3 continued — 6 more routes validated (payments/create-subscription, hosting/renew, hosting/cancel-trial, hosting/auto-renew, domains/nameservers, settings/change-email) | ✅ Closed | `e87ad6a` |
| Batch 7z.3 | S3 continued — 5 more routes (admin/razorpay-mode discriminated-union, hosting/upgrade, contact, user/support, contact `.sanitized` typing fix) | ✅ Closed | `8b4aac3` |
| Batch 7z.4 | S3 continued — 6 more routes (user/support/[id], admin/support-tickets/[id], trial-otp send + verify, trial-eligibility, chat) | ✅ Closed | `1dfc073` |
| Batch 7z.5 | S3 continued — 6 admin write routes (hosting/change-package, hosting/actions discriminated-union, hosting/assign, users/reactivate, users/reset-password, log-error) | ✅ Closed | `a978849` |
| Batch 7z.6 | S3 continued — 6 more admin write routes (domains/nameservers, domains/activate-dns, domains/sync, diag-da/cleanup, reset-password, tld-pricing/cache) | ✅ Closed | `60cf32f` |
| Batch 7z.7 | S3 continued — 6 admin routes (hosting/test-plan, hosting/packages POST + PATCH, hosting/provision, backup, users/[id] PUT, pending-domains/verify) | ✅ Closed | `ba4f8d5` |
| Batch 7z.8 | S3 continued — 6 routes (admin/settings, admin/pending-domains POST, auth/activate, workers/sync-zoho-invoice, workers/sync-hosting-status, workers/process-hosting-expiry) | ✅ Closed | `d524fd9` |
| Batch 7z.9 | S3 continued — 6 routes (workers/process-service-expiry, auth/check-account-status, totp/confirm, totp/disable, resend-activation, admin/domains/dns POST + DELETE) | ✅ Closed | `33ee8ff` |
| Batch 7z.10 | S3 continued — 6 user-facing domain routes (search, activate-dns, renew GET + POST, booking-status GET + POST, verify-status, transfer) | ✅ Closed | `993272a` |
| Batch 7z.11 | S3 continued — 6 routes (log, domains/bulk-search, domains/nameservers, cart, test/automation/trigger, admin/pending-domains/[id]) + latent bug fix | ✅ Closed | `a9317ec` |
| Batch 7z.12 | S3 complete — 3 payment routes (verify, guest/verify, guest/create-order) — **73/73 routes validated** | ✅ Closed | `5355331` |
| Batch 7aa | S1 partial — typed frontend `apiClient` (`ApiResult<T, ApiError>` + Zod-aware) + 3 migrated callsites + 12 new tests | ✅ Closed | `bd4edbf` |
| Batch 7ab | S1 continued — 5 more frontend callsites migrated to `apiClient` (AdminPasswordReset, ProfileCompletionForm, DomainBookingProgress, DomainCrossSell, GoogleRecaptcha) | ✅ Closed | `6d6b714` |
| Batch 7ac | S1 continued — 4 more frontend callsites (ResetPasswordForm, LivePricingIndicator, TrialOtpModal ×2, DomainSetup) | ✅ Closed | `e9c5458` |
| Batch 7ad | S1 continued — 3 more components, 6 fetches (MultiStageRegisterForm, DomainSearch watch, InvoiceDiagnostics ×4) | ✅ Closed | `ba0602c` |
| Batch 7ae | S1 continued — first app/ pages (maintenance, activate ×3) + `cache` option added to apiClient | ✅ Closed | `cbe3301` |
| Batch 7af | S1 continued — 2 admin pages (invoices list-GET, pricing-management GET + DELETE) | ✅ Closed | `02b2d7f` |
| Batch 7ag | S1 continued — 3 pages (domains/transfer, domains/bulk-search, admin/domains GET + sync POST) | ✅ Closed | `d390f38` |
| Batch 7ah | S1 continued — dashboard support pages (create-ticket POST, ticket close PATCH + reply POST) | ✅ Closed | `9bd22ea` |
| Batch 7ai | S1 continued — admin support-tickets pages (auth/me + list/detail GETs, reply POST, status + priority PATCH) | ✅ Closed | `c7ed08f` |
| Batch 7aj | S1 continued — admin hosting pending + packages pages (list GETs, retry POST, delete, package PATCH) | ✅ Closed | `9a64032` |
| Batch 7ak | S1 continued — admin order-management (orders GET + delete/archive + unarchive PATCH) + payment-management (payments GET) | ✅ Closed | `9e6f75e` |
| Batch 7al | S1 continued — admin settings/security 2FA page (totp setup GET + POST, confirm POST, disable POST) | ✅ Closed | `525f521` |
| Batch 7am | S1 continued — admin hosting main page (stats GET, provision-deps 2×GET, provision/actions/change-package POSTs, details GET) | ✅ Closed | `ccbef5e` |
| Batch 7an | S1 continued — admin user-management (3×GET parallel, reset-pw/reactivate/reset-2fa POSTs, deactivate + permanent-delete) + apiClient.delete body support | ✅ Closed | `bdd905f` |
| Batch 7ao | S1 continued — admin pending-domains (balance GET, auth/me GET, list GET, register/verify POSTs, archive + permanent DELETEs, resolve + retry PUTs) | ✅ Closed | `a8f5b17` |
| Batch 7ap | S1 continued — admin system-settings (12 fetches: razorpay-mode GET/POST×2, settings GET×3 + POST×4, check-ip GET; backup blob stays raw) | ✅ Closed | `c2646f5` |
| Batch 7aq | S1 continued — dashboard settings (8 fetches: user-settings GET + PUT×2, auth/me GET, totp setup GET/POST + confirm/disable POST; nominatim geocode stays raw) | ✅ Closed | `bb55a93` |
| Batch 7ar | S1 continued — admin dns-management (10 fetches: domains/dns/nameservers GETs, NS default/custom POSTs, activate-dns POST, record add POST, delete + edit DELETEs-with-body) | ✅ Closed | `702c9a8` |
| Batch 7as | S1 continued — dashboard dns-management (12 fetches: services-status + domains + dns + nameservers GETs, NS default/custom POSTs w/ polling, record add POST, delete + edit DELETEs-with-body + restore POST, activate-dns POST) | 🔄 Committed, deploy pending | `402fd5d` |
| Batch 7at | S1 continued — admin settings (22 fetches: 9 GET loaders incl. paired cache load, cache PUT + DELETE, 2 check-ip GETs, 8 settings save POSTs, test-plan POST; removed dead authHeaders helper) | 🔄 Committed, deploy pending | `547ab37` |
| Batch 7au | S1 continued — dashboard hosting (cancel-trial POST, auto-renew PATCH) + dashboard domains/[id] (services-status + domains + nameservers GETs, NS update POST) | 🔄 Committed, deploy pending | — |

**All four HIGHs + 11 MEDIUMs + 11 LOWs + 2 architectural suggestions (S2 + S3) cleared, M14 / M6 / L12 / S1 in progress.** 53 vertical slices shipped across batches 7a–7au (6 RC ops + 6 DA ops + vocab unification + M13 cleanup + L1 Razorpay typed-client + two M14 slices + L8 error boundaries + L12 jsx-a11y lint + M6 leaf demotion + S2 pre-commit hooks + S3 complete twelve-slice sweep + twenty-one S1 frontend-apiClient slices). Bonus catches:
- 7e: M3's tightened `BookingStep` type uncovered a real save-validation bug — `provisioner-hosting.ts:379` emits `step: "hosting_deferred"` but the schema enum didn't include it.
- 7f: L6's `Redis | null` typing exposed 3 latent null-deref sites (rate-limit, razorpay webhook, tld-pricing-cache) — each guarded.
- 7g–7r: M1 vertical slices establish the `lib/integrations/{resellerclub,directadmin}/` pattern. ~35 `toLowerCase().includes()` chains removed from app code (down from ~50); the inner/outer classification layers now share one fragment vocabulary; payment + admin + cron paths all branch on typed outcomes instead of message strings.
- 7s: With the typed outcomes in place, the 7-arm `error.message.includes` chain in verification-error.ts turned out to be matching strings nobody throws — deleted (−65 LOC).

Remaining work: 3 MEDIUMs (M4 1000+ line page components, M6 client-component ratio, M14 zero component/page/cart-store tests; M8 deferred pending prod data audit) + 2 LOWs (L8 React error boundaries, L12 a11y eslint) + 3 architectural suggestions.

---

## Production-impacting (HIGH) — RESOLVED

### ✅ [H1] Cart store server-sync silently broken for NextAuth users
**File:** [store/cartStore.ts](store/cartStore.ts) — lines 158, 190, 205, 214, 296, 328, 356, 413
**Problem:** Every server-sync path (`addItem`, `removeItem`, `updateItem`, `clearCart`, `loadFromServer`, `saveToServer`, `mergeWithServerCart`, the rehydrate hook) gates on `safeLocalStorage.getItem("token")`. After Batch 6d's NextAuth-only auth migration, `token` is never written by the credentials login path — only by `activate/page.tsx` and `RegisterForm.tsx`. Users who log in via `/login` have `token === null`, so their cart never persists server-side even though `/api/cart` happily accepts the NextAuth cookie.
**Fix:** Replace the localStorage gate with `useSession().status === "authenticated"`, or just always attempt the fetch with `credentials: "include"` and fail-soft on 401.
**Effort:** ~1 hour.

### ✅ [H2] PendingDomain unique index is global-per-domainName but the L5 upsert was scoped to (domainName, userId)
**File:** [models/PendingDomain.ts](models/PendingDomain.ts) — `index({ domainName: 1 }, { unique: true, partialFilterExpression: { isArchived: { $ne: true } } })` + [lib/services/payment/provisioner-verification.ts:151-154](lib/services/payment/provisioner-verification.ts)
**Problem:** Rescan-1's L5 fix scoped the bulk-upsert filter to `(domainName, userId)` so two users' failed registrations stay as separate audit rows. But the schema's unique index was left global. So when user B's registration for the same name fails, the upsert filter doesn't find user A's row, tries to insert a new one, and the unique index throws E11000 — a worse outcome than the pre-fix silent overwrite. The fix is half-wired.
**Fix:** Change the partial unique index to `{ domainName: 1, userId: 1 }` (still partial on `isArchived: {$ne: true}`).
**Effort:** ~10 min + migration to drop/recreate the index.

### ✅ [H3] Dead Bearer-token plumbing across 25+ frontend files
**Files:** Rough list — `app/checkout/page.tsx`, `app/dashboard/{page,dns-management,orders,settings,domains/[id],hosting}/page.tsx`, `app/cart/page.tsx`, `app/admin/{support-tickets,support-tickets/[id],dns-management,hosting,hosting/pending,hosting/packages,domains,settings,system-settings,pending-domains,invoices/[id]/view}/page.tsx`, `components/{HostingUpgradeModal,HostingRenewalModal,DomainRenewalModal,ProfileCompletionForm}.tsx`, `lib/fetcher.ts`.
**Problem:** Batch 6d's L2 only swept 5 admin pages. The remaining files still construct `Authorization: Bearer ${safeLocalStorage.getItem("token")}` headers. For NextAuth-credential-logged-in users, `token` is null → the header is literally `Bearer null`. Auth still works because `AuthService.getUserFromRequest` falls through to the NextAuth cookie, so it's cargo-cult — but it masks any future bug where the cookie fallback breaks.
**Fix:** Sweep the remaining files, dropping the localStorage-token branch and standardising on `credentials: "include"`.
**Effort:** ~3 hours.

### ✅ [H4] MongoDB `maxPoolSize: 10` is too low for Cloud Run concurrency
**File:** [lib/mongodb.ts:48](lib/mongodb.ts)
**Problem:** Cloud Run defaults to 80 concurrent requests per instance. Every concurrent request that hits Mongo queues behind a 10-connection pool. Under steady load the latency floor for any DB call becomes `(queue depth × avg query duration)`.
**Fix:** Bump `maxPoolSize` to 30–50 and document the relationship with Cloud Run `--concurrency`.
**Effort:** ~15 min + a load test.

---

## Real flaws (MEDIUM)

### Architecture

#### ✅ [M1] No anti-corruption layer between routes/services and DirectAdmin / ResellerClub wire shapes — CLOSED (12 slices shipped, batches 7g–7r)
**Files:** 57 callsites of `DirectAdminService.*` and 65 of `ResellerClubAPI.*`/`ResellerClubWrapper.*` directly inside `app/api/**` + `lib/services/payment/`. 51 `toLowerCase().includes(...)` chains parsing upstream English across the codebase.
**Problem:** Routes and provisioners read raw upstream response shapes (`result.status === "success"`, `result.message.toLowerCase().includes("insufficient balance")`). Any wording change at ResellerClub silently flips success → failed.
**Fix:** Introduce `lib/integrations/{resellerclub,directadmin}/` modules that translate raw responses into typed `Result<Outcome, ErrorVariant>` unions. Callers branch on the variant, not the message text. Multi-week effort; can be incremental starting with the provisioner-domain helpers.

### TypeScript / Schema drift

#### ✅ [M2] Schema drift on `User.cart` and `Order.domains.hostingPlan`
**Files:** [models/User.ts:60-72](models/User.ts) (interface) vs `:291-330` (schema); [models/Order.ts](models/Order.ts) vs [lib/types.ts:31](lib/types.ts).
**Problem:** TS interface declares `cart: {…}` while the schema accepts `periodUnit` and `linkedDomain` that the interface omits. Three different `hostingPlan` shapes across cart (`{name, period, features, serverPackage?}`), Order subdoc (`{planId, name, serverPackage}`), and `CartItem` in `lib/types.ts`.
**Fix:** Single `CartItem`/`HostingPlan` type defined once, shared by Mongoose schema, `lib/types.ts`, and the cart store. ~2-3 hours.

#### ✅ [M3] `IOrder.domains.bookingStatus.step` is a tight enum in the schema but `string` in OrderDomain
**Files:** [models/Order.ts:31-39](models/Order.ts) (8-variant enum) vs [lib/services/payment/provisioner.ts:48](lib/services/payment/provisioner.ts) (`step: string`).
**Fix:** Define `BookingStep` once, share with both. ~30 min.

### Frontend

#### [M4] Five page components have crossed the 1000-line threshold
**Files:** `app/dashboard/dns-management/page.tsx` (1597), `app/admin/user-management/page.tsx` (1520), `app/admin/system-settings/page.tsx` (1387), `app/admin/hosting/page.tsx` (1375), `app/admin/dns-management/page.tsx` (1192), `app/admin/settings/page.tsx` (1008). Each carries 30-35 `useState` hooks.
**Fix:** Extract per-domain hooks + sub-components, starting with `dns-management/page.tsx` as the template. ~1 day per page.

#### ✅ [M5] `<Invoice />` is dead but static-imports jsPDF + html2canvas (~500KB)
**File:** [components/Invoice.tsx:5-6](components/Invoice.tsx)
**Problem:** Zero importers exist. 250-line dead component pulling 500KB of vendor code into any page that transitively touches `components/index.ts`. Same class as the M4 orphan-model deletion from rescan-1.
**Fix:** Delete the file. If retained for future use, dynamic-import jsPDF/html2canvas only on click.

#### 🔄 [M6] 78% of components are `'use client'` — PARTIALLY ADDRESSED (slice 7x demoted 14 leaves)
**Problem:** 134 of 172 page/component .tsx files are client-rendered, defeating App Router's perf model. Navigation header, footer, FAQ-item, EmptyState, Card, StatsCard, Skeletons could mostly render on the server.
**Fix:** Audit `components/*.tsx` for `'use client'` directives that don't actually need state/effects; demote the leaves. ~1 day.
**Slice 7x update:** 14 leaf components demoted to server. Static-render targets identified by absence of `useState` / `useEffect` / `useRef` / `useContext` / event handlers / browser APIs / `framer-motion`: `Footer`, `HeroSection`, `Section`, `AuthShell`, `Header`, `ContactInfo`, `MessageAttachments`, and the seven skeleton modules (`PageSkeletons`, `_primitives`, `DashboardSkeletons`, `AdminLayout`, `AdminPages`, `UserDashboard`, `PaymentPages`). `SessionProvider` correctly kept as client (wraps NextAuth's client provider). `FeatureCard` + `StatsCard` kept as client (use `motion.*` from framer-motion). Verified with `next build` (all routes built clean) + full unit suite (580/580 green). Remaining: ~110 client components remain — further demotions need per-component review since some use less obvious client features (refs, context, or transitive imports).

### Database

#### ✅ [M7] Redundant indexes in three models
**Files:**
- [models/Domain.ts:143](models/Domain.ts) (`{ next_action_at: 1 }`) is a prefix of `:147` (`{ next_action_at: 1, processing_until: 1 }`)
- [models/Domain.ts:142](models/Domain.ts) (`{ userId: 1, status: 1 }`) is a prefix of `:150` (`{ userId: 1, status: 1, expiresAt: 1 }`)
- [models/SystemLog.ts:29](models/SystemLog.ts) (`service: { index: true }`) is a prefix of `:44` (`{ service: 1, createdAt: -1 }`)
**Fix:** Drop the prefix-redundant single-field indexes. ~30 min + migration.

#### ⏸ [M8] `PendingDomain._id` is `Schema.Types.Mixed` — DEFERRED (needs prod data audit before backfill)
**File:** [models/PendingDomain.ts:34](models/PendingDomain.ts)
**Problem:** Accepts both ObjectId and String. Every read/write must remember which kind of id this row has.
**Fix:** Pick ObjectId; backfill any String-keyed rows. ~2 hours + migration.

### Operational

#### ✅ [M9] `/api/health` is shallow — passes when Mongo is unreachable
**File:** [app/api/health/route.ts](app/api/health/route.ts)
**Problem:** Returns 200 immediately with no DB/Redis/DA/RC probe. Cloud Run keeps promoting a process whose deps are broken.
**Fix:** Add `/api/health/deep` with `connectDB()` ping + Redis `PING` + last-DA-heartbeat-age. Point readiness probes at deep, keep `/api/health` shallow for liveness.

#### ✅ [M10] `AuthService.getUserFromRequest` emits `warn` on every unauthenticated request
**File:** [lib/auth.ts](lib/auth.ts) — `serverLogger.warn` lines on session fallthrough.
**Fix:** Demote to `debug` or remove — route layer already returns 401.

#### ✅ [M11] Hardcoded prod DA IP `136.115.64.54` as fallback default in 5 places
**Files:** `lib/services/payment/{renewal,provisioner-hosting}.ts`, `lib/services/pending-hostings.ts`, `lib/directadmin/users.ts:109`, `app/api/admin/hosting/provision/route.ts:265`
**Problem:** Forgotten env in staging/dev silently provisions onto the prod DA box.
**Fix:** Single `DA_DEFAULT_IP` constant in `config/constants.ts`; throw if missing in production. ~15 min.

### Code Quality

#### ✅ [M12] Webhook renewal-order does `new Order(...).save()` directly + `Math.random()` suffix
**File:** [lib/services/payment/webhook-handlers.ts:253](lib/services/payment/webhook-handlers.ts)
**Problem:** Last `new Order(...)` outside the service layer (audit said H1 closed this class). `orderId = \`ORD-RNW-${Date.now()}-${Math.floor(Math.random() * 1000)}\`` — same Math.random class that batch 1's [M3] fixed for invoice numbers but only ~1000 suffixes, will collide under burst.
**Fix:** `createRenewalOrder(input)` helper + `crypto.randomBytes(4).toString("hex")`. ~30 min.

#### ✅ [M13] String-message-based error dispatch in `verification-error.ts` — CLOSED (slice 7s removed the dead chain)
**File:** [lib/services/payment/verification-error.ts:219-266](lib/services/payment/verification-error.ts)
**Problem:** `else if (error.message.includes("Invalid payment signature"))` × 7. Any upstream wording change flips errors into the generic 500. 20 such `error.message.includes` patterns across `lib/`.
**Fix:** Throw typed `PaymentError("signature_error")` / `PaymentError("amount_mismatch")` from inner helpers; dispatch on `.code`. ~3 hours.
**Slice 7s update:** All seven `error.message.includes(...)` matchers in `verification-error.ts` (plus the mirrored `isPaymentError` narrowing in `guest/verify/route.ts`) were checking against strings nobody in the codebase throws — verification helpers return `NextResponse`s, RC/DA wrappers now return typed outcomes, the Razorpay SDK throws its own wording. The chain was dead defensive code. Removed (-65 LOC); kept a single generic 500 fallback for cases where the failure-state recording itself fails. The "typed PaymentError" rewrite is no longer needed since the surface to dispatch against doesn't exist.

### Testing

#### 🔄 [M14] Zero component / page / cart-store tests — PARTIALLY ADDRESSED (slice 7u extracted + tested cart-validation helpers)
**Problem:** 588 tests are all model/service/integration. 0 of 172 .tsx files have a sibling `.test.tsx`. 1500-line admin pages and the cart store (more complex than several services by line count) are entirely unverified.
**Fix:** Start with the cart store (pure logic) and the checkout `useEffect` redirect logic. Vitest + @testing-library/react is already transitively available. ~3 hours harness + incremental tests.
**Slice 7u update:** Pure cart-validation logic (`clampRegistrationPeriod` + `validateAndCorrectCartItems`) extracted from `store/cartStore.ts` into `store/cart-validation.ts` so it can be unit-tested without zustand / persistence / toast mocks. 21 new tests pin the clamping window (per-TLD min/max, hosting [1,60]), the legacy hosting-10 yearly back-fix, and the (domainName, itemType) dedup.

**Slice 7v update:** Store-level cart tests landed — 20 cases covering the restricted-TLD gate on `addItem`, the linked-hosting cascade on domain removal (with the info-toast assertion), all five getters (`getTotalPrice` / `getSubtotalPrice` / `getItemCount` / `hasDomainItems` / `hasHostingItems`), `loadFromServer` (dropped-restricted-toast + 401 no-op + validation-on-load), and the three `syncWithServer` happy paths (local-only / server-only / merge-with-dedup) plus the `isInitialized` short-circuit. Uses `vi.hoisted` + jsdom + `global.fetch` stubs; mocks `react-hot-toast` + `@/lib/logger`. Remaining: the `<Cart>` / `<CartCount>` component tests + checkout `useEffect` redirect logic (deferred — separate slice).

#### ✅ [M15] Integration test suite runs serially (`fileParallelism: false`)
**File:** [vitest.integration.config.ts:30](vitest.integration.config.ts)
**Problem:** 159 tests across 16 files run serially. Will scale linearly as coverage grows.
**Fix:** Per-file `beforeAll` spinning up a fresh `MongoMemoryServer` on a random port. ~2 hours.

---

## Cleanups (LOW)

### ✅ [L1] Razorpay SDK escape-hatch casts repeated 10× — CLOSED in batch 7t
**Files:** `lib/razorpay.ts:41,223,244,257,303,338,354`, `lib/razorpay-payments.ts:54,77,93`
**Fix:** Wrap once in a typed `lib/razorpay-client.ts`; collapse the 10 casts to 1.
**Resolution:** New `lib/razorpay-client.ts` constructs the SDK once, sets the 30s timeout, and exposes a strongly-typed `TypedRazorpayClient` facade (`orders` / `payments` / `subscriptions` / `plans` with our `RazorpayPaymentDetails` etc. on the return types). The single `as unknown as TypedRazorpayClient` cast at module scope is the only type-bridging cast left; all seven callsites in `razorpay.ts` and two of the three in `razorpay-payments.ts` are now clean. The third callsite (`getPaymentById`) had zero consumers and was deleted.

### ✅ [L2] Three orphan/duplicate types in `lib/types.ts`
**File:** [lib/types.ts:1-11](lib/types.ts) (`User` duplicates `IUser` and is wrong), `:65-76` (`Payment` — `IPayment` is used directly), `:69-78` (`DNSRecord` — model deleted in M4 batch).
**Fix:** Delete all three; add ESLint rule to flag duplicate `I*`-name interfaces.

### ✅ [L3] Magic numbers `=== 10`, `=== 12` for hosting billing cycle inference (5 sites)
**Files:** `lib/services/payment/post-tasks.ts:68`, `app/checkout/page.tsx:486`, `app/checkout/guest/page.tsx:446`, `app/api/payments/create-order/route.ts:182`, `store/cartStore.ts:44-47`
**Fix:** `lib/billing.ts` exports `inferPeriodUnit(item: CartItem)` returning a strict enum.

### ✅ [L4] `puppeteer` in `dependencies` but only used by test scripts
**File:** `package.json` (puppeteer ^24.28.0, used only in `tests/browser/`)
**Problem:** Adds ~200MB to production node_modules + cold-start working set.
**Fix:** Move to `devDependencies`.

### ✅ [L5] Two parallel client-side loggers with different signatures
**Files:** `lib/logger.ts` (27 consumers, `(...args)` signature) and `lib/client-logger.ts` (2 consumers, `(message, details)` signature). Both POST to `/api/v1/log`.
**Fix:** Pick one shape; migrate; delete the loser. ~2 hours.

### ✅ [L6] `Redis = null as unknown as Redis` when REDIS_HOST is unset
**File:** [lib/redis.ts:22](lib/redis.ts)
**Problem:** Structural lie — every caller of `redis.foo()` will NPE. Currently OK because all callers are inside try/catch, but fragile.
**Fix:** Export typed `Redis | null`; force callers to narrow.

### ✅ [L7] `findUserOrder` still uses `$or` despite Batch 4 [L4] saying it was fixed
**File:** [lib/services/orders.ts:276-281](lib/services/orders.ts)
**Problem:** Sibling `getOrderByIdOrOrderId` was correctly fixed with a single-filter branch; this one was missed. Behaviour fine due to `userId` scope, but description/code disagree.
**Fix:** Mirror `getOrderByIdOrOrderId`. ~10 min.

### ✅ [L8] React error boundaries — CLOSED in batch 7w
**Problem:** A single React render error inside (say) the cart UI tears the whole page tree down to the root `error.tsx`. No mid-tree isolation.
**Fix:** Add `<ErrorBoundary>` around cart, chat widget, floating cart count. ~3 hours.
**Resolution:** Generic `<ErrorBoundary>` (class component, since React's error lifecycles only exist on class components) added at `components/ErrorBoundary.tsx`. Three integrations: `FloatingCart` in the root layout (fallback=null — silent failure preferred to a visible warning on every page), `ChatWidget` on the homepage (fallback=null), and the full cart-page body in `app/cart/page.tsx` (default fallback — the visible reload prompt, since the cart is the primary content). Navigation and Footer stay outside the boundary so a cart crash doesn't tear those down too.

### ✅ [L9] `app/error.tsx` still reads the dead localStorage `token` for "Was user logged in" display
**File:** [app/error.tsx:49-50](app/error.tsx)
**Fix:** Read from `useSession()` (client component, available).

### ✅ [L10] `Order.paymentId` `required:true, unique:true` is write-only/fallback-only after H1 migration
**File:** [models/Order.ts:14,16,122-126](models/Order.ts)
**Problem:** Every renewal-webhook construction fabricates a unique `paymentId` (using Razorpay payment id) just to satisfy the index. `razorpayPaymentId` is the real source of truth and is already indexed.
**Fix:** Drop `required` + `unique`; reads use `razorpayPaymentId ?? paymentId` defensively. ~30 min + migration.

### ✅ [L11] `getUserByIdSafe` is functionally identical to `getUserById` after `password: select:false`
**File:** [lib/services/users.ts:22,33-37](lib/services/users.ts)
**Problem:** Comment claims one is dangerous; in reality neither returns password without explicit `.select("+password")`. Misleads new contributors.
**Fix:** Delete the duplicate; pick the surviving name. ~30 min.

### 🔄 [L12] Accessibility coverage is thin — 10/62 components carry any aria/role attribute — PARTIALLY ADDRESSED (lint setup landed in 7w.2)
**Problem:** No keyboard navigation tests; modals likely lack focus traps + `aria-modal`.
**Fix:** Add `eslint-plugin-jsx-a11y`; run axe-core in CI. ~1 day for lint setup; remediation per component.
**Slice 7w.2 update:** `plugin:jsx-a11y/recommended` added to `.eslintrc.json` (the plugin was already installed transitively via `next/core-web-vitals`, but only 6 of the recommended ~30 rules were active). Enabling the full preset surfaced 144 issues across 7 rules: `label-has-associated-control` (105 — most form labels are wrapping `<input>` instead of using `htmlFor`), `no-static-element-interactions` (17 clickable `<div>`s), `click-events-have-key-events` (10 same family), `anchor-is-valid` (6), `no-autofocus` (4), `html-has-lang` (1), `heading-has-content` (1). Downgraded those 7 specific rules from the preset's `error` to `warn` so new code is flagged but existing patterns don't break the build; remediation is per-component as the audit notes. `npm run lint` still exits 0. Runtime axe-core in CI deferred — needs `@testing-library/react` first.

---

## Architectural Suggestions (no current bug, structural improvement)

### 🔄 [S1] No shared API client in the frontend — 58 files do raw `fetch("/api/...")` — PARTIALLY ADDRESSED (helper + 3-route sweep in batch 7aa)
**Problem:** Only 8 files use `lib/fetcher.ts`; the rest hand-roll. Every endpoint addition touches N callsites; response error handling is per-file; no central place to attach request-id / tracing.
**Suggestion:** Thin typed `apiClient.get(url, schema)` returning a `Result<T, ApiError>`. Migrate incrementally; pair with Zod schemas at the boundary.
**Slice 7aa update:** Helper landed at `lib/api-client.ts` — `apiClient.{get, post, put, patch, delete}` returning `ApiResult<T> = {ok: true; data} | {ok: false; error: ApiError}`. ApiError normalises to `{status, message, code?, body?}` and pulls the route-side `error` + `code` fields (matched pair with the slice 21–32 `validatedBody` helper). Optional Zod schema parses the response body and surfaces "Response schema mismatch" on failure. Network errors (fetch threw) surface as `status=0`. `credentials: "include"` is automatic. 12 new tests pin the 200/4xx/network/schema-mismatch/method-routing paths. 3 representative callsites migrated to validate the API: `OutboundIPBadge` (GET typed against IPData), `ContactForm` (POST), `ForgotPasswordForm` (POST).

**Slice 7ab update:** 5 more callsites migrated — `AdminPasswordReset` (POST), `ProfileCompletionForm` (POST), `DomainBookingProgress` (GET, typed against a `BookingStatusResponse` shape; the 3s-interval polling now goes through the client), `DomainCrossSell` (POST search), `GoogleRecaptcha` (GET captcha-status — the fail-soft security posture is preserved: only an explicit `{enabled:false}` skips the captcha; both non-ok responses and network errors now map cleanly to `result.ok=false` and keep the captcha shown). Each conversion dropped a try/catch + manual `res.json()` + `response.ok` ladder. Total: 8 of ~58 frontend files now use `apiClient`.

**Slice 7ac update:** 4 more callsites — `ResetPasswordForm` (POST), `LivePricingIndicator` (GET pricing, typed against a `PricingResponse` shape), `TrialOtpModal` (both the OTP send + verify POSTs), `DomainSetup` (POST search). Streaming endpoints like `ChatWidget` (SSE) and the Razorpay-flow modals (DomainRenewalModal / HostingRenewalModal / HostingUpgradeModal — their POST lands mid-payment-handler) are intentionally deferred to a dedicated grouping. Total: 12 of ~58 frontend files now use `apiClient`.

**Slice 7ad update:** 3 more components (6 fetches) — `MultiStageRegisterForm` (POST register, with the Zod `details` field-error tree now read from `result.error.body`), `DomainSearch` (POST watch — the 401/409/400 status branching now switches on `result.error.status`), `admin/InvoiceDiagnostics` (all 4 fetches: GET conflicts + clear-invoice-number POST + re-sync POST + the sequential bulk re-sync loop). The `useDomainSearch` hook (3 fetches incl. generation-superseding + a fire-and-forget Phase-2 suggestions call) and `RegisterForm` (4 fetches) are deferred — both have enough control-flow nuance to warrant focused slices. Total: 15 of ~58 frontend files now use `apiClient`. Remaining: ~43.

**Slice 7ae update:** First `app/` pages migrated, plus a helper enhancement — added an optional `cache?: RequestCache` to `apiClient`'s `RequestOptions` (passed through to `fetch`) so always-fresh polling reads can request `cache: "no-store"`. `app/maintenance/page.tsx` (2 status-poll GETs, fail-closed on error → assume maintenance on), `app/activate/page.tsx` (3 fetches: `auth/me` GET with a Bearer header via the new `headers` option + activate POST with its expired/invalid-token branching now keyed on `result.error.message` + resend POST; dropped the now-unused `logger` import). Total: 17 of ~58 frontend files now use `apiClient`.

**Slice 7af update:** 2 admin pages — `app/admin/invoices/page.tsx` (the paginated invoices-list GET; the sibling PDF-download fetch stays raw since it uses `res.blob()`, not JSON), `app/admin/pricing-management/page.tsx` (TLD-pricing GET + cache-purge DELETE — the latter shows off `apiClient.delete`). Confirmed the binary-download routes (`invoices/[id]/view`, the invoice PDF endpoints) are intentionally left on raw `fetch` — `apiClient` is JSON-only by design. Total: 19 of ~58 frontend files now use `apiClient`. Remaining: ~39 (minus the handful of blob/stream endpoints that will stay on raw fetch permanently).

**Slice 7ag update:** 3 more pages — `app/dashboard/domains/transfer/page.tsx` (POST transfer), `app/domains/bulk-search/page.tsx` (POST bulk-search; network vs server error split via `result.error.status === 0`), `app/admin/domains/page.tsx` (domains list GET + per-row sync POST; dropped the now-unused `logger` import). Total: 22 of ~58 frontend files now use `apiClient`. Remaining: ~36.

**Slice 7ah update:** Dashboard support pages — `app/dashboard/support/page.tsx` (NewTicketForm create-ticket POST, typed against `{ ticket: { ticketNumber } }`) and `app/dashboard/support/[id]/page.tsx` (close-ticket PATCH + reply POST). All three mutations dropped their try/catch + manual `res.json()` + `res.ok` ladder; network vs server errors now split on `result.error.status === 0`. The SWR list/detail GETs stay on `useSWR(fetcher)` — apiClient only replaces the imperative mutation fetches here. Total: 24 of ~58 frontend files now use `apiClient`. Remaining: ~34.

**Slice 7ai update:** Admin support-tickets pages (the admin-side twins of 7ah) — `app/admin/support-tickets/page.tsx` (auth/me GET + ticket-list GET) and `app/admin/support-tickets/[id]/page.tsx` (auth/me GET + ticket-detail GET + reply POST + status PATCH + priority PATCH). 9 fetches total. Unlike the dashboard twins these had no SWR — all raw `fetch` with `credentials: "include"` (now automatic). Note on the auth/me path: the old code routed a network `throw` straight to `/login` but an HTTP-error to the session fallback; apiClient collapses both into `result.ok === false` → session fallback → `/login`, so a transient network blip now attempts the NextAuth-session fallback before bouncing to login (strictly more resilient, same end state when no valid session). `setTicket(... ?? null)` keeps the `Ticket | null` state type now that the response is typed. Total: 26 of ~58 frontend files now use `apiClient`. Remaining: ~32.

**Slice 7aj update:** Admin hosting pages — `app/admin/hosting/pending/page.tsx` (pending-list GET, retry POST, delete) and `app/admin/hosting/packages/page.tsx` (packages-list GET, package PATCH). The pending page dropped its now-unused `logger` import (the only `logger.error` lived in the migrated catch). Two preserved nuances: (1) the retry handler refreshes the list on both success and server-rejected outcomes but NOT on a network error — mapped to `if (!result.ok) { toast; return }` ahead of the refresh; (2) the packages-list page's DA-server-down sentinel can arrive either as HTTP 503 / `code: "DA_SERVER_DOWN"` on a non-ok response OR as `code: "DA_SERVER_DOWN"` inside a 200 body — both branches kept, the former via `result.error.{status,code}`, the latter via `result.data.code`. Total: 28 of ~58 frontend files now use `apiClient`. Remaining: ~30. (Slices 7ai + 7aj committed; deploy batched for later per user.)

**Slice 7ak update:** Admin transactions pages — `app/admin/order-management/page.tsx` (paginated orders GET with its prefetch/cache machinery untouched, delete/archive DELETE, unarchive PATCH) and `app/admin/payment-management/page.tsx` (latest-5-payments GET). The orders GET previously swallowed errors via a `logger.error` in the catch and otherwise no-op'd; since apiClient never throws, the whole try/catch/finally collapsed to a plain `if (result.ok) {...}` followed by the unconditional `fetching.current.delete` + loading-flag reset (same cleanup the old `finally` did) — dropped the now-unused `logger` import there. The delete handler also dropped a dead `const data = await response.json()` it never read. payment-management kept its `logger` import (still logs load failures, now off `result.error.message`). Total: 30 of ~58 frontend files now use `apiClient`. Remaining: ~28.

**Slice 7al update:** Admin 2FA page `app/admin/settings/security/page.tsx` — all 4 fetches (totp/setup GET in the mount effect, totp/setup POST to start enrolment, totp/confirm POST, totp/disable POST). The three handlers dropped their `throw new Error(data.error) … catch(showErrorToast)` pattern for the flat `if (result.ok)` shape; error text now reads `result.error.message` (apiClient already lifts the route's `error` field into it). The mount GET's `.then/.catch` promise chain became a small async IIFE with the same fail-to-`false` default. Note this page targets the shared `auth/totp/*` routes (not admin-scoped), so the dashboard-side security page — if one exists — could reuse the exact same conversion later. Total: 31 of ~58 frontend files now use `apiClient`. Remaining: ~27.

**Slice 7am update:** Admin hosting main page `app/admin/hosting/page.tsx` — all 7 fetches (DA stats GET, the provision-deps pair `hosting/packages` + `users/no-hosting`, provision POST, actions POST, hosting-details GET, change-package POST). This was the most guard-heavy page so far: the old stats fetch hand-rolled a `content-type` sniff to catch 502/503 HTML from Nginx before `res.json()`. apiClient already parses best-effort and leaves `data === undefined` on an unparseable 200 body, so that guard became a clean `if (!result.data)` branch, while the 503/`DA_SERVER_DOWN`/network paths fold into `!result.ok` (checking `error.status === 503 || error.code === 'DA_SERVER_DOWN' || error.status === 0`). The DA-down sentinel is still also honoured when it rides inside a 200 body (`result.data.code === 'DA_SERVER_DOWN'`). `fetchProvisionDeps` went from two sequential awaits to a single `Promise.all` (no dependency between the two GETs); its DA-down check now covers both the non-ok-error and the 200-body-sentinel forms via one combined predicate. `logger` stays imported (still used in the actions + change-package error paths). One behaviour normalisation worth noting: a non-503 HTTP error that previously returned `{success:false}` JSON used to show "Failed to fetch hosting data"; it now routes through `!result.ok` and shows the server-supplied `error.message` while marking the DA banner — acceptable given the DA-down detection (the load-bearing part) is preserved. Total: 32 of ~58 frontend files now use `apiClient`. Remaining: ~26.

**Slice 7an update — plus a helper enhancement:** Admin user-management `app/admin/user-management/page.tsx` — all 8 fetches: the 3-way parallel user-list load (active / deactivated / services), reset-password POST, reactivate POST, reset-2fa POST, and the two DELETEs (soft-deactivate + `?permanent=true` hard-delete). The parallel load previously used `Promise.allSettled` + per-result `.ok`/`.json()` unwrapping; since apiClient never throws it became a plain `Promise.all` of three `ApiResult`s with `result.ok ? data.users : []` each (the service-users branch still `logger.warn`s on failure, so `logger` stays imported). **Helper enhancement:** both DELETEs send a JSON body (`{ userId }`), but `apiClient.delete(url, schema?, opts?)` had no body slot — so `delete` now takes `(url, body?, schema?, opts?)` mirroring post/put/patch (the underlying `request` already gates on `body !== undefined`, so the three existing no-body `delete` callers — pricing-management, hosting/pending, order-management — are unaffected; verified by full `tsc`). Total: 33 of ~58 frontend files now use `apiClient`. Remaining: ~25.

**Slice 7ao update:** Admin pending-domains `app/admin/pending-domains/page.tsx` — all 10 fetches across every HTTP verb the helper now covers: balance GET, auth/me GET (same session-fallback normalisation as 7ai/7an), the paginated list GET, register + verify POSTs, archive + `?permanent=true` DELETEs, mark-resolved + retry PUTs. The retry handler keeps its two-step dependency (PUT reset-to-pending → POST register) — the early `if (!resetResult.ok) return` now resets `actionLoading` before bailing (previously the `finally` did it). The two DELETEs use the new bodyless `apiClient.delete` (no `{userId}` here — the id is in the path/query). No `logger` in this file, so nothing to drop. Total: 34 of ~58 frontend files now use `apiClient`. Remaining: ~24.

**Slice 7ap update:** Admin system-settings `app/admin/system-settings/page.tsx` — 12 of its 13 fetches: razorpay-mode GET + save-keys/switch-mode POSTs, the three `admin/settings` GET loaders (IP-whitelist, captcha, CORS — all typed against `{ settings?: Record<string, { value?: unknown }> }`), the four `admin/settings` save POSTs, and the check-ip GET. **The backup fetch stays raw** — it's a `res.blob()` download with bespoke 401/403/500 status-code messaging, exactly the kind of binary/stream endpoint apiClient is not meant for (same call made for the invoice-PDF routes in 7af). Notable: the save-whitelist and save-CORS handlers each fire two sequential POSTs that previously relied on a shared try/catch to surface any failure; since apiClient never throws, each now captures both `ApiResult`s and shows the success toast only when *both* `.ok`, logging the first failing `.error.message` otherwise (the union is narrowed via `!x.ok ? x.error.message : …` so TS is happy). `logger` stays (used across every loader's failure path + the untouched backup handler). Total: 35 of ~58 frontend files now use `apiClient`. Remaining: ~23.

**Slice 7aq update:** Dashboard settings `app/dashboard/settings/page.tsx` — 8 of its 9 fetches: the user-settings GET loader + its two PUT savers (change-password, update-profile), the auth/me GET, and the four totp endpoints (setup GET in the security-tab effect, setup/confirm/disable POSTs — same shape as the admin 2FA page in 7al). **The nominatim.openstreetmap.org reverse-geocode stays raw** — it's a cross-origin third-party call with a custom `User-Agent`, and apiClient is for same-origin `/api/*` routes (it force-sets `credentials: include`, wrong for a public CORS endpoint). Two response-typing snags surfaced and were fixed cleanly rather than papered over: the settings GET is typed `UserSettings & { profile?: Record<string,string> }` so `setSettings(data)` stays assignable, and the `/auth/me` merge keeps its original `any`-era spread semantics via a single `as User` cast on the updater return (the server user carries extra `password`/`provider` fields not on the local `User` interface). Total: 36 of ~58 frontend files now use `apiClient`. Remaining: ~22.

**Slice 7ar update:** Admin dns-management `app/admin/dns-management/page.tsx` — all 10 fetches: the domains-list GET, dns-records GET (with its 404-driven "zone still propagating" 30s-retry loop preserved — now keyed on `result.error.status === 404` instead of `response.status`), the nameservers GET with default-NS auto-detect, the default + custom nameserver POSTs, activate-dns POST, record-add POST, and the two record DELETEs that ship a `recordData` body (delete-record + the delete-then-add edit flow) — these lean on the new `apiClient.delete(url, body?)` from 7an. Dropped the now-unused `logger` import (its only use was the domains-load catch) plus a dead `initialNsSnapshot` local that was captured but never read. The DNS GET's `errorData = await response.json().catch(...)` was also dead (parsed, never used) and is gone. Total: 37 of ~58 frontend files now use `apiClient`. Remaining: ~21.

**Slice 7as update — DNS pair complete:** Dashboard dns-management `app/dashboard/dns-management/page.tsx` (the user-facing twin of 7ar) — all 12 fetches: services-status GET (its catch was the only `logger` use, so the import is gone), domains-list GET, dns-records GET (404 propagation retry preserved), nameservers GET (keeps the `data.success`-false branch + the 404/500-specific toasts via `result.error.status`), the default + custom nameserver POSTs with their 10-attempt verification polling loops intact, record-add POST, and the record DELETEs-with-body (delete + the edit's delete-then-add **plus its best-effort restore-POST on add failure**) — all on `apiClient.delete(url, body?)` / `apiClient.post`. With 7ar this closes the DNS-management pair. Total: 38 of ~58 frontend files now use `apiClient`. Remaining: ~20.

**Slice 7at update — biggest single page:** Admin settings `app/admin/settings/page.tsx` — all 22 fetches. The page's `authHeaders = (extra) => extra` helper was a no-op (it never added a Bearer token — H3 in 7c confirmed none is written), so it's deleted outright and apiClient's automatic `credentials: include` + Content-Type covers everything. Breakdown: 9 GET loaders (incl. the `Promise.all` cache+settings pair, which became two `ApiResult`s), the cache PUT + DELETE, two check-ip GETs, the IP-whitelist + CORS save pairs (now `Promise.all` of two POSTs, success toast only when both `.ok`), and the captcha/hosting-trial/trial-OTP/test-plan/maintenance save POSTs. The many `try {…} catch {}`-swallow loaders collapse to flat `if (result.ok)` since apiClient never throws. Three response-typing snags fixed by typing the GET generics to the existing state shapes (`IPData` for both check-ip + ip-status, the inline cache-status shape) rather than casting. Total: 39 of ~58 frontend files now use `apiClient`. Remaining: ~19.

**Slice 7au update:** Two user-facing service pages — `app/dashboard/hosting/page.tsx` (cancel-trial POST + auto-renew PATCH; SWR GET untouched) and `app/dashboard/domains/[id]/page.tsx` (the two sequential loadDomainDetails GETs — services-status then user/domains — plus the nameservers GET and the NS-update POST). The latter dropped its now-unused `logger` import (all three uses were in the migrated catches). The two-step domain load keeps its semantics: services-status is best-effort (`statusResult.ok ? data.hostedDomains : []`) and the domains GET drives the not-found redirect. Total: 41 of ~58 frontend files now use `apiClient`. Remaining: ~17.

### ✅ [S2] No pre-commit hooks (husky/lefthook); CI is the only gate — CLOSED in batch 7y
**Suggestion:** Husky + lint-staged running `tsc --noEmit` on staged files and `eslint --fix`. ~30 min.
**Resolution:** `husky` + `lint-staged` installed as devDeps; `prepare` script wired so `npm install` auto-installs the git hook. `.husky/pre-commit` runs `npx lint-staged` (eslint --fix on staged `.ts/.tsx/.js/.jsx` per the `lint-staged` config in `package.json`) followed by `npx tsc --noEmit` (project-wide typecheck). Skipping with `--no-verify` is supported but discouraged — the same checks gate CI.

### ✅ [S3] Most API routes parse JSON bodies with no validation — CLOSED (helper + 12-slice sweep across batches 7z–7z.12, all 73 routes validated)
**Files:** `app/api/admin/users/route.ts`, `app/api/domains/dns/route.ts`, `app/api/admin/users/reset-2fa/route.ts` use `Schemas.*.safeParse`. The other 130+ routes do `const { x, y } = await request.json()`.
**Suggestion:** `validatedBody<T>(req, schema)` helper. Sweep highest-risk routes (user mutations, admin writes, payment webhooks) first. Helper ~30 min; sweep is route-by-route.
**Slice 7z update:** Helper landed at `lib/api-validation.ts` — `validatedBody(req, schema)` + `validatedQuery(req, schema)`, both returning a `{ok: true, data} | {ok: false, response}` discriminated union with a uniform 400 + `code: "VALIDATION_ERROR"` / `code: "INVALID_JSON"` shape. 10 new tests pin the parse-fail + multi-issue join + coercion paths. 5 high-risk routes migrated: `payments/cancel-subscription` (hostingId required), `payments/create-order` (cart-items array shape), `user/domains/watch` (domain-name shape + length), `user/complete-profile` (nested address shape), `user/hosting/check-eligibility` (optional domainName).

**Slice 7z.2 update:** 6 more routes migrated — `payments/create-subscription` (planId/interval/domainName), `user/hosting/renew` (domainName), `user/hosting/cancel-trial` (hostingId via Schemas.id), `user/hosting/[id]/auto-renew` (boolean autoRenew flag), `user/domains/nameservers` (with a Zod `.refine` linking method=custom to ≥2 nameservers, replacing 20 lines of inline validation), `user/settings/change-email` (Schemas.email + currentPassword, replacing 4 hand-rolled checks).

**Slice 7z.3 update:** 5 more routes — `admin/razorpay-mode` (Zod `discriminatedUnion("action")` typing the save_keys / switch_mode variants distinctly; replaces a runtime `if (action === …)` re-check), `user/hosting/upgrade` (domainName + targetPlanId), `contact` (full structural shape; existing InputValidator still runs after Zod for content safety + sanitization), `user/support` (subject/category/message + attachments shape; replaces 4 hand-rolled length checks). Plus a latent-typing fix in `contact/route.ts` — Zod giving `email: string` revealed that the `InputValidator.*.sanitized` return is `string | Record<string,string>`; coerced via `String()` at the boundary.

**Slice 7z.4 update:** 6 more routes — `user/support/[id]` (PATCH close-only + POST reply, with attachment shape + 5000-char cap), `admin/support-tickets/[id]` (PATCH status/priority via `.enum`, POST admin reply), `user/hosting/trial-otp/send` (optional phone — body or User record), `user/hosting/trial-otp/verify` (phone + 6-digit code regex), `user/hosting/trial-eligibility` (planId / deviceFingerprint / recaptchaToken / otpToken — `z.infer` re-exports the input type so the shared `runEligibility` helper keeps a single type alias), `chat` (LLM endpoint — array shape + role enum + bounded content per message; replaces 14 lines of `(m as unknown)`-style filtering).

**Slice 7z.5 update:** 6 admin write routes — `admin/hosting/change-package` (username + newPackage caps), `admin/hosting/actions` (discriminated union per action — suspend/unsuspend require username because the typed DA wrappers don't accept undefined; delete accepts either username or hostingId; surfaced + fixed a latent bug where the previous `any`-typed body would crash at the wrapper boundary when only hostingId was sent for suspend/unsuspend), `admin/hosting/assign` (userId via Schemas.id + package + domain), `admin/users/reactivate` (userId via Schemas.id), `admin/users/reset-password` (userId + newPassword min-6 + optional sendEmail with default true), `admin/log-error` (full system-log entry shape — replaces an unauthenticated `await req.json()` that fed straight into recordSystemLog).

**Slice 7z.6 update:** 6 more admin write routes — `admin/domains/nameservers` (same refine-based shape as the user twin from 7z.2; replaces 20 lines of inline validation), `admin/domains/activate-dns` (domainName + optional force flag), `admin/domains/sync` (single domain OR domainNames array, batch capped at 100), `admin/diag-da/cleanup` (usernames bulk-delete, capped at 100), `admin/reset-password` (admin self-reset — Zod refine validates newPassword === confirmPassword so the path-tagged error attaches to confirmPassword, replacing 3 hand-rolled checks), `admin/tld-pricing/cache` (PUT — enabled / ttlMinutes with refine: at least one required; ttlMinutes capped at 30 days).

**Slice 7z.7 update:** 6 admin routes — `admin/hosting/test-plan` (action enum + optional plan id), `admin/hosting/packages` (POST + PATCH — POST uses `.passthrough()` for arbitrary DA flags, PATCH validates the partial-update shape against Schemas.id), `admin/hosting/provision` (userId/domain/package/daUsername/validity/price/periodUnit — moved validation ahead of the admin auth check; the script's existing `let body: ProvisionBody = {}; try {...} catch {}` early-parse pattern was kept for the catch-handler's later `body` reference), `admin/backup` (password required, replacing a 2-step manual JSON-parse + missing-password check), `admin/users/[id]` (PUT updates firstName/lastName/email/role/isActive partial shape, Schemas.email + role enum), `admin/pending-domains/verify` (domainIds bulk-array, capped at 100). Plus a latent typing fix in `admin/hosting/packages` — Zod giving `quota: string | number | undefined` surfaced that the DA wrapper expects `string`; coerced via `String(...)` at the boundary.

**Slice 7z.8 update:** 6 more routes spanning admin + auth + workers — `admin/settings` (key + value as `z.unknown()` to preserve the arbitrary-JSON-value contract; description + category caps), `admin/pending-domains` POST (full create-row shape — userId via Schemas.id, currency / period defaults handled downstream, numeric-or-string customer/contact IDs preserved), `auth/activate` (single activation token, length-capped), `workers/sync-zoho-invoice` (full Cloud Tasks payload — orderId/userId/serviceType/domainName/hostingPlanId/amount/currency/razorpayPaymentId/durationMonths; replaces a 4-field hand-rolled check that was reachable only after destructure), `workers/sync-hosting-status` (userId), `workers/process-hosting-expiry` (hostingId). The workers are particularly nice — Cloud Tasks payloads now fail-fast with a structured 400 instead of crashing midway through processing.

**Slice 7z.9 update:** 6 more routes finishing the workers + the security-critical auth surface — `workers/process-service-expiry` (serviceId + hosting/domain enum + optional simulatedTime string-only — TimeService.parse rejects raw ms, which the previous `any` body silently coerced), `auth/check-account-status` (Schemas.email), `auth/totp/confirm` (6-8 digit regex), `auth/totp/disable` (code 6..64 chars accepting TOTP or backup code; runtime branches downstream; + password), `auth/resend-activation` (Schemas.email), `admin/domains/dns` POST + DELETE (finishes the slice 11 GET-only migration — required record envelope with `.passthrough()` for per-type extras; the previous `request.json().catch(() => ({}))` pattern in DELETE meant `recordData` was effectively `any`, masking that RC's wrapper requires all four fields).

**Slice 7z.10 update:** 6 user-facing domain routes — `domains/search` (domain + tlds-as-union-of-array-or-CSV-string for legacy clients + quick flag), `domains/activate-dns` (domainName + optional force), `domains/renew` (GET via `validatedQuery` with `z.coerce.number()` defaulting years to 1; POST with paymentId required — was silently allowed empty before), `domains/booking-status` (GET refine "orderId OR domainName"; POST extracts a `bookingStepSchema` enum mirroring the model's BookingStep — surfaces a real shape contract that the old `string` accept would only have hit at Mongoose enum-validation save time), `domains/verify-status` (domainName), `domains/transfer` (domainName + authCode capped at 128, no regex pin since EPP code formats vary by registry).

**Slice 7z.11 update:** 6 more routes finishing nearly all the remaining surface — `log` (client log payload — level enum + bounded message + z.unknown() details), `domains/bulk-search` (array of strings, route dedupes downstream), `domains/nameservers` (same refine-based shape as the user + admin twins from 7z.2/7z.6), `cart` (.passthrough() envelope; the existing TLD-clamp + restricted-TLD-drop logic runs after Zod's structural gate), `test/automation/trigger` (optional serviceId/serviceType/now), `admin/pending-domains/[id]` PATCH (status enum mirroring the PendingDomain model's allowed values — exposed a latent bug where the route's downstream order-sync compared `status === "registered"` but the model never allows that value, so every pending → completed admin action silently set the Order domain to `status=failed`; fixed by switching to the actual enum mapping `completed → registered`, anything-else → failed).

**Slice 7z.12 update — S3 closed:** 3 payment routes — `payments/verify` (cartItems[] + order_id OR subscription_id refine + payment_id + signature; replaces a 3-condition post-destructure check), `payments/guest/verify` (same envelope + guestToken with its own min(1) for "token required"), `payments/guest/create-order` (envelope-only `.passthrough()` schema; the route has two modes — with guestToken: signed token is source of truth, body's registrant fields are ignored; without: deeper per-field validation runs inside the route to preserve precise error wording). **73 of 73 routes now validate** — every API route that parses a JSON body now does so through `validatedBody` or an equivalent Zod-based path. Helper landed in slice 21 (`067da79`); the 12-slice sweep ran 21 → 32 across admin writes, payment flows, user mutations, auth + workers, user-facing domain ops, and the payment-verification surface. S3 architectural suggestion closed.

---

## What surprised me

**Half-finished NextAuth migration.** Batch 6d closed 5 admin pages but ~30% of the frontend still wires Bearer tokens that nobody writes. Three callsites are load-bearing: cart-store (H1), `app/error.tsx`, `app/checkout/page.tsx`'s "credentials login uses JWT token" branch. The system limps along because every API route falls through to a NextAuth-cookie path that hides the bug.

**The PendingDomain L5 fix is half-wired.** App-layer filter was scoped correctly, DB-layer unique index was not — worse outcome than the pre-fix silent overwrite.

**Zero React tests.** 588 tests, 0 component/page/store tests. The 1500-line admin pages and the cart store (more complex than several services) have no automated coverage at all.

**The anti-corruption-layer gap** is structurally the most expensive piece. 51 `toLowerCase().includes(...)` chains + 122 direct upstream-SDK callsites. Every prior rescan flagged some flavor of "RC/DA error leaked / string-typed". The per-finding fixes are correct but they're a Hydra. A proper `lib/integrations/` boundary would close that class of bug permanently.

---

## Suggested batching

- ~~**Batch 7a** — H1 (cart breakage)~~ ✅ shipped `c4aec87`
- ~~**Batch 7b** — H2 (PendingDomain index + prod migration)~~ ✅ shipped `45e8e85` + `caece03`
- ~~**Batch 7c** — H3 (Bearer cleanup sweep, 38 files)~~ ✅ shipped `6bdd43b`
- ~~**Batch 7d** — H4 (Mongo pool sizing)~~ ✅ shipped `9b60a9f`
- ~~**Batch 7e** — M2 + M3 + M5 + M7 + M9 + M10 + M11 + M12 + M15 + L2~~ ✅ shipped `8aee422`
- ~~**Batch 7f** — L3 + L4 + L5 + L6 + L7 + L9 + L10 + L11~~ ✅ shipped `5ee9c94`
- ~~**Batch 7g** — M1 slice 1: RC registerDomain anti-corruption~~ 🔄 shipped `67390e4`
- ~~**Batch 7h** — M1 slice 2: DA createUser anti-corruption~~ 🔄 shipped `6391de2`
- ~~**Batch 7i** — M1 slice 3: RC renewDomain anti-corruption~~ 🔄 shipped `2fca12a`
- ~~**Batch 7j** — M1 slice 4: inner/outer RC fragment vocab unified~~ 🔄 shipped `c31bf1e`
- ~~**Batch 7k** — M1 slice 5: DA suspendUser anti-corruption~~ 🔄 shipped `292802c`
- ~~**Batch 7l** — M1 slice 6: DA unsuspendUser + webhook suspend migration~~ 🔄 shipped `90ac494`
- ~~**Batch 7m** — M1 slice 7: RC transferDomain~~ 🔄 shipped `facfb87`
- ~~**Batch 7n** — M1 slice 8: DA getUserConfig + sync-worker migration~~ 🔄 shipped `23fda8e`
- ~~**Batch 7o** — M1 slice 9: DA deleteUser + admin/hosting/actions sweep~~ 🔄 shipped `ba451f2`
- ~~**Batch 7p** — M1 slice 10: RC getDomainOrderId / getDomainDetails~~ ✅ shipped `c76ce35`
- ~~**Batch 7q** — M1 slice 11: RC getDNSRecords~~ ✅ shipped `a4b4422` (DA modifyDomain dropped — no callers in codebase; updateDNS is permanently disabled)
- ~~**Batch 7r** — M1 slice 12: DA changePackage + upgrade-flow + admin route~~ ✅ shipped `26d201f`
- ~~**Batch 7s** — M13 (delete dead `error.message.includes` chain — typed PaymentError unnecessary, no callers throw those strings)~~ ✅ shipped `299f84c`
- ~~**Batch 7t** — L1 (typed Razorpay SDK client, 10 casts → 1)~~ ✅ shipped `9b6d018`
- ~~**Batch 7u** — M14 partial: pure cart-validation helpers + 21 unit tests~~ ✅ shipped `0011477`
- ~~**Batch 7v** — M14 continued: store-level cart tests (addItem/removeItem cascade, getters, syncWithServer happy path)~~ ✅ shipped `12d2cbd`
- ~~**Batch 7w** — L8 (React error boundaries)~~ ✅ shipped `2339a2a`
- ~~**Batch 7w.2** — L12 (jsx-a11y eslint surface)~~ ✅ shipped `7c466b5` (lint setup; runtime axe + per-component remediation deferred)
- ~~**Batch 7x** — M6 partial: 14 leaf components demoted from `'use client'` to server~~ ✅ shipped `0f35e5f`
- ~~**Batch 7y** — S2: pre-commit hooks (husky + lint-staged + tsc --noEmit)~~ ✅ shipped `2660cfe`
- ~~**Batch 7z** — S3 helper (`validatedBody` / `validatedQuery`) + 5-route sweep + 10 tests~~ ✅ shipped `067da79`
- ~~**Batch 7z.2** — S3 continued: 6 more routes (payments/create-subscription, hosting/renew + cancel-trial + auto-renew, domains/nameservers, settings/change-email)~~ ✅ shipped `e87ad6a`
- ~~**Batch 7z.3** — S3 continued: 5 more (admin/razorpay-mode discriminated-union, hosting/upgrade, contact, user/support, latent `.sanitized` typing fix)~~ ✅ shipped `8b4aac3`
- ~~**Batch 7z.4** — S3 continued: 6 more (user/support/[id], admin/support-tickets/[id], trial-otp send + verify, trial-eligibility, chat)~~ ✅ shipped `1dfc073`
- ~~**Batch 7z.5** — S3 continued: 6 admin write routes (hosting/change-package, hosting/actions discriminated-union + latent bug fix, hosting/assign, users/reactivate, users/reset-password, log-error)~~ ✅ shipped `a978849`
- ~~**Batch 7z.6** — S3 continued: 6 more admin write routes (domains/nameservers, domains/activate-dns, domains/sync, diag-da/cleanup, reset-password, tld-pricing/cache)~~ ✅ shipped `60cf32f`
- ~~**Batch 7z.7** — S3 continued: 6 admin routes (hosting/test-plan, hosting/packages POST + PATCH, hosting/provision, backup, users/[id] PUT, pending-domains/verify) + latent quota-NaN fix~~ ✅ shipped `ba4f8d5`
- ~~**Batch 7z.8** — S3 continued: 6 routes (admin/settings, admin/pending-domains POST, auth/activate, 3 workers)~~ ✅ shipped `d524fd9`
- ~~**Batch 7z.9** — S3 continued: 6 routes (process-service-expiry, auth/check-account-status, totp/confirm + disable, resend-activation, admin/domains/dns POST + DELETE)~~ ✅ shipped `33ee8ff`
- ~~**Batch 7z.10** — S3 continued: 6 user-facing domain routes (search, activate-dns, renew, booking-status, verify-status, transfer)~~ ✅ shipped `993272a`
- ~~**Batch 7z.11** — S3 continued: 6 routes (log, bulk-search, nameservers, cart, test-automation, pending-domains/[id]) + latent pending-domain status bug fix~~ ✅ shipped `a9317ec`
- ~~**Batch 7z.12** — S3 COMPLETE: 3 payment routes (verify, guest/verify, guest/create-order) — **73/73 routes validated**~~ ✅ shipped `5355331` (+ follow-up fix `d7cd9cb`)
- ~~**Batch 7aa** — S1: typed frontend `apiClient` (`ApiResult<T, ApiError>` + Zod-aware) + 3 callsites + 12 tests~~ ✅ shipped `bd4edbf`
- ~~**Batch 7ab** — S1 continued: 5 more frontend callsites migrated to `apiClient`~~ ✅ shipped `6d6b714`
- ~~**Batch 7ac** — S1 continued: 4 callsites (ResetPasswordForm, LivePricingIndicator, TrialOtpModal ×2, DomainSetup)~~ ✅ shipped `e9c5458`
- ~~**Batch 7ad** — S1 continued: 3 components / 6 fetches (MultiStageRegisterForm, DomainSearch watch, InvoiceDiagnostics ×4)~~ ✅ shipped `ba0602c`
- ~~**Batch 7ae** — S1 continued: first app/ pages (maintenance, activate ×3) + `cache` option on apiClient~~ ✅ shipped `cbe3301`
- ~~**Batch 7af** — S1 continued: 2 admin pages (invoices list-GET, pricing-management GET + DELETE)~~ ✅ shipped `02b2d7f`
- ~~**Batch 7ag** — S1 continued: 3 pages (domains/transfer, bulk-search, admin/domains GET + sync POST)~~ ✅ shipped `d390f38`
- ~~**Batch 7ah** — S1 continued: dashboard support pages (create-ticket POST, close PATCH, reply POST)~~ ✅ shipped `9bd22ea`

### Remaining open work (no batch numbers assigned yet)
- **S1 continued** — ~34 frontend `fetch` callsites still to migrate to `apiClient` (admin hosting/orders/users/settings pages, dashboard pages, cart/checkout). Blob/stream + payment-handler fetches stay on raw `fetch` by design.
- **M14** — component-level tests (needs `@testing-library/react` installed first).
- **M4** — 5 page components > 1000 lines (multi-day per page).
- **M6 continued** — per-component review of the ~110 remaining client components.
- **axe-core in CI** — runtime accessibility checks (depends on the M14 test harness).
- ⏸ **M8** (PendingDomain._id ObjectId) — deferred pending prod data audit.
