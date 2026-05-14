import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import SupportTicket from "@/models/SupportTicket";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) return secureErrorResponse("Forbidden", 403, "FORBIDDEN");

    await connectDB();

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = 25;

    const filter: Record<string, unknown> = {};
    if (status && status !== "all") filter.status = status;

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .select("ticketNumber subject category status priority userEmail userName createdAt updatedAt messages")
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);

    const mapped = tickets.map((t) => ({
      ...t,
      messageCount: t.messages.length,
      lastMessage: t.messages.at(-1) ?? null,
      messages: undefined,
    }));

    return secureJsonResponse({ tickets: mapped, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
