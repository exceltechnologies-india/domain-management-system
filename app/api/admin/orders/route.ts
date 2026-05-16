import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getUserByIdSafe } from "@/lib/services/users";
import { listOrdersForAdmin } from "@/lib/services/orders";
import { getToken } from "next-auth/jwt";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    let user = await AuthService.getUserFromRequest(request);

    if (!user) {
      const token = await getToken({ req: request, secret: AUTH_SECRET });
      if (token?.id) {
        user = await getUserByIdSafe(token.id as string);
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const archived = searchParams.get("archived") === "true";
    const page = parseInt(searchParams.get("page") || "1");
    const perPage = parseInt(searchParams.get("per_page") || "100");

    const { orders, total, hasMore } = await listOrdersForAdmin({
      archived,
      page,
      perPage,
    });

    return NextResponse.json({
      success: true,
      orders,
      page_context: { has_more_page: hasMore, page, per_page: perPage, total },
    });
  } catch (error) {
    serverLogger.error("Failed to fetch admin orders:", error);
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
  }
}
