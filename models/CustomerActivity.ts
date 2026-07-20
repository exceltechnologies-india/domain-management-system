import mongoose, { Document, Schema } from "mongoose";

export type ActivityType =
  | "landing_page_visit"
  | "view_content"
  | "start_trial"
  | "registration"
  | "email_verified"
  | "first_login"
  | "domain_added"
  | "wordpress_installed"
  | "website_uploaded"
  | "checkout_started"
  | "purchase"
  | "renewal";

export interface ICustomerActivity extends Document {
  userId?: mongoose.Types.ObjectId | null;
  /** Anonymous visitor id (cookie) for pre-registration events. */
  anonId?: string | null;
  activity: ActivityType;
  /** Score actually applied for this occurrence (0 for repeat milestones). */
  score: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const CustomerActivitySchema = new Schema<ICustomerActivity>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    anonId: { type: String, default: null, index: true },
    activity: { type: String, required: true, index: true },
    score: { type: Number, default: 0 },
    metadata: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CustomerActivitySchema.index({ createdAt: -1 });

export default (mongoose.models.CustomerActivity as mongoose.Model<ICustomerActivity>) ||
  mongoose.model<ICustomerActivity>("CustomerActivity", CustomerActivitySchema);
