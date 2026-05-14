import mongoose, { Document, Schema } from "mongoose";

export interface IPendingHosting extends Document {
  userId: Schema.Types.ObjectId;
  domain: string;
  package: string;
  daUsername: string;
  error: string;
  status: "failed" | "pending";
  createdAt: Date;
}

const PendingHostingSchema = new Schema<IPendingHosting>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    domain: {
      type: String,
      required: true,
    },
    package: {
      type: String,
      required: true,
    },
    daUsername: {
      type: String,
      required: true,
    },
    error: {
      type: String,
    },
    status: {
      type: String,
      enum: ["failed", "pending"],
      default: "failed",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for janitor + admin queries.
// `userId` already indexed at the field level above.
PendingHostingSchema.index({ status: 1 });
PendingHostingSchema.index({ userId: 1, status: 1 });
PendingHostingSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.PendingHosting ||
  mongoose.model<IPendingHosting>("PendingHosting", PendingHostingSchema);
