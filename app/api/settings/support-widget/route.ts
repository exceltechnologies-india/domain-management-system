import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongoose";
import { getSupportWidgetVariant, getSupportWhatsappNumber } from "@/lib/services/appearance";

// Public: the support-widget switcher reads which widget to render (chatbot |
// whatsapp) plus the company WhatsApp number. Whitelisted in middleware
// (PUBLIC_API_PREFIXES). Degrades to the chatbot on any error so a support
// widget always renders.
export async function GET() {
  try {
    await connectToDatabase();
    const [variant, whatsappNumber] = await Promise.all([
      getSupportWidgetVariant(),
      getSupportWhatsappNumber(),
    ]);
    return NextResponse.json({ variant, whatsappNumber });
  } catch {
    return NextResponse.json({ variant: "chatbot", whatsappNumber: "" });
  }
}
