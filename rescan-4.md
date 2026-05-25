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
| Batch 7x | M6 partial — demote 14 leaf components from `'use client'` to server | 🔄 In progress | pending |

**All four HIGHs + 11 MEDIUMs + 11 LOWs cleared, M14 / M6 / L12 in progress.** 19 vertical slices shipped across batches 7a–7x (6 RC ops + 6 DA ops + the vocab unification + the M13 cleanup + the L1 Razorpay typed-client + two M14 slices + L8 error boundaries + L12 jsx-a11y lint + M6 leaf demotion). Bonus catches:
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

### [S1] No shared API client in the frontend — 58 files do raw `fetch("/api/...")`
**Problem:** Only 8 files use `lib/fetcher.ts`; the rest hand-roll. Every endpoint addition touches N callsites; response error handling is per-file; no central place to attach request-id / tracing.
**Suggestion:** Thin typed `apiClient.get(url, schema)` returning a `Result<T, ApiError>`. Migrate incrementally; pair with Zod schemas at the boundary.

### [S2] No pre-commit hooks (husky/lefthook); CI is the only gate
**Suggestion:** Husky + lint-staged running `tsc --noEmit` on staged files and `eslint --fix`. ~30 min.

### [S3] Most API routes parse JSON bodies with no validation; only 3 use Zod despite the dep being present
**Files:** `app/api/admin/users/route.ts`, `app/api/domains/dns/route.ts`, `app/api/admin/users/reset-2fa/route.ts` use `Schemas.*.safeParse`. The other 130+ routes do `const { x, y } = await request.json()`.
**Suggestion:** `validatedBody<T>(req, schema)` helper. Sweep highest-risk routes (user mutations, admin writes, payment webhooks) first. Helper ~30 min; sweep is route-by-route.

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
- **Batch 7x** — M4 + M6 (frontend decomposition of 1000+ line page components) — multi-day, per page.
- **Batch 7y** — ⏸ M8 (PendingDomain._id ObjectId) — deferred pending prod data audit.
