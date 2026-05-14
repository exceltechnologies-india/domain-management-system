import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { Schemas } from "@/lib/validation";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { z } from "zod";
import { serverLogger } from "@/lib/server-logger";
import {
  listUsers,
  findUserRoleById,
  updateUserRole,
  softDeleteUser,
  permanentDeleteUser,
} from "@/lib/services/users";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 100;

// GET - Fetch users (admin only) with pagination
export async function GET(request: NextRequest) {
  try {
    // Authorization: Strict admin check
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10))
    );

    const { users, total, totalPages, hasMore } = await listUsers({
      filter: { role: { $ne: "admin" }, isDeleted: { $ne: true } },
      page,
      limit,
    });

    // Map to clean response objects
    const cleanUsers = users.map((u: any) => ({
      _id: u._id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      isActive: u.isActive !== false,
      hostingCreatedAt: u.hostingCreatedAt,
      hostingExpiresAt: u.hostingExpiresAt,
      totpEnabled: u.totpEnabled === true,
    }));

    return secureJsonResponse({
      success: true,
      users: cleanUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore,
      },
    });
  } catch (error) {
    return secureErrorResponse("Failed to fetch users", 500, "DATABASE_ERROR", error);
  }
}

// PUT - Update user role (admin only)
export async function PUT(request: NextRequest) {
  try {
    // Authorization: Strict admin check
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Schema Validation
     * Uses Zod to strictly typed fields and prevent 'Role Escalation' or
     * 'Mass Assignment' of other user properties.
     */
    const body = await request.json();
    const result = Schemas.adminUserUpdate.safeParse(body);

    if (!result.success) {
      return secureErrorResponse(
        "Invalid request data",
        400,
        "VALIDATION_ERROR",
        result.error.format()
      );
    }

    const { userId, role } = result.data;

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Privilege Guard
     * Prevents an admin from using this endpoint to demote or modify OTHER admins.
     * Admin escalation/modification should only happen through a higher-trust CLI or direct DB access.
     */
    const targetRole = await findUserRoleById(userId);
    if (!targetRole) {
      return secureErrorResponse("User not found", 404, "NOT_FOUND");
    }

    if (targetRole.role === "admin") {
      return secureErrorResponse(
        "Cannot modify admin users via this endpoint",
        403,
        "FORBIDDEN"
      );
    }

    const updatedUser = await updateUserRole(userId, role);
    if (!updatedUser) {
      return secureErrorResponse("User not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({
      success: true,
      message: "User role updated successfully",
      user: {
        _id: updatedUser._id,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        role: updatedUser.role,
      },
    });
  } catch (error) {
    return secureErrorResponse("Failed to update user", 500, "SERVER_ERROR", error);
  }
}

// DELETE - Delete user (admin only)
export async function DELETE(request: NextRequest) {
  try {
    // Authorization: Strict admin check
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Validation: Require User ID in body, strictly typed
    const body = await request.json();
    const result = z.object({ userId: Schemas.id }).safeParse(body);

    if (!result.success) {
      return secureErrorResponse("Invalid User ID", 400, "VALIDATION_ERROR");
    }

    const { userId } = result.data;

    // Prevent admin from deleting themselves
    if (user._id?.toString() === userId) {
      return secureErrorResponse(
        "Cannot delete your own account",
        400,
        "BAD_REQUEST"
      );
    }

    // Safety: Check if target user is an admin
    const targetRole = await findUserRoleById(userId);
    if (!targetRole) {
      return secureErrorResponse("User not found", 404, "NOT_FOUND");
    }

    if (targetRole.role === "admin") {
      return secureErrorResponse("Cannot delete admin users", 403, "FORBIDDEN");
    }

    const url = new URL(request.url);
    const isPermanent = url.searchParams.get("permanent") === "true";

    if (isPermanent) {
      // PERMANENT DELETION - Extreme action, logging mandatory
      serverLogger.info(
        `🚨 [USER-DELETE] Permanent deletion initiated for user ${userId}`
      );

      const { ordersSnapshotted } = await permanentDeleteUser(userId);
      serverLogger.info(
        `✅ [USER-DELETE] Snapshotted user details for ${ordersSnapshotted} orders before deletion.`
      );

      return secureJsonResponse({
        success: true,
        message: "User permanently deleted",
      });
    }

    // Soft delete user by deactivating and invalidating sessions
    const updatedUser = await softDeleteUser(userId);
    if (!updatedUser) {
      return secureErrorResponse("User not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({
      success: true,
      message: "User deactivated successfully",
    });
  } catch (error) {
    return secureErrorResponse("Failed to delete user", 500, "SERVER_ERROR", error);
  }
}
