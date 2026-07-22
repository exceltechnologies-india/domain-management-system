import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongoose";
import { getShowGstin, getShowPhone, getSocialLinks, DEFAULT_SOCIAL_LINKS } from "@/lib/services/appearance";

// Public: the footer + contact card read whether the GSTIN / phone number
// should be shown, plus the social profile links. Whitelisted in middleware
// (PUBLIC_API_PREFIXES). Degrades to defaults on any error.
export async function GET() {
  try {
    await connectToDatabase();
    const [showGstin, showPhone, social] = await Promise.all([getShowGstin(), getShowPhone(), getSocialLinks()]);
    return NextResponse.json({ showGstin, showPhone, social });
  } catch {
    return NextResponse.json({ showGstin: true, showPhone: true, social: DEFAULT_SOCIAL_LINKS });
  }
}
