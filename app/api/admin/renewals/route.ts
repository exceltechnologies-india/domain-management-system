/**
 * Admin API: cross-mode upcoming-renewals dashboard feed.
 *
 * Unions Hostings on all three billing rails into a single chronological
 * list of upcoming renewals so an operator can answer "what's about to
 * renew across our whole book in the next N days?" in one view:
 *
 *   - Tokens-flow Hostings (razorpayTokenId set) — driven by our daily
 *     MIT cron; hard 1-attempt rule applies. Charge date is
 *     `expiryDate - 1 day` to match CHARGE_LOOKAHEAD_DAYS in
 *     lib/services/payment/recurring-charge-service.ts.
 *   - Subscriptions-flow Hostings (subscriptionId set, no token) —
 *     driven by Razorpay's Subscriptions API server-side. Charge date
 *     is `expiryDate` (Razorpay's renewal-charge timing is theirs to
 *     own; we surface expiry as the soonest visible signal).
 *   - Manual Hostings (neither set) — no auto-renewal at all. Listed
 *     so the operator can pro-actively reach out before expiry.
 *
 * Source of truth is the Hosting collection (which carries both ID
 * fields), filtered by expiryDate within the requested window. Joins
 * with User (email/name) + HostingPlan (price) for the response.
 *
 * Permission: admin-only. 403 otherwise.
 *
 * Closes audit Finding 6 of 6 (cross-mode renewals dashboard).
 * Per-attempt MIT state still lives at /admin/recurring-charges
 * (Tokens-flow specific); this feed is the broader cross-mode lens.
 */
import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import Hosting from "@/models/Hosting";
import User from "@/models/User";
import HostingPlan from "@/models/HostingPlan";

export const dynamic = "force-dynamic";

type MandateMode = "tokens" | "subscriptions" | "manual";

const VALID_MODES: MandateMode[] = ["tokens", "subscriptions", "manual"];

interface RenewalRow {
  hostingId: string;
  domainName: string;
  userEmail: string;
  userName: string;
  planName: string;
  planPrice: number | null;
  planCurrency: string;
  mandateMode: MandateMode;
  expiryDate: string;
  // For Tokens, this is expiryDate - 1d (the cron sweeps at that time).
  // For Subscriptions / Manual, it equals expiryDate (Razorpay or
  // operator owns the charge timing).
  chargeDate: string;
  hostingStatus: string;
  isTrial: boolean;
  // Razorpay IDs surfaced so an operator can pivot to the Razorpay
  // dashboard without leaving the row.
  razorpayCustomerId: string | null;
  razorpayTokenId: string | null;
  subscriptionId: string | null;
}

function deriveMandateMode(h: {
  razorpayTokenId?: string | null;
  subscriptionId?: string | null;
}): MandateMode {
  if (h.razorpayTokenId) return "tokens";
  if (h.subscriptionId) return "subscriptions";
  return "manual";
}

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectDB();

    const url = new URL(request.url);
    const modeParam = url.searchParams.get("mode");
    const windowParam = url.searchParams.get("window") || "30d";
    const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitParam) ? limitParam : 100));

    const windowDays = ({ "7d": 7, "30d": 30, "90d": 90 } as const)[
      windowParam as "7d" | "30d" | "90d"
    ] ?? 30;

    const now = new Date();
    const until = new Date(now);
    until.setDate(until.getDate() + windowDays);

    // Active or expired hostings whose expiry falls in the window.
    // 'pending' rows haven't been DA-provisioned yet (no expiry to
    // renew against); 'terminated' / 'failed' are already gone.
    const baseFilter: Record<string, unknown> = {
      status: { $in: ["active", "expired"] },
      expiryDate: { $lte: until },
    };

    if (modeParam && VALID_MODES.includes(modeParam as MandateMode)) {
      if (modeParam === "tokens") {
        baseFilter.razorpayTokenId = { $exists: true, $ne: null, $nin: ["", null] };
      } else if (modeParam === "subscriptions") {
        baseFilter.subscriptionId = { $exists: true, $ne: null, $nin: ["", null] };
        baseFilter.razorpayTokenId = { $in: [null, undefined, ""] };
      } else {
        // manual: neither field set
        baseFilter.razorpayTokenId = { $in: [null, undefined, ""] };
        baseFilter.subscriptionId = { $in: [null, undefined, ""] };
      }
    }

    type HostingLean = {
      _id: { toString(): string };
      domainName: string;
      userId: { toString(): string };
      status: string;
      expiryDate: Date;
      planId?: string;
      isTrial?: boolean;
      razorpayCustomerId?: string | null;
      razorpayTokenId?: string | null;
      subscriptionId?: string | null;
    };

    const hostings = (await Hosting.find(baseFilter)
      .sort({ expiryDate: 1 })
      .limit(limit)
      .lean()) as unknown as HostingLean[];

    const userIds = Array.from(new Set(hostings.map((h) => h.userId.toString())));
    const planIds = Array.from(
      new Set(hostings.map((h) => h.planId).filter((p): p is string => Boolean(p)))
    );

    const [users, plans] = await Promise.all([
      userIds.length
        ? User.find({ _id: { $in: userIds } })
            .select("_id email firstName lastName")
            .lean()
        : [],
      planIds.length
        ? HostingPlan.find({ planId: { $in: planIds } })
            .select("planId name price currency")
            .lean()
        : [],
    ]);

    type UserRow = { _id: { toString(): string }; email: string; firstName?: string; lastName?: string };
    type PlanRow = { planId: string; name: string; price?: number; currency?: string };

    const userMap = new Map<string, UserRow>(
      (users as unknown as UserRow[]).map((u) => [u._id.toString(), u])
    );
    const planMap = new Map<string, PlanRow>(
      (plans as unknown as PlanRow[]).map((p) => [p.planId, p])
    );

    const rows: RenewalRow[] = hostings.map((h) => {
      const userId = h.userId.toString();
      const user = userMap.get(userId);
      const plan = h.planId ? planMap.get(h.planId) : undefined;
      const mode = deriveMandateMode(h);

      const chargeDate = new Date(h.expiryDate);
      if (mode === "tokens") {
        // Cron's CHARGE_LOOKAHEAD_DAYS=1 — charge fires up to 1 day before expiry.
        chargeDate.setDate(chargeDate.getDate() - 1);
      }

      return {
        hostingId: h._id.toString(),
        domainName: h.domainName,
        userEmail: user?.email ?? "(deleted)",
        userName: user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "",
        planName: plan?.name ?? h.planId ?? "Unknown",
        planPrice: plan?.price ?? null,
        planCurrency: plan?.currency ?? "INR",
        mandateMode: mode,
        expiryDate: h.expiryDate.toISOString(),
        chargeDate: chargeDate.toISOString(),
        hostingStatus: h.status,
        isTrial: h.isTrial ?? false,
        razorpayCustomerId: h.razorpayCustomerId ?? null,
        razorpayTokenId: h.razorpayTokenId ?? null,
        subscriptionId: h.subscriptionId ?? null,
      };
    });

    // Aggregate counts by mode across the SAME window (not the filtered
    // slice) so the dashboard can show "12 tokens-mode renewals this
    // window" regardless of which mode-filter the user is currently
    // viewing.
    const allInWindow = await Hosting.find({
      status: { $in: ["active", "expired"] },
      expiryDate: { $lte: until },
    })
      .select("razorpayTokenId subscriptionId")
      .lean();

    const counts: Record<MandateMode, number> = {
      tokens: 0,
      subscriptions: 0,
      manual: 0,
    };
    for (const h of allInWindow as unknown as Array<{
      razorpayTokenId?: string | null;
      subscriptionId?: string | null;
    }>) {
      counts[deriveMandateMode(h)] += 1;
    }

    return secureJsonResponse({
      success: true,
      window: windowParam,
      modeFilter: modeParam && VALID_MODES.includes(modeParam as MandateMode) ? modeParam : null,
      counts,
      rows,
      hasMore: rows.length >= limit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    serverLogger.error("[Admin:renewals] error:", msg);
    return secureErrorResponse("Failed to load renewals", 500, "INTERNAL_ERROR");
  }
}
