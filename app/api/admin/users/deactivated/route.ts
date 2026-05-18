import { NextRequest, NextResponse } from "next/server";
import { listDeactivatedUsers } from "@/lib/services/users";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

// GET - Fetch all deactivated users (admin only)
export async function GET(request: NextRequest) {
  try {
    // Verify admin authentication
    const user = await AuthService.getUserFromRequest(request);

    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch only deactivated users (admins excluded for security)
    const users = await listDeactivatedUsers();
    return NextResponse.json({ success: true, users });
  } catch (error) {
    serverLogger.error("Error fetching deactivated users:", error);
    return NextResponse.json(
      { error: "Failed to fetch deactivated users" },
      { status: 500 }
    );
  }
}
