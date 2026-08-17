/**
 * Sub-reseller feature kill-switch (env-only, DEFAULT ON).
 *
 * The reseller feature ships live by default; this flag exists purely as a
 * disable-without-redeploy escape hatch. It is the INVERSE of the trial-abuse
 * gate (`lib/trial-abuse.ts`): the feature is enabled unless `RESELLER_FEATURE_ENABLED`
 * is EXPLICITLY set to a falsey value (`false` / `0` / `no` / `off`). An unset
 * or empty var means enabled.
 *
 * Env-only, no admin DB toggle — same rationale as the other feature gates
 * (see auto-memory `feedback_no_db_kill_switch`).
 */
export function isResellerFeatureEnabled(): boolean {
  const v = (process.env.RESELLER_FEATURE_ENABLED ?? "").toLowerCase().trim();
  if (v === "") return true; // unset → enabled (default ON)
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}
