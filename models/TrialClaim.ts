import mongoose, { Schema, Document } from "mongoose";

/**
 * Audit record of every hosting-trial claim. Keyed three ways so we can
 * detect repeat-claim abuse without rummaging through orders:
 *   - by userId (for the one-trial-per-user rule)
 *   - by ipHash (HMAC of client IP — never store the raw IP)
 *   - by deviceFingerprint (best-effort browser hash)
 *
 * We keep the records forever for audit. Queries are bounded by createdAt to
 * the 30-day enforcement window so the indexes stay tight.
 */
export interface ITrialClaim extends Document {
  userId: mongoose.Types.ObjectId;
  userEmail: string;
  ipHash?: string;
  deviceFingerprint?: string;
  planId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TrialClaimSchema = new Schema<ITrialClaim>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userEmail: { type: String, required: true, lowercase: true, trim: true },
    ipHash: { type: String, index: true },
    deviceFingerprint: { type: String, index: true },
    planId: { type: String },
  },
  { timestamps: true }
);

// Compound indexes scoped by createdAt — most queries are "did this signal
// claim a trial in the last 30 days?"
TrialClaimSchema.index({ ipHash: 1, createdAt: -1 });
TrialClaimSchema.index({ deviceFingerprint: 1, createdAt: -1 });
TrialClaimSchema.index({ userEmail: 1, createdAt: -1 });

export default (mongoose.models.TrialClaim as mongoose.Model<ITrialClaim>) ||
  mongoose.model<ITrialClaim>("TrialClaim", TrialClaimSchema);
