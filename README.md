# Anutech Digital — Domain & Hosting Management Platform

A production web application for **Anutech Digital Private Limited** that lets customers search and register domains, buy and manage web hosting, configure DNS, and pay online — with a full admin back office for operating the business. Built on **Next.js (App Router)** and deployed on **Google Cloud Run**.

- **Package:** `domain-management-system` · **Version:** 3.3.0
- **Live:** https://app.anutech.in

> **This app can run in two shapes, and which one you get is configuration.**
> Standalone (the live deployment today) it is the whole product, marketing
> homepage included. With `NEXT_PUBLIC_RESELLEROS_URL` set it becomes the
> hosting/domain **engine and panel behind ResellerOS**: `/` redirects to
> ResellerOS and DMS serves no homepage of its own. See
> [ResellerOS integration](#reselleros-integration).

---

## Features

**Customer-facing**
- Domain search & registration across 100+ TLDs (real-time availability + transparent pricing) via **ResellerClub**
- Domain management — DNS records, nameservers, WHOIS privacy, transfers & expiry reminders
  (renewal is **not** self-service — see [Domain renewal](#domain-renewal-is-not-self-service))
- Web hosting purchase, provisioning & management via **DirectAdmin** (plans, trials, upgrades, renewals)
- Cart & checkout (guest + logged-in) with **Razorpay** payments (cards, UPI, net-banking, e-mandates/autopay)
- Automated tax invoicing via **Zoho Books**
- Accounts with **NextAuth** (credentials + OAuth), TOTP 2FA, email notifications with one-click unsubscribe

**Admin back office**
- Domain, hosting, order, payment, invoice & user management
- DNS management, pricing management, recurring-charge & renewal dashboards
- Integration-health monitoring (Razorpay / Zoho / DirectAdmin) and system settings

## Tech Stack

| Area | Technology |
|------|-----------|
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS, Framer Motion, lucide-react |
| Data | MongoDB (Mongoose), Redis (ioredis) for caching/rate-limiting |
| Auth | NextAuth, bcryptjs, otplib (TOTP 2FA), JWT |
| Payments & billing | Razorpay, Zoho Books |
| Integrations | ResellerClub (domains), DirectAdmin (hosting), Google Cloud Tasks |
| Validation | Zod, validator |
| Email | Nodemailer (SMTP) |
| Testing | Vitest |
| Runtime | Node.js ≥ 20 · deployed on Google Cloud Run (Docker) |

## Project Structure

```
app/            Next.js App Router — pages + API routes
  api/          Backend route handlers (domains, hosting, payments, admin, webhooks…)
  admin/        Admin back-office pages
  dashboard/    Authenticated customer dashboard
  login/ hosting/ domains/ cart/ checkout/ about/ contact/ privacy/ …
                Public pages. Flat, NOT a `(public)` route group — this README
                claimed one until 2026-09-21 and there has never been one.
components/     Reusable UI + feature components
lib/            Services & integrations (payments, resellerclub, directadmin, email, logger…)
models/         Mongoose schemas
hooks/          React hooks
store/          Zustand stores
middleware/     Next.js middleware
config/         App configuration
scripts/        Ops scripts (deploy, health-check, DB migrate, secret scan…)
tests/          Vitest unit + integration tests
docs/           Technical docs
```

## Getting Started

### Prerequisites
- Node.js ≥ 20
- MongoDB instance (Atlas or local)
- Redis instance
- Accounts/credentials for the third-party integrations you intend to exercise (Razorpay, ResellerClub, DirectAdmin, Zoho Books)

### Setup

> **Running locally?** Use `bash scripts/run-local.sh`. reCAPTCHA's site key is
> domain-locked to production, so on localhost the widget errors and the Sign in
> button stays disabled; the script blanks the reCAPTCHA keys **for that process
> only** and points `APP_URL`/`NEXTAUTH_URL` at localhost so activation emails
> don't link to production. Do *not* blank the keys in `.env.local` —
> `deploy-cloud-run.sh` reads the site key from there and would ship the blank
> to production.

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file from the template and fill in values
cp .env.example .env.local

# 3. (Optional) initialize the database / create an admin user
npm run init-db
npm run recreate-admin

# 4. Run the dev server (http://localhost:3000)
npm run dev
```

Or run the whole stack — app, MongoDB and Redis — in containers, which is how
the ResellerOS integration is developed against:

```bash
docker compose up -d --build     # http://localhost:4310
```

The compose stack points ResellerClub and DirectAdmin at `.invalid` hosts so a
stray real credential cannot reach them. It does **not** isolate the network:
the container has working internet, so that config is the whole of the safety.



### Environment variables
All configuration is supplied via environment variables — see [`.env.example`](.env.example) for the full list (Mongo/Redis, NextAuth secrets, Razorpay, ResellerClub, DirectAdmin, Zoho, SMTP, reCAPTCHA, etc.).

> **Note on production secrets:** local dev + build-time-public values live in `.env.local`; production runtime secrets live in **Google Secret Manager**. Rotating a secret means updating *both* stores. Never commit real secrets — a pre-commit hook (`.husky/pre-commit` → `scripts/check-staged-for-secrets.sh`) scans staged changes and blocks known secret patterns.



## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the dev server (Turbopack) |
| `npm run build` | Production build (+ copies static assets into the standalone output) |
| `npm run start` | Start the production server |
| `npm run lint` | ESLint |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:coverage` | Unit tests with coverage |
| `npm run test:int` | Integration tests |
| `npm run health` | Run the health-check script |
| `npm run migrate` / `migrate:status` / `migrate:dry` | Database migrations |
| `npm run init-db` / `recreate-admin` | DB bootstrap helpers |
| `npm run deps:check` | `npm audit` + `npm outdated` |
| `bash scripts/run-local.sh` | Run locally with reCAPTCHA disabled and emails pointed at localhost (`--prod` for a standalone build) |
| `docker compose up -d --build` | Local stack: DMS on **4310** + MongoDB + Redis, upstreams pointed at `.invalid` hosts (see [ResellerOS integration](#reselleros-integration)) |
| `bash scripts/setup-cloud-scheduler-tokens.sh` | Provision the Tokens-flow Cloud Scheduler jobs (idempotent) |
| `bash scripts/setup-cloud-scheduler-billing.sh` | Provision the billing Cloud Scheduler jobs — renewal-payment dunning (idempotent; see [docs/renewal-payment-dunning.md](docs/renewal-payment-dunning.md)) |

## Testing

```bash
npm test              # all unit tests (Vitest, jsdom)
npm run test:watch    # watch mode
npm run test:int      # integration tests (Vitest, node env)
```

### Mock testing — how we test payment/provisioning logic without real charges

Money-path and third-party flows (Razorpay charges/refunds, DirectAdmin
provisioning, email) can't hit the real APIs in a unit test — that would cost
money, mutate live data, or fail offline. Instead we **mock the external
dependency at the module boundary and test *our* logic's reaction** to each
outcome it can return.

**The pattern** (see `tests/unit/lib/services/payment/recurring-charge-service.test.ts`
for a full example):

1. **Mock the boundary** with `vi.hoisted` + `vi.mock` so the mock is in place
   before the module under test imports it:
   ```ts
   const chargeViaToken = vi.hoisted(() => vi.fn());
   vi.mock("@/lib/razorpay", () => ({ RazorpayService: { chargeViaToken } }));
   const daSuspendUser = vi.hoisted(() => vi.fn());
   vi.mock("@/lib/integrations/directadmin", () => ({ suspendUser: daSuspendUser }));
   ```
   Also mock the DB models (`@/models/*`) and `@/lib/mongodb` so nothing tries
   to reach Mongo — `beforeEach` resets every mock to a known-good default.

2. **Drive one outcome per test** by controlling what the mock returns/throws,
   then assert what *our* code did:
   ```ts
   // success → renews
   chargeViaToken.mockResolvedValueOnce({ paymentId: "pay_x", orderId: "order_x" });
   // hard decline → suspends (tagged retriable:false, like the real SDK)
   chargeViaToken.mockRejectedValueOnce(Object.assign(new Error("Card declined"), { retriable: false, statusCode: 400 }));
   // infra failure (404/5xx/timeout) → retry, must NOT suspend
   chargeViaToken.mockRejectedValueOnce(Object.assign(new Error("404"), { retriable: true, statusCode: 404 }));
   ```
   This lets us prove all three day-15 branches — **renew / suspend /
   retry-without-suspend** — deterministically, with zero live payments.

**Rule of thumb:** mock the *thing you don't own* (Razorpay, DA, SMTP, the DB),
and assert on the *behaviour you do own*. Reserve real-API calls for the
explicitly-gated integration tests under `tests/integration/` (e.g.
`razorpay-tokens-live.test.ts`, `razorpay-mit-charge.verify.test.ts`), which
run only against **test-mode** keys and skip when those keys are absent.

## Deployment

Deployed to **Google Cloud Run** via a local Docker build:

```bash
bash scripts/deploy-cloud-run.sh
```

The script builds the image locally, pushes it to Artifact Registry, promotes a new Cloud Run revision, and runs a health smoke-test. Runtime secrets are injected from Google Secret Manager. See `docs/` for deeper technical notes.

### Scheduled jobs

Cron endpoints under `app/api/cron/` and `app/api/workers/` are **not self-starting** — each
needs a Google Cloud Scheduler job. Those are provisioned by idempotent scripts, not by hand,
so the schedule and headers stay version-controlled:

```bash
bash scripts/setup-cloud-scheduler-tokens.sh    # Tokens flow: provisioning, recurring charge, mandate-refund retry
bash scripts/setup-cloud-scheduler-billing.sh   # Billing: renewal-payment dunning
```

Deploy **before** running these — the billing script preflights its endpoint and refuses to
create a job pointing at a route that isn't live yet.

## ResellerOS integration

ResellerOS (`Abhicode0to1/new-reselleros`) is the reseller's billing/CRM app.
DMS is the hosting and domain engine behind it. The two are **federated, not
merged** — DMS keeps its own database, its own admin panel and its own customer
panel, and ResellerOS reaches them over an HTTP API and a signed hand-off.

### The front door

`NEXT_PUBLIC_RESELLEROS_URL` is the single switch.

| | unset (default) | set |
|---|---|---|
| `GET /` | DMS's marketing homepage | `307` to ResellerOS |
| Logo / "home" links | DMS `/` | ResellerOS |
| `/privacy`, `/terms-and-conditions`, `/cancellation-refund`, `/contact`, `/about` | served by DMS | `307` to the ResellerOS equivalent — **for non-admins only** |
| Everything else | unchanged | unchanged |

Those five are **redirected, never 404ed**. Razorpay requires a merchant's
policy pages to be publicly reachable, so the content has to keep existing
somewhere public; each one points at a real ResellerOS page
(`/terms-and-conditions` → `/terms`, `/cancellation-refund` → `/refund`,
`/contact` → `/enquiry`, the rest 1:1). If a target is ever removed from
ResellerOS, remove it from the map in `lib/reseller-os.ts` rather than leaving
a redirect into a 404.

An **admin still gets DMS's own copy**, so the pages stay checkable without
unsetting the front door. That is why these paths join the middleware's
`needsToken` set — and only when the front door is configured, so a standalone
DMS keeps its "public routes fetch no token" property.

**Not taken over:** `/hosting`, `/domains/*`, `/cart` and `/checkout` — the only
working purchase funnel for hosting and domains — and `/login`, `/dashboard`
and `/admin`, which are the point of the app.

Unset is the default on purpose: turning the frontpage off is a deployment
decision, not something that happens to a standalone DMS because this code
merged. The value must include a scheme — a bare host is refused rather than
turned into a link that resolves against the current origin.

It is enforced in two places, both reading `resellerOsUrl()` in
[`lib/reseller-os.ts`](lib/reseller-os.ts): `middleware.ts` (for the status —
`app/` has a `loading.tsx`, so a redirect decided during render arrives after
streaming has begun and degrades to a `200` carrying a one-second
`<meta http-equiv="refresh">`) and `app/page.tsx` (the guarantee, since
middleware only runs where its matcher says).

**`NEXT_PUBLIC_*` is inlined by `next build`, not read at runtime.** It must be
a **build arg**, and it is declared in *both* Dockerfile stages — the builder
copy feeds the client bundle (the links), the runner copy feeds the server
component (the redirect). Setting it only on a running container does nothing.

### Engine API

Read-only, consumed by ResellerOS. Authenticated with `x-integration-key`,
compared in constant time, and **fail closed** — an unset key refuses every
request rather than allowing them.

| Route | Purpose | Key |
|---|---|---|
| `GET /api/integrations/engine/health` | Reachability + capability probe. Booleans only; never echoes a secret and never calls a paid upstream. | `ENGINE_READ_API_KEY` |
| `GET /api/integrations/engine/services` | A customer's domains + hosting, by email. An unknown email is `200` with `linked:false`, not `404`. | `ENGINE_READ_API_KEY` |

Three key names exist, one per blast radius, and they are deliberately not
interchangeable — do not reuse a stronger key to satisfy a weaker check. Only
one of the three is wired to anything today:

| Key | Blast radius | Status |
|---|---|---|
| `ENGINE_READ_API_KEY` | Reads. Cannot change anything, cannot spend. | **In use** by both routes above. |
| `BILLING_COMMAND_API_KEY` | Register / renew / suspend / delete. Treat it like a production password. | Checked by `authorizeEngineCommandRequest`, but **no command route exists yet**. |
| `BILLING_PROVISION_API_KEY` | Creates a login account here. | **Name only.** Nothing reads it — it appears in one comment and in `.env.example`. |

Setting a key that nothing reads grants nothing; the point of listing them is
that a reader should not mistake a reserved name for a working capability.

### SSO hand-off

ResellerOS signs a 60-second, single-use HS256 token with `ENGINE_SSO_SECRET`
and sends the user to `/sso`. [`lib/integrations/engine-sso.ts`](lib/integrations/engine-sso.ts)
verifies it, burns the `jti` in Redis (`SET NX`) and mints a normal NextAuth
session through the `engine-sso` credentials provider. The token says **who**,
never **what**, and it never creates an account — an unknown user is refused.
The secret is separate from `NEXTAUTH_SECRET`/`JWT_SECRET` because it is shared
with another app and is therefore the likeliest of the three to leak.

### Local stack

`docker-compose.yml` runs DMS + MongoDB + Redis with the upstreams pointed at
`.invalid` hosts, so a stray real credential is not on its own enough to reach
ResellerClub or DirectAdmin.

```bash
docker compose up -d --build     # DMS on http://localhost:4310
```

Note what that safety rests on: the container **has working internet**. The
`.invalid` values in `.env.docker` are the only thing stopping a real call.

Two values are passed as **build args** (see the note above): the front-door
URL, and `NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS`, which shows the demo-account panel
on `/login`. The deploy script passes neither, so a production image is built
without them.

## Domain renewal is not self-service

`POST /api/domains/renew` requires the caller to own the domain **and** to
present a verified Razorpay payment, both checked before the registrar is
called. Nothing in the app can currently produce that payment: there is no
retail renewal price for domains anywhere in this codebase (`renewalPrice` is a
`HostingPlan` field, and `getRenewalPricing` returns the *registrar's cost*).
So `components/DomainRenewalModal.tsx` tells the customer renewal is not
self-service yet and routes them to support.

This is not a regression. Before 2026-09-21 the route had no ownership check at
all and took an unverified payment id that the modal **fabricated**, so any
signed-in customer could renew any domain in the reseller account for free —
and it then failed to write its Order row (two schema-required fields were
never passed), returning `500` *after* the registrar had been charged. The
renewal really happened, we really paid, nothing was recorded, and the customer
was told it failed.

To finish the feature: set a markup, then mirror
`app/api/user/hosting/renew/route.ts` — server-price it, `RazorpayService.createOrder`,
persist a pending Order, and let `/api/payments/verify` drive the registrar call.

## Conventions

- Project-wide working conventions and operational runbooks live in [`CLAUDE.md`](CLAUDE.md).

- The active work log / audit trail is tracked in `TASKS.md`.

## License

Proprietary © Anutech Digital Private Limited. All rights reserved.