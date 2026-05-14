import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    await connectDB();

    const user = await User.findOne({ email: email.toLowerCase().trim() });

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

