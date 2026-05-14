import mongoose, { Document, Schema } from "mongoose";

export interface ISettings extends Document {
  key: string;
  value: any;
  description?: string;
  category: string;
  updatedAt: Date;
  updatedBy: string;
}

const SettingsSchema = new Schema<ISettings>({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  value: {
    type: Schema.Types.Mixed,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  category: {
    type: String,
    required: true,
    default: "general",
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: String,
    required: true,
  },
});

// Index automatically created by unique: true on key field

export default mongoose.models.Settings ||
  mongoose.model<ISettings>("Settings", SettingsSchema);
