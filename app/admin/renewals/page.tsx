'use client';

/**
 * /admin/renewals — cross-mode upcoming-renewals dashboard.
 *
 * One unified chronological list of Hostings whose expiry falls in the
 * selected window, across all three billing rails:
 *
 *   - Tokens-flow → driven by our daily MIT cron; hard 1-attempt rule
 *   - Subscriptions-flow → Razorpay handles charge + retries server-side
 *   - Manual → no auto-renewal; operator outreach needed
 *
 * Closes audit Finding 6 of 6 (cross-mode renewals dashboard) — the
 * last MEDIUM admin-UI gap from the Tokens-flow visibility audit. The
 * per-attempt Tokens-flow state still lives at /admin/recurring-charges
 * (where you triage failed/abandoned MITs); this feed is the broader
 * "what's about to renew across our whole book" lens.
 */

import { useEffect, useState, useCallback } from "react";
import AdminLayout from "@/components/admin/AdminLayout";
import { apiClient } from "@/lib/api-client";
import { safeLocalStorage } from "@/lib/storage";
import { Loader2, RefreshCw, Filter, ExternalLink } from "lucide-react";

type MandateMode = "tokens" | "subscriptions" | "manual";

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
  chargeDate: string;
  hostingStatus: string;
  isTrial: boolean;
  razorpayCustomerId: string | null;
  razorpayTokenId: string | null;
  subscriptionId: string | null;
}

interface ApiResponse {
  success: boolean;
  window: string;
  modeFilter: MandateMode | null;
  counts: Record<MandateMode, number>;
  rows: RenewalRow[];
  hasMore: boolean;
}

const MODE_OPTIONS: Array<{ value: MandateMode | "all"; label: string; classes: string }> = [
  { value: "all", label: "All", classes: "bg-gray-100 text-gray-800" },
  { value: "tokens", label: "Tokens", classes: "bg-purple-100 text-purple-800" },
  { value: "subscriptions", label: "Subscription", classes: "bg-blue-100 text-blue-800" },
  { value: "manual", label: "Manual", classes: "bg-gray-100 text-gray-700" },
];

const WINDOW_OPTIONS = [
  { value: "7d", label: "Next 7 days" },
  { value: "30d", label: "Next 30 days" },
  { value: "90d", label: "Next 90 days" },
];

function modeBadge(mode: MandateMode): { label: string; classes: string } {
  const opt = MODE_OPTIONS.find((m) => m.value === mode);
  return opt ? { label: opt.label, classes: opt.classes } : { label: mode, classes: "bg-gray-100" };
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysUntil(iso: string): number {
  const d = new Date(iso).getTime();
  const now = Date.now();
  return Math.round((d - now) / (24 * 60 * 60 * 1000));
}

interface CurrentUser {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export default function AdminRenewalsPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modeFilter, setModeFilter] = useState<MandateMode | "all">("all");
  const [windowFilter, setWindowFilter] = useState<string>("30d");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("window", windowFilter);
    if (modeFilter !== "all") params.set("mode", modeFilter);
    const result = await apiClient.get<ApiResponse>(
      `/api/admin/renewals?${params.toString()}`
    );
    if (result.ok) {
      setData(result.data);
    } else {
      setError(result.error.message || "Failed to load renewals");
    }
    setLoading(false);
  }, [modeFilter, windowFilter]);

  useEffect(() => {
    const raw = safeLocalStorage.getItem("user");
    if (raw) {
      try {
        const u = JSON.parse(raw);
        setCurrentUser({
          firstName: u.firstName || "Admin",
          lastName: u.lastName || "",
          email: u.email || "",
          role: u.role || "admin",
        });
      } catch {
        /* ignore */
      }
    }
    void fetchData();
  }, [fetchData]);

  return (
    <AdminLayout
      user={currentUser || { firstName: "Admin", lastName: "", email: "", role: "admin" }}
      onLogout={() => {
        window.location.href = "/login";
      }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Renewals (cross-mode)</h1>
            <p className="text-sm text-gray-500 mt-1">
              Upcoming hosting renewals across all billing rails. For Tokens-flow per-attempt
              state, see <a href="/admin/recurring-charges" className="text-blue-600 hover:underline">Recurring Charges</a>.
            </p>
          </div>
          <button
            onClick={() => void fetchData()}
            disabled={loading}
            className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Filters</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Billing mode</label>
              <select
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as MandateMode | "all")}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
              >
                {MODE_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Window</label>
              <select
                value={windowFilter}
                onChange={(e) => setWindowFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
              >
                {WINDOW_OPTIONS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Summary counts */}
        {data && (
          <div className="grid grid-cols-3 gap-4 mb-6">
            {(["tokens", "subscriptions", "manual"] as MandateMode[]).map((m) => {
              const opt = MODE_OPTIONS.find((o) => o.value === m)!;
              return (
                <div key={m} className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className={`text-xs font-medium px-2 py-0.5 rounded-full inline-block ${opt.classes}`}>
                    {opt.label}
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{data.counts[m] ?? 0}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Table */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-4">{error}</div>
        )}
        {loading && !data ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : data && data.rows.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-12 text-center text-gray-500">
            No renewals due in this window.
          </div>
        ) : data ? (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Charge date</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Domain</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">User</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Plan</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500 uppercase text-xs">Amount</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Mode</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Hosting status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.rows.map((row) => {
                    const b = modeBadge(row.mandateMode);
                    const dDays = daysUntil(row.chargeDate);
                    const isPast = dDays < 0;
                    return (
                      <tr key={row.hostingId} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs">
                          <div className={`font-medium ${isPast ? "text-red-700" : "text-gray-900"}`}>
                            {formatDate(row.chargeDate)}
                          </div>
                          <div className="text-gray-500">
                            {isPast ? `${Math.abs(dDays)}d ago` : `in ${dDays}d`}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="font-medium text-gray-900">{row.domainName}</div>
                          {row.isTrial && (
                            <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-700 border border-amber-200">
                              TRIAL
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <div className="text-gray-900">{row.userName || row.userEmail}</div>
                          {row.userName && <div className="text-xs text-gray-500">{row.userEmail}</div>}
                        </td>
                        <td className="px-4 py-2 text-gray-700">{row.planName}</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-900">
                          {row.planPrice !== null
                            ? `${row.planCurrency === "INR" ? "₹" : row.planCurrency + " "}${row.planPrice.toFixed(2)}`
                            : "—"}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${b.classes}`}>
                            {b.label}
                          </span>
                          {row.mandateMode === "tokens" && (
                            <a
                              href={`/admin/recurring-charges`}
                              className="ml-2 text-blue-600 hover:underline inline-flex items-center text-xs"
                              title="See per-attempt MIT state"
                            >
                              attempts <ExternalLink className="w-3 h-3 ml-0.5" />
                            </a>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs font-medium ${
                            row.hostingStatus === "expired" ? "text-red-700" : "text-gray-700"
                          }`}>
                            {row.hostingStatus}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data.hasMore && (
              <div className="bg-yellow-50 border-t border-yellow-200 px-4 py-2 text-xs text-yellow-800">
                Showing first {data.rows.length} rows. Narrow the filters to see more.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </AdminLayout>
  );
}
