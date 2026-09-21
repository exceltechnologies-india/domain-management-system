/**
 * `hosting.change_plan` — move an existing account onto a different plan.
 *
 * Phase 7 is "reversible spend": a bigger package costs the reseller real
 * money on their DirectAdmin server, and changing back undoes it. That is a
 * step up from Phase 6 (free) and a step below Phase 8 (a rupee that does not
 * come back).
 *
 * ─── WHY `hosting.provision` IS NOT IN THIS FILE ─────────────────────────────
 * It was in the plan for this phase and it is NOT built, because building it
 * would create real hosting accounts that nobody can log into.
 *
 * DMS's `createUser` mints the username itself (with collision retry) and sets
 * `passwd: Math.random().toString(36).slice(-10) + 'A1!'` — a throwaway it
 * never stores and never returns. That is not an oversight: the comment beside
 * it says "user will use SSO", and DMS's customers reach DirectAdmin through
 * passwordless SSO from the DMS portal. An account provisioned by the engine
 * for somebody who has no DMS portal user therefore has no way in at all, and
 * the failure is silent — provisioning "succeeds" and the customer is locked
 * out of something they paid for.
 *
 * That is a product decision (does an engine-provisioned account get a portal
 * user? who owns the username?), not a coding one, and it is recorded in
 * Todos.md §D as blocking this phase. Guessing it here would be the worst kind
 * of progress.
 *
 * ─── THE PLAN COMES FROM THE CATALOGUE, NOT FROM THE CALLER ──────────────────
 * The payload names a `planId`; the DirectAdmin package is READ from that
 * plan's row. Letting the caller pass a package name directly would make the
 * caller a second source for something the catalogue owns — the defect family
 * of AGENTS.md L104 and L106, where a figure copied out of its source went
 * wrong and the guard checking it had been fed from the same copy.
 *
 * ─── THE CHANGE HAS TWO HALVES AND BOTH ARE THE EFFECT ───────────────────────
 * DMS stores the plan on the `Hosting` row (`planId`, `name`, `serverPackage`)
 * and its own upgrade path writes all three after the DirectAdmin call. A
 * command that changed only DirectAdmin would leave the customer panel showing
 * the old plan while the server served the new one — a divergence with no error
 * anywhere. So the record is part of the work, and part of what the reconciler
 * checks.
 */
import { serverLogger } from "@/lib/server-logger";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";
import { attemptProviderWrite, providerRefused } from "./engine-attempt";

/**
 * Mongo and DirectAdmin are loaded LAZILY, for the reason the DNS handler
 * spells out: `lib/mongodb.ts` THROWS at module load when `MONGODB_URI` is
 * absent, exactly like `lib/resellerclub/client.ts`. A static import here would
 * make the whole command registry un-importable without a database URI, so
 * `dns.record.upsert` would fail to load because of a missing Mongo config.
 */
async function deps() {
  const [{ getUserConfig, changePackage }, { getPlanByPlanId }, { listHostingsByDirectAdminUsername }] =
    await Promise.all([
      import("@/lib/integrations/directadmin"),
      import("@/lib/services/hosting-plans"),
      import("@/lib/services/hostings"),
    ]);
  return { getUserConfig, changePackage, getPlanByPlanId, listHostingsByDirectAdminUsername };
}

interface ChangePlanRequest {
  username: string;
  planId: string;
}

function parseRequest(payload: Record<string, unknown>): ChangePlanRequest {
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const planId = typeof payload.planId === "string" ? payload.planId.trim() : "";
  if (!username || !planId) {
    throw new Error(
      'This command needs "username" (the DirectAdmin account) and "planId" (the plan to move ' +
        "it to) in its payload. The subject is the domain. The DirectAdmin package name is read " +
        "from the plan, so it must not be passed here — the catalogue owns it."
    );
  }
  return { username, planId };
}

/**
 * DirectAdmin package names are compared case-insensitively.
 *
 * `changePackage` runs the caller's string through `normalizePackageName`,
 * which only corrects CASE and only for the packages in the static config —
 * a DA-only package like `25GB-wp` passes through untouched. So the value DA
 * ends up storing may differ in case from the one we sent, and an exact
 * comparison would report a successful change as `not_done`.
 */
function samePackage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Find the ONE hosting row this command is about.
 *
 * `Hosting` is unique on `(userId, domainName)`, NOT on the DirectAdmin
 * username — one DA account can legitimately own several rows. So the domain
 * (the command's subject) is what narrows it, and anything other than exactly
 * one match is refused BEFORE DirectAdmin is touched: updating "the" row when
 * two match would be a guess about whose plan changed.
 */
async function findHostingRow(username: string, domain: string) {
  const { listHostingsByDirectAdminUsername } = await deps();
  const all = await listHostingsByDirectAdminUsername(username);
  const matches = all.filter(
    (h) => String(h.domainName ?? "").trim().toLowerCase() === domain.trim().toLowerCase()
  );

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No hosting record in DMS matches DirectAdmin account "${username}" on ${domain}` +
        (all.length
          ? ` (that account has ${all.length} record(s), for: ${all
              .map((h) => h.domainName)
              .join(", ")}). Check the subject domain.`
          : ". That account has no hosting records at all — check the username.")
    );
  }
  throw new Error(
    `${matches.length} hosting records in DMS match "${username}" on ${domain}, so it is not ` +
      "clear which one this plan change is about. Nothing was changed. Resolve the duplicate " +
      "rows in DMS first."
  );
}

export const changeHostingPlan: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const req = parseRequest(ctx.payload);
  const domain = ctx.subject;
  const { getUserConfig, changePackage, getPlanByPlanId } = await deps();

  // ── 1. The plan. Everything else is derived from this row. ────────────────
  const plan = await getPlanByPlanId(req.planId);
  if (!plan) {
    throw new Error(
      `No hosting plan called "${req.planId}" exists in DMS, so there is no DirectAdmin package ` +
        "to move to and no plan details to record. Add the plan in DMS, or send a planId that " +
        "already exists."
    );
  }
  const targetPackage = String(plan.directAdminPackage ?? "").trim();
  if (!targetPackage) {
    throw new Error(
      `The DMS plan "${req.planId}" has no directAdminPackage set, so nothing can be asked of ` +
        "DirectAdmin. Set it on the plan in DMS and run this again."
    );
  }

  // ── 2. The record. Refused here means DirectAdmin was never touched. ──────
  const hosting = await findHostingRow(req.username, domain);

  // ── 3. What DirectAdmin says today. A read: safe, and changes nothing. ────
  const config = await getUserConfig({ username: req.username });
  if (config.kind !== "found") {
    throw new Error(
      config.kind === "user_not_found"
        ? `DirectAdmin has no account called "${req.username}".`
        : `Could not reach DirectAdmin to check "${req.username}": ${config.reason}`
    );
  }
  /**
   * An absent `package` field is not evidence of anything — it means this
   * DirectAdmin did not tell us. Treated as "needs changing" so the command
   * still does its work, and the reconciler treats the same absence as
   * `unknown` rather than guessing.
   */
  const currentPackage = config.config.package;
  const daNeedsChange = !samePackage(currentPackage, targetPackage);
  const recordNeedsChange =
    !samePackage(hosting.serverPackage, targetPackage) ||
    String(hosting.planId ?? "") !== String(plan.planId);

  if (!daNeedsChange && !recordNeedsChange) {
    // Already there, in both places. A success — same reasoning as
    // "already suspended": a retry must not look like a problem.
    return {
      result: {
        ok: true,
        domain,
        username: req.username,
        planId: plan.planId,
        package: targetPackage,
        changed: false,
        note: "The account is already on this plan and DMS already records it; nothing to do.",
      },
    };
  }

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true,
        domain,
        username: req.username,
        planId: plan.planId,
        package: targetPackage,
        changed: false,
        dryRun: true,
        wouldChange: [
          daNeedsChange
            ? `DirectAdmin: ${currentPackage ?? "(not reported)"} -> ${targetPackage}`
            : null,
          recordNeedsChange
            ? `DMS record: ${hosting.serverPackage ?? "(unset)"} -> ${targetPackage}`
            : null,
        ].filter(Boolean),
        note: "Test mode: DirectAdmin was read but NOT changed, and no record was written.",
      },
    };
  }

  /**
   * An inactive plan is allowed, and reported rather than refused.
   *
   * Refusing would block a legitimate downgrade onto a retired tier, and a
   * guard that fires on a right answer is one somebody deletes (AGENTS.md
   * L103). The caller named this plan by id, which is the deliberate act; the
   * flag makes the unusual choice visible afterwards.
   */
  if (plan.isActive === false) {
    serverLogger.warn(
      `[engine] change_plan moving ${req.username} (${domain}) onto INACTIVE plan ${plan.planId}`
    );
  }

  // ── 4. DirectAdmin, then the record — the same order DMS's own upgrade uses.
  if (daNeedsChange) {
    const outcome = await attemptProviderWrite(() =>
      changePackage({ username: req.username, newPackage: targetPackage })
    );
    if (outcome.kind !== "changed") {
      throw providerRefused(
        outcome.kind === "package_not_found"
          ? `DirectAdmin has no package called "${targetPackage}". The DMS plan "${plan.planId}" ` +
            "points at a package that does not exist on the server — fix the plan's " +
            "directAdminPackage, or create the package in DirectAdmin."
          : `DirectAdmin refused the plan change: ${outcome.kind}` +
            ("reason" in outcome ? ` (${outcome.reason})` : "")
      );
    }
  }

  hosting.planId = plan.planId;
  hosting.name = plan.name;
  hosting.serverPackage = targetPackage;
  try {
    await hosting.save();
  } catch (err) {
    /**
     * DirectAdmin changed and DMS did not. Said in full, because the two
     * systems now disagree and the sentence an operator reads is the only
     * thing that will tell them.
     *
     * Branded `responded`, not `sent_unknown`: DirectAdmin answered and we
     * know exactly what it did. The subject is released because the state is
     * known, and running the same command again is safe — the DirectAdmin half
     * is already correct and will be skipped, and the record write is retried.
     */
    const message = err instanceof Error ? err.message : String(err);
    throw providerRefused(
      `DirectAdmin was changed to "${targetPackage}" for ${req.username}, but the DMS hosting ` +
        `record for ${domain} could NOT be updated: ${message}. The server and the customer ` +
        "panel now disagree. Sending this command again is safe and will finish the job."
    );
  }

  serverLogger.warn(
    `[engine] plan changed for ${req.username} (${domain}) to ${plan.planId} / ${targetPackage}`
  );
  return {
    result: {
      ok: true,
      domain,
      username: req.username,
      planId: plan.planId,
      package: targetPackage,
      changed: true,
      directAdminChanged: daNeedsChange,
      planIsActive: plan.isActive !== false,
    },
  };
};

/**
 * Reconciler: is the account on this plan, and does DMS say so?
 *
 * Both halves, because both are the command's effect. Checking DirectAdmin
 * alone would report `done` for a change that left the customer panel showing
 * the old plan — settling a command that only half happened.
 */
export const reconcileChangePlan: Reconciler = async (ctx): Promise<ReconcileVerdict> => {
  let req: ChangePlanRequest;
  try {
    req = parseRequest(ctx.request);
  } catch {
    return "unknown";
  }

  const { getUserConfig, getPlanByPlanId } = await deps();

  const plan = await getPlanByPlanId(req.planId);
  if (!plan?.directAdminPackage) return "unknown";
  const targetPackage = String(plan.directAdminPackage).trim();

  let hosting;
  try {
    hosting = await findHostingRow(req.username, ctx.subject);
  } catch {
    // No row, or several. Nothing can be concluded about whether the change
    // landed — which is `unknown`, never `not_done`.
    return "unknown";
  }

  const config = await getUserConfig({ username: req.username });
  if (config.kind !== "found") return "unknown";
  // An absent `package` is a missing answer, not a "no".
  if (config.config.package === undefined) return "unknown";

  const daDone = samePackage(config.config.package, targetPackage);
  const recordDone =
    samePackage(hosting.serverPackage, targetPackage) &&
    String(hosting.planId ?? "") === String(plan.planId);

  return daDone && recordDone ? "done" : "not_done";
};
