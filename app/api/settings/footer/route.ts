import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongoose";
import { getFooterVariant } from "@/lib/services/appearance";

// Public: the footer switcher reads which template to render. Whitelisted in
// middleware (PUBLIC_API_PREFIXES). Degrades to the default on any error so
// the footer always renders.
export async function GET() {
  try {
    await connectToDatabase();
    return NextResponse.json({ variant: await getFooterVariant() });
  } catch {
    return NextResponse.json({ variant: "modern" });
  }
}
