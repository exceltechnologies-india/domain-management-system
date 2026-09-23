/**
 * Record that a cron RAN, so that one which stops running can be noticed.
 *
 * ─── WHAT THIS DETECTS, AND WHAT IT DOES NOT ─────────────────────────────────
 * It answers "has this cron been invoked lately". It does NOT answer "is it
 * succeeding" — a cron that runs every night and fails every night looks
 * healthy here. That is deliberate, not an oversight: failures already throw,
 * log, and reach `systemlogs` and the admin integration-health page. The gap
 * this closes is the other one, where a deleted Scheduler job or a 404ing path
 * produces no error at all and is silent by construction (AGENTS.md L1).
 *
 * The field is called `lastRunAt` rather than `lastSuccessAt` for that reason.
 * A name that promised success would be answering a question it cannot see
 * (L12).
 *
 * ─── WHY A MARK AND NOT A WRAPPER ────────────────────────────────────────────
 * The obvious design wraps each handler — start row, finish row, ok/failed. Two
 * things argued against it here:
 *
 *  - **Placement matters more than completeness.** The mark has to happen AFTER
 *    the auth check. Wrapping the whole GET would record a heartbeat for every
 *    unauthorised probe, so a dead Scheduler job would look alive as long as
 *    anything at all hit the URL. That is worse than no heartbeat, because it
 *    reads as evidence.
 *  - Retrofitting a wrapper meant re-indenting four large, differently-shaped
 *    handler bodies. A one-line call placed by hand after each auth block is
 *    the smaller change, and it answers the question being asked.
 *
 * ─── IT MUST NOT BE ABLE TO BREAK THE CRON ───────────────────────────────────
 * This is bookkeeping wrapped around work that matters more. Every write is
 * swallowed and logged: if the heartbeat cannot be written, the cron still runs.
 * A heartbeat that can fail a renewal sweep has made the system less reliable
 * in the name of measuring it.
 */
import { serverLogger } from "@/lib/server-logger";

/**
 * Mongo is imported LAZILY, for the reason the engine handlers document:
 * `lib/mongodb.ts` throws at module load without `MONGODB_URI`, so a top-level
 * import here would turn a missing heartbeat into a cron route that cannot
 * load at all.
 */
async function store() {
  const [{ default: CronRun }, { default: connectDB }] = await Promise.all([
    import("@/models/CronRun"),
    import("@/lib/mongodb"),
  ]);
  await connectDB();
  return CronRun;
}

/**
 * Stamp one heartbeat. Call it immediately AFTER the auth check and before the
 * work — never before auth, or an unauthorised probe counts as a run.
 */
export async function recordCronHeartbeat(name: string): Promise<void> {
  try {
    const CronRun = await store();
    await CronRun.create({ name, ranAt: new Date() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    serverLogger.warn(
      `[cron-heartbeat] could not record a run of ${name}: ${msg}. The cron itself is ` +
        `unaffected; this run will simply not appear in the heartbeat.`
    );
  }
}

/**
 * The newest run per cron, plus when this heartbeat first recorded anything.
 *
 * `watchingSince` is the third condition the staleness check needs. Without it,
 * "never recorded" cannot be told apart from "we only started looking an hour
 * ago", and every cron reads as broken on the day this ships (L39).
 */
export async function readHeartbeat(): Promise<{
  runs: Array<{ name: string; lastRunAt: Date | null }>;
  watchingSince: Date | null;
}> {
  const CronRun = await store();

  const grouped = await CronRun.aggregate<{ _id: string; lastRunAt: Date }>([
    { $group: { _id: "$name", lastRunAt: { $max: "$ranAt" } } },
  ]);

  const first = await CronRun.findOne({}, { ranAt: 1 }).sort({ ranAt: 1 }).lean();

  return {
    runs: grouped.map((g) => ({ name: g._id, lastRunAt: g.lastRunAt ?? null })),
    watchingSince: (first as { ranAt?: Date } | null)?.ranAt ?? null,
  };
}
