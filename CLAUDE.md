# Project conventions for Claude Code

This file holds workspace-level instructions that apply to every session in this repo.

## Audit-cycle workflow (MANDATORY)

When working through an audit cycle backed by a markdown file (the active one is `TASKS.md`; historical ones may exist as `rescan-3.md`, `audit.md`, etc.), the audit MD is the source of truth for what is done, in flight, and pending. After **every** shipped batch you must:

1. Update the status table in the audit MD: mark the item ✅ Done (or 🔄 In progress / ⏸ Deferred as appropriate). Include the short commit hash next to the status when the batch has landed.
2. Refresh the "suggested batching" / next-batches list at the top so completed items are struck through or removed and the numbering still reads cleanly.
3. Refresh the summary line at the top (e.g. "N vertical slices shipped (X RC + Y DA + …)") so a future reader sees the current count without reading the whole table.
4. Commit the audit-MD update — either bundled with the batch's code commit, or as a follow-up `docs:` commit referencing the batch.

Do this **every time**, not just at end-of-session. The audit file going stale is the single fastest way to lose track of what has shipped vs what is still pending across multi-batch cycles.

If multiple audit MDs are active (e.g. an older `audit.md` plus the newer `TASKS.md`), update the one that owns the batch and leave the others alone.

### Flipping In-Flight → Done in TASKS.md (reviewer dashboard parser)

The senior reviewer dashboard at task.anutech.in parses TASKS.md entries by **title text**. When an In-Flight entry's title stays verbatim and only the `[ ]` flips to `[x]`, the dashboard reconciles the hourglass to a check on the ORIGINAL day's row — but registers NO event for the day the fix actually shipped. Today's-view ends up showing 0 events even though work landed.

**The rule**: when flipping an In-Flight item to ✅ Done, ADD a NEW `[x]` "Recently Shipped" entry above it with a distinct title (e.g. prefixed with "FIXED:" or rewritten to describe the resolution). Keep the original In-Flight row in place too — flip its `[ ]` to `[x]` and append a "✅ RESOLVED on YYYY-MM-DD" prefix to the body for the audit trail. Result: yesterday's row reconciles ⏳ → ✅ AND today's view shows the freshly-shipped resolution event. Both reviewers see the full report-in → resolution-out arc.

NEVER delete completed tasks — audit trail. The dashboard, the codebase history, and the project memory all rely on the historical entries staying in place. (See auto-memory `feedback_tasks_flip_dual_entry`.)

## HARD RULE — Never let secrets reach git

**Single biggest "cost-per-mistake" rule in this repo.** A MongoDB Atlas password leaked into the initial commit and stayed in git history until 2026-06-29 — cleanup cost was a history rewrite + force-push of 147 tags + password rotation + Secret Manager v2 + Cloud Run redeploy. Don't repeat.

**Enforcement (defence in depth):**

1. **Pre-commit hook** at `.husky/pre-commit` calls `scripts/check-staged-for-secrets.sh` BEFORE eslint/tsc. The script greps staged hunks (ADDED lines only) for: MongoDB URIs with embedded credentials, Razorpay live/test key SECRETS (24+ chars after `rzp_live_/rzp_test_` — Key IDs are shorter and OK), Anthropic API keys (`sk-ant-`), AWS access keys (`AKIA…`), GCP service-account `private_key` JSON fields, PEM `BEGIN PRIVATE KEY` blocks, and env-var-shape secret assignments (`KEY/SECRET/TOKEN/PASSWORD = "long-random"`). Blocks the commit on any match.
2. **`.gitignore`** covers `.env`, `.env.*` (except `.env.example`), `gcp-key.json`, `service-account*.json`, `*.json.key`, and `scripts/*-backup-*.json`. Don't loosen these without re-adding what you removed.
3. **Two-store discipline** (see auto-memory `project_secret_manager_split`): `.env.local` is for local dev + build-time-public values; Google Secret Manager holds the production runtime secrets. Updating one without the other will silently break the OTHER environment. Always pair them when rotating.

**When to override (`--no-verify`):**
Only for confirmed false positives — e.g., an intentional test fixture string that triggers the regex. NEVER skip to commit a real secret. If you skipped and a real secret slipped, you owe a history rewrite + a rotation, not a quiet fix-forward.

**If you find a leaked credential already in history:** rotate the live credential FIRST (Atlas/Razorpay/whichever console), then `gcloud secrets versions add NAME --data-file=-` for the runtime store, then force a new Cloud Run revision (env-var nudge or full redeploy), THEN rewrite git history + force-push. The order matters — rewriting history while the leaked credential is still live just hides it from new clones without actually securing anything.

## Trial order invoice policy (operator decision 2026-06-30)

**Do NOT generate a Zoho Books invoice for ₹0 trial signups.** The Order row gets persisted (`amount: 0, status: 'pending', orderType: 'hosting_trial'`) as the audit trail; the Hosting row gets created with `isTrial: true` and `billingType: 'manual'`; the welcome email fires when the DA-provisioning cron flips the Hosting to active. None of that emits a tax invoice.

The customer's FIRST tax invoice fires at day 15+ when the trial converts via the renewal flow (`/api/user/hosting/renew` → Razorpay one-shot order → `/api/payments/verify` → `createZohoInvoice` in `lib/services/payment/post-tasks.ts`). At that point the renewal Order has the real ₹599.88 (Starter yearly) / ₹1,500 (Standard yearly) / ₹2,246.40 (Plus yearly) amount, and the invoice issued matches the actual charge.

**Why this is correct**: Indian GST requires a tax invoice only for a taxable supply with consideration > 0. Issuing ₹0 invoices in Zoho would clutter the books, complicate revenue reporting, and create unnecessary reconciliation work for the finance team. AWS / Netflix / Spotify / GoDaddy all follow the same pattern — invoice fires at first real charge, not at trial signup.

**Enforcement**: `createZohoInvoice` in `lib/services/payment/post-tasks.ts` short-circuits at the top with `if (!orderAmount || orderAmount <= 0 || orderType === 'hosting_trial') return earlyWithNoInvoice;`. The guard fires before any retry/claim logic so neither an accidental zero-amount caller nor a future code path that hands a trial Order can issue an invoice in Zoho. The guard is belt-and-suspenders — current callers (`payments/verify` + `payments/guest/verify`) only fire on a real Razorpay payment, which always has amount > 0; the guard defends against future regressions.

If a customer ASKS for a trial-period invoice: there is none. Canned response: *"No invoice is issued for the free trial period since there's no charge. Your first invoice will be generated automatically when your trial converts on day 15 — that's when your card / UPI mandate is charged for the first time."*

## Other persistent conventions

- Do not surface credential/key rotation as a next step — the user has opted out for this project (see auto-memory `feedback_key_rotation_skip`). **Exception**: active leaks discovered via security review override this preference; rotate immediately, don't ask twice.
- Do not force-restart the DirectAdmin/hosting server or aggressively roll IPs — the Cloud Run NAT IP must stay whitelisted at all 4 DA layers (see auto-memory `project_da_whitelist_layers`).
- After triggering a deploy via `scripts/deploy-cloud-run.sh`, tail the output so the user sees progress (see auto-memory `feedback_deploy_progress`).
- **Always use the local Docker build path** when deploying. `bash scripts/deploy-cloud-run.sh` already defaults to local — do NOT pass `--cloud-build`, and do NOT propose Cloud Build (`gcloud builds submit`) as an alternative. Cloud Build on `E2_HIGHCPU_8` was costing ~$0.08/deploy and ~10 deploys/day adds up; the VPS already runs 24/7 so local builds are free at the margin. If Docker is missing on the host running the script, fix Docker — don't fall back to Cloud Build. The `--cloud-build` flag and `cloudbuild.yaml` stay in the repo only as an emergency escape hatch for machines that don't have Docker (see auto-memory `feedback_local_build_only`).
