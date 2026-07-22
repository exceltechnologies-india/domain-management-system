import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongoose";
import { getShowGstin, getShowPhone } from "@/lib/services/appearance";

// Public: the footer + contact card read whether the GSTIN / phone number
// should be shown. Whitelisted in middleware (PUBLIC_API_PREFIXES). Degrades
// to "shown" on any error so content isn't hidden by a transient failure.
export async function GET() {
  try {
    await connectToDatabase();
    const [showGstin, showPhone] = await Promise.all([getShowGstin(), getShowPhone()]);
    return NextResponse.json({ showGstin, showPhone });
  } catch {
    return NextResponse.json({ showGstin: true, showPhone: true });
  }
}
