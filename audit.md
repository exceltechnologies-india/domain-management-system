# Project Audit — Domain Management System

**Date:** 2026-05-13
**Version audited:** 3.3.0
**Scope:** Full project rescan (`/home/rsa-key-20251224/dd`)

---

## 1. Project Snapshot

| Attribute | Value |
|---|---|
| Purpose | SaaS for domain registration + web hosting (India market) |
| Framework | Next.js 15 (App Router, standalone build), React 19, TypeScript 6.0 |
| Database | MongoDB 8 + Mongoose (17 collections) |
| Auth | NextAuth.js + TOTP 2FA + custom session timeout |
| State | Zustand (cart) + SWR |
| Payments | Razorpay |
| Integrations | ResellerClub, DirectAdmin, Zoho Books, GCP Cloud Tasks, Redis, Anthropic Claude |
| Tests | Vitest + Playwright (60% threshold, ~15 test files) |
| Deploy | Docker → GCP Cloud Run (primary); deploy.sh + plain `node --env-file=.env.local .next/standalone/server.js` (VPS fallback) |
| Source files | ~250 TS/TSX, ~100 API routes, 103 components, 77 lib modules, 17 models |

---

## 2. Critical Flaws

### ~~[CRITICAL-1] No git repository~~ — RESOLVED 2026-05-14
Initialized `main`-branch repository in [/](.) and verified `.gitignore` correctly excludes `.env.local`, `gcp-key.json`, `node_modules/`, `.next/`, `coverage/`, `deployment-logs/`, `*.tsbuildinfo`, and `*.log`. Confirmed zero files inside excluded directories were staged. Initial commit `2ceee43` contains 502 files / 113,935 lines. Repo-local identity set to `Pawan <pawan@exceltechnologies.in>` (not global — only affects this repo).

Remote configured at `git@github.com:exceltechnologies-india/domain-management-system.git` (private). `main` tracks `origin/main`.

Classic branch protection rule created on `main` requiring PR review (1 approval), status checks (no checks added yet pending CI from MEDIUM-6), and blocking force-pushes / deletions / bypass.

**Caveat — known limitation, not a bug to fix:** GitHub Free orgs do not enforce branch protection or rulesets on private repositories. The rule is saved and will activate automatically when the org upgrades to GitHub Team (~$4/user/month) or if the repo is made public. Until then it serves as documented policy only. Re-evaluate when team size or risk profile justifies the upgrade.

---

### ~~[CRITICAL-2] Secrets baked into Docker image~~ — PARTIALLY RESOLVED 2026-05-14
The `cp -f .env.local .next/standalone/.env.local 2>/dev/null || true` segment was removed from the [package.json](package.json) `build` script. The build script now only copies `.next/static` and `public` into the standalone output:

```
"build": "next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/"
```

The Docker path was already safe in practice (`.env.local` is excluded by [.dockerignore](.dockerignore), so the `cp -f` was a silent no-op inside the image build). Removing it closes the footgun for `gcloud builds submit` / `gcloud run deploy --source` paths, where `.env.local` *would* be present in the build context.

**Still required before production deploy:**
1. Provision Cloud Run with secrets from Secret Manager (`MONGODB_URI`, `NEXTAUTH_SECRET`, `JWT_SECRET`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ZOHO_*`, `DIRECTADMIN_*`, `RESELLERCLUB_*`, `SMTP_PASS`, `RECAPTCHA_SECRET_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `ADMIN_PASSWORD`).
2. **Rotate any production credential that was in a previously-built/pushed image** — historical layers cannot be unbaked.
3. Keep `.env.local` for local development only (already in [.gitignore](.gitignore) and [.dockerignore](.dockerignore)).

---

### ~~[CRITICAL-3] Security module excluded from coverage~~ — RESOLVED 2026-05-14
[vitest.config.ts](vitest.config.ts) no longer excludes [lib/security.ts](lib/security.ts) from coverage. Added [tests/unit/lib/security.test.ts](tests/unit/lib/security.test.ts) — 42 tests covering every public method on `SecurityValidator`:

- `containsMaliciousPatterns`: SQL injection, NoSQL operators, XSS payloads, javascript:/event-handler URLs, path traversal (raw + URL-encoded), null-byte injection, command-injection metacharacters
- `validateFileUpload`: dangerous extensions (`.exe`, `.bat`, `.cmd`, `.sh`, `.php`), oversized content, malicious content in safe-named file, path-traversal filenames
- `sanitizeInput`: HTML stripping, max-length truncation, whitespace normalisation, special-char filtering
- `validateEmailSecurity`: format validation, `..` / `@.` / `.@` rejection, max length, sanitised output is lowercase + trimmed
- `validatePasswordSecurity`: length + variety requirements, common-pattern dictionary, medium / strong tiering
- `validateCSRF`: GET/HEAD/OPTIONS bypass, Origin match, Referer fallback, production-strict header requirement, missing `NEXTAUTH_URL` rejection

**Measured coverage of [lib/security.ts](lib/security.ts):** 98.93% lines, 95.38% branches, 100% functions, 98.88% statements. Suite moved from 298 → 340 tests, all green.

**Bug fixed as a byproduct of exposing the file to tests:** `validateFileUpload` would crash with `RangeError: Maximum call stack size exceeded` when called with content larger than ~10 MB — the size check added an error but did not short-circuit, and the subsequent `containsMaliciousPatterns(content)` call overflowed the regex engine. [lib/security.ts](lib/security.ts) now returns early after the size check. Detected because the new oversized-file test failed on the first run; the fix is in the same commit.

---

### ~~[CRITICAL-4] `unsafe-eval` and `unsafe-inline` in CSP~~ — RESOLVED 2026-05-16 (all Razorpay flows iframe-isolated; CSP allowlist inverted to deny-list)
CSP is now per-route. [lib/security-headers.ts](lib/security-headers.ts) accepts a `strictCSP` option that strips `'unsafe-inline'` and `'unsafe-eval'` from `script-src`, leaving the nonce as the only allowed inline-script execution path. [middleware.ts](middleware.ts) sets the flag based on the request path.

**Strict CSP applied to:**
- All `/api/*` routes (including the `/api/v1/*` alias) — JSON responses, no scripts execute
- Static legal/marketing/error pages: `/about`, `/cancellation-refund`, `/data-deletion`, `/privacy`, `/terms-and-conditions`, `/maintenance`, `/403`

**Relaxed CSP retained for:** dashboard, admin, auth (login/register/reset-password/activate/contact), cart, checkout, home, and any other page that may surface a Razorpay renewal/upgrade modal or reCAPTCHA widget. Conservative on purpose — Razorpay still requires `unsafe-eval`, and these modals can appear dynamically.

**Live verification (standalone build on port 3458):**
- `/api/health` and `/api/v1/health` → `script-src 'self' 'nonce-…' blob: data: https://…` (no unsafe-*)
- `/privacy` and `/about` → same nonce-only script-src; 200 OK; every `<script>` tag in the rendered HTML carries the correct nonce (0 unnonced scripts)
- `/login` → still `script-src 'self' 'nonce-…' 'unsafe-inline' 'unsafe-eval' …` (relaxed as intended)

**Suite still green:** 298/298 tests, lint clean, production build succeeded.

**Iframe-isolation infrastructure landed 2026-05-15:** New route [/razorpay-checkout](app/razorpay-checkout/page.tsx) is the *only* place in the app that loads `checkout.razorpay.com/v1/checkout.js`. Parent pages embed it as an iframe and exchange `{type, …}` messages defined in [lib/razorpay-checkout-protocol.ts](lib/razorpay-checkout-protocol.ts). React wrapper [components/RazorpayCheckoutFrame.tsx](components/RazorpayCheckoutFrame.tsx) gives consumers a `useRazorpayCheckout()` hook with a Promise-shaped `open(options)` API and a `<Frame />` overlay component that mounts on demand.

**Migrated as pilot:** [components/HostingRenewalModal.tsx](components/HostingRenewalModal.tsx) — direct `new window.Razorpay(options).open()` replaced with `await razorpay.open(options)`. The handler/dismiss closures are now a linear try/catch instead of nested callbacks. 340/340 tests, lint + tsc clean, production build succeeded (62 static pages, up from 61 — the new iframe page).

**Migrated additionally 2026-05-15:** [components/HostingUpgradeModal.tsx](components/HostingUpgradeModal.tsx) — happened as part of the MEDIUM-3 decomposition pass. Now uses `useRazorpayCheckout()`.

**Migrated 2026-05-16 (the remaining three direct-checkout.js consumers):**
- [app/checkout/page.tsx](app/checkout/page.tsx) — main checkout (order + subscription paths). The sequential order→subscription handler chain became a linear `await razorpay.open(orderOptions); await razorpay.open(subOptions); verifyPayment(...)`.
- [app/checkout/guest/page.tsx](app/checkout/guest/page.tsx) — guest checkout (single order path).
- [app/dashboard/invoices/page.tsx](app/dashboard/invoices/page.tsx) — invoice repayment. Dropped `next/script` Razorpay tag.

**CSP allowlist inverted 2026-05-16 ([middleware.ts](middleware.ts)):** strict CSP is now the default. The list is now `RELAXED_CSP_PAGE_PATHS` (6 entries): `/razorpay-checkout` (the iframe) plus `/login`, `/register`, `/forgot-password`, `/reset-password`, `/contact` (Google reCAPTCHA v2, which also requires unsafe-eval). Every other page — dashboard, admin, cart, /checkout (now safe because it delegates to the iframe), payment-success, domains/*, home, legal pages — and every API route runs with nonce-only `script-src`. Migrating reCAPTCHA behind a similar iframe shim would be the next step to make those 5 strict too; out of scope for CRITICAL-4.

**Suite green:** 340/340 tests, lint clean (0 errors), tsc clean, production build succeeded.

**Unchanged in this pass:**
- `style-src 'unsafe-inline'` still required by Tailwind's utility classes and Next.js's style injection. Switching to nonce-only style-src would require either a Next.js style hash plan or a CSS-modules migration; out of scope.
- The strict-page allowlist is still conservative. `/payment-success`, `/hosting`, `/domains/search` could likely move onto the strict list after a manual audit — track separately from CRITICAL-4.

---

## 3. Architectural Issues

### ~~[HIGH-1] Monolithic service wrappers~~ — RESOLVED 2026-05-14

| File | LOC (before) | LOC (after barrel) | Status |
|---|---|---|---|
| [lib/resellerclub.ts](lib/resellerclub.ts) | 2,452 | 95 | ~~Split~~ ✅ |
| [lib/directadmin.ts](lib/directadmin.ts) | 1,193 | 108 | ~~Split~~ ✅ |
| [lib/zohobooks.ts](lib/zohobooks.ts) | 1,192 | 422 | ~~Split~~ ✅ |
| [lib/auth-config.ts](lib/auth-config.ts) | 863 | 55 | ~~Split~~ ✅ |

**resellerclub.ts split (2026-05-14):** The 2,452-line single class was split into 5 topical submodules + a shared client. The old [lib/resellerclub.ts](lib/resellerclub.ts) is now a 95-line backwards-compatible barrel exposing the same `ResellerClubAPI` class surface, so the 13 call sites across `app/`, `lib/`, and `lib/payment-services/` did not need to change.

```
lib/resellerclub/
  client.ts            85 LOC   shared axios instance + env validation + interceptors
  search.ts           835 LOC   getDomainPricing, getTLDPricing, searchDomain,
                                searchDomainWithTlds, getResellerPricingForTLD, getResellerDetails
  customers.ts        663 LOC   getCustomerId, createCustomer, modifyCustomer, modifyContact,
                                createContact, getOrCreateCustomerAndContact, getCustomerDetails,
                                getCustomerDomains
  registration.ts     364 LOC   deleteDomainOrder, registerDomain, getDomainDetails,
                                getDomainExpiry, getDomainOrderId
  dns.ts              393 LOC   activateDNSManagement, getDNSRecords, addDNSRecord,
                                updateDNSRecord, deleteDNSRecord, setDefaultNameservers,
                                setCustomNameservers, getNameservers
  renewal-transfer.ts 125 LOC   getRenewalPricing, renewDomain, transferDomain
```

Verified on main: 298/298 tests green, `npm run lint` clean, `npm run build` succeeded. No call-site change required (zero files in `app/`, `tests/`, `models/` modified). Each method moved verbatim — no logic changes.

**The other three large files were split on 2026-05-14:**

```
lib/directadmin/    (1,193 → 108 barrel)
  client.ts        359  LOC  shared HTTP client: state (rate limit, circuit breaker,
                              request queue), executeRequest, validators, error class,
                              auth getter, constants (NAMESERVERS, KNOWN_PACKAGES)
  packages.ts      148  LOC  listPackages, getPackageDetails, createPackage
  users.ts         502  LOC  createUser, getUserConfig, getUserUsage, getUserDomains,
                              changePackage, suspendUser, unsuspendUser, deleteUser,
                              listUsers, getAllUserUsage, getOneTimeLoginUrl, domainExists
  dns.ts           177  LOC  getDNSRecords, deleteDNSRecords, addDNSRecord,
                              updateDNSNameservers
  server.ts         82  LOC  getServerInfo, listResellers, getLicenseInfo

lib/auth-config/    (863 → 55 barrel)
  helpers.ts        48  LOC  GoogleProfile/GithubProfile types, extractSocialName,
                              SOCIAL_PROVIDERS, useSecureCookies
  providers.ts     221  LOC  the providers[] array (Google, Facebook, GitHub, Credentials
                              with all its TOTP + bcrypt + session-activity wiring)
  callbacks.ts     541  LOC  the callbacks { signIn, jwt, session, redirect } object
  cookies.ts        46  LOC  the cookies {} object

lib/zohobooks/      (1,192 → 422 barrel)
  contacts.ts      286  LOC  contact-CRUD: getContactByEmail/Name, createContact,
                              updateContactDetails, getContactPersons, updateContactPerson,
                              updateContactToConsumer
  invoices.ts      466  LOC  createInvoice, getInvoicesByEmail, getInvoicePdf,
                              getAllInvoices, getInvoiceById, applyPaymentToInvoice,
                              getInvoicesByReferenceNumber
  recurring.ts     149  LOC  createRecurringInvoice
  credit-notes.ts   85  LOC  createCreditNote
  org.ts            35  LOC  getOrganizationDetails
```

**Judgement calls on the trickier shapes (worth knowing for future maintainers):**

- **directadmin.ts** had module-level shared state baked into static class fields (rate-limit timer, circuit breaker, request queue). State + `executeRequest` moved to file-scoped `let` in `client.ts`. The barrel's `DirectAdminService` class re-exports `NAMESERVERS` / `KNOWN_PACKAGES` as static fields so `DirectAdminService.NAMESERVERS` still works for the 15 call sites that use it.

- **zohobooks.ts** is a **singleton with instance state** (`accessToken`, `tokenExpiry`, `config`, `baseUrl`) — not a static-method class like resellerclub/directadmin. So the topical files take `self: ZohoBooksService` as their first arg and reach the singleton state via `_`-prefixed `@internal` accessors on the class (`_baseUrl`, `_orgId`, `_getHeaders()`, `_idempotentRetry`, etc.). Public class methods are 1-line `await import('./zohobooks/<topic>').then(m => m.fn(this, ...))` delegates — dynamic imports break the type cycle (topical files `import type` the class for the `self` param). Slightly more boilerplate than the other splits, but no public-API change so the 10 importers (payment-services, webhook route, admin endpoints, invoice download/pay routes) didn't move.

- **auth-config.ts** is a config object so the split was straightforward — sections lifted out wholesale.

**Verified on main:** 340/340 tests, lint clean, `tsc --noEmit` clean, production build succeeded. No call site outside the three subtrees was modified.

---

### ~~[HIGH-2] Routes carrying state-machine logic~~ — RESOLVED 2026-05-14
| Route | LOC (before) | LOC (after) | Shrinkage |
|---|---|---|---|
| [app/api/payments/verify/route.ts](app/api/payments/verify/route.ts) | 635 | 256 | -60% |
| [app/api/webhooks/razorpay/route.ts](app/api/webhooks/razorpay/route.ts) | 430 | 103 | -76% |

**New modules under [lib/payment-services/](lib/payment-services/) (verbatim extraction — no logic changes):**

- [verification.ts](lib/payment-services/verification.ts) (176 LOC) — `verifyRazorpayPayment()` (signature → `getPaymentDetails` → status check → order/subscription mismatch checks) and `validateOrderAmountMatchesRazorpay()` (anti-underpayment fraud).
- [order-creator.ts](lib/payment-services/order-creator.ts) (241 LOC) — `validateNoRestrictedDomains()` (pre-flight check for unsupported TLDs) and `createCompletedOrder()` (orderId/paymentId generation, type inference, provisioning, atomic Order + Payment save inside a Mongo transaction).
- [verification-error.ts](lib/payment-services/verification-error.ts) (214 LOC) — `handleVerificationError()` (fallback-order creation for post-payment provisioning failures + HTTP error-message + status-code mapping).
- [webhook-handlers.ts](lib/payment-services/webhook-handlers.ts) (336 LOC) — `handleSubscriptionCharged()` (9-step renewal flow: plan lookup → RenewalPayment insert → atomic claim → hosting reactivation/extension → trial-to-paid transition → Order audit record → fire-and-forget Zoho sync) and `handleSubscriptionFailed()` (immediate expiry + DA suspend).

**Routes are now orchestration only.** `payments/verify` is 256 LOC because of the legitimately route-shaped success-response builder (~50 LOC of human-readable message tier construction) — closer to the audit's "30–80" target only if response shaping is extracted too, but that's a stylistic judgement call rather than a structural problem. `webhooks/razorpay` is exactly the audit's target: signature → age gate → redis nonce → dispatch → 200, all within 103 LOC.

**Verified on main: 298/298 tests pass, lint clean, production build succeeded.** No call-site outside the two routes changed. Method bodies extracted verbatim — no behavioural changes — so the existing test surface is sufficient to catch regression.

---

### ~~[HIGH-3] No API versioning~~ — RESOLVED 2026-05-16 (v1 routing infra + every internal caller migrated)
Foundational `/api/v1/` alias is now in place. Every existing `/api/<path>` endpoint is also reachable at `/api/v1/<path>` and produces identical behaviour (same auth gates, same handler).

**Implementation:**
- [next.config.js](next.config.js) — `rewrites()` maps `/api/v1/:path*` → `/api/:path*`. The rewrite happens at the routing layer; the URL the client sees is unchanged.
- [middleware.ts](middleware.ts) — added a `classificationPath` that strips the `/api/v1/` prefix and is used only by the admin/public API prefix checks (`isAdminApi`, `isPublicApi`). The original `pathname` is still used for logging so audit trails can distinguish v1-specific traffic. Middleware runs *before* the rewrite, so without this normalization `/api/v1/admin/*` would have bypassed the admin auth gate — that hole is now closed.

**Smoke-tested live (2026-05-14, standalone build on port 3457):**
- `GET /api/health` → 200 `{status:"ok"}`
- `GET /api/v1/health` → 200 `{status:"ok"}` (identical body)
- `GET /api/admin/users` (no auth) → 401 `{error:"Unauthorized"}`
- `GET /api/v1/admin/users` (no auth) → 401 `{error:"Unauthorized"}` — confirms no bypass via the versioned path

**Suite still green:** 298/298 tests pass; lint clean; production build succeeded.

**Server-side callers migrated 2026-05-16:** 9 internal `${NEXTAUTH_URL}/api/<path>` and `fetch('/api/<path>')` call-sites in server-only modules were switched to `/api/v1/<path>`:
- [lib/client-logger.ts](lib/client-logger.ts), [lib/logger.ts](lib/logger.ts), [lib/server-logger.ts](lib/server-logger.ts) — log shippers (`/api/v1/log`, `/api/v1/admin/log-error`)
- [lib/payment-services/webhook-handlers.ts](lib/payment-services/webhook-handlers.ts) — Cloud Tasks dispatch to `/api/v1/workers/sync-zoho-invoice`
- [app/api/user/dashboard/route.ts](app/api/user/dashboard/route.ts) — `/api/v1/workers/sync-hosting-status`
- [app/api/cron/daily-scheduler/route.ts](app/api/cron/daily-scheduler/route.ts) (×2) — `/api/v1/workers/process-service-expiry`, `/api/v1/workers/check-domain-watch`
- [app/api/cron/check-hosting-expiry/route.ts](app/api/cron/check-hosting-expiry/route.ts) — `/api/v1/workers/process-hosting-expiry`
- [app/api/user/settings/change-email/route.ts](app/api/user/settings/change-email/route.ts) — user-facing email-verification link

340/340 tests still green; 0 lint errors. The rewrite layer makes both paths functionally identical, so the migration is no-op behaviourally — but server-issued URLs (Cloud Tasks targets, email links, log endpoints) now carry the versioned prefix that v2 cutover work will be able to opt out of cleanly.

**Client-side callers migrated 2026-05-16:** 205 references across 63 files in `app/` (excl. `app/api/`), `components/`, `hooks/`, `store/` — `fetch('/api/<path>')`, `axios.X('/api/<path>')`, `useSWR('/api/<path>', …)`, and bare URL-string literals — were rewritten to `/api/v1/<path>` with a single perl pass:
```
perl -i -pe 's|([\x27\x22\x60])/api/(?!v1/)|$1/api/v1/|g' <client-tree-files>
```
Top hotspots: `app/admin/settings/page.tsx` (22), `app/admin/system-settings/page.tsx` (13), `app/dashboard/dns-management/page.tsx` (12), `app/admin/pending-domains/page.tsx` (10), `app/admin/dns-management/page.tsx` (10).

340/340 tests still pass; 0 lint errors; production build succeeded.

**Excluded from migration on purpose:**
- `app/api/**` — audit-log metadata strings (`resource: "/api/admin/backup"`) live alongside the canonical handler and document the unversioned source-of-truth path; migrating would just rename log fields without behavioural change.
- [lib/session-activity.ts](lib/session-activity.ts):`requiresSessionRotation` — pattern matcher, currently dead code. If ever wired up, it must accept both prefixes (or strip `/v1/` before matching).
- [lib/security/headers.ts](lib/security/headers.ts):`startsWith("/api/webhooks/")` — pattern matcher for CORS-skip; only hit by third-party callers using the configured `/api/webhooks/<vendor>` URL.

**Pending future work:**
- No `/api/v2/` exists yet, and won't until a breaking change is needed. The infrastructure is in place so introducing v2 is just adding a sibling route handler.
- Treat `/api/v1/` semantics as stable from this point forward. Any future change that would break a v1 caller (response shape change, removed fields, changed status codes) must instead live under `/api/v2/`.

---

### ~~[HIGH-4] No service / repository layer~~ — PARTIALLY RESOLVED 2026-05-14 (foundation + 9 model services + User wider adoption + admin CRUD tightening + lib/payment-services folded into lib/services/payment)
**Footprint measured:** 107 route files, ~269 distinct Mongoose-model operations across the codebase. Top models by op count: User (93), Order (67), Hosting (28), HostingPlan (25), PendingDomain (16), Domain (12), SupportTicket (11), PendingHosting (8), DomainWatch (7).

**Foundation laid for the rest:** Added [lib/services/](lib/services/) (parallel to the existing [lib/payment-services/](lib/payment-services/)). The pattern mirrors the audit's referenced "half-formed" pattern — domain-specific use-case functions, not a generic repository abstraction.

**User done as the concrete first model:**

[lib/services/users.ts](lib/services/users.ts) — exports:
- Reads: `getUserById`, `getUserByIdSafe` (password-stripped, the default for client returns), `getUserByEmail`, `findUserRoleById` (lightweight role lookup for admin-guards), `countAdmins`, `countUsers`, `listUsers` (paginated admin listing with sane default projection)
- Writes: `updateUserRole` (whitelist-locked findByIdAndUpdate to prevent mass-assignment), `softDeleteUser` (sets `isActive=false`, `isDeleted=true`, `deletedAt`, invalidates sessions), `permanentDeleteUser` (snapshots `userName`/`userEmail` onto historical Orders before dropping the user), `applyUserPatch` (admin field update with session-invalidation on `isActive: true → false`)

**Migrations completed:** the two highest-User-concentration route files:
- [app/api/admin/users/route.ts](app/api/admin/users/route.ts) — GET/PUT/DELETE — was 7 direct User calls → 0. Now uses `listUsers`, `findUserRoleById`, `updateUserRole`, `softDeleteUser`, `permanentDeleteUser`.
- [app/api/admin/users/[id]/route.ts](app/api/admin/users/[id]/route.ts) — GET/PUT/DELETE — was 5 direct User calls → 0. Now uses `getUserByIdSafe`, `getUserById`, `countAdmins`, `applyUserPatch`, `softDeleteUser`. The 30-line in-route soft-delete + invalidate-sessions logic is now a 1-liner.

The user-permanent-deletion "snapshot orders before deletion" logic — previously hand-inlined in the admin route — is now centralized inside `permanentDeleteUser` where any future caller benefits automatically.

**Verified on main:** 340/340 tests, lint clean, tsc clean, production build succeeded.

**Order service added 2026-05-16:** [lib/services/orders.ts](lib/services/orders.ts) — exports:
- Reads: `getOrderById`, `getOrderByOrderId`, `findUserOrder` (handles both `_id` and `orderId`, filters soft-deleted, ownership-gated in one query), `listOrdersForAdmin` (paginated + auto-applies the `userId`-snapshot fallback when the user has been hard-deleted), `listOrdersForUser`
- Writes: `softDeleteOrder`, `permanentlyDeleteOrder`, `unarchiveOrder` (each returns the affected document so callers can log the order ID)

**Routes migrated:** [app/api/admin/orders/route.ts](app/api/admin/orders/route.ts), [app/api/admin/orders/[id]/route.ts](app/api/admin/orders/[id]/route.ts), [app/api/user/orders/[id]/route.ts](app/api/user/orders/[id]/route.ts), [app/api/orders/route.ts](app/api/orders/route.ts). The 25-line populate-and-snapshot-fallback block in admin/orders is now centralised; the route shrank from ~99 lines to ~46.

**Hosting service added 2026-05-16:** [lib/services/hostings.ts](lib/services/hostings.ts) — exports:
- Reads: `getHostingById`, `findUserHosting` (the recurring `{ userId, domainName }` pattern with `domainName` optional), `userHasAnyHosting` (eligibility shortcut that avoids hauling the whole doc), `listHostingsForUser`

**Sites migrated:** [lib/payment-services/webhook-handlers.ts](lib/payment-services/webhook-handlers.ts) (3 of 3 Hosting accesses), [app/api/user/hosting/check-eligibility/route.ts](app/api/user/hosting/check-eligibility/route.ts) (2 of 2). Also fixed a latent type-error caught during migration: `hosting.next_action_at = null` → `undefined` (the field is typed `Date | undefined`; the null was hidden behind the looser Mongoose Document type).

**Zoho-invoice idempotency lease extracted 2026-05-16:** added to [lib/services/orders.ts](lib/services/orders.ts) — `claimOrderForZohoInvoice`, `recordZohoInvoiceForOrder` (handles the E11000 invoice-number collision internally), `releaseZohoInvoiceClaim`, `markZohoInvoiceCreationFailed`, `getOrderByRazorpayPaymentId`, `listStuckZohoInvoiceOrders`. The claim accepts opts `staleClaimAfterMs` (idempotency recovery), `allowNull` (zoho-retry tolerates legacy nulls), and `allowFailed` (zoho-retry picks up `creation_failed` rows).

**Sites migrated:** [lib/payment-services/post-tasks.ts](lib/payment-services/post-tasks.ts) (full Zoho-invoice creation path now a 3-call sequence), [lib/payment-services/idempotency.ts](lib/payment-services/idempotency.ts) (drop direct Order import; lease + record + release helpers handle all transitions), [lib/zoho-invoice-retry.ts](lib/zoho-invoice-retry.ts) (entire file now zero direct Order references — `findStuckOrders` became `listStuckZohoInvoiceOrders`). The three files used to repeat the same `findOneAndUpdate` lease pattern with subtly-different `$or` arms — diverged by accident as the codebase grew. The service-level helper guarantees the same invariants everywhere, and adding a new state (e.g. `"creation_failed_permanent"`) is now a single-file change.

**HostingPlan service added 2026-05-16:** [lib/services/hosting-plans.ts](lib/services/hosting-plans.ts) — exports `getPlanByPlanId(planId, { activeOnly? })`, `getPlanById(id)`, `listActivePlans({ sort? })`, `getPlanByRazorpaySubscriptionPlanId(razorpayPlanId)` (used by the `subscription.charged` webhook to map a Razorpay plan back to its local catalogue entry).

**Sites migrated:** [app/api/user/hosting/upgrade/route.ts](app/api/user/hosting/upgrade/route.ts) + [/upgrade-info](app/api/user/hosting/upgrade-info/route.ts), [/renew](app/api/user/hosting/renew/route.ts) + [/renew-info](app/api/user/hosting/renew-info/route.ts), [/trial-eligibility](app/api/user/hosting/trial-eligibility/route.ts); [lib/payment-services/webhook-handlers.ts](lib/payment-services/webhook-handlers.ts), [/upgrade.ts](lib/payment-services/upgrade.ts), [/provisioner.ts](lib/payment-services/provisioner.ts), [/idempotency.ts](lib/payment-services/idempotency.ts); [app/api/workers/process-hosting-expiry/route.ts](app/api/workers/process-hosting-expiry/route.ts), [/sync-zoho-invoice/route.ts](app/api/workers/sync-zoho-invoice/route.ts). 12 of the 14 read sites migrated; the two admin CRUD routes (`/admin/hosting/packages`, `/admin/hosting/test-plan`) retain direct model access because their create/update/upsert logic is route-specific and doesn't generalise cleanly.

**Verified on main 2026-05-16:** 340/340 tests, lint clean, tsc clean, production build succeeded.

**Verified on main 2026-05-16:** 340/340 tests, lint clean, tsc clean, production build succeeded.

**PendingDomain service added 2026-05-16:** [lib/services/pending-domains.ts](lib/services/pending-domains.ts) — exports `getPendingDomainById(id, { populateUser? })` (handles the legacy raw-string-`_id` / `ObjectId` dual-lookup in a single helper), `getPendingDomainByName`, `listActivePendingDomainsForUser` (filters `isArchived`), `listAllPendingDomainNames` (lean projection used by admin domain-index pages).

**Sites migrated:** [app/api/user/domains/route.ts](app/api/user/domains/route.ts) and [app/api/user/dashboard/route.ts](app/api/user/dashboard/route.ts) (both use the `listActivePendingDomainsForUser` helper); [app/api/admin/pending-domains/[id]/route.ts](app/api/admin/pending-domains/[id]/route.ts) (3 of 3 findOne sites — the GET/PUT/DELETE handlers now share the dual-id helper; deleteOne + findOneAndUpdate inside the DELETE handler retain direct model access since the surrounding orchestration is route-specific); [app/api/admin/pending-domains/route.ts](app/api/admin/pending-domains/route.ts) (uniqueness check); [app/api/admin/domains/route.ts](app/api/admin/domains/route.ts) (admin domain index uses the lean-names helper).

**Domain service added 2026-05-16:** [lib/services/domains.ts](lib/services/domains.ts) — slim by design: only the two patterns that actually repeat (`listDomainsForUser` for dashboard/index/DNS-manager views, `getDomainById` for test-automation routes). The rest of Domain access — provisioner inserts, cron lease updates, verification claims, admin cleanup deletes — is bespoke business logic that doesn't share shape across callers and stays as direct model access.

**Sites migrated:** [app/api/user/domains/route.ts](app/api/user/domains/route.ts), [app/api/user/dashboard/route.ts](app/api/user/dashboard/route.ts), [app/api/user/domains/dns/route.ts](app/api/user/domains/dns/route.ts) (the three `Domain.find({ userId })` callers), [app/api/test/automation/status/route.ts](app/api/test/automation/status/route.ts), [app/api/test/automation/trigger/route.ts](app/api/test/automation/trigger/route.ts) (the two `findById` callers).

**SupportTicket service added 2026-05-16:** [lib/services/support-tickets.ts](lib/services/support-tickets.ts) — `findUserTicket` + `findUserTicketLean` (the user-scoped fetches bake the `{ _id, userId }` ownership filter so a missing-userId foot-gun can't surface a foreign ticket), `listTicketsForUser`, `listTicketsForUserSummary` (consolidates the user-list `messageCount`/`lastMessage` projection), `getTicketById` + `getTicketByIdLean`, `listTicketsForAdmin` (paginated with the same summary-row shaping), `countOpenTickets` (encapsulates the `{ status: { $in: ['open','in_progress'] } }` definition for system-health). The user-side ticket-create and admin status/priority `findByIdAndUpdate` stay as direct model access — each has route-specific validation (attachments, status whitelist) and the service wrapper would just thinly forward.

**Sites migrated:** [app/api/user/support/route.ts](app/api/user/support/route.ts) (list), [app/api/user/support/[id]/route.ts](app/api/user/support/[id]/route.ts) (3 of 3 findOne sites — the unused `SupportTicket` direct import dropped entirely), [app/api/admin/support-tickets/route.ts](app/api/admin/support-tickets/route.ts) (full rewrite — the 25-line list+map+pagination collapsed into a single service call), [app/api/admin/support-tickets/[id]/route.ts](app/api/admin/support-tickets/[id]/route.ts) (2 findById sites), [app/api/admin/system-health/route.ts](app/api/admin/system-health/route.ts) (open-tickets count).

**DomainWatch service added 2026-05-16:** [lib/services/domain-watches.ts](lib/services/domain-watches.ts) — user side: `listWatchesForUser`, `countWatchesForUser` (used by the per-user limit check), `upsertUserWatch` (idempotent add via the unique `(userId, domainName)` index), `removeUserWatch` (returns whether anything was actually deleted so the route can 404 cleanly). Cron side: `listWatchesForCron(batchSize)` (lean + `userId` populated for the notification email), `recordWatchCheck(id, status)`, `removeWatchById(id)`.

**Sites migrated:** [app/api/user/domains/watch/route.ts](app/api/user/domains/watch/route.ts) (full rewrite — every method's direct DomainWatch call replaced), [app/api/workers/check-domain-watch/route.ts](app/api/workers/check-domain-watch/route.ts) (3 of 3 sites). Zero remaining `DomainWatch.X(...)` calls outside the model file itself.

**Verified on main 2026-05-16:** 340/340 tests, lint clean, tsc clean, production build succeeded.

**User-model wider adoption 2026-05-17:** Migrated the dominant `User.findById(token.id).select("-password")` pattern across 24 sites (admin/user routes that resolve a NextAuth token to a user — admin/pending-domains, admin/tld-pricing/cache, admin/settings, admin/invoices, user/dashboard, user/domains, auth/me, etc.) to `getUserByIdSafe`. A second pass replaced plain `User.findById(X)` (no chained method) with `getUserById(X)` across ~12 sites in workers, webhooks, and lib/admin-auth. ~20 files lost their now-unused `import User from "@/models/User"`. Total `User.X(...)` calls outside the service dropped from 103 → 73. Remaining callers are auth-internal (`lib/auth*.ts`, `lib/session-activity.ts`, `lib/auth-config/*`) where the password hash is intentionally needed, and a handful of `User.findOne({ email })` / `User.updateOne(...)` sites that need bespoke service helpers — kept as raw access until the surrounding code is next touched.

**HostingPlan admin CRUD tightening 2026-05-17:** Added `getPlanByPlanIdLean`, `setPlanActive(planId, isActive)`, and `upsertPlanByPlanId(planId, data)` to [lib/services/hosting-plans.ts](lib/services/hosting-plans.ts). The test-plan toggle route ([app/api/admin/hosting/test-plan/route.ts](app/api/admin/hosting/test-plan/route.ts)) — previously a mix of inline `findOne().lean()`, `updateOne`, and `findOneAndUpdate({ upsert: true })` calls — now reads as three service calls + Settings/Razorpay orchestration. Admin packages CRUD ([app/api/admin/hosting/packages/route.ts](app/api/admin/hosting/packages/route.ts)) stays direct: its DA-sync logic and partial-update orchestration is intentionally route-specific.

**lib/payment-services/ → lib/services/payment/ 2026-05-17:** Folded the 10-file orchestration directory under `lib/services/` for consistency. Every import path updated via a single perl pass (`@/lib/payment-services/` → `@/lib/services/payment/`). No behavioural change — the move was purely structural.

**Verified on main 2026-05-17:** 340/340 tests, tsc clean, production build succeeded.

**Pending — incremental adoption:**
1. **User model migration:** 12 done, ~81 sites remaining across `app/api/**` and `lib/**`. The service surface is in place; routes adopt as they're next touched.
2. **Order service migration:** 4 routes migrated; the heavier work lives in `lib/payment-services/` (idempotency, post-tasks, zoho-invoice-retry — 5–7 ops each, with atomic `findOneAndUpdate` lease patterns that warrant their own use-case-named service helpers).
3. **Hosting service migration:** 5 of 28 ops migrated. Bigger uses (`Hosting.find` + `deleteMany` in admin actions, `findOneAndUpdate` lease in daily-scheduler) need their own use-case wrappers — out of scope for this pass.
4. **HostingPlan, PendingDomain, Domain, SupportTicket, etc.** — smaller but worth their own modules.
5. The existing [lib/payment-services/](lib/payment-services/) should probably move under [lib/services/](lib/services/) for consistency — left in place this pass to avoid touching all the verification/order-creator/webhook-handlers files yet again.

**Migration playbook for future routes:**
- Identify the Mongoose calls in the file.
- Map each to a service function (extend the service module with a use-case-named function if no existing one fits — avoid creating thin pass-throughs that just wrap a single Mongoose method).
- Replace the route-level `await connectDB()` calls when the only reason they existed was the Mongoose access — services call it themselves.
- Keep auth, validation, response shaping in the route. Push state-changing logic and queries into the service.

---

### ~~[HIGH-5] `Pending*` collections risk orphans~~ — RESOLVED 2026-05-14
Added [app/api/cron/pending-sweeper/route.ts](app/api/cron/pending-sweeper/route.ts) — a daily sweeper that scans both `PendingDomain` (skipping `isArchived`) and `PendingHosting` for records older than 24h in non-terminal statuses (`pending` / `processing` / `failed`).

**Severity tiers in the admin digest:**
- WARN — 24h to 7d old
- CRITICAL — older than 7d, OR `verificationAttempts > 5` on `PendingDomain`

**Alert pattern:** Single digest email to `ADMIN_EMAIL` per run via `EmailService.sendAdminNotification`, mirroring the existing [check-unprovisioned](app/api/cron/check-unprovisioned/route.ts) cron (same auth, same logger, same email helper, same response wrappers). Records are sorted CRITICAL-first, then by age descending.

**Auth:** `x-cron-secret` header (timing-safe) OR admin session.

**Dedupe strategy:** Run daily, not hourly. One digest per day is the dedupe — admin sees the same record listed each morning until they resolve it. Avoids needing a `lastAlertedAt` field on the models.

**Deliberately *not* implemented:** Auto-archive / TTL deletion of >30d records. Silently deleting paid-but-unprovisioned customer state would mask exactly the failure mode this cron is meant to surface. Admin archives manually via the existing UI after resolution.

**Cloud Scheduler setup** (needs to be run during the deploy):

```
gcloud scheduler jobs create http pending-sweeper \
  --schedule="0 9 * * *" --time-zone="Asia/Kolkata" \
  --uri="https://app.anutech.in/api/cron/pending-sweeper" \
  --http-method=GET \
  --headers="x-cron-secret=$CRON_SECRET"
```

09:00 IST puts the digest in admin's inbox before the business day starts.

---

### ~~[HIGH-6] Three overlapping security files~~ — RESOLVED 2026-05-15
Consolidated into [lib/security/](lib/security/):

- **[lib/security/validator.ts](lib/security/validator.ts)** (390 LOC) — `SecurityValidator` class: malicious-pattern detection, file-upload validation, input sanitization, email/password validation, CSRF (Origin/Referer check).
- **[lib/security/headers.ts](lib/security/headers.ts)** (147 LOC) — `addSecurityHeaders`, `addCorsHeaders`, `buildPreflightResponse`. Per-route strict-CSP / relaxed-CSP gating.

Old top-level files retained as thin backwards-compat barrels so the ~10 existing import sites don't need to change:

- [lib/security.ts](lib/security.ts) — re-exports `SecurityValidator`.
- [lib/security-headers.ts](lib/security-headers.ts) — re-exports `addSecurityHeaders` / `addCorsHeaders` / `buildPreflightResponse`.

**Deleted as dead code:** the old `lib/security-middleware.ts` had **zero importers** (verified by grep across `app/`, `lib/`, `tests/`, `middleware.ts`). The audit-recommended `middleware.ts` submodule never landed there. Removed rather than ported.

Audit-recommended sub-files I did NOT create:
- `csrf.ts` — CSRF lives as `SecurityValidator.validateCSRF` and only has one caller (middleware.ts). Splitting it out would add a file for no readability gain.
- `rate-limit.ts` — already exists as the top-level [lib/rate-limit.ts](lib/rate-limit.ts); not moved to avoid breaking 12+ import sites for a cosmetic relocation.

**Verified:** 340/340 tests, lint clean (errors), `tsc --noEmit` clean.

---

## 4. Code Quality

### ~~[MEDIUM-1] 540 `any` types~~ — PARTIALLY RESOLVED 2026-05-17 (ResellerClub + Zoho Books + DirectAdmin external-API wrappers fully typed; 845 → 682 sitewide)
Across `lib/`, `app/`, `components/`. TypeScript was doing far less work than it could. Worst offenders were the external API wrappers (ResellerClub / DirectAdmin responses).

**First pass — ResellerClub wrappers (audit-recommended starting point):**

[lib/resellerclub/types.ts](lib/resellerclub/types.ts) — new shared type file: `RcTldPricing`, `RcPricingResponse`, `RcDomainPricing`, `RcTldPricingPair` (the `getTLDPricing` shape — `customer` + `reseller` blocks + tld), `RcTldPricingDetail` (the extended shape `PricingService.getTLDPricing` returns with pre-extracted `price` / `resellerPrice` / `currency` / `registrationPeriod`), `RcAvailabilityEntry`, `RcAvailabilityResponse`, `RcAvailabilitySearchParams`, `RcDnsRecord`. The records keep open index signatures (`[k: string]: unknown`) so future upstream fields don't surface as type errors.

**Migrated:**
- [lib/resellerclub/search.ts](lib/resellerclub/search.ts) — 11 → 0 anys. Strict types on `getDomainPricing`, `getTLDPricing`, `searchDomain`'s Object.entries iteration (no more `data as any` casts), `getResellerDetails` (added the actually-used fields `billingmode`, `resellerstatus`, `totalreceipts` and tightened the index signature to `string | undefined` so callers that read `.billingmode` as a string still compile cleanly). The `catch (error: any)` was rewritten using `AxiosError` instanceof narrowing.
- [lib/resellerclub/dns.ts](lib/resellerclub/dns.ts) — 14 → 0 anys. Added a tiny `axiosStatus(err: unknown)` helper to narrow catch errors, typed the DNS-record iteration via `RcDnsRecord`, dropped the 5 `(record as any)` casts on the dynamically-keyed record reads.
- [lib/resellerclub-dns-specific.ts](lib/resellerclub-dns-specific.ts) — 23 → 0 anys. Same `axiosStatus` helper + bulk perl pass over the 23 identical `catch (error: any)` / `error.response?.status === 404` patterns.

**Net:** 48 anys removed (≈6% of the 845 total). The `getDomainPricing` / `searchDomain` chain — the audit's named "highest-traffic" target — is now fully typed end-to-end.

**Second pass — Zoho Books wrappers (2026-05-17):** Same approach, applied to the Zoho Books module:

[lib/zohobooks/types.ts](lib/zohobooks/types.ts) — new shared types file: `ZohoApiEnvelope` (the `{ code, message }` wrapper every Zoho response shares), specific response wrappers for contacts/invoices/credit-notes/recurring/organization (`ZohoContactsListResponse`, `ZohoInvoiceResponse`, etc.), record types (`ZohoContact`, `ZohoContactPerson`, `ZohoLineItem`, `ZohoCreditNote`, `ZohoRecurringInvoice`, `ZohoOrganization`, `ZohoBillingAddress`), app-side input shapes (`ZohoUserInput`, `ZohoOrderInput`, `ZohoOrderItemInput`), and an `unwrapZohoError(err: unknown)` helper that replaces the `(error as any).response?.data` foot-gun. The existing `ZohoInvoice` from [lib/types.ts](lib/types.ts) is re-exported through the types module so a single canonical definition stays in place.

**Migrated:**
- [lib/zohobooks.ts](lib/zohobooks.ts) — 28 → 0 anys. Every public delegate method now has a concrete return type (`ZohoContact | null`, `ZohoInvoice[]`, etc.) instead of `any`. The internal `idempotentRetry` and `getHeaders` helpers — previously `lastError: any` + `headers: any` — now use `unknown` with narrowing via the new helper. `ZohoError.details` was widened from `any` to `unknown`.
- [lib/zohobooks/invoices.ts](lib/zohobooks/invoices.ts) — 25 → 0 anys. `createInvoice` / `getInvoicesByEmail` / `getAllInvoices` / `getInvoiceById` / `getInvoicesByReferenceNumber` / `applyPaymentToInvoice` / `getInvoicePdf` all switched from `Promise<any>` to typed returns. Eight `catch (X: any)` blocks rewritten via `unwrapZohoError`.
- [lib/zohobooks/contacts.ts](lib/zohobooks/contacts.ts) — 19 → 0 anys. Same pattern across `getContactByEmail` / `getContactByName` / `createContact` / `updateContactDetails` / `getContactPersons` / `updateContactPerson` / `updateContactToConsumer`.

**Net:** 72 anys removed (≈8.5% of the original 845). Combined two-pass total: **120 anys removed, 845 → 725 sitewide**.

**Downstream type ripples** caught + fixed during this pass:
- [app/api/admin/system-health/route.ts](app/api/admin/system-health/route.ts): explicit casts on `org.plan_name` / `org.trial_expiry_date` since the org response now has an `unknown`-indexed signature.
- [app/api/user/invoices/[id]/pay/route.ts](app/api/user/invoices/[id]/pay/route.ts): `invoice.balance ?? 0` since the typed `ZohoInvoice.balance` is now `number | undefined`.
- [lib/services/payment/post-tasks.ts](lib/services/payment/post-tasks.ts): `let invoice: ZohoInvoice | null` since `createInvoice` may now return null on idempotency skip.

**Verified on main 2026-05-17:** 340/340 tests, tsc clean, production build succeeded.

**Third pass — DirectAdmin + smaller Zoho submodules (2026-05-17):**

[lib/directadmin/types.ts](lib/directadmin/types.ts) — new shared types file: `DAParsedRecord` / `DAParsedResponse` (the parsed key=value form vs. the raw-string fall-through from `parseResponseData`), `DAErrorPayload` (the `error=1&text=…` shape DA returns on failure), and `unwrapDAError(err: unknown)` to narrow Axios catches into `{ status, data, code, message }`.

**Migrated (DirectAdmin):**
- [lib/directadmin/client.ts](lib/directadmin/client.ts) — 10 → 0 anys. `DirectAdminError.response` widened from `any` to `unknown`. `requestQueue: Promise<unknown>`. `parseDAError` / `parseResponseData` signatures rewritten with `unknown` input + typed records (rather than `any → any`). Five `catch (error: any)` sites in the executeRequest retry loop rewritten via `unwrapDAError`, dropping every `error.response?.status` / `error.code` access through a named helper.
- [lib/directadmin/users.ts](lib/directadmin/users.ts) — 8 → 0 anys. `getUserConfig` / `getUserUsage` / `getAllUserUsage` all switched from `Promise<any>` to `Promise<Record<string, string | undefined>>`. Six `catch ((error: any) => …)` patterns rewritten to `unknown` with `unwrapDAError` narrowing.
- [lib/directadmin/dns.ts](lib/directadmin/dns.ts) — 7 → 0 anys. Added a local `DADnsRecord` interface so `getDNSRecords` returns a real type instead of `any[]`. The BIND-zone-file fallback and URL-encoded path now share the same record shape (`key` is optional — present for API-parsed records, absent for raw-zone fallback). `deleteDNSRecords` / `addDNSRecord` / `updateDNSNameservers` switched off `Promise<any>` returns.
- [lib/directadmin/packages.ts](lib/directadmin/packages.ts) — 3 → 0 anys. `getPackageDetails` now returns `Record<string, string | undefined>`. `createPackage(options)` typed as `Record<string, string | undefined>`.
- [lib/directadmin/server.ts](lib/directadmin/server.ts) — 2 → 0 anys. `getServerInfo` / `getLicenseInfo` typed.

**Migrated (Zoho follow-ups now that `lib/zohobooks/types.ts` exists):**
- [lib/zohobooks/recurring.ts](lib/zohobooks/recurring.ts) — 5 → 0 anys. `createRecurringInvoice` signature uses the existing `ZohoUserInput` / `ZohoOrderInput` / `ZohoOrderItemInput` types. Two `catch (X: any)` blocks rewritten via `unwrapZohoError`.
- [lib/zohobooks/org.ts](lib/zohobooks/org.ts) — 3 → 0 anys. `getOrganizationDetails` returns `ZohoOrganization | null`; the `find((o: any) =>)` callback typed via the returned record type.
- [lib/zohobooks/credit-notes.ts](lib/zohobooks/credit-notes.ts) — 1 → 0 anys. Return type tightened to `ZohoCreditNote`.

**Downstream ripples** caught + fixed:
- [app/api/admin/hosting/details/route.ts](app/api/admin/hosting/details/route.ts) + [app/api/user/hosting/stats/route.ts](app/api/user/hosting/stats/route.ts) — the typed `getDNSRecords` return surfaced two `(r: any) => r.value.replace(…)` sites where `r.value` is now correctly typed as `string | undefined`; tightened with `?? ''` guards.

**Net this pass:** 43 anys removed (`725 → 682`). Combined three-pass total: **163 anys removed sitewide (845 → 682, 19% reduction)** — every external-API wrapper (ResellerClub, Zoho Books, DirectAdmin) now has a co-located types module and an `unwrap-*-Error` helper for catch-block narrowing.

**Verified on main 2026-05-17:** 340/340 tests, tsc clean, production build succeeded.

**Pending:** 682 anys remaining. Largest residual clusters:
- Admin route handlers (`app/api/admin/hosting/stats/route.ts`: 21, `app/admin/user-management/page.tsx`: 20) — request/response shapes plus `event: any` callback params on the UI side.
- Other ad-hoc admin/user-page anys throughout `app/admin/**` and `app/dashboard/**` (most files 5–10).
- Generic library helpers (`lib/audit-log.ts`: 11, `lib/rate-limit.ts`: 14) — internal types worth a dedicated pass.

---

### ~~[MEDIUM-2] 76 raw `console.*` calls in production code~~ — RESOLVED 2026-05-14
[lib/server-logger.ts](lib/server-logger.ts) now emits **structured JSON in production** — one line per log entry with `severity`, `message`, ISO `time`, plus any object-arg fields merged into the top level. Cloud Logging auto-parses these and surfaces them with the right `severity` icon, full `jsonPayload`, and searchable fields. Dev mode is unchanged: human-readable `[INFO]` / `[WARNING]` / `[ERROR]` prefix on `console.*` for readability in the terminal.

Verified live (NODE_ENV=production):
```
{"severity":"INFO","message":"hello from prod","time":"2026-05-14T07:56:01.041Z","requestId":"abc-123","userId":"u-42"}
{"severity":"WARNING","message":"warn-level event","time":"2026-05-14T07:56:01.043Z","route":"/api/x"}
```

**All `console.*` call sites migrated.** 67 swaps across two passes:

| Pass | Target | Sink |
|---|---|---|
| 1 (2026-05-14, server) | middleware.ts (2), lib/recaptcha.ts server class (2), lib/recaptcha.ts client class (3), lib/logout.ts (1), lib/storage.ts (2) | mixed (`serverLogger` for server, `logger` for client) |
| 2 (2026-05-14, client) | 26 files in app/**/*.tsx + components/*.tsx (system-settings, GoogleRecaptcha, pricing-management, user-management, error boundaries, etc.) | `logger` |

**ESLint hardened** ([.eslintrc.json](.eslintrc.json)) — `"no-console": "warn"` site-wide with **no allowlist**. The previous `allow: ["error"]` exception was dropped now that every `console.error` is migrated. Override keeps the rule off only on [lib/server-logger.ts](lib/server-logger.ts) and [lib/logger.ts](lib/logger.ts) (the legitimate output sinks). Lint surfaces **0 console warnings** site-wide.

Any remaining `console.*` text in the codebase lives only inside comments (`// console.error(...)`), JSDoc `@example` blocks (pricing-service.ts, resellerclub/search.ts), or string literals (field-encryption.ts shows users how to generate a key via `node -e "console.log(...)"`). ESLint correctly ignores all of these — they aren't call sites.

**Verified:** 340/340 tests, lint clean (0 warnings), `tsc --noEmit` clean, production build succeeded.

---

### ~~[MEDIUM-3] Massive React components~~ — RESOLVED 2026-05-15
| File | LOC (before) | LOC (after) | Sub-components | Status |
|---|---|---|---|---|
| [components/skeletons/PageSkeletons.tsx](components/skeletons/PageSkeletons.tsx) | 1,007 | 14 (barrel) | 5 in `components/skeletons/` | ~~Split~~ ✅ 2026-05-14 |
| [components/RegisterForm.tsx](components/RegisterForm.tsx) | 686 | 474 | 3 in `components/register/` | ~~Split~~ ✅ 2026-05-15 |
| [components/admin/InvoiceDiagnostics.tsx](components/admin/InvoiceDiagnostics.tsx) | 429 | 186 | 3 in `components/admin/invoice-diagnostics/` | ~~Split~~ ✅ 2026-05-15 |
| [components/HostingUpgradeModal.tsx](components/HostingUpgradeModal.tsx) | 414 | 276 | 2 in `components/hosting-upgrade/` | ~~Split~~ ✅ 2026-05-15 |

**PageSkeletons split (2026-05-14):** The 1,007-line client component file is now a 14-line backwards-compatible barrel that re-exports from 5 topical files alongside it. The 32 importing pages in `app/**` did not need to change.

```
components/skeletons/
  _primitives.tsx     77 LOC   Sk, PageHeader, TableSkeleton, FormSection (internal helpers; not re-exported)
  AdminLayout.tsx     76 LOC   AdminLayoutSkeleton, AdminTableRowsSkeleton
  AdminPages.tsx     204 LOC   9 admin per-page skeletons
  UserDashboard.tsx  489 LOC   12 user-dashboard skeletons
  PaymentPages.tsx   188 LOC   CheckoutPageSkeleton, PaymentSuccessPageSkeleton, CartPageSkeleton
  PageSkeletons.tsx   14 LOC   barrel re-export
```

**Honest bundle-size delta (build before vs after):**
| Route | Before | After | Δ First-Load JS |
|---|---|---|---|
| `/cart` | 150 kB | 149 kB | **-1 kB** |
| `/admin/hosting/packages` | 6.26 / 130 kB | 6.25 / 130 kB | -0.01 kB |
| `/payment-success` | 4.43 / 141 kB | 4.42 / 141 kB | -0.01 kB |
| All other routes (~32 importers) | — | — | unchanged |

The audit predicted "almost certainly costing measurable JS bundle weight." That turned out to be partially wrong — Next.js's tree-shaker was already dropping unused named exports from the single-file module on most routes. The refactor's real value here is **maintainability** (5 ~200-LOC files instead of one 1,007-LOC monster, less merge-conflict surface, lower lint/tsc cost per file). One real bundle win on `/cart`; the rest are flat.

**Verified:** 340/340 tests, lint clean, `tsc --noEmit` clean, production build succeeded. No call-site outside `components/skeletons/` modified.

**Three stateful components split (2026-05-15)** — each had richer internal state than the skeletons (forms, queries, transitions, payment flow), so splitting required actual decomposition rather than mechanical extraction.

**RegisterForm.tsx → 686 / 474** (1.45× ratio is honest — the `detectLocation` geocoding helper is ~160 LOC of fallback logic that has to stay in the parent because it owns `formData` setState. Could be lifted to a custom hook later if it grows; not today.) Split into:
- `components/register/PersonalInfoSection.tsx` (93) — first/last name, email, company, phone
- `components/register/AddressSection.tsx` (115) — Address Line 1, city/state/country/zipcode + auto-fill button
- `components/register/CredentialsSection.tsx` (79) — password + confirm with self-owned show/hide toggles
- `components/register/types.ts` (29) — `RegisterFormData`, `RegisterAddress`, `RegisterChangeHandler`

**InvoiceDiagnostics.tsx → 429 / 186** — admin parent keeps state, data fetching, action handlers, top-level layout. Three sub-components extracted:
- `components/admin/invoice-diagnostics/DiagnosticsHeader.tsx` (86) — collapsible row with status pill + refresh chip
- `components/admin/invoice-diagnostics/ConflictsTable.tsx` (116) — invoiceNumber-collision groups with per-row "Clear #" action
- `components/admin/invoice-diagnostics/StuckOrdersTable.tsx` (118) — paid-orders-without-Zoho-invoice rows + bulk re-sync UI
- `components/admin/invoice-diagnostics/types.ts` (40)

**HostingUpgradeModal.tsx → 414 / 276** — **double-duty migration**: simultaneously decomposed AND migrated to the iframe-based `useRazorpayCheckout()` flow added for [CRITICAL-4](#critical-4). The 7-state UI ([loading, select, confirm, paying, verifying, success, error]) keeps small states inline; the two big states extracted:
- `components/hosting-upgrade/SelectPlanStep.tsx` (96) — plan-selection list with prorated charges
- `components/hosting-upgrade/ConfirmStep.tsx` (92) — confirmation block + Back/Pay buttons
- `components/hosting-upgrade/types.ts` (33)
- Razorpay opens inside the isolated `/razorpay-checkout` iframe — kills two birds: closes a MEDIUM-3 item and migrates a CRITICAL-4 remainder consumer in the same commit. Three Razorpay flows still need migration (`app/checkout/page.tsx`, `app/checkout/guest/page.tsx`, `app/dashboard/invoices/page.tsx`); when those land too, `unsafe-eval` drops from app pages site-wide.

**Verified:** 340/340 tests, lint clean (errors), `tsc --noEmit` clean, production build succeeded (62 static pages).

---

### ~~[MEDIUM-4] ESLint config is permissive~~ — PARTIALLY RESOLVED 2026-05-15
Added the `@typescript-eslint` plugin to [.eslintrc.json](.eslintrc.json) with two of the three audit-recommended rules at warn level:

```json
"@typescript-eslint/no-explicit-any": "warn",
"@typescript-eslint/no-unused-vars": [
  "warn",
  { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }
]
```

Rules exempt on `tests/**` and `scripts/**` so mock-heavy test code doesn't drown the signal. `lib/server-logger.ts` and `lib/logger.ts` continue to opt out of `no-console`.

**Surface this exposes:** **1,248 lint warnings** across `app/`, `lib/`, `components/`, `middleware.ts` —
- 842 `no-explicit-any` (real untyped surface area; mostly third-party API response shapes)
- 406 `no-unused-vars` (mostly stale imports + unused catch-block `error` variables)

**CI handling:** the CI workflow runs `next lint --quiet` so only errors surface as GitHub annotations. Warnings show up locally on `npm run lint` and serve as a tech-debt indicator without producing 1,248 PR annotations on every push. Both audit-recommended outcomes met: visibility + non-blocking.

**Not added in this pass:** `@typescript-eslint/no-floating-promises`. It requires type-aware linting (`parserOptions.project: ./tsconfig.json`), which makes lint substantially slower because it loads the type checker. Worth adding once the existing warnings are paid down so the cost lands on cleaner code.

---

## 5. Testing

### ~~[MEDIUM-5] Thin test coverage~~ — PARTIALLY RESOLVED 2026-05-14
Added [tests/unit/lib/razorpay.test.ts](tests/unit/lib/razorpay.test.ts) — 17 tests covering the security-critical signature primitives that both [app/api/payments/verify/route.ts](app/api/payments/verify/route.ts) and [app/api/webhooks/razorpay/route.ts](app/api/webhooks/razorpay/route.ts) depend on as their first line of defense:

- `verifyPayment` order flow: correct signature accepted, tampered order_id/payment_id/signature rejected
- `verifyPayment` subscription flow: correct signature accepted, swapped sub_id rejected, order-flow sig sent in subscription slot rejected (guards against developer mistakes mixing the two HMAC formulas)
- `verifyPayment` input safety: missing both order_id and subscription_id, length-mismatched signature (timingSafeEqual throw), non-hex signature, empty signature — all return false without throwing
- `verifyWebhookSignature`: matching body+sig accepted; tampered body, forged delivery with wrong secret, empty signature, non-hex signature, and event-swapping replay all rejected

Test count moved from 281 → 298, all green.

**Deliberately deferred to integration tests (deemed remaining work):**
1. Route-level tests for [payments/verify](app/api/payments/verify/route.ts) and [webhooks/razorpay](app/api/webhooks/razorpay/route.ts). Each route has 10+ collaborators (AuthService, MongoDB models, Razorpay client, Email, Cloud Tasks, payment-services helpers, Redis nonce). Mocking that surface to test 4 early-return paths is high-effort, low-value — integration tests using a test Mongo + Razorpay sandbox are the right place.
2. Auth surface (TOTP setup/confirm, password reset, session timeout).
3. Domain provisioning lifecycle (`Pending → Domain` promotion).
4. CSRF and rate-limit middleware.

**Coverage threshold caveat unchanged:** [vitest.config.ts](vitest.config.ts) still excludes `lib/security.ts` and `lib/pricing-service.ts` from coverage. The 60% threshold is on whatever's measured, not the codebase. [CRITICAL-3](#critical-3) tracks the security.ts exclusion separately.

---

### ~~[MEDIUM-6] No visible CI~~ — PARTIALLY RESOLVED 2026-05-14
Added [.github/workflows/ci.yml](.github/workflows/ci.yml) with two jobs triggered on push to `main` and on pull requests:

**Job 1: `ci` (Lint + Test + Type-check) — blocking**
- `npm ci` on Node 20 (matches `package.json#engines`)
- `npm run lint`
- `npx tsc --noEmit` (full project type-check)
- `npm test` (vitest, 340 tests)
- `PUPPETEER_SKIP_DOWNLOAD=true` so CI doesn't waste minutes downloading Chromium

**Job 2: `audit` (npm audit) — informational only (`continue-on-error: true`)**
- `npm audit --audit-level=high` against the lockfile

The audit step is **deliberately non-blocking** for now: `npm audit` currently reports 13 high-severity advisories, all in Next.js (XSS / SSRF / cache-poisoning / middleware bypass / DoS variants on `^15.5.15`). Making it blocking today would red-bar every PR. Promote it to required once Next.js is bumped to a patched 15.x (or a per-vuln allowlist is added).

**Pre-flight fixes landed alongside the workflow:**
- [tests/unit/lib/auth.test.ts](tests/unit/lib/auth.test.ts) — fixed a possibly-null deref in the bearer-token test (`result.email` → `result!.email`).
- [tests/unit/lib/security.test.ts](tests/unit/lib/security.test.ts) — cast `process.env` to a writable record before assigning `NODE_ENV` (TypeScript 6 / @types/node 24+ types `NODE_ENV` as read-only).

**Verified:** vitest 340/340, lint clean (8 expected `console.*` warnings, exit 0), `tsc --noEmit` clean.

**Pending follow-up (the still-unresolved part):**
1. **Gate `deploy.sh` behind CI green status.** Requires `gh` CLI authenticated on the deploy host, then a step like `gh run list --branch main --limit 1 --json conclusion` to inspect the latest run before proceeding. Defer until the team has reviewed the CI workflow output for a few cycles.
2. **Wire the required-status-check on the `main` ruleset/branch-protection rule.** Once CI runs at least once, the GitHub UI surfaces `CI / Lint + Test + Type-check` in the "required status checks" dropdown — pick it there. (No code change needed; only the existing GitHub limitation that ruleset enforcement on Free private repos is cosmetic until upgrading to Team — see [CRITICAL-1](#critical-1).)
3. **Upgrade Next.js + flip the audit job to blocking.** Likely a `npm audit fix` on `next` will patch all 13 advisories. Smoke-test on a branch before merging.

---

## 6. Operational

### ~~[MEDIUM-7] PM2 single-instance fork mode~~ — RESOLVED 2026-05-14
PM2 wiring removed across the project. Cloud Run path (Dockerfile → `node server.js`) was already PM2-free; the cleanup is on the VPS side.

**Changes:**
- `ecosystem.config.js` **deleted**. The settings it held (`PORT`, `NODE_OPTIONS`, `NODE_ENV`) now live in [deploy.sh](deploy.sh) and `.env.local`.
- [deploy.sh](deploy.sh) rewritten. The PM2 lifecycle (`pm2 delete` / `pm2 start` / `pm2 logs` / `pm2 status`) is replaced by:
  - **Graceful stop** — read PID from `deployment-logs/.server.pid`, send SIGTERM, wait up to 10 s for in-flight requests to drain, fall back to SIGKILL. Strictly better than the old `pm2 delete + kill -9 port` combo at preserving Razorpay webhooks.
  - **Detached start** — `nohup setsid node --env-file=.env.local .next/standalone/server.js >> $LOG_DIR/server.log 2>&1 &`, write PID, `disown`. `--env-file` replaces the env-loading PM2 was doing.
  - **Liveness check** — confirms the new process is still alive 3 s after spawn, prints last 50 log lines if not.
- [view-logs.sh](view-logs.sh) refactored to read `server.log` + `migrate.log` instead of `pm2-logs-*.log`.
- [app/api/admin/razorpay-mode/route.ts](app/api/admin/razorpay-mode/route.ts) — the admin "switch test/live mode" endpoint previously called `pm2 restart next-app --update-env` to pick up the new `RAZORPAY_KEY_*` env values. Now sends SIGTERM to the PID from `deployment-logs/.server.pid`; the host's process supervisor (systemd on VPS, Cloud Run on managed hosting) is responsible for re-spawning. The admin response is explicit when no supervisor is configured: *"server was not restarted — re-deploy to apply"*.
- [middleware.ts](middleware.ts) + [MIGRATIONS.md](MIGRATIONS.md) + [.dockerignore](.dockerignore) — comment/text updates removing stale PM2 references.

**Verified:** 340/340 tests, lint clean, tsc clean, `bash -n` on both scripts, production build succeeded. The graceful-stop path also avoids the old PM2 1500 MB hard-restart that the audit flagged as dropping in-flight webhooks — the new path doesn't impose a memory cap; if you want one, set `NODE_OPTIONS="--max-old-space-size=N"` in `.env.local` (deploy.sh defaults it to 1024).

**Operational note for VPS users:** deploy.sh starts the server detached but does **not** supervise it. If the node process crashes mid-life, nothing restarts it. Use a systemd unit (or any init supervisor) with `Restart=always` pointing at `.next/standalone/server.js`. On Cloud Run this is the platform's job and no supervisor setup is needed.

---

### ~~[MEDIUM-8] `deploy.sh` is not atomic~~ — RESOLVED 2026-05-15
[deploy.sh](deploy.sh) now follows a snapshot-and-rollback pattern. Before lint/build/migrate begins, the current `.next/` is moved to `.next.prev/`. The build then writes a fresh `.next/`. On any failure (lint, build, migrate), a `rollback_next()` helper deletes the partial `.next/` and restores `.next.prev/`. The script exits non-zero with a clear "⏪ Rolling back" log line.

**Failure modes covered atomically:**
- Lint failure
- `next build` failure
- `migrate:status` failure
- `migrate` failure (with the caveat that schema state may be partially-applied — the script logs this explicitly; only the build is rolled back, the DB is not).

**Manual rollback after a bad deploy** (when the new server is running but is misbehaving):
```bash
# Stop the running server
kill -TERM "$(cat deployment-logs/.server.pid)"
# Swap the rollback target back in
mv .next .next.failed
mv .next.prev .next
# Re-run the start step (or re-run deploy.sh — it picks up .next as "current")
```

The old "preserve cache between builds" trick (partial-rm of `.next/static`, `.next/server`, manifests) is gone. Builds now start from a fresh `.next/` every time. Cost: ~30-60s added to each build. Trade-off accepted in exchange for atomicity — a failed build no longer leaves the deployment in a broken half-state.

The audit's original recommendation built to `.next.new/` then swapped; this implementation instead snapshots to `.next.prev/` and lets the build write to `.next/` directly. Functionally equivalent atomic semantics, simpler script.

**Cloud Run note:** this matters for the VPS path only. On Cloud Run, atomicity is built-in — failed revisions don't get traffic, and `gcloud run deploy` rolls back automatically.

**Verified:** `bash -n deploy.sh` clean, production build succeeded.

---

### ~~[MEDIUM-9] Repo-root clutter~~ — RESOLVED 2026-05-14
- **`test-full-app.js`** (1,258 lines / 71 KB) deleted. It was a one-off Playwright admin-flow probe with **hardcoded credentials** (`ADMIN_PASSWORD='admin123'` in source), `BASE_URL='https://localhost'`, no integration into any test runner, and not referenced from anywhere except audit.md itself. Moving it to `scripts/` would just preserve that footgun under a different path — deletion is the correct outcome.
- **`tsconfig.tsbuildinfo`** (524 KB) deleted from disk. Already gitignored; will be regenerated on the next `tsc` run.

**Out-of-scope flag (separate from MEDIUM-9):** the same `admin123` literal also appears in [scripts/init-db.js](scripts/init-db.js) and [scripts/setup.js](scripts/setup.js) as a seed admin password. Those are bootstrap scripts (not in active production paths) but should be reviewed when the admin onboarding flow is next touched — a seed password baked into source is an easy target.

---

### [LOW-1] `npm audit` never gated
Scripts (`npm run audit`, `audit:summary`) are wired up but no recent output captured. Run before each deploy.

---

### ~~[LOW-2] No structured logging~~ — RESOLVED 2026-05-14
Per the audit's "pair with MEDIUM-2" guidance, this is now fully addressed by the work from [MEDIUM-2](#medium-2) plus per-request correlation IDs landed in this pass:

**Structured JSON output** (from MEDIUM-2): `serverLogger.*` emits one JSON line per entry in production, with `severity` matching Cloud Logging's `LogSeverity` enum, `message`, ISO `time`, and any object-arg fields merged to the top level. Cloud Logging auto-parses these into searchable structured entries.

**Request-ID correlation** (new this pass):
- [lib/request-id.ts](lib/request-id.ts) — `resolveRequestId(headers)` prefers Cloud Run's `X-Cloud-Trace-Context` header (so log entries automatically correlate with Cloud Trace spans), then any upstream `x-request-id`, then a fresh `crypto.randomUUID()`. Edge-runtime safe.
- [middleware.ts](middleware.ts) — computes the request ID once per request and:
  1. Attaches it to the response as `x-request-id` (client / load balancer / support correlation).
  2. Attaches it to the **request** via `nextWithNonce` so route handlers can read `request.headers.get("x-request-id")` and include it in their own log meta args.
  3. Includes `{ requestId }` in middleware's own structured logs (auth-attempt warnings, CSRF-failure warnings).
- [lib/server-logger.ts](lib/server-logger.ts) — JSDoc now documents the `{ requestId }` meta-arg pattern so future log calls can join the correlation trail.

**Live-verified on the standalone build:**
```
# Cloud Run-style trace header → request ID = the trace ID
$ curl -H "X-Cloud-Trace-Context: 9d2f3a8e1b4c5d6e7f0a/1234;o=1" .../api/health
→ x-request-id: 9d2f3a8e1b4c5d6e7f0a

# Client-supplied header → echoed back
$ curl -H "x-request-id: client-trace-abc-123" .../api/health
→ x-request-id: client-trace-abc-123

# Nothing supplied → fresh UUID
$ curl .../api/health
→ x-request-id: 4c4321d1-a67b-4c61-a4e7-105caa5bca3b
```

**Verified:** 340/340 tests, lint clean, tsc clean, production build succeeded.

**Auto-propagation via AsyncLocalStorage (2026-05-14):** Routes no longer need to pass `{ requestId }` manually. [lib/request-context.ts](lib/request-context.ts) registers an `AsyncLocalStorage` instance on `globalThis`, and `serverLogger` reads from it on every call. Wrapping a route handler with `withRequestLogContext(...)` binds `x-request-id` for the lifetime of that request — every async operation it spawns (DB queries, service-module calls, fetch) inherits the same context and every log line that fires inside it automatically carries `requestId` in the JSON output.

Wired as a demonstration on [app/api/payments/verify/route.ts](app/api/payments/verify/route.ts):

```ts
export const POST = withRequestLogContext(async (request: NextRequest) => {
  // ... existing logic ...
  // every serverLogger.* call below + every payment-services helper
  // automatically logs with requestId attached
});
```

**Direct-test verification:**
```
--- outside context ---
{"severity":"INFO","message":"hello from outside","time":"…"}

--- inside withRequestContext({requestId:"demo-123"}) ---
{"severity":"INFO","message":"first log inside ALS","time":"…","requestId":"demo-123"}
{"severity":"WARNING","message":"second log, still inside","time":"…","requestId":"demo-123","orderId":"ord-42"}

--- back outside ---
{"severity":"INFO","message":"hello from outside again","time":"…"}
```

**Decoupling note:** request-context imports `node:async_hooks` which Webpack rejects in the Edge runtime (middleware). To avoid pulling the import into the Edge bundle, request-context publishes its storage on `globalThis.__requestContextStorage` and server-logger reads from globalThis instead of importing the module directly. Middleware (Edge) still passes `{ requestId }` explicitly to its serverLogger calls; route handlers (Node) get auto-flow.

**Pending follow-up (optional, incremental):** Other route handlers can adopt `withRequestLogContext` opportunistically when next touched. No big-bang migration needed — the auto-flow is already in place for any route that wraps itself, and middleware-set request IDs are still on the response header for client-side support correlation regardless.

---

## 7. Data & Domain Model

### ~~[LOW-3] No DB migration history visible~~ — RESOLVED 2026-05-13
The migration framework was already solid ([scripts/db/migrate.ts](scripts/db/migrate.ts), tracked in `_migrations` collection, three prior migrations on file). What was missing: a migration for the LOW-4 index additions, deploy-script integration, and a developer workflow doc.

- Added [scripts/db/migrations/004_add_user_pending_hosting_support_ticket_indexes.ts](scripts/db/migrations/004_add_user_pending_hosting_support_ticket_indexes.ts) — explicit, deterministic creation of the 10 new indexes from LOW-4 on existing databases (not relying on Mongoose `autoIndex` alone). All use `{ background: true }`; `down()` wraps `dropIndex` in `.catch(() => {})` for idempotent rollback.
- Wired migrations into [deploy.sh](deploy.sh) (step 4b): runs `npm run migrate:status` then `npm run migrate` after a successful build and before PM2 start. A failed migration aborts the deploy. Output logged to `deployment-logs/<timestamp>/migrate.log`.
- Added [MIGRATIONS.md](MIGRATIONS.md) at the project root documenting: when to write a migration, file naming, the up/down template, local workflow, production behavior, rollback procedure, and a pre-merge safety checklist.

---

### ~~[LOW-4] Mongoose models have inconsistent indexes~~ — RESOLVED 2026-05-13
Audited all 17 models. Most were well-indexed already (Domain, Hosting, Order, RenewalPayment, PendingDomain, DomainWatch, TrialClaim, SystemLog). Three had real gaps where queries existed without a supporting index:

- [models/User.ts](models/User.ts) — added 6 indexes covering confirmed queries: `role` (admin enumeration), `activationToken` / `resetToken` / `pendingEmailToken` (sparse, for token-lookup flows), `directAdminUsername` (sparse, for cross-system lookups), `resellerClubCustomerId` (sparse, for webhook handlers).
- [models/PendingHosting.ts](models/PendingHosting.ts) — added 3 indexes: `status`, `userId + status`, `status + createdAt`. Required by the existing `countDocuments({ status })` calls in the admin stats endpoint and future janitor crons.
- [models/SupportTicket.ts](models/SupportTicket.ts) — added `status + createdAt` compound for the admin queue sorted by recency.

All optional fields use sparse indexes so they don't pay storage for the null majority. Indexes are auto-created on next deploy via Mongoose's default `autoIndex` behavior (no migration script required); MongoDB builds them in the background and they are small collections by application standard.

---

## 8. Resolved Issues

### Sensitive artifacts on disk — RESOLVED 2026-05-13
- `gcp-key.json` moved to `~/.secrets-backup/gcp-key.json.20260513` (chmod 600)
- `auth-debug.log` (135 KB stale) moved to `~/.secrets-backup/auth-debug.log.20260513`
- `debug_payment.log` (empty) deleted
- Misleading "Check auth-debug.log" string in [app/api/admin/orders/[id]/re-sync-invoice/route.ts](app/api/admin/orders/[id]/re-sync-invoice/route.ts) replaced with "Check server logs"

**Follow-up still required:** Rotate the GCP service account key in the GCP console, then delete the backup copy.

---

## 9. Suggested Priority Roadmap

| Day | Task | Severity |
|---|---|---|
| 1 | ~~`git init`, push to private remote, branch protection~~ ✅ 2026-05-14 (enforcement awaits GitHub Team upgrade) | CRITICAL-1 |
| 2 | ~~Strip `.env.local` from build script~~ ✅ 2026-05-14 · move to Cloud Run secrets, rotate exposed credentials | CRITICAL-2 |
| 3 | ~~Sweeper cron for `PendingDomain` / `PendingHosting` with admin alerts~~ ✅ 2026-05-14 (Cloud Scheduler job still needs to be created in GCP) | HIGH-5 |
| 4 | ~~Tests for `payments/verify` and Razorpay webhook~~ ✅ 2026-05-14 (signature primitives unit-tested; route-level integration tests remain) | MEDIUM-5 |
| 5 | ~~Split [lib/resellerclub.ts](lib/resellerclub.ts), [lib/directadmin.ts](lib/directadmin.ts), [lib/zohobooks.ts](lib/zohobooks.ts), [lib/auth-config.ts](lib/auth-config.ts) into focused modules~~ ✅ 2026-05-14 | HIGH-1 |
| 6 | ~~Add CI workflow (lint + test + audit)~~ ✅ 2026-05-14 (deploy gating + audit-blocking still pending) | MEDIUM-6 |
| 7 | ~~Structured logger, remove `console.*` from server code, tighten ESLint~~ ✅ 2026-05-14 (extended to client code too — 67 swaps, 0 console warnings remaining) | MEDIUM-2 |
| 8 | ~~Atomic deploy — snapshot `.next` → `.next.prev`, rollback on any failure~~ ✅ 2026-05-15 | MEDIUM-8 |
| 9 | Rotate GCP service account key, delete backup | Resolved follow-up |
| 10 | DB index audit on Mongoose models | LOW-4 |

---

## 10. Strengths Worth Preserving

Not everything is broken — these patterns are good and should not be regressed:

- Clear staging-table pattern (`Pending*` collections) for eventual-consistency provisioning
- Well-factored [lib/payment-services/](lib/payment-services/) sub-pipeline (price-verifier, provisioner, renewal, post-tasks)
- Comprehensive middleware-level security ([middleware.ts](middleware.ts), CSP nonce, HTTPS redirect, maintenance mode)
- Audit logging ([lib/audit-log.ts](lib/audit-log.ts)) and field encryption ([lib/field-encryption.ts](lib/field-encryption.ts))
- Sophisticated Zustand cart with localStorage + server sync ([store/cartStore.ts](store/cartStore.ts))
- Timestamped per-deploy log folders ([deployment-logs/](deployment-logs/))
- TOTP 2FA with backup codes for both admin and user accounts
- `.dockerignore` and `.gitignore` already cover the major sensitive-file classes
