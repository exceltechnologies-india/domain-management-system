'use client';

/**
 * /admin/recurring-charges — Tokens-flow MIT recurring-charge dashboard.
 *
 * Surfaces every `RecurringChargeAttempt` row in a filterable table so
 * an operator can answer questions like:
 *   - "How many MIT charges are pending right now?"
 *   - "Which Hostings have failing mandates that will be abandoned next attempt?"
 *   - "When is this customer's next retry?"
 *   - "What error did Razorpay return on the last attempt?"
 *
 * Closes audit Finding 3 from the admin-UI visibility audit (no UI
 * surface for the new RecurringChargeAttempt collection that Phase 2D
 * shipped today).
 *
 * Read-only — no mutation. To resolve a failed charge, an operator
 * pivots into the Razorpay dashboard via the customerId / tokenId IDs
 * shown in the table (which they can copy-click).
 */

import { useEffect, useState, useCallback } from "react";
import AdminLayout from "@/components/admin/AdminLayout";
import RefreshButton from "@/components/dashboard/RefreshButton";
import { apiClient } from "@/lib/api-client";
import { safeLocalStorage } from "@/lib/storage";
import {
  Loader2, RefreshCcw, AlertTriangle, Clock, RotateCw, CheckCircle2, XCircle, Lock,
} from "lucide-react";

type AttemptStatus = "pending" | "in_progress" | "succeeded" | "failed" | "abandoned";

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
  wasFirstPostTrial?: boolean;
  maxAttempts?: number;
}

interface ApiResponse {
  success: boolean;
  window: string;
  statusFilter: AttemptStatus | null;
  counts: Record<AttemptStatus, number>;
  rows: AttemptRow[];
  hasMore: boolean;
}

const STATUS_META: Record<AttemptStatus, { label: string; classes: string; dot: string; icon: React.ElementType; iconBg: string; iconColor: string }> = {
  pending: { label: "Pending", classes: "bg-amber-100 text-amber-800", dot: "bg-amber-500", icon: Clock, iconBg: "bg-amber-50", iconColor: "text-amber-600" },
  in_progress: { label: "In progress", classes: "bg-blue-100 text-blue-800", dot: "bg-blue-500", icon: RotateCw, iconBg: "bg-blue-50", iconColor: "text-blue-600" },
  succeeded: { label: "Succeeded", classes: "bg-green-100 text-green-800", dot: "bg-green-500", icon: CheckCircle2, iconBg: "bg-green-50", iconColor: "text-green-600" },
  failed: { label: "Failed (retry scheduled)", classes: "bg-orange-100 text-orange-800", dot: "bg-orange-500", icon: AlertTriangle, iconBg: "bg-orange-50", iconColor: "text-orange-600" },
  abandoned: { label: "Abandoned", classes: "bg-red-100 text-red-800", dot: "bg-red-500", icon: XCircle, iconBg: "bg-red-50", iconColor: "text-red-600" },
};

const STATUS_ORDER: AttemptStatus[] = ["pending", "in_progress", "succeeded", "failed", "abandoned"];

const WINDOW_OPTIONS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface CurrentUser { firstName: string; lastName: string; email: string; role: string; }

export default function AdminRecurringChargesPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<AttemptStatus | "all">("all");
  const [windowFilter, setWindowFilter] = useState<string>("7d");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    const params = new URLSearchParams();
    params.set("window", windowFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    const result = await apiClient.get<ApiResponse>(`/api/admin/recurring-charges?${params.toString()}`);
    if (result.ok) {
      setData(result.data);
    } else {
      setErrorStatus(result.error.status);
      setError(result.error.message || "Failed to load recurring charges");
    }
    setLoading(false);
  }, [statusFilter, windowFilter]);

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

  // 401 → handled app-wide by SessionExpiredBanner in AdminLayout; skip the
  // in-page red banner for it. Everything else shows below.
  const isAuthError = errorStatus === 401;

  return (
    <AdminLayout
      user={currentUser || { firstName: "Admin", lastName: "", email: "", role: "admin" }}
      onLogout={() => { window.location.href = "/login"; }}
    >
      <div className="space-y-6">
        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-50 rounded-xl">
              <RefreshCcw className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold text-gray-900">Recurring Charges</h1>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600 border border-gray-200">
                  <Lock className="h-3 w-3" /> Read-only
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-0.5">
                Tokens-flow auto-charge attempts — one row per (Hosting, billing cycle). Refund / cancel mandates from the Razorpay dashboard.
              </p>
            </div>
          </div>
          <RefreshButton onClick={() => void fetchData()} isLoading={loading} />
        </div>

        {/* ── Status stat cards (clickable → filter) ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {STATUS_ORDER.map((s) => {
            const meta = STATUS_META[s];
            const active = statusFilter === s;
            const Icon = meta.icon;
            return (
              <button
                key={s}
                onClick={() => setStatusFilter((prev) => (prev === s ? "all" : s))}
                className={`bg-white border rounded-2xl shadow-sm px-4 py-4 flex items-center gap-3 text-left transition-all ${active ? "border-blue-300 ring-2 ring-blue-100" : "border-gray-200 hover:border-gray-300 hover:shadow-md"}`}
              >
                <div className={`p-2 rounded-xl ${meta.iconBg}`}>
                  <Icon className={`h-4 w-4 ${meta.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-500 truncate">{s === "failed" ? "Failed" : meta.label}</p>
                  <p className="text-xl font-bold text-gray-900">{data ? (data.counts[s] ?? 0) : "—"}</p>
                </div>
              </button>
            );
          })}
        </div>
        {statusFilter !== "all" && (
          <div className="-mt-2">
            <button onClick={() => setStatusFilter("all")} className="text-xs font-medium text-blue-600 hover:underline">
              ← Clear status filter (showing {STATUS_META[statusFilter].label})
            </button>
          </div>
        )}

        {/* ── Attempts card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <RefreshCcw className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">Charge Attempts</h3>
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

          <div className="p-4 sm:p-6">
            {error && !isAuthError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-4 flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" /> {error}</div>
                <button onClick={() => void fetchData()} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-white border border-red-300 text-red-700 hover:bg-red-100 shrink-0">Retry</button>
              </div>
            )}

            {loading && !data ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600 mb-3" />
                <span className="text-sm">Loading charge attempts…</span>
              </div>
            ) : data && data.rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="p-3 bg-gray-50 rounded-2xl mb-3">
                  <RefreshCcw className="h-6 w-6 text-gray-400" />
                </div>
                <p className="text-sm font-medium text-gray-900">No recurring charge attempts in this window</p>
                <p className="text-xs text-gray-500 mt-1 max-w-md">
                  Tokens-flow is dormant in production until <code className="px-1 py-0.5 bg-gray-100 rounded text-[11px]">HOSTING_MANDATE_FLOW=tokens</code>. Until then, no attempt rows are written.
                </p>
              </div>
            ) : data ? (
              <div className="overflow-x-auto -mx-4 sm:-mx-6">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="px-4 sm:px-6 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Domain</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Customer</th>
                      <th className="px-4 py-2.5 text-right font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Amount</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Status</th>
                      <th className="px-4 py-2.5 text-center font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Attempt</th>
                      <th className="px-4 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Due / Next retry</th>
                      <th className="px-4 sm:px-6 py-2.5 font-semibold text-gray-400 uppercase text-[11px] tracking-wide">Last error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.rows.map((row) => {
                      const meta = STATUS_META[row.status];
                      return (
                        <tr key={row.id} className="hover:bg-gray-50/70 transition-colors">
                          <td className="px-4 sm:px-6 py-3">
                            <div className="font-medium text-gray-900">{row.domainName}</div>
                            <div className="text-xs text-gray-400 font-mono truncate max-w-[160px]">{row.tokenId}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-gray-900">{row.userName || row.userEmail}</div>
                            {row.userName && <div className="text-xs text-gray-500 truncate max-w-[180px]">{row.userEmail}</div>}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-gray-900 whitespace-nowrap">₹{row.amountInRupees.toFixed(2)}</td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.classes}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                              {meta.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            <span
                              title={row.wasFirstPostTrial
                                ? "First post-trial charge — hard 1-attempt rule (trial→paid conversion didn't take)"
                                : "Renewal — hard 1-attempt rule (existing customer's mandate failed)"}
                              className={`font-semibold ${row.wasFirstPostTrial ? "text-purple-700" : "text-blue-700"}`}
                            >
                              {row.attemptCount} / {row.maxAttempts ?? 1}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                            <div>Due: {formatDate(row.dueDate)}</div>
                            {row.nextAttemptAt && row.status === "failed" && (
                              <div className="text-orange-700">Next retry: {formatDate(row.nextAttemptAt)}</div>
                            )}
                            {row.abandonedAt && (
                              <div className="text-red-700">Abandoned: {formatDate(row.abandonedAt)}</div>
                            )}
                          </td>
                          <td className="px-4 sm:px-6 py-3 text-xs text-gray-600 max-w-md truncate" title={row.lastError ?? ""}>
                            {row.lastError ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {data.hasMore && (
                  <div className="mt-3 mx-4 sm:mx-6 bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl text-xs text-amber-800 flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Showing the first {data.rows.length} rows. Narrow the window or status to see the rest.
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
