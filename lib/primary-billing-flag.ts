/**
 * Primary-billing kill-switch (env-only, DEFAULT OFF).
 *
 * Unlike most feature flags in this codebase (e.g. `RESELLER_FEATURE_ENABLED`,
 * default ON — see lib/reseller-flag.ts), this one defaults OFF: flipping it
 * ON changes which engine issues a REAL, legally-numbered GST tax invoice
 * for a live payment (see TASKS.md "Primary Billing Integration"). It
 * should only go ON after Phases 1a/1b/1c have been reviewed end-to-end —
 * while OFF, every call site behaves byte-identically to before this
 * feature existed (falls straight through to the existing Zoho path).
 *
 * Env-only, no admin DB toggle — same rationale as the other feature gates
 * (see auto-memory `feedback_no_db_kill_switch`).
 */
export function isPrimaryBillingEnabled(): boolean {
  const v = (process.env.PRIMARY_BILLING_ENABLED ?? "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}
