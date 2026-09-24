import mongoose, { Schema, Document } from "mongoose";

/**
 * A free hosting trial started OUTSIDE DMS — today, only on the ResellerOS site
 * (its "Start free trial" → cart → checkout; the customer has no DMS account yet).
 *
 * Why DMS keeps it: the owner's rule is ONE free trial per customer (24 Sep 2026),
 * across both apps. ResellerOS can ask DMS, but DMS has no way to ask ResellerOS,
 * so DMS is the one place that knows every trial: its own (orders, hostings) plus
 * these. ResellerOS writes a row here when it starts a trial and reads through
 * lib/trials/trial-history before starting one. DMS's own trial gates read it too.
 *
 * Matched on email, phone (last 10 digits) and domain — the site has no login,
 * so these are what "the same customer" can mean. Kept forever, like TrialClaim.
 */
export interface IExternalTrial extends Document {
  source: "reselleros";
  /** The trial's id in the source system (a ResellerOS lead id). Unique, so a retried record is a no-op. */
  ref: string;
  email: string;
  phoneKey?: string;
  domain?: string;
  planId?: string;
  cycle?: "monthly" | "yearly";
  createdAt: Date;
  updatedAt: Date;
}

const ExternalTrialSchema = new Schema<IExternalTrial>(
  {
    source: { type: String, enum: ["reselleros"], required: true },
    ref: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phoneKey: { type: String, index: true },
    domain: { type: String, lowercase: true, trim: true, index: true },
    planId: { type: String },
    cycle: { type: String, enum: ["monthly", "yearly"] },
  },
  { timestamps: true },
);

export default (mongoose.models.ExternalTrial as mongoose.Model<IExternalTrial>) ||
  mongoose.model<IExternalTrial>("ExternalTrial", ExternalTrialSchema);
