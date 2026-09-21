import mongoose, { Schema, Document } from "mongoose";

/**
 * An exclusive claim on doing something to one subject.
 *
 * The row IS the lock: acquiring is an insert, and the unique index on
 * `{ command, subject }` is what makes that atomic. Releasing is a delete. No
 * read-then-write, because two callers that both read "free" would both then
 * write, and a registration would go out twice.
 *
 * WHY THIS IS SEPARATE FROM EngineCommand's commandId index:
 * `commandId` is request-keyed — it answers "have I seen this exact request?".
 * Two legitimately different commandIds can both mean "register example.com",
 * and to a commandId index they look like two unrelated requests. Only a
 * key on the SUBJECT sees the collision. Conflating the two would make
 * replaying a retry and blocking a double-registration the same constraint.
 */

export interface IEngineSubjectClaim extends Document {
  /** The verb, e.g. "domain.register". Part of the unique key. */
  command: string;
  /** What is being acted on, e.g. "example.com". Part of the unique key. */
  subject: string;
  /** Which command holds it — for diagnosing a stuck claim. */
  commandId: string;
  /** When this claim stops being honoured. See the note on the index below. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EngineSubjectClaimSchema = new Schema<IEngineSubjectClaim>(
  {
    command: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    commandId: { type: String, required: true, trim: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/**
 * THE constraint. Everything else in this file is bookkeeping.
 *
 * Unique on the pair, not on commandId: see the header. `command` is part of
 * the key so that two different operations on the same domain — a renewal and
 * a DNS edit — do not block each other, while two registrations of the same
 * name cannot both proceed.
 */
EngineSubjectClaimSchema.index({ command: 1, subject: 1 }, { unique: true });

/**
 * TTL so a crash does not lock a domain forever.
 *
 * Two things to know before trusting it:
 *
 * 1. Mongo's TTL monitor runs about once a minute, so `expiresAt` is a floor,
 *    not a deadline — a claim can outlive it by up to ~60s. Anything that
 *    needs a hard bound must check `expiresAt` itself rather than assume the
 *    row is gone.
 * 2. It is a SAFETY NET, not the release path. The normal path deletes the
 *    row when the command reaches a terminal state. If the TTL is doing the
 *    releasing, something died holding a lock, and that is worth knowing
 *    about rather than quietly recovering from.
 *
 * `expireAfterSeconds: 0` means "expire at the time in this field", which is
 * what lets each claim carry its own lifetime — a registration can hold longer
 * than a DNS edit.
 */
EngineSubjectClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default (mongoose.models.EngineSubjectClaim as mongoose.Model<IEngineSubjectClaim>) ||
  mongoose.model<IEngineSubjectClaim>("EngineSubjectClaim", EngineSubjectClaimSchema);
