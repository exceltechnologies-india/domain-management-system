import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import { getCurrentDate } from "@/lib/dateUtils";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const today = getCurrentDate();
    
    // Find ALL hostings to check their raw dates
    const allHostings = await Hosting.find({ status: 'active' }).limit(5).select('domainName expiryDate status');
    
    // Run the actual query
    const expiredHostings = await Hosting.find({
        status: 'active',
        expiryDate: { $lt: today, $ne: null }
    }).select('domainName expiryDate');

    return NextResponse.json({
        currentTime: today,
        currentTimeISO: today.toISOString(),
        expiredCount: expiredHostings.length,
        expiredItems: expiredHostings,
        sampleActiveHostings: allHostings
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
