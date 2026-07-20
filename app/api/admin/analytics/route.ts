import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongoose";
import { getScoreWeights, setScoreWeights, ACTIVITY_TYPES } from "@/lib/services/analytics";
import User from "@/models/User";
import CustomerActivity from "@/models/CustomerActivity";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";

interface TopCustomer {
  id: string;
  name: string;
  email: string;
  leadScore: number;
  lastActivityAt: string | null;
}

export async function GET(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await connectToDatabase();
    const [weights, topDocs, recentDocs, totalActivities] = await Promise.all([
      getScoreWeights(),
      User.find({ leadScore: { $gt: 0 } })
        .sort({ leadScore: -1 })
        .limit(20)
        .select("firstName lastName email leadScore lastActivityAt")
        .lean(),
      CustomerActivity.find({})
        .sort({ createdAt: -1 })
        .limit(30)
        .select("activity score userId anonId createdAt")
        .lean(),
      CustomerActivity.estimatedDocumentCount(),
    ]);

    const topCustomers: TopCustomer[] = (topDocs as Array<Record<string, unknown>>).map((d) => ({
      id: String(d._id),
      name: `${(d.firstName as string) || ""} ${(d.lastName as string) || ""}`.trim() || "—",
      email: (d.email as string) || "",
      leadScore: (d.leadScore as number) || 0,
      lastActivityAt: d.lastActivityAt ? new Date(d.lastActivityAt as string).toISOString() : null,
    }));

    const recentActivity = (recentDocs as Array<Record<string, unknown>>).map((d) => ({
      activity: d.activity as string,
      score: (d.score as number) || 0,
      userId: d.userId ? String(d.userId) : null,
      anonId: (d.anonId as string) || null,
      createdAt: new Date(d.createdAt as string).toISOString(),
    }));

    return NextResponse.json({
      success: true,
      weights,
      activityTypes: ACTIVITY_TYPES,
      topCustomers,
      recentActivity,
      totalActivities,
    });
  } catch (error) {
    serverLogger.error("Analytics fetch error:", error);
    return NextResponse.json({ error: "Failed to load analytics" }, { status: 500 });
  }
}

const patchSchema = z.object({
  weights: z.record(z.string(), z.number().min(0).max(100000)),
});

export async function PATCH(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const validation = await validatedBody(request, patchSchema);
  if (!validation.ok) return validation.response;

  try {
    await connectToDatabase();
    const weights = await setScoreWeights(
      validation.data.weights,
      String(user._id ?? user.id ?? "admin"),
    );
    return NextResponse.json({ success: true, weights });
  } catch (error) {
    serverLogger.error("Analytics update error:", error);
    return NextResponse.json({ error: "Failed to update score weights" }, { status: 500 });
  }
}
