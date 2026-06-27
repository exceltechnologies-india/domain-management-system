/**
 * Admin API: list RecurringChargeAttempt rows for the Tokens-flow
 * MIT-charge dashboard.
 *
 * Joins each attempt with its Hosting (for domainName + status) and
 * User (for email/name) so the table renders in one round-trip. Read-only;
 * no mutation. Filterable by status + lookback window so the page is
 * usable at any volume.
 *
 * Permission: admin-only (AuthService.isAdmin). Returns 403 otherwise.
 *
 * Surfaced in the admin sidebar as "Recurring Charges" — see
 * components/admin/AdminLayout.tsx. The page at
 * app/admin/recurring-charges/page.tsx renders the table.
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import RecurringChargeAttempt from "@/models/RecurringChargeAttempt";
import Hosting from "@/models/Hosting";
import User from "@/models/User";

export const dynamic = "force-dynamic";

type AttemptStatus = "pending" | "in_progress" | "succeeded" | "failed" | "abandoned";

const VALID_STATUSES: AttemptStatus[] = [
  "pending",
  "in_progress",
  "succeeded",
  "failed",
  "abandoned",
];

interface AttemptRow {
  id: string;
  hostingId: string;
  domainName: string;
  userEmail: string;
  userName: string;
  customerId: string;
  tokenId: string;
  amountInRupees: number;
  dueDate: string;
  attemptCount: number;
  status: AttemptStatus;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  abandonedAt: string | null;
  razorpayPaymentId: string | null;
  razorpayOrderId: string | null;
  createdAt: string;
  // True when this attempt was the FIRST post-trial charge for its hosting
  // (no prior succeeded attempt existed when this attempt fired). Used by
  // the UI to show "N / 1" instead of "N / 4" — first-charge fails follow
  // the hard 1-attempt rule, not the 4-attempt renewal soft-grace.
  wasFirstPostTrial: boolean;
  maxAttempts: number;
}

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectDB();

    // Parse + validate query params
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const windowParam = url.searchParams.get("window") || "7d";
    const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitParam) ? limitParam : 100));

    const windowDays = ({ "24h": 1, "7d": 7, "30d": 30, "90d": 90 } as const)[
      windowParam as "24h" | "7d" | "30d" | "90d"
    ] ?? 7;
    const since = new Date();
    since.setDate(since.getDate() - windowDays);

    const filter: Record<string, unknown> = { createdAt: { $gte: since } };
    if (statusParam && VALID_STATUSES.includes(statusParam as AttemptStatus)) {
      filter.status = statusParam;
    }

    // Pull attempts. Newest first so the dashboard shows recent activity
    // at the top. lean() because we're shaping the response ourselves.
    const attempts = (await RecurringChargeAttempt.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()) as unknown as Array<{
      _id: { toString(): string };
      hostingId: { toString(): string };
      userId: { toString(): string };
      customerId: string;
      tokenId: string;
      amountInRupees: number;
      dueDate: Date;
      attemptCount: number;
      status: AttemptStatus;
      nextAttemptAt?: Date | null;
      lastAttemptAt?: Date | null;
      lastError?: string | null;
      abandonedAt?: Date | null;
      razorpayPaymentId?: string | null;
      razorpayOrderId?: string | null;
      createdAt: Date;
    }>;

    // Batch-fetch the join targets (Hosting for domain; User for email + name).
    const hostingIds = Array.from(new Set(attempts.map((a) => a.hostingId.toString())));
    const userIds = Array.from(new Set(attempts.map((a) => a.userId.toString())));

    const [hostings, users, succeededByHosting] = await Promise.all([
      hostingIds.length
        ? Hosting.find({ _id: { $in: hostingIds } })
            .select("_id domainName status")
            .lean()
        : [],
      userIds.length
        ? User.find({ _id: { $in: userIds } })
            .select("_id email firstName lastName")
            .lean()
        : [],
      // For each hosting on the page, find the earliest succeeded attempt's
      // createdAt. An attempt is "first post-trial" iff its createdAt is
      // <= this value (or no value exists for its hosting at all).
      hostingIds.length
        ? RecurringChargeAttempt.aggregate<{
            _id: { toString(): string };
            earliestSucceededAt: Date;
          }>([
            { $match: { hostingId: { $in: hostingIds }, status: "succeeded" } },
            { $group: { _id: "$hostingId", earliestSucceededAt: { $min: "$createdAt" } } },
          ])
        : [],
    ]);

    type HostingRow = { _id: { toString(): string }; domainName: string };
    type UserRow = { _id: { toString(): string }; email: string; firstName?: string; lastName?: string };
    const hostingMap = new Map<string, HostingRow>(
      (hostings as unknown as HostingRow[]).map((h) => [h._id.toString(), h])
    );
    const userMap = new Map<string, UserRow>(
      (users as unknown as UserRow[]).map((u) => [u._id.toString(), u])
    );
    const firstSuccessByHosting = new Map<string, Date>(
      succeededByHosting.map((r) => [r._id.toString(), r.earliestSucceededAt])
    );

    const rows: AttemptRow[] = attempts.map((a) => {
      const hostingId = a.hostingId.toString();
      const userId = a.userId.toString();
      const hosting = hostingMap.get(hostingId);
      const user = userMap.get(userId);
      // wasFirstPostTrial: no prior succeeded attempt existed when this
      // row was created. The earliest-succeeded check handles 3 cases
      // correctly: (a) no successes at all → true; (b) THIS row is the
      // earliest success → true (no prior at attempt time); (c) row was
      // created after a prior success → false (it's a renewal).
      // Kept for audit-trail differentiation in the UI even though both
      // branches now share the hard 1-attempt policy.
      const firstSuccessAt = firstSuccessByHosting.get(hostingId);
      const wasFirstPostTrial = !firstSuccessAt || a.createdAt <= firstSuccessAt;
      const maxAttempts = 1; // uniform hard rule — see lib/services/payment/recurring-charge-service.ts
      return {
        id: a._id.toString(),
        hostingId,
        domainName: hosting?.domainName ?? "(deleted)",
        userEmail: user?.email ?? "(deleted)",
        userName: user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "",
        customerId: a.customerId,
        tokenId: a.tokenId,
        amountInRupees: a.amountInRupees,
        dueDate: a.dueDate.toISOString(),
        attemptCount: a.attemptCount,
        status: a.status,
        nextAttemptAt: a.nextAttemptAt ? a.nextAttemptAt.toISOString() : null,
        lastAttemptAt: a.lastAttemptAt ? a.lastAttemptAt.toISOString() : null,
        lastError: a.lastError ?? null,
        abandonedAt: a.abandonedAt ? a.abandonedAt.toISOString() : null,
        razorpayPaymentId: a.razorpayPaymentId ?? null,
        razorpayOrderId: a.razorpayOrderId ?? null,
        createdAt: a.createdAt.toISOString(),
        wasFirstPostTrial,
        maxAttempts,
      };
    });

    // Aggregate counts by status (across the same window — not the filter,
    // so the dashboard can show "12 abandoned this week" regardless of
    // which status filter the user is currently viewing).
    const allInWindow = await RecurringChargeAttempt.aggregate<{
      _id: AttemptStatus;
      count: number;
    }>([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const counts: Record<AttemptStatus, number> = {
      pending: 0,
      in_progress: 0,
      succeeded: 0,
      failed: 0,
      abandoned: 0,
    };
    for (const row of allInWindow) {
      if (row._id in counts) counts[row._id] = row.count;
    }

    return secureJsonResponse({
      success: true,
      window: windowParam,
      statusFilter: filter.status ?? null,
      counts,
      rows,
      hasMore: rows.length >= limit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    serverLogger.error("[Admin:recurring-charges] error:", msg);
    return secureErrorResponse("Failed to load recurring charges", 500, "INTERNAL_ERROR");
  }
}
