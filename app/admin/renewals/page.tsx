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
import RefreshButton from "@/components/dashboard/RefreshButton";
import { apiClient } from "@/lib/api-client";
import { safeLocalStorage } from "@/lib/storage";
import {
  Loader2, ExternalLink, CalendarClock, Repeat, CreditCard, Clock, Layers, AlertTriangle,
} from "lucide-react";

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

const MODE_META: Record<MandateMode, { label: string; classes: string; dot: string; icon: React.ElementType; iconBg: string; iconColor: string }> = {
  tokens: { label: "Tokens", classes: "bg-purple-100 text-purple-800", dot: "bg-purple-500", icon: Repeat, iconBg: "bg-purple-50", iconColor: "text-purple-600" },
  subscriptions: { label: "Subscription", classes: "bg-blue-100 text-blue-800", dot: "bg-blue-500", icon: CreditCard, iconBg: "bg-blue-50", iconColor: "text-blue-600" },
  manual: { label: "Manual", classes: "bg-gray-100 text-gray-700", dot: "bg-gray-400", icon: Clock, iconBg: "bg-gray-100", iconColor: "text-gray-600" },
};

const WINDOW_OPTIONS = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function daysUntil(iso: string): number {
  const d = new Date(iso).getTime();
  const now = Date.now();
  return Math.round((d - now) / (24 * 60 * 60 * 1000));
}

/** Colored "in Nd / Nd ago" pill — overdue red, ≤7d amber, else neutral. */
function DuePill({ chargeDate }: { chargeDate: string }) {
  const d = daysUntil(chargeDate);
  const isPast = d < 0;
  const soon = !isPast && d <= 7;
  const classes = isPast
    ? "bg-red-50 text-red-700 border-red-200"
    : soon
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-gray-50 text-gray-600 border-gray-200";
  const text = isPast ? `${Math.abs(d)}d ago` : d === 0 ? "today" : `in ${d}d`;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${classes}`}>
      {text}
    </span>
  );
}

function money(price: number | null, currency: string): string {
  if (price === null) return "—";
  const sym = currency === "INR" ? "₹" : `${currency} `;
  return `${sym}${price.toFixed(2)}`;
}

interface CurrentUser { firstName: string; lastName: string; email: string; role: string; }

export default function AdminRenewalsPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [modeFilter, setModeFilter] = useState<MandateMode | "all">("all");
  const [windowFilter, setWindowFilter] = useState<string>("30d");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    const params = new URLSearchParams();
    params.set("window", windowFilter);
    if (modeFilter !== "all") params.set("mode", modeFilter);
    const result = await apiClient.get<ApiResponse>(`/api/admin/renewals?${params.toString()}`);
    if (result.ok) {
      setData(result.data);
    } else {
      setErrorStatus(result.error.status);
      setError(result.error.message || "Failed to load renewals");
    }
    setLoading(false);
  }, [modeFilter, windowFilter]);

  // 401 = the admin session token wasn't accepted (expired / mid-rotation) —
  // handled app-wide by the SessionExpiredBanner in AdminLayout, so we skip the
  // in-page banner for it. Everything else (incl. 403) shows the red banner.
  const isAuthError = errorStatus === 401;

  useEffect(() => {
    const raw = safeLocalStorage.getItem("user");
    if (raw) {
      try {
        const u = JSON.parse(raw);
        setCurrentUser({ firstName: u.firstName || "Admin", lastName: u.lastName || "", email: u.email || "", role: u.role || "admin" });
      } catch { /* ignore */ }
    }
    void fetchData();
  }, [fetchData]);

  const counts = data?.counts;
  const totalCount = counts ? (counts.tokens ?? 0) + (counts.subscriptions ?? 0) + (counts.manual ?? 0) : 0;
  // Revenue due + overdue count are computed off the currently-loaded rows.
  const revenueDue = data?.rows.reduce((sum, r) => sum + (r.planPrice ?? 0), 0) ?? 0;
  const overdueCount = data?.rows.filter((r) => daysUntil(r.chargeDate) < 0).length ?? 0;

  const statCards: Array<{ key: MandateMode | "all"; label: string; count: number; icon: React.ElementType; iconBg: string; iconColor: string }> = [
    { key: "all", label: "All renewals", count: totalCount, icon: Layers, iconBg: "bg-blue-50", iconColor: "text-blue-600" },
    { key: "tokens", label: "Tokens", count: counts?.tokens ?? 0, icon: Repeat, iconBg: MODE_META.tokens.iconBg, iconColor: MODE_META.tokens.iconColor },
    { key: "subscriptions", label: "Subscription", count: counts?.subscriptions ?? 0, icon: CreditCard, iconBg: MODE_META.subscriptions.iconBg, iconColor: MODE_META.subscriptions.iconColor },
    { key: "manual", label: "Manual", count: counts?.manual ?? 0, icon: Clock, iconBg: MODE_META.manual.iconBg, iconColor: MODE_META.manual.iconColor },
  ];

  return (
    <AdminLayout
      user={currentUser || { firstName: "Admin", lastName: "", email: "", role: "admin" }}
      onLogout={() => { window.location.href = "/login"; }}
    >
      <div className="space-y-6">
        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <CalendarClock className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Renewals</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Upcoming hosting renewals across all billing rails. For per-attempt auto-charge state, see{" "}
                <a href="/admin/recurring-charges" className="text-blue-600 hover:underline">Recurring Charges</a>.
              </p>
            </div>
          </div>
          <RefreshButton onClick={() => void fetchData()} isLoading={loading} />
        </div>

        {/* ── Summary stat cards (clickable → filter by mode) ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((c) => {
            const active = modeFilter === c.key;
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                onClick={() => setModeFilter(c.key)}
                className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${active ? "border-blue-300 ring-2 ring-blue-100" : "border-gray-200 hover:border-gray-300 hover:shadow-md"}`}
              >
                <div className={`p-2 rounded-xl ${c.iconBg}`}>
                  <Icon className={`h-4 w-4 ${c.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-500">{c.label}</p>
                  <p className="text-xl font-bold text-gray-900">{data ? c.count : "—"}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Renewals card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header — title, revenue chip, window segmented control */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5 flex-wrap">
              <CalendarClock className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">Upcoming Renewals</h3>
              {data && data.rows.length > 0 && (
                <>
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
                    {money(revenueDue, "INR")} due
                  </span>
                  {overdueCount > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
                      <AlertTriangle className="h-3 w-3" /> {overdueCount} overdue
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="inline-flex bg-gray-100 rounded-xl p-1">
              {WINDOW_OPTIONS.map((w) => (
                <button
                  key={w.value}
                  onClick={() => setWindowFilter(w.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${windowFilter === w.value ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="p-4 sm:p-6">
            {/* Auth errors (401/403) are handled app-wide by the
                SessionExpiredBanner mounted in AdminLayout — no in-page banner
                needed here. Only non-auth load failures render below. */}
            {error && !isAuthError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-4 flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" /> {error}</div>
                <button onClick={() => void fetchData()} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-white border border-red-300 text-red-700 hover:bg-red-100 shrink-0">Retry</button>
              </div>
            )}

            {loading && !data ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600 mb-3" />
                <span className="text-sm">Loading renewals…</span>
              </div>
            ) : data && data.rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="p-3 bg-gray-50 rounded-2xl mb-3">
                  <CalendarClock className="h-6 w-6 text-gray-400" />
                </div>
                <p className="text-sm font-medium text-gray-900">No renewals due in this window</p>
                <p className="text-xs text-gray-500 mt-1">Try widening the window or switching billing mode.</p>
              </div>
            ) : data ? (
              <div className="overflow-x-auto -mx-4 sm:-mx-6">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="px-4 sm:px-6 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Charge date</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Domain</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Customer</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Plan</th>
                      <th className="px-4 py-2.5 text-right font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Amount</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Mode</th>
                      <th className="px-4 sm:px-6 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.rows.map((row) => {
                      const meta = MODE_META[row.mandateMode];
                      return (
                        <tr key={row.hostingId} className="hover:bg-gray-50/70 transition-colors">
                          <td className="px-4 sm:px-6 py-3 whitespace-nowrap">
                            <div className="font-medium text-gray-900 text-xs">{formatDate(row.chargeDate)}</div>
                            <div className="mt-1"><DuePill chargeDate={row.chargeDate} /></div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900">{row.domainName}</div>
                            {row.isTrial && (
                              <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-700 border border-amber-200">TRIAL</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-gray-900">{row.userName || row.userEmail}</div>
                            {row.userName && <div className="text-xs text-gray-500 truncate max-w-[180px]">{row.userEmail}</div>}
                          </td>
                          <td className="px-4 py-3 text-gray-700">{row.planName}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-900 whitespace-nowrap">{money(row.planPrice, row.planCurrency)}</td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.classes}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                              {meta.label}
                            </span>
                            {row.mandateMode === "tokens" && (
                              <a href="/admin/recurring-charges" className="ml-2 text-blue-600 hover:underline inline-flex items-center text-xs" title="See per-attempt MIT state">
                                attempts <ExternalLink className="w-3 h-3 ml-0.5" />
                              </a>
                            )}
                          </td>
                          <td className="px-4 sm:px-6 py-3 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                              row.hostingStatus === "expired" ? "bg-red-100 text-red-800"
                                : row.hostingStatus === "active" ? "bg-green-100 text-green-800"
                                : "bg-gray-100 text-gray-700"
                            }`}>
                              {row.hostingStatus}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {data.hasMore && (
                  <div className="mt-3 mx-4 sm:mx-6 bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl text-xs text-amber-800 flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Showing the first {data.rows.length} rows. Narrow the window or mode to see the rest.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
