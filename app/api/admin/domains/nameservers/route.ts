import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomain, findOrderDomain } from "@/lib/services/orders";
import { validatedBody, z } from "@/lib/api-validation";

// Mirrors the schema in app/api/user/domains/nameservers/route.ts.
const domainNameRegex =
  /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
const nameserverRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const adminNameserversSchema = z
  .object({
    domainName: z.string().trim().regex(domainNameRegex, "Invalid domain name format"),
    method: z.enum(["default", "custom"]),
    nameservers: z
      .array(z.string().trim().toLowerCase().regex(nameserverRegex, "Invalid nameserver format"))
      .min(2, "At least two nameservers are required")
      .optional(),
  })
  .refine(
    (d) =>
      d.method === "default" || (d.nameservers !== undefined && d.nameservers.length >= 2),
    {
      message: "At least two nameservers are required for custom method",
      path: ["nameservers"],
    }
  );

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const validation = await validatedBody(request, adminNameserversSchema);
    if (!validation.ok) return validation.response;
    const { domainName, method, nameservers } = validation.data;

    // Admin can access any order
    const order = await findOrderByDomain(domainName);
    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);
    if (!domain) {
      return NextResponse.json({ error: "Domain not found in order" }, { status: 404 });
    }

    if (!domain.resellerClubOrderId) {
      return NextResponse.json({ error: "Domain does not have a ResellerClub Order ID" }, { status: 400 });
    }

    // Shape guaranteed by the Zod refine: method=custom ⇒ ≥2 valid NSs.
    const apiResult =
      method === "default"
        ? await ResellerClubWrapper.setDefaultNameservers(domain.resellerClubOrderId)
        : await ResellerClubWrapper.setCustomNameservers(domain.resellerClubOrderId, nameservers!);

    if (apiResult.status === "success") {
      return NextResponse.json({ success: true, message: "Nameservers updated successfully" });
    }

    return NextResponse.json({ error: apiResult.message || "Failed to update nameservers" }, { status: 500 });
  } catch (error) {
    serverLogger.error("Admin nameservers update error:", error);
    return NextResponse.json({ error: "Failed to update nameservers" }, { status: 500 });
  }
}