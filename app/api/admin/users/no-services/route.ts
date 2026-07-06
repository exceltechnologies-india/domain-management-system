export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { listUsersWithoutServicesAggregation } from "@/lib/services/users";
import { authOptions } from "@/lib/auth-config";
import { serverLogger } from "@/lib/server-logger";

/**
 * GET /api/admin/users/no-services
 *
 * Admin-only. Registered-but-never-converted users — the complement of
 * /api/admin/users/services. Zero domains + zero hostings + no DA account,
 * excluding admins + soft-deleted. The "dormant / re-engagement" audience.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const sessionUser = session?.user as { role?: string } | undefined;
    if (!session || !session.user || sessionUser?.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized access" }, { status: 401 });
    }

    const users = await listUsersWithoutServicesAggregation();

    return NextResponse.json({
      success: true,
      users,
      count: users.length,
    });
  } catch (error: unknown) {
    serverLogger.error("Error fetching no-service users:", error);
    const message = error instanceof Error ? error.message : "Failed to fetch no-service users";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
