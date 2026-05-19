import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";

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

    const { domainName, method, nameservers } = await request.json();

    if (!domainName || !method) {
      return NextResponse.json({ error: "Domain name and method are required" }, { status: 400 });
    }

    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
    if (!domainRegex.test(domainName)) {
      return NextResponse.json({ error: "Invalid domain name format" }, { status: 400 });
    }

    await connectDB();

    // Verify user owns the order/domain
    const order = await Order.findOne({ 
      "domains.domainName": domainName, 
      userId: user._id,
      isDeleted: { $ne: true } 
    });

    if (!order) {
      return NextResponse.json({ error: "Domain not found or unauthorized" }, { status: 404 });
    }

    const domain = order.domains.find((d: IOrder['domains'][number]) => d.domainName === domainName);
    if (!domain) {
      return NextResponse.json({ error: "Domain not found in order" }, { status: 404 });
    }

    if (!domain.resellerClubOrderId) {
      return NextResponse.json({ error: "Domain is missing its registrar order reference. Please contact support." }, { status: 400 });
    }

    let apiResult;
    if (method === "default") {
      apiResult = await ResellerClubWrapper.setDefaultNameservers(domain.resellerClubOrderId);
    } else if (method === "custom") {
      if (!Array.isArray(nameservers) || nameservers.length < 2) {
        return NextResponse.json({ error: "At least two nameservers are required" }, { status: 400 });
      }
      const normalized = (nameservers as unknown[])
        .map((ns) => String(ns).toLowerCase().trim())
        .filter((ns: string) => ns.length > 0);
      if (normalized.length < 2) {
        return NextResponse.json({ error: "At least two nameservers are required" }, { status: 400 });
      }
      const nsRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      for (const ns of normalized) {
        if (!nsRegex.test(ns)) {
          return NextResponse.json({ error: "Invalid nameserver format" }, { status: 400 });
        }
      }
      apiResult = await ResellerClubWrapper.setCustomNameservers(domain.resellerClubOrderId, normalized);
    } else {
      return NextResponse.json({ error: "Invalid method" }, { status: 400 });
    }

    if (apiResult.status === "success") {
      return NextResponse.json({ success: true, message: "Nameservers updated successfully" });
    }

    return NextResponse.json({ error: apiResult.message || "Failed to update nameservers" }, { status: 500 });
  } catch (error) {
    serverLogger.error("User nameservers update error:", error);
    return NextResponse.json({ error: "Failed to update nameservers" }, { status: 500 });
  }
}
