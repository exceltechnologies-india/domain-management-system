import mongoose, { Document, Model, Schema } from "mongoose";

export interface IDomainWatch extends Document {
  userId: mongoose.Types.ObjectId;
  domainName: string;
  lastCheckedAt?: Date;
  lastStatus?: "available" | "taken" | "unknown";
  notifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DomainWatchSchema = new Schema<IDomainWatch>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    domainName: { type: String, required: true, lowercase: true, trim: true },
    lastCheckedAt: { type: Date },
    lastStatus: { type: String, enum: ["available", "taken", "unknown"] },
    notifiedAt: { type: Date },
  },
  { timestamps: true }
);

DomainWatchSchema.index({ userId: 1, domainName: 1 }, { unique: true });

const DomainWatch: Model<IDomainWatch> =
  mongoose.models.DomainWatch ??
  mongoose.model<IDomainWatch>("DomainWatch", DomainWatchSchema);

export default DomainWatch;
