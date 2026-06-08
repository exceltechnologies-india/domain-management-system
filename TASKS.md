# Domain Management Portal — Tasks

**Last updated:** 08 Jun 2026

## In Flight

(nothing in flight)

## Recently Shipped — user-visible improvements

- [x] **Customer dashboard page** — added automated safety checks for the dashboard data feed: one customer can never see another's orders or hosting; a deactivated account holding a still-valid login token can't reach the data; broken background-sync jobs don't blank the dashboard; the upcoming-renewal list only shows real registered items inside a 30-day window (queued for next deploy)
- [x] **Payment provider webhook (Razorpay)** — added automated safety checks to the webhook endpoint that receives payment-status updates from the provider: only requests cryptographically signed by the provider are accepted; messages older than 24 hours are rejected (anti-replay); duplicate deliveries within a 15-minute window are deduplicated at the cache layer; the database is the long-term safety net (deploy `dms-00103-dmg` live)
- [x] **Customer domain-watch list (add / list / remove)** — added automated safety checks: per-customer cap (20 domains) to prevent abuse; duplicate-add attempts return a clean "already watching" message instead of a crash; one customer can't see or remove another customer's watches (deploy `dms-00103-dmg` live)
- [x] **Public contact form** — added automated safety checks: bots are filtered by reCAPTCHA before any email is sent; user-supplied HTML is stripped before being rendered into the admin email and the user's confirmation email (anti-XSS); validation errors are surfaced cleanly to the user (deploy `dms-00103-dmg` live)
- [x] **Customer nameserver-change endpoint** — added automated safety checks so customers can't change nameservers for domains they don't own, and malformed nameservers are rejected before being sent to the registrar (deploy `dms-00103-dmg` live)
- [x] **Email-change flow (request + confirm)** — added automated safety checks: password is re-verified before a change is started; social-login accounts (e.g. Google) can't bypass that check; the confirmation link expires after 1 hour, signs the user out on every device, and is safe against email-enumeration probes (deploy `dms-00102-7q5` live)
- [x] **Customer hosting-stats page** — added automated safety checks for the customer-facing hosting dashboard, mirroring the admin version (per-customer rate limit, slow DirectAdmin server handled gracefully) (deploy `dms-00102-7q5` live)
- [x] **Public TLD pricing display page** — added automated safety checks so the live pricing API stays fast (cached), and a specific-TLD lookup always gets a fresh price (uncached) (deploy `dms-00101-xr2` live)
- [x] **Admin order-management page** — added automated safety checks for the order list, archive, and unarchive flows (deploy `dms-00101-xr2` live)
- [x] **Admin pending-domains list page** — added automated safety checks so the page handles invalid filters, big page sizes, and broken inputs without crashing
- [x] **Reorganized this task tracker** so it reads in plain English for the senior reviewer (technical details moved to `docs/AUDIT-TECHNICAL.md`)
- [x] **Admin can manually provision a hosting account from the dashboard** — safety checks added so a slow hosting server doesn't lock up the form, and failed attempts are queued for retry instead of vanishing
- [x] **Admin can create / list / edit hosting packages** — package price changes now automatically sync with the payment provider for renewals
- [x] **Customer payments now go through stricter security checks** so the system can't be tricked into accepting underpayment, or sneaking unpaid items past the verification gate
- [x] **Guest checkout (no account needed) is hardened** against email-claim attacks where someone tries to bind a paid purchase to another customer's account
- [x] **Domain search is faster on repeat queries** thanks to caching, and won't lock up if the upstream registry is slow
- [x] **Profile edits are locked down** so a regular user can't accidentally (or intentionally) promote themselves to admin
- [x] **Set-password flow works correctly for users who originally signed in with Google** (previously it asked them for a "current password" they never had)
- [x] **Admin hosting-stats page degrades gracefully when DirectAdmin is slow** — shows cached data instead of a blank page after 5 seconds
- [x] **Admin TLD-pricing dashboard** loads faster (cached), and refuses to cache an empty result so a brief upstream outage can't make it look like "no TLDs available"
- [x] **Admin can mark pending domains as completed / failed / cancelled**, with proper sync back to the customer's order and the registrar
- [x] **Payment confirmation and renewal-reminder emails** (and WhatsApp messages) verified end-to-end
- [x] **One-time-use backup codes for two-factor login** work as expected; admin-initiated 2FA reset properly revokes existing sessions

## Backlog

- [ ] **Split the largest admin pages** (User Management, DNS Management, Hosting, System Settings) into smaller pieces so they're easier to maintain
- [ ] **Run accessibility checks automatically in the build pipeline** so the site stays usable for screen-reader users
- [ ] **Tighten one legacy database field** (pending-domain identifier) — needs a one-time data audit before the change

---

_Technical history & per-batch engineering details: see [`docs/AUDIT-TECHNICAL.md`](docs/AUDIT-TECHNICAL.md)_
