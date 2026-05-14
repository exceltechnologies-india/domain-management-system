import mongoose, { Document, Schema } from "mongoose";

export interface ISystemLog extends Document {
  level: "info" | "warn" | "error";
  message: string;
  source: string; // The origin of the error (e.g., "Client Boundary", "Server Logger", etc.)
  url?: string; // The URL where the error occurred
  stack?: string; // Stack trace if available
  service?: string; // The specific service (e.g. resellerclub, razorpay, api)
  requestId?: string; // To trace a request flow
  statusCode?: number; // For API logging
  ip?: string; // For security tracking
  metadata?: Record<string, any>; // Any extra pertinent data
  user?: mongoose.Types.ObjectId; // If a user session was active
  createdAt: Date;
}

const SystemLogSchema = new Schema<ISystemLog>(
  {
    level: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "error",
    },
    message: { type: String, required: true },
    source: { type: String, required: true },
    url: { type: String },
    stack: { type: String },
    service: { type: String, index: true },
    requestId: { type: String },
    statusCode: { type: Number },
    ip: { type: String },
    metadata: { type: Schema.Types.Mixed },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    createdAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    capped: { size: 52428800, max: 50000 } // 50MB limit, auto-rotating
  }
);

SystemLogSchema.index({ level: 1, createdAt: -1 });
SystemLogSchema.index({ service: 1, createdAt: -1 });
SystemLogSchema.index({ requestId: 1 });
SystemLogSchema.index({ createdAt: -1 });

export default mongoose.models.SystemLog ||
  mongoose.model<ISystemLog>("SystemLog", SystemLogSchema);
