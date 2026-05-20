# Project Audit

**Last full rescan:** 2026-05-20
**Scope:** 485 TS/TSX source files (~92K LOC), 136 API routes, ~15 services in `lib/services/`, ~12 Mongoose models, 459 tests (434 unit + 25 integration).

This document tracks **currently-open** findings. The full historical pass log (HIGH-4 service-layer migrations, MEDIUM-1 any-types reduction across 15 passes, MEDIUM-4 ESLint hardening, MEDIUM-5 integration-test scaffolding, MEDIUM-6 CI gating) is preserved in git history — refer to `git log --oneline --all` and the commit messages, which carry the same level of detail this file used to inline.

## Resolved (high-level — see git log for details)

- ✅ **CRITICAL-1** — git/repo + branch protection (2026-05-14)
- ✅ **CRITICAL-3** — security module under test coverage (98.93% lines)
- ✅ **CRITICAL-4** — CSP `unsafe-eval` / `unsafe-inline` isolated to iframe-only flows
- ✅ **HIGH-1** — monolithic service wrappers split into focused modules
- ✅ **HIGH-2** — state-machine logic out of routes
- ✅ **HIGH-3** — `/api/v1/*` versioning surface live
- ✅ **HIGH-4 (User)** — every `User.X(...)` callsite outside `lib/services/users.ts` migrated (~93 → 0). **Note**: Order/Hosting/SupportTicket models still have direct callsites (see [H4] below).
- ✅ **HIGH-5** — `Pending*` collection sweepers + auto-retry cron (2026-05-20)
- ✅ **HIGH-6** — security module consolidation
- ✅ **MEDIUM-1** — `any` types 845 → 10 (99% reduction; remaining 10 are intentional with eslint-disable + rationale)
- ✅ **MEDIUM-2** — structured logger, zero `console.*` outside `lib/*-logger.ts`
- ✅ **MEDIUM-3** — large React components decomposed
- ✅ **MEDIUM-4** — ESLint hardened with `@typescript-eslint/no-explicit-any`, `no-unused-vars`, `no-floating-promises` (type-aware); 134 floating-promise sites fixed
- ✅ **MEDIUM-5** — integration-test scaffolding via `mongodb-memory-server`; route-level tests for `payments/verify` + `webhooks/razorpay`; +119 tests this session
- ✅ **MEDIUM-6** — CI lint + test + tsc + integration + audit gating; `deploy-cloud-run.sh` blocked behind CI-green
- ✅ **MEDIUM-7** — Cloud Run replaces single-instance PM2
- ✅ **MEDIUM-8** — atomic deploy with rollback path
- ✅ **MEDIUM-9** — repo-root clutter cleaned
- ✅ **LOW-1** — `npm audit` gated in CI (high+ threshold)
- ✅ **LOW-2** — structured logging
- ✅ **LOW-3** — DB migration history
- ✅ **LOW-4** — Mongoose model index audit
- ✅ **[H3] Zoho axios timeout** (commit `bb91b5d`) — 24 callsites swapped to a shared `zohoAxios = axios.create({ timeout: 30_000 })` in `lib/zohobooks/axios-client.ts`. Hung Zoho upstream no longer stalls Cloud Run slots.
- ✅ **[M8] Unused dependencies removed** (commit `bb91b5d`) — 20 packages uninstalled: `underscore`, `dns2`, `dompurify`, `whois`, `whois-api`, `whois-json`, `@react-pdf/renderer`, `styled-jsx`, + 12 stale `@types/*`. All had zero refs across the codebase before removal.
- ✅ **[M9] `npm audit` cleared** (commit `bb91b5d`) — `brace-expansion`, `protobufjs`, `ws` advisories patched via `npm audit fix`. 3 moderate → 0 vulnerabilities.
- ✅ **[M10] AdminLayout deduped** (commit `bb91b5d`) — dead 167-line `components/admin/AdminLayout.tsx` removed; `AdminLayoutNew.tsx` renamed in place; 18 consumer imports + the `components/index.ts` re-export updated; default-export function renamed `AdminLayoutNew` → `AdminLayout`.
- ✅ **[L1] `/api/debug/check-expiry` removed** (commit `bb91b5d`) — dev-scaffolding route that leaked 5 active hosting rows (domainName + expiryDate) to any logged-in user. Not referenced anywhere; deleting was cleaner than gating.
- ✅ **[L4] Stale TODOs resolved** (commit `bb91b5d`) — `lib/resellerclub/customers.ts:567` (resellerClub-id persistence shipped via `setUserResellerClubIds`) and `app/api/admin/hosting/stats/route.ts:137` (per-user DA fetch trade-off) — both converted to explanatory notes.
- ✅ **Batch 1 verification 2026-05-20** (revision `dms-00029-4jj`) — 434 unit + 25 integration tests green, tsc clean, `next lint --quiet` clean, 0 `npm audit` findings, `/api/health` 200 OK, zero error-level Cloud Run logs in the post-deploy window.

## Deliberately deferred (by user)

- **CRITICAL-2** — Rotate credentials baked into pre-Secret-Manager Docker layers.
- **Day-9 roadmap** — Rotate GCP service account key.

Per user instruction (2026-05-20), key/credential rotation is out of scope for this project. Not surfaced as a next step.

---

## Open issues (rescan 2026-05-20)

Issues are listed by severity. Each has a file pointer, one-line problem, one-line fix, and a rough effort estimate. The list is meant to be picked off in batches — see "Recommended order" at the bottom.

### HIGH

#### [H1] IDOR on invoice-pay
**File:** [app/api/user/invoices/[id]/pay/route.ts:25-49](app/api/user/invoices/%5Bid%5D/pay/route.ts#L25-L49)
**Problem:** Any logged-in user can enumerate Zoho invoice IDs from the URL and pay (or read metadata from the response on) any invoice. There's no ownership check — the route hits `zohoService.getInvoiceById(invoiceId)` directly from the URL param.
**Fix:** Look up via local `Order.findOne({ userId, zohoInvoiceId })` first (the pattern used in `/invoices/[id]/pdf/route.ts:49`), then call Zoho.
**Effort:** 30 min.

#### [H2] Anthropic chat endpoint — unauthed, no rate-limit
**File:** [app/api/chat/route.ts:19-59](app/api/chat/route.ts#L19-L59)
**Problem:** Public POST streams Claude responses (1024 max_tokens, 20-turn history) with no auth, no rate-limit, no reCAPTCHA. A trivial loop drains the `ANTHROPIC_API_KEY` budget.
**Fix:** Wrap with `rateLimiters` IP-keyed bucket (e.g. 10/min/IP) **and** require a session OR reCAPTCHA v3 token.
**Effort:** 30 min.

#### [H3] Trial-abuse check-then-act race
**File:** [lib/trial-abuse.ts:111-140](lib/trial-abuse.ts#L111-L140) + `recordTrialClaim` at L168
**Problem:** `evaluateTrialAbuse` queries `TrialClaim.exists(...)` and the claim row is only inserted after Razorpay verifies. Two concurrent requests from the same IP/device both pass the check.
**Fix:** Sparse unique index on `(ipHash, deviceFingerprint)`; catch `E11000` as "already claimed."
**Effort:** 15 min.

#### [H4] Service-layer bypass — Order / Hosting / SupportTicket
**Files:** 54 route files across `app/api/**`. ~58 direct `Order.*` callsites, ~26 direct `Hosting.*` callsites. Examples: [app/api/admin/hosting/assign/route.ts:7,83](app/api/admin/hosting/assign/route.ts), [app/api/admin/domains/route.ts:40](app/api/admin/domains/route.ts), [app/api/workers/process-hosting-expiry/route.ts](app/api/workers/process-hosting-expiry/route.ts).
**Problem:** HIGH-4 closed only `User`; Order, Hosting, SupportTicket still have routes that call `.save()` / `Model.find` directly, bypassing the service layer.
**Fix:** Replicate the User-service migration pattern for the other three. Each landed in ~3-4 commits in HIGH-4.
**Effort:** Multi-hour, can be split across sessions.

#### [H5] `provisionCartItems` is 950 lines
**File:** [lib/services/payment/provisioner.ts:95-1054](lib/services/payment/provisioner.ts) (one exported function)
**Problem:** Spans 95 → 1054 of a 1054-line file. Deeply nested DA + RC + email + dates + reminder logic in one body — effectively untestable as a whole.
**Fix:** Decompose into per-item provisioner (domain vs hosting), reminder scheduler, DA-account allocator.
**Effort:** Multi-hour.

### MEDIUM

#### [M1] Inconsistent cron auth
**Files:** [app/api/workers/check-domain-watch/route.ts:31-32](app/api/workers/check-domain-watch/route.ts#L31-L32), [process-service-expiry/route.ts:80-81](app/api/workers/process-service-expiry/route.ts#L80-L81), [sync-zoho-invoice/route.ts:43-44](app/api/workers/sync-zoho-invoice/route.ts#L43-L44), `process-hosting-expiry/route.ts:22-23` (needs verification).
**Problem:** These four use plain `authHeader !== process.env.CRON_SECRET` (timing-vulnerable). Other crons + `/api/cron/*` use `crypto.timingSafeEqual`.
**Fix:** Shared `authorizeCronRequest(request)` helper; replace all four.
**Effort:** 30 min.

#### [M2] CSRF middleware only covers `/api/admin/*`
**File:** [middleware.ts:297-303](middleware.ts#L297-L303)
**Problem:** `/api/user/*` and `/api/payments/*` mutating routes have no Origin/Referer check; defence reduces to NextAuth's `sameSite:lax` cookie, which still allows top-level navigation POSTs.
**Fix:** Move `validateCSRF` above the admin branch so it runs for any authenticated mutating `/api/*`.
**Effort:** 30 min.

#### [M3] User model leaks `password` + `resetToken` by default
**File:** [models/User.ts:97,242](models/User.ts#L97) (password) + L242 (resetToken)
**Problem:** Neither field has `select: false`. Other secret fields (`totpSecret`, `pendingEmailToken`) do. Any naive `User.findById(...)` (including `getUserById` in the service) returns the bcrypt hash + live reset token; `JSON.stringify` of the doc leaks both.
**Fix:** Add `select:false` to both. Explicitly `.select('+password')` in the login + reset flows (the service has helpers for this already).
**Effort:** 30 min.

#### [M4] Raw upstream errors echoed to client
**File:** [app/api/user/hosting/renew/route.ts:156-157](app/api/user/hosting/renew/route.ts#L156-L157) (and likely other `/api/user/*` routes)
**Problem:** `secureErrorResponse(error.message, …)` echoes Razorpay/Mongo error strings back to the client (e.g. credential / network detail in upstream errors).
**Fix:** Return a generic message; keep the real one in `serverLogger`.
**Effort:** 15 min per route.

#### [M5] Repeated `order.domains.find()` pattern in 16+ files
**Files:** [app/api/user/domains/nameservers/route.ts:52](app/api/user/domains/nameservers/route.ts#L52), [app/api/admin/domains/dns/route.ts:63,150,247](app/api/admin/domains/dns/route.ts), [app/api/admin/pending-domains/[id]/register/route.ts:81,89,98,184](app/api/admin/pending-domains/%5Bid%5D/register/route.ts), + ~12 more.
**Problem:** Same `(d) => d.domainName === name` lookup repeated. Each callsite has its own type cast.
**Fix:** Add `findDomainItem(order, name)` / `mapDomainItems(order)` helpers in `lib/services/orders.ts`.
**Effort:** 1 hr.

#### [M6] 30 inline `session.user as {…}` narrowings
**Files:** Across `app/**` and `lib/**`. Examples: [app/api/admin/log-error/route.ts:46](app/api/admin/log-error/route.ts#L46), [app/api/admin/users/services/route.ts:18](app/api/admin/users/services/route.ts#L18).
**Problem:** Each route re-narrows `(session.user as { id?, role?, … })` piecemeal.
**Fix:** One `getAuthedUser(req): { id; role; email }` helper in `lib/auth.ts`, or `next-auth` module augmentation.
**Effort:** 1 hr.

#### [M7] Zero unit tests for `lib/services/*`
**Directory:** `tests/unit/lib/services/` does not exist.
**Problem:** The 15 service modules introduced in HIGH-4 (users, orders, hostings, domains, pending-hostings, etc.) have no direct unit tests. Integration tests cover only the two payment routes.
**Fix:** Add unit tests per service against the existing `mongodb-memory-server` scaffolding from MEDIUM-5.
**Effort:** Multi-hour.

### LOW

#### [L1] N+1 shape in admin users-services list
**File:** [app/api/admin/users/services/route.ts:39](app/api/admin/users/services/route.ts#L39)
**Problem:** Iterates `allServiceUsers` and does linear `.some()` over `verifiedUsers` per row (O(n·m)).
**Fix:** Build a `Set<_id>` once before the loop.
**Effort:** 15 min.

#### [L2] Stale unused `User` import
**File:** [app/api/admin/hosting/assign/route.ts:7](app/api/admin/hosting/assign/route.ts#L7)
**Problem:** Imports `User` but never references it directly — also confirms [H4] bypass since the route mutates the doc inline.
**Fix:** Remove import; move mutation into the user service.
**Effort:** 5 min (combined with [H4]).

#### [L3] Chat model version drift (needs verification)
**File:** [app/api/chat/route.ts:48](app/api/chat/route.ts#L48)
**Problem:** Uses `claude-haiku-4-5`; cutoff in env says 2026-01, current latest haiku tier may be newer.
**Fix:** Verify against current Anthropic model list; bump if needed.
**Effort:** 15 min.

---

## Recommended order

### Batch 1 — security-heavy (~3 hrs, 6 items)
[H1] IDOR invoice-pay + [H2] chat rate-limit + [H3] trial-abuse race + [M1] cron timing-safe + [M2] CSRF on user routes + [M3] User `select:false`.

### Batch 2 — quality / refactor (multi-hour, can be split)
[M5] domain-find helper + [M6] `getAuthedUser` helper + [L1] N+1 fix + [L2] stale import + [L3] chat model bump + [M4] error-message scrubbing.

### Batch 3 — long-running (multi-session)
[H4] Order/Hosting/SupportTicket service-layer migration + [H5] `provisionCartItems` decomposition + [M7] `lib/services/*` unit tests.

### Strengths to preserve

- Service-layer pattern in [lib/services/](lib/services/) for `User` (every direct call routed through it).
- 459 tests across unit + integration suites — runtime ~40s for full unit + ~5s for integration.
- Mongoose timestamps + index audit complete; structured logging; CSP iframe-isolated for Razorpay.
- Atomic Cloud Run deploy with `deploy-cloud-run.sh` CI-gate + smoke test.
- Auto-retry cron drains deferred hostings when DA recovers; admin "Retry" + cron share the same `provisionPendingHosting` code path.
