import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongoose";
import { getShowGstin, getSocialLinks, DEFAULT_SOCIAL_LINKS } from "@/lib/services/appearance";

// Public: the footer reads whether the GSTIN should be shown, plus the social
// profile links. Whitelisted in middleware (PUBLIC_API_PREFIXES). Degrades to
// defaults on any error.
export async function GET() {
  try {
    await connectToDatabase();
    const [showGstin, social] = await Promise.all([getShowGstin(), getSocialLinks()]);
    return NextResponse.json({ showGstin, social });
  } catch {
    return NextResponse.json({ showGstin: true, social: DEFAULT_SOCIAL_LINKS });
  }
}
