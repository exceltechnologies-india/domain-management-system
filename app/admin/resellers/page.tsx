"use client";

/**
 * Admin → Resellers (sub-reseller feature, Phase 1).
 * List all resellers, create a new one (fresh account + set-password email),
 * and approve / suspend. All data comes from /api/admin/resellers (admin-gated).
 */
import { useEffect, useState, useCallback } from "react";
import AdminLayout from "@/components/admin/AdminLayout";
import RefreshButton from "@/components/dashboard/RefreshButton";
import { apiClient } from "@/lib/api-client";
import { safeLocalStorage } from "@/lib/storage";
import { Store, CheckCircle2, Ban, Clock } from "lucide-react";

interface OwnerRef {
  _id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}
interface ResellerRow {
  _id: string;
  businessName: string;
  slug: string;
  status: "pending" | "approved" | "suspended";
  markupPercent: number;
  walletBalance: number;
  ownerUserId: OwnerRef | null;
  createdAt: string;
}
interface ListResponse {
  success: boolean;
  resellers: ResellerRow[];
}

interface CurrentUser { firstName: string; lastName: string; email: string; role: string; }

const STATUS_META: Record<ResellerRow["status"], { label: string; classes: string; icon: React.ElementType }> = {
  pending: { label: "Pending", classes: "bg-amber-100 text-amber-800", icon: Clock },
  approved: { label: "Approved", classes: "bg-green-100 text-green-800", icon: CheckCircle2 },
  suspended: { label: "Suspended", classes: "bg-red-100 text-red-800", icon: Ban },
};

function formatDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default function AdminResellersPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [rows, setRows] = useState<ResellerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [markupPercent, setMarkupPercent] = useState("");
  const [creating, setCreating] = useState(false);
  const [formMsg, setFormMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await apiClient.get<ListResponse>("/api/admin/resellers");
    if (result.ok) {
      setRows(result.data.resellers || []);
    } else {
      setError(result.error.message || "Failed to load resellers");
    }
    setLoading(false);
  }, []);

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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setFormMsg(null);
    const body: Record<string, unknown> = { email, businessName };
    if (markupPercent.trim() !== "") body.markupPercent = Number(markupPercent);
    const result = await apiClient.post<{ success: boolean }>("/api/admin/resellers", body);
    if (result.ok) {
      setFormMsg({ kind: "ok", text: "Reseller created — a set-password email has been sent." });
      setEmail(""); setBusinessName(""); setMarkupPercent("");
      void fetchData();
    } else {
      setFormMsg({ kind: "err", text: result.error.message || "Failed to create reseller" });
    }
    setCreating(false);
  };

  const handleAction = async (id: string, action: "approve" | "suspend") => {
    const result = await apiClient.patch<{ success: boolean }>(`/api/admin/resellers/${id}`, { action });
    if (result.ok) void fetchData();
    else setError(result.error.message || `Failed to ${action} reseller`);
  };

  return (
    <AdminLayout
      user={currentUser || { firstName: "Admin", lastName: "", email: "", role: "admin" }}
      onLogout={() => { window.location.href = "/login"; }}
    >
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 rounded-xl">
              <Store className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Resellers</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                White-label sub-resellers. Create an account (they get a set-password email), then approve to activate.
              </p>
            </div>
          </div>
          <RefreshButton onClick={() => void fetchData()} isLoading={loading} />
        </div>

        {/* Create form */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Create a reseller</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="reseller-business" className="block text-sm font-medium text-gray-700 mb-1">
                Business name
              </label>
              <input
                id="reseller-business"
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
                minLength={2}
                placeholder="Acme Web Services"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="reseller-email" className="block text-sm font-medium text-gray-700 mb-1">
                Owner email
              </label>
              <input
                id="reseller-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="owner@acme.com"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="reseller-markup" className="block text-sm font-medium text-gray-700 mb-1">
                Markup % <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id="reseller-markup"
                type="number"
                min={0}
                max={100}
                step="0.1"
                value={markupPercent}
                onChange={(e) => setMarkupPercent(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="sm:col-span-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create reseller"}
              </button>
              {formMsg && (
                <span className={`text-sm ${formMsg.kind === "ok" ? "text-green-700" : "text-red-600"}`}>
                  {formMsg.text}
                </span>
              )}
            </div>
          </form>
        </div>

        {/* List */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg p-3">{error}</div>
        )}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Owner</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Markup</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No resellers yet.</td></tr>
                ) : (
                  rows.map((r) => {
                    const meta = STATUS_META[r.status];
                    const Icon = meta.icon;
                    return (
                      <tr key={r._id}>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{r.businessName}</div>
                          <div className="text-xs text-gray-400">{r.slug}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{r.ownerUserId?.email || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${meta.classes}`}>
                            <Icon className="h-3 w-3" /> {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{r.markupPercent}%</td>
                        <td className="px-4 py-3 text-gray-500">{formatDate(r.createdAt)}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {r.status !== "approved" && (
                            <button
                              onClick={() => void handleAction(r._id, "approve")}
                              className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                            >
                              Approve
                            </button>
                          )}
                          {r.status !== "suspended" && (
                            <button
                              onClick={() => void handleAction(r._id, "suspend")}
                              className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                            >
                              Suspend
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
