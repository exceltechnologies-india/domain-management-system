import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { AuthService } from "@/lib/auth";
import { Schemas } from "@/lib/validation";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { z } from "zod";
import { validatedBody } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { provisionBillingCustomer } from "@/lib/integrations/billing-customer";
import {
  listUsers,
  findUserRoleById,
  updateUserRole,
  softDeleteUser,
  permanentDeleteUser,
  getUserByEmail,
  createUser,
  setUserBillingCustomerId,
} from "@/lib/services/users";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 100;

// GET - Fetch users (admin only) with pagination
export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
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

    // Map to clean response objects. IUser doesn't declare `createdAt` (the
    // mongoose-timestamps plugin adds it at runtime) — read it via a tight
    // structural cast.
    const cleanUsers = users.map((u) => {
      const withTs = u as typeof u & { createdAt?: Date };
      return {
        _id: u._id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role,
        createdAt: withTs.createdAt,
        isActive: u.isActive !== false,
        hostingCreatedAt: u.hostingCreatedAt,
        hostingExpiresAt: u.hostingExpiresAt,
        totpEnabled: u.totpEnabled === true,
      };
    });

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

const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: Schemas.email,
  provisionBilling: z.boolean().optional().default(false),
});

// POST - Manually create a customer (admin only). Same shape as a guest
// checkout account (no password — a "set your password" email is sent),
// since that's the only existing pattern for an account with no self-chosen
// credentials yet. Optionally also provisions a Billing Panel (ResellerOS)
// customer for the same person, mirroring the checkbox Billing already has
// for the opposite direction.
export async function POST(request: NextRequest) {
  try {
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const validation = await validatedBody(request, createUserSchema);
    if (!validation.ok) return validation.response;
    const { firstName, lastName, email, provisionBilling } = validation.data;

    const existing = await getUserByEmail(email);
    if (existing) {
      return secureErrorResponse(
        "A user with this email already exists",
        409,
        "USER_EXISTS"
      );
    }

    const newUser = await createUser({
      email,
      password: randomBytes(32).toString("hex"), // unusable — set via email link below
      firstName,
      lastName,
      role: "user",
      isActive: true,
      isActivated: true,
      isGuest: true,
      profileCompleted: false,
      provider: "credentials",
    });

    try {
      const setupToken = randomBytes(32).toString("hex");
      newUser.resetToken = setupToken;
      newUser.resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await newUser.save();
      EmailService.sendPasswordResetEmail(
        newUser.email,
        firstName,
        setupToken,
        true,
        "An account has been set up for you by our team. To get started, choose a password using the button below:"
      )
        .then((ok) => serverLogger.info(`[admin-create-user] Setup email ${ok ? "sent" : "returned false"} for ${email}`))
        .catch((err) => serverLogger.error(`[admin-create-user] Setup email failed for ${email}:`, err));
    } catch (err) {
      serverLogger.error("[admin-create-user] Failed to prepare setup email:", err);
    }

    let billing: { linked: boolean; billingCustomerId?: string; error?: string } = { linked: false };
    if (provisionBilling) {
      const result = await provisionBillingCustomer({ name: `${firstName} ${lastName}`.trim(), email });
      if (result) {
        await setUserBillingCustomerId(newUser._id.toString(), result.billing_customer_id);
        billing = { linked: true, billingCustomerId: result.billing_customer_id };
      } else {
        billing = { linked: false, error: "Could not reach Billing Panel — account created without a Billing link." };
      }
    }

    return secureJsonResponse({
      success: true,
      user: {
        _id: newUser._id,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        email: newUser.email,
      },
      billing,
    });
  } catch (error) {
    return secureErrorResponse("Failed to create user", 500, "DATABASE_ERROR", error);
  }
}

// PUT - Update user role (admin only)
export async function PUT(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
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
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
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
