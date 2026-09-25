/**
 * Today's automatic spend for ONE engine command — the `usage` half of the
 * daily cap in engine-register-policy.ts.
 *
 * Shared by `domain.register` and `domain.renew`, which each count only their
 * own command, so the two allowances are separate.
 *
 * Counted from the engine's own command records for the last 24 hours,
 * excluding this command and any dry run. A command still running or awaiting
 * reconciliation counts at `thisCost` — it may already have spent, and a cap
 * that ignored it would let a burst through while the first ones are in flight.
 * A success that spent nothing (`changed !== true`, e.g. already registered to
 * this customer) is not counted.
 */
import type { DailyUsage } from "./engine-register-policy";

export async function readDailyUsage(command: string, commandId: string, thisCost: number): Promise<DailyUsage> {
  /* Lazy: lib/mongodb.ts throws at load without its env (see the handlers). */
  const [{ default: EngineCommand }, { default: connectDB }] = await Promise.all([
    import("@/models/EngineCommand"),
    import("@/lib/mongodb"),
  ]);
  await connectDB();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await EngineCommand.find({
    command,
    commandId: { $ne: commandId },
    createdAt: { $gte: since },
    status: { $in: ["succeeded", "in_progress", "needs_reconciliation"] },
  })
    .select("status result")
    .lean<{ status: string; result?: Record<string, unknown> }[]>();
  let count = 0;
  let rupees = 0;
  for (const r of rows) {
    if (r.result?.dryRun === true) continue;
    if (r.status === "succeeded" && r.result?.changed !== true) continue; // spent nothing
    count += 1;
    const c = Number(r.result?.costRupees);
    rupees += Number.isFinite(c) && c > 0 ? c : thisCost;
  }
  return { count, rupees };
}
