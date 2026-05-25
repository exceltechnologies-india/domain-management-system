import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import type { IUser } from "@/models/User";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomainForUser, findOrderDomain } from "@/lib/services/orders";
import { validatedBody, z } from "@/lib/api-validation";

// Domain-name regex + nameserver-name regex mirror the inline checks
// the route previously did by hand. Zod gates the structural shape;
// per-nameserver format is enforced by the per-element schema.
const domainNameRegex =
  /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
const nameserverRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const nameserversSchema = z
  .object({
    domainName: z
      .string()
      .trim()
      .regex(domainNameRegex, "Invalid domain name format"),
    method: z.enum(["default", "custom"]),
    nameservers: z
      .array(z.string().trim().toLowerCase().regex(nameserverRegex, "Invalid nameserver format"))
      .min(2, "At least two nameservers are required")
      .optional(),
  })
  .refine(
    (data) =>
      data.method === "default" ||
      (data.nameservers !== undefined && data.nameservers.length >= 2),
    {
      message: "At least two nameservers are required for custom method",
      path: ["nameservers"],
    }
  );

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    // Auth: JWT first, then NextAuth
    let user = await AuthService.getUserFromRequest(request);
    if (!user) {
      const token = await getToken({ req: request, secret: AUTH_SECRET });
      if (token?.id) {
        const t = token as unknown as { id: string; role?: string };
        user = { _id: t.id, role: t.role || "user" } as unknown as IUser;
      }
    }
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, nameserversSchema);
    if (!validation.ok) return validation.response;
    const { domainName, method, nameservers } = validation.data;

    // Verify user owns the order/domain
    const order = await findOrderByDomainForUser(user._id, domainName);

    if (!order) {
      return NextResponse.json({ error: "Domain not found or unauthorized" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);
    if (!domain) {
      return NextResponse.json({ error: "Domain not found in order" }, { status: 404 });
    }

    if (!domain.resellerClubOrderId) {
      return NextResponse.json({ error: "Domain is missing its registrar order reference. Please contact support." }, { status: 400 });
    }

    // method/nameservers shape is guaranteed by the Zod refine above —
    // method=custom always carries a ≥2-nameserver array of valid hosts.
    const apiResult =
      method === "default"
        ? await ResellerClubWrapper.setDefaultNameservers(domain.resellerClubOrderId)
        : await ResellerClubWrapper.setCustomNameservers(domain.resellerClubOrderId, nameservers!);

    if (apiResult.status === "success") {
      return NextResponse.json({ success: true, message: "Nameservers updated successfully" });
    }

    return NextResponse.json({ error: apiResult.message || "Failed to update nameservers" }, { status: 500 });
  } catch (error) {
    serverLogger.error("User nameservers update error:", error);
    return NextResponse.json({ error: "Failed to update nameservers" }, { status: 500 });
  }
}
