import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { getUserById } from "@/lib/services/users";
import connectDB from "@/lib/mongodb";
import { validatedBody, z } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";

const assignSchema = z.object({
  userId: Schemas.id,
  package: z.string().trim().min(1).max(100),
  domain: z.string().trim().toLowerCase().min(3).max(253),
});

/**
 * POST /api/admin/hosting/assign
 * Manually assigns a hosting package to a user.
 * Restricted to Admins only.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      serverLogger.warn("Admin Hosting Assignment Attempt: Unauthorized access");
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    const validation = await validatedBody(request, assignSchema);
    if (!validation.ok) return validation.response;
    const { userId, package: packageName, domain } = validation.data;

    await connectDB();
    const user = await getUserById(userId);
    
    if (!user) {
        return secureErrorResponse("User not found", 404, "USER_NOT_FOUND");
    }

    // 3. Generate DA Username if not exists
    let daUsername = user.directAdminUsername;
    if (!daUsername) {
        const cleanDomain = domain.replace(/[^a-zA-Z0-9]/g, "").substring(0, 8);
        const random = Math.random().toString(36).substring(2, 6);
        daUsername = `${cleanDomain}${random}`.toLowerCase();
        
        if (daUsername.length > 14) {
            daUsername = daUsername.substring(0, 14);
        }
    }

    serverLogger.info(`Admin assigning hosting for user ${user.email} (DA: ${daUsername}) - Domain: ${domain}, Package: ${packageName}`);

    // 4. Create User in DirectAdmin
    const result = await DirectAdminService.createUser(daUsername, user.email, domain, packageName);

    // 4.5. Update DNS Nameservers in DirectAdmin
    try {
      const resellerClubNameServers = [
        "deepak1299294.mercury.orderbox-dns.com",
        "deepak1299294.venus.orderbox-dns.com",
        "deepak1299294.earth.orderbox-dns.com",
        "deepak1299294.mars.orderbox-dns.com",
      ];

      serverLogger.info(`Updating DNS nameservers for ${domain} in DirectAdmin`);

      await DirectAdminService.updateDNSNameservers(
        daUsername,
        domain,
        resellerClubNameServers
      );

      serverLogger.info(`DNS nameservers updated successfully for ${domain}`);
    } catch (dnsError: unknown) {
      // Log but don't fail the entire provisioning if DNS update fails
      const message = dnsError instanceof Error ? dnsError.message : String(dnsError);
      serverLogger.warn(`Failed to update DNS nameservers for ${domain}: ${message}`);
    }

    // 5. Update User Record
    if (!user.directAdminUsername) {
        user.directAdminUsername = daUsername;
        await user.save();
    }

    return secureJsonResponse({ 
      success: true, 
      message: `Hosting assigned successfully to ${user.email}`,
      data: {
        daUsername,
        domain,
        package: packageName,
        result
      }
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`Admin Hosting Assignment Error:`, message);

    // Handle specific DA errors nicely
    if (message.includes("already exists")) {
        return secureErrorResponse("User or Domain already exists on the server.", 409, "ALREADY_EXISTS");
    }

    return secureErrorResponse(
      `Failed to assign hosting: ${message}`,
      500,
      "ASSIGNMENT_FAILED"
    );
  }
}
