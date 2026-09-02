import mongoose, { Document, Schema } from "mongoose";

/**
 * Generic atomic sequence counter, keyed by an arbitrary string.
 *
 * Backs the primary tax-invoice numbering series (lib/billing/invoiceNumber.ts)
 * — GST requires a gapless, sequential invoice number per fiscal year, which a
 * random/timestamp scheme (see Order.invoiceNumber's legacy pre-save hook)
 * can't guarantee. `findOneAndUpdate` with `$inc` is atomic at the MongoDB
 * level, so concurrent requests allocating a number for the same key never
 * collide or skip.
 */
export interface ICounter extends Document {
  key: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  seq: {
    type: Number,
    required: true,
    default: 0,
  },
});

export default mongoose.models.Counter ||
  mongoose.model<ICounter>("Counter", CounterSchema);
