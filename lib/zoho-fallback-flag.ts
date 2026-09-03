/**
 * Zoho-invoice **fallback** kill-switch (env-only, DEFAULT ON).
 *
 * Replaces the former `PRIMARY_BILLING_ENABLED` gate (removed 2026-09-03).
 * The relationship inverted: our own GST engine is now **permanent** and
 * ungated — it always issues the tax invoice — and the thing that is
 * optional is whether **Zoho Books acts as the safety net** when our engine
 * fails.
 *
 * Why the switch moved: gating the primary engine meant a config mistake
 * could quietly stop issuing our own legally-numbered `TI/YYYY-YY/NNNNN`
 * invoices. The engine is reviewed, audited and E2E-tested; it should not be
 * something a stray env var can turn off. The genuinely operational question
 * is what to do on failure, and that is what this flag answers.
 *
 * Same opt-out shape as `RESELLER_FEATURE_ENABLED` (lib/reseller-flag.ts):
 * the fallback is enabled unless `ZOHO_INVOICE_FALLBACK_ENABLED` is
 * EXPLICITLY set to a falsey value (`false` / `0` / `no` / `off`). Unset or
 * empty means enabled, which is the recommended production setting.
 *
 * ── What turning it OFF actually does ────────────────────────────────────
 * With the fallback disabled, a primary-engine failure is no longer papered
 * over: `createPrimaryInvoice` rethrows, and the caller's existing handling
 * takes over — a durable SystemLog row, `zohoInvoiceId: 'creation_failed'`
 * on the Order, and the order surfacing in admin integration-health as a
 * stuck invoice.
 *
 * That means a customer whose payment SUCCEEDED can be left temporarily
 * without any invoice at all. That is the deliberate trade: no Zoho-numbered
 * invoice sneaks into a GSTIN you are trying to keep on a single series, at
 * the cost of needing an operator to resolve the failure. Only disable it if
 * you would rather fix a failure by hand than have Zoho issue a
 * second-series invoice automatically.
 *
 * Leave it ON unless you have that specific reason.
 *
 * Env-only, no admin DB toggle — same rationale as the other feature gates
 * (see auto-memory `feedback_no_db_kill_switch`).
 */
export function isZohoInvoiceFallbackEnabled(): boolean {
  const v = (process.env.ZOHO_INVOICE_FALLBACK_ENABLED ?? "").toLowerCase().trim();
  if (v === "") return true; // unset → enabled (default ON)
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}
