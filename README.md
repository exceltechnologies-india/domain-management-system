# Anutech Digital — Domain & Hosting Management Platform

A production web application for **Anutech Digital Private Limited** that lets customers search and register domains, buy and manage web hosting, configure DNS, and pay online — with a full admin back office for operating the business. Built on **Next.js (App Router)** and deployed on **Google Cloud Run**.

- **Package:** `domain-management-system` · **Version:** 3.3.0
- **Live:** https://app.anutech.in

---

## Features

**Customer-facing**
- Domain search & registration across 100+ TLDs (real-time availability + transparent pricing) via **ResellerClub**
- Domain management — DNS records, nameservers, WHOIS privacy, transfers, renewals & expiry reminders
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
  (public)      Marketing/auth/checkout pages (home, hosting, about, contact, login…)
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

## Conventions

- Project-wide working conventions and operational runbooks live in [`CLAUDE.md`](CLAUDE.md).

- The active work log / audit trail is tracked in `TASKS.md`.

## License

Proprietary © Anutech Digital Private Limited. All rights reserved.