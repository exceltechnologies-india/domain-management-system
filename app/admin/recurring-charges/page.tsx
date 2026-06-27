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
import { apiClient } from "@/lib/api-client";
import { safeLocalStorage } from "@/lib/storage";
import { Loader2, RefreshCw, Filter } from "lucide-react";

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
}

interface ApiResponse {
  success: boolean;
  window: string;
  statusFilter: AttemptStatus | null;
  counts: Record<AttemptStatus, number>;
  rows: AttemptRow[];
  hasMore: boolean;
}

const STATUS_OPTIONS: Array<{ value: AttemptStatus | "all"; label: string; classes: string }> = [
  { value: "all", label: "All", classes: "bg-gray-100 text-gray-800" },
  { value: "pending", label: "Pending", classes: "bg-yellow-100 text-yellow-800" },
  { value: "in_progress", label: "In progress", classes: "bg-blue-100 text-blue-800" },
  { value: "succeeded", label: "Succeeded", classes: "bg-green-100 text-green-800" },
  { value: "failed", label: "Failed (retry scheduled)", classes: "bg-orange-100 text-orange-800" },
  { value: "abandoned", label: "Abandoned", classes: "bg-red-100 text-red-800" },
];

const WINDOW_OPTIONS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

function badgeFor(status: AttemptStatus): { label: string; classes: string } {
  const opt = STATUS_OPTIONS.find((s) => s.value === status);
  if (!opt) return { label: status, classes: "bg-gray-100 text-gray-800" };
  return { label: opt.label, classes: opt.classes };
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface CurrentUser {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export default function AdminRecurringChargesPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<AttemptStatus | "all">("all");
  const [windowFilter, setWindowFilter] = useState<string>("7d");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("window", windowFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    const result = await apiClient.get<ApiResponse>(
      `/api/admin/recurring-charges?${params.toString()}`
    );
    if (result.ok) {
      setData(result.data);
    } else {
      setError(result.error.message || "Failed to load recurring charges");
    }
    setLoading(false);
  }, [statusFilter, windowFilter]);

  useEffect(() => {
    // Mirror the cached-user pattern from other admin pages so the sidebar
    // renders correctly. AuthService.isAdmin() gates the actual API; this
    // is just for AdminLayout's display.
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
            <h1 className="text-2xl font-bold text-gray-900">Recurring Charges</h1>
            <p className="text-sm text-gray-500 mt-1">
              Tokens-flow MIT charge attempts — one row per (Hosting, billing cycle).
              Read-only; use Razorpay dashboard to refund / cancel mandates.
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
              <label className="text-xs font-medium text-gray-500 block mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as AttemptStatus | "all")}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            {(["pending", "in_progress", "succeeded", "failed", "abandoned"] as AttemptStatus[]).map((s) => {
              const opt = STATUS_OPTIONS.find((o) => o.value === s)!;
              return (
                <div key={s} className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className={`text-xs font-medium px-2 py-0.5 rounded-full inline-block ${opt.classes}`}>
                    {opt.label}
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{data.counts[s] ?? 0}</div>
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
            No recurring charge attempts in this window.
            <div className="text-xs mt-2 text-gray-400">
              (Tokens-flow is dormant in production until HOSTING_MANDATE_FLOW=tokens. Until then,
              no RecurringChargeAttempt rows are written.)
            </div>
          </div>
        ) : data ? (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Domain</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">User</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500 uppercase text-xs">Amount</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Status</th>
                    <th className="px-4 py-2 text-center font-medium text-gray-500 uppercase text-xs">Attempt</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Due / Next retry</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase text-xs">Last error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.rows.map((row) => {
                    const b = badgeFor(row.status);
                    return (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2">
                          <div className="font-medium text-gray-900">{row.domainName}</div>
                          <div className="text-xs text-gray-400 font-mono">{row.tokenId}</div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="text-gray-900">{row.userName || row.userEmail}</div>
                          {row.userName && <div className="text-xs text-gray-500">{row.userEmail}</div>}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-900">
                          ₹{row.amountInRupees.toFixed(2)}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${b.classes}`}>
                            {b.label}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-center font-medium text-gray-900">
                          {row.attemptCount} / 4
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-600">
                          <div>Due: {formatDate(row.dueDate)}</div>
                          {row.nextAttemptAt && row.status === "failed" && (
                            <div className="text-orange-700">Next retry: {formatDate(row.nextAttemptAt)}</div>
                          )}
                          {row.abandonedAt && (
                            <div className="text-red-700">Abandoned: {formatDate(row.abandonedAt)}</div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-600 max-w-md truncate" title={row.lastError ?? ""}>
                          {row.lastError ?? "—"}
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
