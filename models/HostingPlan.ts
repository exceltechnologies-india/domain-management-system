import mongoose, { Document, Schema } from "mongoose";

export interface IHostingPlan extends Document {
  planId: string; // The package name in DirectAdmin (e.g., "basic_plan")
  name: string; // Display name (e.g., "Basic Plan")
  description: string;
  price: number;
  renewalPrice: number;
  currency: string;
  features: string[];
  isActive: boolean;
  directAdminPackage: string; // The actual package name on DA server
  quota: number; // in MB
  bandwidth: number; // in MB
  razorpayPlans?: {
    monthly?: string;
    yearly?: string;
  };
  details?: any; // Raw DirectAdmin package details
}

const HostingPlanSchema = new Schema<IHostingPlan>(
  {
    planId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    renewalPrice: {
      type: Number,
      min: 0,
      // Note: can't use `this.price` here — `this` is null during findOneAndUpdate upserts
      default: 0,
    },
    currency: {
      type: String,
      required: true,
      default: "INR",
    },
    features: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    directAdminPackage: {
      type: String,
      required: true,
      trim: true,
    },
    quota: {
      type: Number,
      required: true,
      // min: 0, // Removed to allow -1 for unlimited
    },
    bandwidth: {
      type: Number,
      required: true,
      // min: 0, // Removed to allow -1 for unlimited
    },
    razorpayPlans: {
      monthly: { type: String, trim: true },
      yearly: { type: String, trim: true },
    },
    details: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.models.HostingPlan ||
  mongoose.model<IHostingPlan>("HostingPlan", HostingPlanSchema);
