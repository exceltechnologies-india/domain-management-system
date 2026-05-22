import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getUserById } from "@/lib/services/users";
import { listOrdersForUser } from "@/lib/services/orders";
import { getToken } from "next-auth/jwt";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    let user = await AuthService.getUserFromRequest(request);

    if (!user) {
      const token = await getToken({ req: request, secret: AUTH_SECRET });
      if (token?.id) {
        user = await getUserById(token.id as string);
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orders = await listOrdersForUser(String(user._id), { limit: 50 });

    return NextResponse.json({ success: true, orders });
  } catch (error) {
    serverLogger.error("Failed to fetch orders:", error);
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
  }
}
