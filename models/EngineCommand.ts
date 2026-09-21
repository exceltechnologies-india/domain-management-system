import mongoose, { Schema, Document } from "mongoose";

/**
 * A command ResellerOS asked this engine to perform.
 *
 * This is the IDEMPOTENCY store: the caller generates a `commandId` per
 * intent, and sending it again returns the stored outcome instead of doing
 * the work twice. That covers the retry case — a timeout on ResellerOS's side,
 * a redeploy mid-flight, a human pressing the button again.
 *
 * It does NOT cover the other case, which is why EngineSubjectClaim exists:
 * two *different* commandIds can both mean "register example.com", and a
 * request-keyed index cannot see that they collide. One store answers "have I
 * seen this request?", the other answers "is something already happening to
 * this thing?". Neither substitutes for the other.
 *
 * Nothing routes to this yet (Phase 2 is the store and the mutex only). It is
 * built first so the guarantees exist before anything can spend money through
 * them.
 */

/** Terminal states are the ones a replay can answer from. */
export type EngineCommandStatus =
  | "received"
  | "in_progress"
  | "succeeded"
  | "failed"
  /**
   * The request reached the provider and we do not know what it did — the
   * `sent_unknown` transport from lib/integrations/transport.ts.
   *
   * Deliberately NOT "failed". A failed command is safe to retry; this one is
   * the opposite, because the domain may already be registered. It needs a
   * human or a reconciliation pass to look at the provider before anything
   * else happens to this subject.
   */
  | "needs_reconciliation";

export interface IEngineCommand extends Document {
  /** The caller's idempotency key. Unique — this is the whole point. */
  commandId: string;
  /** What to do, e.g. "domain.register". */
  command: string;
  /** What it acts on, e.g. "example.com". Normalised by the caller. */
  subject: string;
  status: EngineCommandStatus;
  /** The request as received, so a replay can be compared against it. */
  request?: Record<string, unknown>;
  /** The stored outcome, replayed verbatim on a duplicate commandId. */
  result?: Record<string, unknown>;
  error?: string;
  /** How far the provider call got. See lib/integrations/transport.ts. */
  transport?: "not_sent" | "sent_unknown" | "responded";
  attempts: number;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EngineCommandSchema = new Schema<IEngineCommand>(
  {
    commandId: {
      type: String,
      required: [true, "commandId is required"],
      /**
       * Unique, and the ONLY uniqueness this collection needs. It answers
       * "have I already been asked this exact thing?".
       *
       * It deliberately does not stop two different commandIds naming the
       * same subject — that is a different question, and putting it here
       * would make replaying a retry and blocking a collision the same
       * constraint, so neither could be relaxed without losing the other.
       */
      unique: true,
      trim: true,
    },
    command: { type: String, required: true, trim: true, index: true },
    subject: { type: String, required: true, trim: true, index: true },
    status: {
      type: String,
      enum: ["received", "in_progress", "succeeded", "failed", "needs_reconciliation"],
      default: "received",
      index: true,
    },
    request: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    transport: {
      type: String,
      enum: ["not_sent", "sent_unknown", "responded"],
    },
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

/**
 * NO TTL on this collection, on purpose.
 *
 * It is the record of what was done on someone's behalf and what it cost. A
 * command that expired out of the store would let the same commandId run a
 * second time and spend again, which is precisely what it exists to prevent —
 * and `needs_reconciliation` rows are the ones you least want to lose.
 */
EngineCommandSchema.index({ status: 1, createdAt: -1 });
EngineCommandSchema.index({ command: 1, subject: 1, createdAt: -1 });

export default (mongoose.models.EngineCommand as mongoose.Model<IEngineCommand>) ||
  mongoose.model<IEngineCommand>("EngineCommand", EngineCommandSchema);
