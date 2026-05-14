import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import Settings from "@/models/Settings";
import { connectToDatabase } from "@/lib/mongoose";
import User from "@/models/User";
import { requireReAuth } from "@/lib/admin-security";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all settings
    const settings = await Settings.find({}).sort({ category: 1, key: 1 });

    // Convert to key-value object for easier frontend usage
    const settingsObject = settings.reduce((acc, setting) => {
      acc[setting.key] = {
        value: setting.value,
        description: setting.description,
        category: setting.category,
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
      };
      return acc;
    }, {} as any);

    return NextResponse.json({
      success: true,
      settings: settingsObject,
    });
  } catch (error) {
    serverLogger.error("Settings fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { key, value, description, category } = await request.json();

    // Step-up auth: only required for security-critical settings
    if (category === "security") {
      const adminId = (user._id as any)?.toString() || user.id || "";
      const reauth = await requireReAuth(request, adminId);
      if (!reauth.passed) {
        return NextResponse.json(
          { error: "Current password required to update security settings", code: "REAUTH_REQUIRED" },
          { status: 403 }
        );
      }
    }

    if (!key || value === undefined) {
      return NextResponse.json(
        { error: "Key and value are required" },
        { status: 400 }
      );
    }

    await connectToDatabase();

    // Update or create setting
    const setting = await Settings.findOneAndUpdate(
      { key },
      {
        key,
        value,
        description: description || "",
        category: category || "general",
        updatedAt: new Date(),
        updatedBy: user.email,
      },
      { upsert: true, new: true }
    );

    return NextResponse.json({
      success: true,
      setting: {
        key: setting.key,
        value: setting.value,
        description: setting.description,
        category: setting.category,
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
      },
    });
  } catch (error) {
    serverLogger.error("Settings update error:", error);
    return NextResponse.json(
      { error: "Failed to update setting" },
      { status: 500 }
    );
  }
}
