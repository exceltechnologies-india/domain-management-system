/**
 * IPCheck service.
 *
 * The admin "what is this server's outbound IP" debug tool persists each probe
 * result so the operator can see the most recent answer without re-running the
 * fan-out call. Two endpoints — POST stores, GET reads.
 */
import connectDB from "@/lib/mongodb";
import IPCheck from "@/models/IPCheck";
import type { IIPCheck } from "@/models/IPCheck";

export interface IPCheckInput {
  success: boolean;
  message: string;
  data?: IIPCheck["data"];
  error?: string;
  checkedBy: unknown;
}

/**
 * Persist a fresh IP-check result. Stamps `checkedAt` server-side so the row
 * is the source of truth for "when did we last probe."
 */
export async function recordIPCheck(input: IPCheckInput): Promise<IIPCheck> {
  await connectDB();
  return IPCheck.create({
    success: input.success,
    message: input.message,
    data: input.data,
    error: input.error,
    checkedBy: input.checkedBy,
    checkedAt: new Date(),
  });
}

/**
 * Read the most-recent IP-check row, with `checkedBy` populated for the
 * admin-status panel that shows who ran the last probe.
 */
export async function getLatestIPCheck(): Promise<IIPCheck | null> {
  await connectDB();
  // Mongoose's populate signature accepts a 4th `Model` arg, but the typed
  // overload doesn't include it. Pull `User` lazily so this service file
  // doesn't have a hard import on User just for populate.
  const User = (await import("@/models/User")).default;
  return IPCheck.findOne()
    .sort({ checkedAt: -1 })
    .populate("checkedBy", "firstName lastName email", User);
}
