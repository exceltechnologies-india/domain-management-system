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
| Deploy | Docker → GCP Cloud Run, PM2 (fork mode, 1500 MB cap) |
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

### ~~[CRITICAL-4] `unsafe-eval` and `unsafe-inline` in CSP~~ — PARTIALLY RESOLVED 2026-05-14
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

**Pending (the still-unresolved part):**
1. Most user-facing pages still run with `unsafe-eval` because of Razorpay's eval-using checkout SDK. Replacing it with Razorpay's "Elements" integration (the iframe variant) would remove the dependency from our origin entirely and let strict CSP roll out site-wide.
2. `style-src 'unsafe-inline'` is unchanged — Tailwind's utility classes and Next.js's style injection emit unhashed inline styles. Switching to a nonce-only style-src would require either a Next.js style hash plan or a CSS-modules migration; out of scope here.
3. The strict-page allowlist is conservative. As features are confirmed not to depend on eval/inline scripts (e.g. `/payment-success`, `/hosting`, `/domains/search` after manual audit), they can move onto the strict list.

---

## 3. Architectural Issues

### [HIGH-1] Monolithic service wrappers

| File | LOC (before) | LOC (after) | Status |
|---|---|---|---|
| [lib/resellerclub.ts](lib/resellerclub.ts) | 2,452 | 95 (barrel) | ~~Split~~ ✅ 2026-05-14 |
| [lib/directadmin.ts](lib/directadmin.ts) | 1,193 | 1,193 | pending |
| [lib/zohobooks.ts](lib/zohobooks.ts) | 1,192 | 1,192 | pending |
| [lib/auth-config.ts](lib/auth-config.ts) | 863 | 863 | pending |

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

**Pending fix for the other three large files** (`directadmin.ts`, `zohobooks.ts`, `auth-config.ts`) — same pattern when prioritised; each gets its own `lib/<name>/` directory with topical submodules and a thin barrel.

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

### ~~[HIGH-3] No API versioning~~ — PARTIALLY RESOLVED 2026-05-14
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

**Pending future work (the part of HIGH-3 that's *not* resolved):**
- No `/api/v2/` exists yet, and won't until a breaking change is needed. The infrastructure is now in place so introducing v2 is just adding a sibling route handler — `lib/resellerclub.ts`-style namespace work, not a routing project.
- Treat `/api/v1/` semantics as stable from this point forward. Any future change that would break a v1 caller (response shape change, removed fields, changed status codes) must instead live under `/api/v2/`.
- 13 internal `import { ResellerClubAPI } …` and equivalent server-side fetches still use the unversioned `/api/<path>` URLs. Migrate them to `/api/v1/<path>` opportunistically — both paths work, so this is cleanup, not a deadline.

---

### [HIGH-4] No service / repository layer
Routes call Mongoose models directly. Schema changes ripple into dozens of files. A half-formed pattern exists in [lib/payment-services/](lib/payment-services/) — extend it to domains, hosting, users, orders.

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

### [HIGH-6] Three overlapping security files
[lib/security.ts](lib/security.ts), [lib/security-middleware.ts](lib/security-middleware.ts), [lib/security-headers.ts](lib/security-headers.ts) — boundaries unclear.

**Fix:** Consolidate into `lib/security/` with explicit submodules (`headers.ts`, `middleware.ts`, `csrf.ts`, `rate-limit.ts`, `validation.ts`).

---

## 4. Code Quality

### [MEDIUM-1] 540 `any` types
Across `lib/`, `app/`, `components/`. TypeScript is doing far less work than it could. Worst offenders are the external API wrappers (ResellerClub / DirectAdmin responses).

**Fix:** Model the external API response shapes. Start with the highest-traffic endpoints (domain search response, registration response, hosting provisioning).

---

### ~~[MEDIUM-2] 76 raw `console.*` calls in production code~~ — PARTIALLY RESOLVED 2026-05-14
[lib/server-logger.ts](lib/server-logger.ts) now emits **structured JSON in production** — one line per log entry with `severity`, `message`, ISO `time`, plus any object-arg fields merged into the top level. Cloud Logging auto-parses these and surfaces them with the right `severity` icon, full `jsonPayload`, and searchable fields. Dev mode is unchanged: human-readable `[INFO]` / `[WARNING]` / `[ERROR]` prefix on `console.*` for readability in the terminal.

Verified live (NODE_ENV=production):
```
{"severity":"INFO","message":"hello from prod","time":"2026-05-14T07:56:01.041Z","requestId":"abc-123","userId":"u-42"}
{"severity":"WARNING","message":"warn-level event","time":"2026-05-14T07:56:01.043Z","route":"/api/x"}
```

**Server-side `console.*` calls migrated to `serverLogger`:**
- [middleware.ts](middleware.ts) — 2 security-audit warns
- [lib/recaptcha.ts](lib/recaptcha.ts) `RecaptchaServer` class — 1 warn + 1 error

**Client-side `console.*` calls migrated to existing [lib/logger.ts](lib/logger.ts):**
- [lib/recaptcha.ts](lib/recaptcha.ts) `RecaptchaClient` class — 1 warn + 2 errors
- [lib/logout.ts](lib/logout.ts) — 1 warn
- [lib/storage.ts](lib/storage.ts) — 2 warns

**ESLint tightened** ([.eslintrc.json](.eslintrc.json)): `"no-console": ["warn", { "allow": ["error"] }]` site-wide, with an override that keeps `no-console: off` only on the two logger files themselves (which legitimately *are* the `console.*` output sink). Lint surfaces 8 remaining `console.*` calls in `app/admin/*` and `components/*` UI files — these are client-side React paths and out of scope for the "Cloud Run unstructured logs" concern. They can be migrated opportunistically.

**Suite still green:** 340/340 tests, build clean, smoke-tested structured output on the standalone server.

**Pending follow-up:** 51 `console.*` calls remain in `app/**/*.tsx` page files (mostly client-side React, mostly `console.error` which is explicitly allowed by the new rule). Migrating these to `logger` would just centralize error telemetry — useful but not Cloud-Run-blocking.

---

### [MEDIUM-3] Massive React components
| File | LOC |
|---|---|
| [components/skeletons/PageSkeletons.tsx](components/skeletons/PageSkeletons.tsx) | 1,007 |
| [components/RegisterForm.tsx](components/RegisterForm.tsx) | 686 |
| [components/admin/InvoiceDiagnostics.tsx](components/admin/InvoiceDiagnostics.tsx) | 429 |
| [components/HostingUpgradeModal.tsx](components/HostingUpgradeModal.tsx) | 414 |

**Fix priority:**
- `PageSkeletons.tsx` — split per route, import dynamically. This is almost certainly costing measurable JS bundle weight on first load.
- `RegisterForm.tsx` — split address / personal / credentials sections.

---

### [MEDIUM-4] ESLint config is permissive
[.eslintrc.json](.eslintrc.json):

```json
{
  "extends": ["next/core-web-vitals"],
  "rules": {
    "no-console": "off",
    "react/no-unescaped-entities": "off"
  }
}
```

**Fix:** Add `@typescript-eslint`, enable `no-explicit-any`, `no-unused-vars`, `no-floating-promises`. Keep at warning level initially to avoid a big-bang fix.

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

### [MEDIUM-7] PM2 single-instance fork mode
[ecosystem.config.js](ecosystem.config.js) — `instances: 1`, `exec_mode: 'fork'`. One crash = downtime. The 1500 MB cap forces a hard restart that drops in-flight Razorpay webhooks.

**Fix:**
- If running on Cloud Run: PM2 is redundant — Cloud Run autoscales. Drop PM2 and let Cloud Run manage process lifecycle.
- If running on a VM: switch to `exec_mode: 'cluster'` with `instances: 2` minimum.

---

### [MEDIUM-8] `deploy.sh` is not atomic
Stop → Clean → Build → Start. If `Build` fails *after* `Clean`, the app is down until a human fixes it. [deployment-logs/](deployment-logs/) keeps logs but not the previous bundle.

**Fix:** Build to `.next.new/standalone/`, then atomic-swap on success:
```
rm -rf .next.prev
mv .next .next.prev
mv .next.new .next
pm2 reload next-app
```
Rollback = `mv .next .next.failed && mv .next.prev .next && pm2 reload`.

---

### [MEDIUM-9] Repo-root clutter
- [test-full-app.js](test-full-app.js) — 71 KB ad-hoc script; move to [scripts/](scripts/) or delete
- [tsconfig.tsbuildinfo](tsconfig.tsbuildinfo) — 559 KB build artifact; gitignored already, just delete from disk

---

### [LOW-1] `npm audit` never gated
Scripts (`npm run audit`, `audit:summary`) are wired up but no recent output captured. Run before each deploy.

---

### [LOW-2] No structured logging
With 76 `console.*` calls and no log shipper, debugging in production means scrolling Cloud Run logs.

**Fix:** Pair with MEDIUM-2 — once structured logging is in, ship to Google Cloud Logging with severity levels and request IDs.

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
| 5 | ~~Split [lib/resellerclub.ts](lib/resellerclub.ts) into 5–6 focused modules~~ ✅ 2026-05-14 (3 other large files in HIGH-1 still pending) | HIGH-1 |
| 6 | ~~Add CI workflow (lint + test + audit)~~ ✅ 2026-05-14 (deploy gating + audit-blocking still pending) | MEDIUM-6 |
| 7 | Structured logger, remove `console.*` from server code, tighten ESLint | MEDIUM-2 |
| 8 | Atomic deploy (build to `.next.new`, atomic swap) | MEDIUM-8 |
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
