import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";
import { z } from "zod";

const checkAccountStatusSchema = z.object({
  email: Schemas.email,
});

// Force dynamic rendering
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const validation = await validatedBody(request, checkAccountStatusSchema);
    if (!validation.ok) return validation.response;
    const { email } = validation.data;

    const user = await getUserByEmail(email);

    if (!user) {
      return NextResponse.json(
        { exists: false, isActive: false },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        exists: true,
        isActive: user.isActive,
        isDeactivated: !user.isActive,
        role: user.role,
      },
      { status: 200 }
    );
  } catch (error) {
    serverLogger.error("Error checking account status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

