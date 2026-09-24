/**
 * Which hosting plan can be trialled free: Starter only (owner decision,
 * 24 Sep 2026 — "No other plans is eligible for free trial").
 *
 * The panel dialog has shown the trial button on Starter alone since it was
 * written, but nothing on the server checked, so a hand-built cart line or a
 * direct POST could start a Plus trial. Both gates read this: the eligibility
 * check and create-order. ResellerOS holds the same rule in its own
 * `lib/hosting/trial-plan.ts`; the two repos share no code.
 */
export const TRIAL_PLAN_ID = "starter";

export const TRIAL_PLAN_REFUSAL =
  "The free trial is only on the Starter plan. Start a Starter trial, or add Standard or Plus to your cart and buy it.";

/** True only for Starter. Case-insensitive: the DB stores "Starter", the config "starter". */
export function isTrialPlan(planId: string | null | undefined): boolean {
  return (planId ?? "").trim().toLowerCase() === TRIAL_PLAN_ID;
}
