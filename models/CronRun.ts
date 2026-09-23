/**
 * One row per cron invocation — the heartbeat the staleness check reads.
 *
 * It records THAT a cron ran, not whether it succeeded. Failures already throw,
 * log and reach `systemlogs`; what nothing could see was a cron that stopped
 * being invoked at all. See lib/cron/record-run.ts for why the field is
 * `ranAt` and not `succeededAt`.
 *
 * Why a collection and not Cloud Run logs: AGENTS.md L38. The logs are the
 * richer source and they need a token that expires quietly, which is how a
 * self-check ends up reporting "healthy" from a source it can no longer read.
 * This is reachable with the same credentials as everything else in the app, so
 * a check built on it cannot go blind without the whole app going down — and if
 * the app is down, its silence is the answer.
 *
 * A row is written when a run STARTS and updated when it finishes, rather than
 * only on completion. A cron that begins and is then killed — an instance torn
 * down mid-run, a timeout — leaves a row with `ok` still null, which is a
 * visible third state. Writing only on success would make that case
 * indistinguishable from never having run.
 */
import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICronRun extends Document {
  /** Route name, e.g. "pending-sweeper". Matches EXPECTED_CRONS. */
  name: string;
  /** When the run was authorised and began. */
  ranAt: Date;
  createdAt: Date;
}

const CronRunSchema = new Schema<ICronRun>(
  {
    name: { type: String, required: true, index: true },
    ranAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/** The query the staleness check makes: newest run per name. */
CronRunSchema.index({ name: 1, ranAt: -1 });

/**
 * 60 days, and the number matters. The staleness check's widest window is 30
 * hours, so 60 days is far more than it needs — the extra is for a human
 * answering "when did this stop", which is the question asked after an alarm
 * and which a 48-hour retention cannot answer.
 */
CronRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

const CronRun: Model<ICronRun> =
  (mongoose.models.CronRun as Model<ICronRun>) ||
  mongoose.model<ICronRun>("CronRun", CronRunSchema, "cron_runs");

export default CronRun;
