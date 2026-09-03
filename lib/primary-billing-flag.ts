/**
 * Primary-billing kill-switch (env-only, **DEFAULT ON** as of 2026-09-03).
 *
 * Our own GST engine is the PRIMARY invoice issuer: it mints the real,
 * legally-numbered `TI/YYYY-YY/NNNNN` tax invoice, and Zoho Books is the
 * automatic **fallback**, called only when the primary engine throws (see
 * lib/services/billing/createPrimaryInvoice.ts). Operator decision
 * 2026-09-03 — the post-Phase-2 audit closed the last correctness gaps, so
 * the feature ships enabled rather than opt-in.
 *
 * Same shape as `RESELLER_FEATURE_ENABLED` (lib/reseller-flag.ts): enabled
 * unless `PRIMARY_BILLING_ENABLED` is EXPLICITLY set to a falsey value
 * (`false` / `0` / `no` / `off`). Unset or empty means enabled.
 *
 * ── Rolling it back ──────────────────────────────────────────────────────
 * This is the emergency escape hatch if the GST engine misbehaves on live
 * payments. Disable it with the LITERAL string, never by removing the var:
 *
 *   gcloud run services update dms --region=europe-west1 \
 *     --update-env-vars PRIMARY_BILLING_ENABLED=false
 *
 * `scripts/deploy-cloud-run.sh` treats an EMPTY Cloud Run value as "not
 * set" and falls through to the deploying machine's `.env.local`, so
 * `--remove-env-vars` would hold only until the next full deploy. A
 * non-empty "false" wins that chain and sticks. Disabling sends every call
 * site straight back down the pre-existing Zoho path.
 *
 * NOTE: disabling does NOT retroactively change invoices already issued.
 * Orders carrying `invoiceProvider: 'primary'` keep their `TI/...` numbers
 * — those are issued tax documents, not a rendering preference. Guards in
 * the admin re-sync route and the sync-zoho-invoice worker exist precisely
 * so a flag flip-flop can't re-invoice them through Zoho.
 *
 * Env-only, no admin DB toggle — same rationale as the other feature gates
 * (see auto-memory `feedback_no_db_kill_switch`).
 */
export function isPrimaryBillingEnabled(): boolean {
  const v = (process.env.PRIMARY_BILLING_ENABLED ?? "").toLowerCase().trim();
  if (v === "") return true; // unset → enabled (default ON)
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}
