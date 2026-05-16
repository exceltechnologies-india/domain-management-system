import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import { getUserByIdSafe } from "@/lib/services/users";
import { ZohoBooksService } from "@/lib/zohobooks";
import connectDB from "@/lib/mongodb";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    
    // Auth Check
    serverLogger.info('[AdminAPI] Invoice Request received');
    let user = await AuthService.getUserFromRequest(request);
    
    if (!user) {
      serverLogger.info('[AdminAPI] No user from request, checking NextAuth token');
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        user = await getUserByIdSafe(token.id);
      }
    }

    if (!user || user.role !== "admin") {
      serverLogger.info('[AdminAPI] Unauthorized access attempt', user?.email);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Params
    serverLogger.info('[AdminAPI] fetching invoices via Zoho service. OrgID:', process.env.ZOHO_ORG_ID);
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const perPage = parseInt(searchParams.get("per_page") || "20");

    const zohoService = ZohoBooksService.getInstance();
    const result = await zohoService.getAllInvoices(page, perPage);

    return NextResponse.json({
        success: true,
        invoices: result.invoices,
        page_context: result.page_context
    });

  } catch (error) {
    serverLogger.error("Failed to fetch admin invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    );
  }
}
