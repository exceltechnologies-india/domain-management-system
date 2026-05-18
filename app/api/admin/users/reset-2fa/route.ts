import { NextRequest } from "next/server";
import { findUserRoleById, getUserById, resetUser2FA } from "@/lib/services/users";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { z } from "zod";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  userId: z.string().min(1),
});

// POST - Admin resets 2FA for a user
export async function POST(request: NextRequest) {
  try {
    const admin = await AuthService.getUserFromRequest(request);
    if (!admin || admin.role !== "admin") {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = await request.json();
    const result = bodySchema.safeParse(body);
    if (!result.success) {
      return secureErrorResponse("Invalid request data", 400, "VALIDATION_ERROR");
    }

    const { userId } = result.data;

    const role = await findUserRoleById(userId);
    if (!role) {
      return secureErrorResponse("User not found", 404, "NOT_FOUND");
    }
    if (role.role === "admin") {
      return secureErrorResponse("Cannot modify admin accounts via this endpoint", 403, "FORBIDDEN");
    }

    const target = await getUserById(userId);
    if (!target?.totpEnabled) {
      return secureErrorResponse("This user does not have 2FA enabled", 400, "BAD_REQUEST");
    }

    await resetUser2FA(userId);

    serverLogger.info(
      `[2FA-RESET] Admin ${admin.email} reset 2FA for user ${target.email} (${userId})`
    );

    return secureJsonResponse({
      success: true,
      message: `2FA has been disabled for ${target.firstName} ${target.lastName}. They will need to set it up again if required.`,
    });
  } catch (error) {
    return secureErrorResponse("Failed to reset 2FA", 500, "SERVER_ERROR", error);
  }
}
