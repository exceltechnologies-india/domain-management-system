/**
 * Reusable presentational primitives + the client-side tracking-ID preview
 * helper for the /admin/settings page.
 *
 * Split out of page.tsx (maintainability refactor). All of these were already
 * module-scope (they close over nothing from the page component), so this is a
 * pure relocation — no behavioural change.
 */
import { type ReactNode } from "react";
import { Loader2, Save, CheckCircle, AlertCircle } from "lucide-react";

// Client-side ID preview — mirrors lib/services/tracking.ts extraction so the
// admin sees the detected ID as they paste. The SERVER re-extracts on save
// (the authoritative boundary); this is UX feedback only. Kept out of the
// server-only tracking service so the client bundle doesn't pull it in.
export function previewTrackingId(
  provider: "ga4" | "gtm" | "meta" | "googleAds",
  raw: string
): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (provider === "ga4") { const m = s.match(/\bG-[A-Z0-9]{4,15}\b/i); return m ? m[0].toUpperCase() : ""; }
  if (provider === "gtm") { const m = s.match(/\bGTM-[A-Z0-9]{4,15}\b/i); return m ? m[0].toUpperCase() : ""; }
  if (provider === "googleAds") { const m = s.match(/\bAW-[0-9]{6,15}\b/i); return m ? m[0].toUpperCase() : ""; }
  const init = s.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/i);
  if (init) return init[1];
  const bare = s.match(/^\d{6,20}$/);
  return bare ? bare[0] : "";
}

// ── Reusable primitives ────────────────────────────────────────────────────────

export function SCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function SCardHead({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, color = "blue" }: { checked: boolean; onChange: (v: boolean) => void; color?: "blue" | "red" | "purple" | "orange" | "green" }) {
  const ring = { blue: "peer-focus:ring-blue-300 peer-checked:bg-blue-600", red: "peer-focus:ring-red-300 peer-checked:bg-red-600", purple: "peer-focus:ring-purple-300 peer-checked:bg-purple-600", orange: "peer-focus:ring-orange-300 peer-checked:bg-orange-500", green: "peer-focus:ring-green-300 peer-checked:bg-green-600" }[color];
  return (
    <label className="relative inline-flex items-center cursor-pointer shrink-0">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
      <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${ring}`} />
    </label>
  );
}

export function SaveBtn({ onClick, loading, label, color = "blue", disabled = false }: { onClick: () => void; loading: boolean; label: string; color?: "blue" | "red" | "purple" | "orange" | "green"; disabled?: boolean }) {
  const cls = { blue: "bg-blue-600 hover:bg-blue-700", red: "bg-red-600 hover:bg-red-700", purple: "bg-purple-600 hover:bg-purple-700", orange: "bg-orange-500 hover:bg-orange-600", green: "bg-green-600 hover:bg-green-700" }[color];
  return (
    <button onClick={onClick} disabled={loading || disabled} className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${cls}`}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {loading ? "Saving…" : label}
    </button>
  );
}

export function StatusBanner({ active, activeMsg, inactiveMsg, color = "green" }: { active: boolean; activeMsg: string; inactiveMsg: string; color?: "green" | "red" | "purple" | "orange" | "yellow" }) {
  const cfg = {
    green:  { bg: "bg-green-50 border-green-200",  icon: "text-green-600"  },
    red:    { bg: "bg-red-50 border-red-200",       icon: "text-red-600"    },
    purple: { bg: "bg-purple-50 border-purple-200", icon: "text-purple-600" },
    orange: { bg: "bg-orange-50 border-orange-200", icon: "text-orange-500" },
    yellow: { bg: "bg-yellow-50 border-yellow-200", icon: "text-yellow-600" },
  }[color];
  const Icon = active ? CheckCircle : AlertCircle;
  return (
    <div className={`flex items-start gap-3 p-3.5 border rounded-xl ${cfg.bg}`}>
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${active ? cfg.icon : "text-gray-400"}`} />
      <p className="text-sm text-gray-700">{active ? activeMsg : inactiveMsg}</p>
    </div>
  );
}

export function SFooter({ children }: { children: ReactNode }) {
  return <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60 flex items-center gap-3">{children}</div>;
}

/** Inline skeleton matching the toggle-card layout used by every settings section. */
export function SettingsContentSkeleton() {
  return (
    <div className="space-y-5">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-7 w-7 rounded-lg skeleton" />
              <div className="space-y-1.5">
                <div className="h-3.5 w-40 rounded skeleton" />
                <div className="h-2.5 w-56 rounded skeleton" />
              </div>
            </div>
            <div className="h-6 w-11 rounded-full skeleton" />
          </div>
          {/* Body — banner + a couple of input rows */}
          <div className="p-6 space-y-4">
            <div className="h-12 w-full rounded-xl skeleton" />
            <div className="space-y-1.5">
              <div className="h-3 w-28 rounded skeleton" />
              <div className="h-20 w-full rounded-xl skeleton" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-32 rounded skeleton" />
              <div className="h-10 w-48 rounded-xl skeleton" />
            </div>
          </div>
          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60 flex items-center gap-3">
            <div className="h-9 w-44 rounded-xl skeleton" />
          </div>
        </div>
      ))}
    </div>
  );
}
