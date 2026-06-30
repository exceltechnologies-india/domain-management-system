/**
 * HostingPlan service.
 *
 * HostingPlan is the read-heavy registry of catalogue entries (Starter,
 * Standard, Plus, etc.). The same pattern — look up by external `planId`,
 * sometimes filtered to active — repeats across user routes, workers, and
 * payment-services. Centralising it removes the temptation for callers to
 * add their own subtly-different filter (e.g. forgetting `isActive`).
 *
 * Admin CRUD routes (create / update / upsert) retain direct model access
 * for now: each carries its own business logic (sync with DirectAdmin, etc.)
 * that doesn't generalise into a service helper without losing meaning.
 */
import connectDB from "@/lib/mongodb";
import HostingPlan from "@/models/HostingPlan";
import type { IHostingPlan } from "@/models/HostingPlan";

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up a plan by its external `planId` (e.g. `"plus"`). Returns null when
 * not found. The most common HostingPlan access pattern — every renewal,
 * upgrade, trial-eligibility, and invoice-build path starts here.
 */
export async function getPlanByPlanId(
  planId: string,
  opts?: { activeOnly?: boolean }
): Promise<IHostingPlan | null> {
  await connectDB();
  // Case-insensitive lookup — the live DB has mixed-case planIds (commercial
  // tiers 'Starter'/'Standard'/'Plus' are capitalized to match DA package
  // names, but the frontend's HOSTING_PLANS config sends lowercase 'starter'
  // /'standard'/'plus' IDs, and DA-internal package names like '25GB-wp' /
  // 'ultimatepackage' are themselves mixed-case). Without this normalization,
  // a Manual-flow trial signup on the Starter plan emitted the misleading
  // "This plan is not available for a free trial" toast because line-90 of
  // /api/user/hosting/trial-eligibility couldn't find the row.
  const filter: Record<string, unknown> = {
    planId: { $regex: `^${planId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  };
  if (opts?.activeOnly) filter.isActive = true;
  return HostingPlan.findOne(filter);
}

/**
 * Admin-only lookup by Mongo `_id`. Used by routes that already hold a
 * primary-key reference (e.g. defaults-sync, package management).
 */
export async function getPlanById(id: string): Promise<IHostingPlan | null> {
  await connectDB();
  return HostingPlan.findById(id);
}

/**
 * Look up a plan whose `razorpayPlans.monthly` OR `razorpayPlans.yearly`
 * matches the given Razorpay subscription `plan_id`. Used by the
 * `subscription.charged` webhook to determine which local plan a recurring
 * charge belongs to (and therefore the renewal duration).
 */
export async function getPlanByRazorpaySubscriptionPlanId(
  razorpayPlanId: string
): Promise<IHostingPlan | null> {
  await connectDB();
  return HostingPlan.findOne({
    $or: [
      { "razorpayPlans.monthly": razorpayPlanId },
      { "razorpayPlans.yearly": razorpayPlanId },
    ],
  });
}

/**
 * List every active plan, sorted by price ascending. The default ordering
 * matches what the upgrade UI wants ("upgrade tier" = next-higher price);
 * pass `sort: false` if you need insertion order instead.
 */
export async function listActivePlans(
  opts?: { sort?: false | "price-asc" | "price-desc" }
): Promise<IHostingPlan[]> {
  await connectDB();
  const sortOpt = opts?.sort;
  let query = HostingPlan.find({ isActive: true });
  if (sortOpt !== false) {
    const dir = sortOpt === "price-desc" ? -1 : 1;
    query = query.sort({ price: dir });
  }
  return query;
}

/**
 * Lean variant of {@link getPlanByPlanId} — admin GET routes that only
 * surface the document as JSON (e.g. the test-plan toggle screen) skip
 * the Mongoose Document hydration cost.
 */
export async function getPlanByPlanIdLean(
  planId: string
): Promise<any | null> {
  await connectDB();
  // Mirrors the case-insensitive normalization in getPlanByPlanId — see
  // that function's comment for the full rationale.
  return HostingPlan.findOne({
    planId: { $regex: `^${planId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  }).lean();
}

// ─── Writes (admin) ───────────────────────────────────────────────────────────

/**
 * Toggle `isActive` on a plan by external planId. Used by the test-plan
 * enable/disable toggle and the admin packages screen. Returns the
 * `updateOne` result so callers can detect "no such plan" (matchedCount 0).
 */
export async function setPlanActive(
  planId: string,
  isActive: boolean
): Promise<{ matched: number; modified: number }> {
  await connectDB();
  const r = await HostingPlan.updateOne({ planId }, { $set: { isActive } });
  return { matched: r.matchedCount ?? 0, modified: r.modifiedCount ?? 0 };
}

/**
 * Create-or-update a plan keyed by external `planId`. Used by:
 *  - the test-plan toggle (atomically wires up the Razorpay plan id + DA
 *    package + pricing fields on enable),
 *  - the admin DA-sync path when a DA-package-named plan needs to be
 *    backfilled from the registrar side.
 *
 * Pass only the fields that should change; the upsert merges via `$set`.
 * On insert, missing schema-required fields fall back to model defaults.
 */
export async function upsertPlanByPlanId(
  planId: string,
  data: Record<string, unknown>
): Promise<IHostingPlan | null> {
  await connectDB();
  return HostingPlan.findOneAndUpdate(
    { planId },
    { $set: { planId, ...data } },
    { upsert: true, new: true }
  );
}
