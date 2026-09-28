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
    <div className={`bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function SCardHead({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="text-xs text-ink-3 mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, color = "blue" }: { checked: boolean; onChange: (v: boolean) => void; color?: "blue" | "red" | "purple" | "orange" | "green" }) {
  const ring = { blue: "peer-focus:ring-amber/40 peer-checked:bg-amber", red: "peer-focus:ring-rose peer-checked:bg-rose", purple: "peer-focus:ring-indigo peer-checked:bg-indigo", orange: "peer-focus:ring-amber peer-checked:bg-amber", green: "peer-focus:ring-emerald peer-checked:bg-emerald" }[color];
  return (
    <label className="relative inline-flex items-center cursor-pointer shrink-0">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
      <div className={`w-11 h-6 bg-hairline peer-focus:outline-none peer-focus:ring-4 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-paper after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-paper after:border-hairline-strong after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${ring}`} />
    </label>
  );
}

export function SaveBtn({ onClick, loading, label, color = "blue", disabled = false }: { onClick: () => void; loading: boolean; label: string; color?: "blue" | "red" | "purple" | "orange" | "green"; disabled?: boolean }) {
  const cls = { blue: "bg-amber hover:brightness-90", red: "bg-rose hover:bg-rose/90", purple: "bg-indigo hover:bg-indigo/90", orange: "bg-amber hover:bg-amber", green: "bg-emerald hover:bg-emerald/90" }[color];
  return (
    <button onClick={onClick} disabled={loading || disabled} className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-paper rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${cls}`}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {loading ? "Saving…" : label}
    </button>
  );
}

export function StatusBanner({ active, activeMsg, inactiveMsg, color = "green" }: { active: boolean; activeMsg: string; inactiveMsg: string; color?: "green" | "red" | "purple" | "orange" | "yellow" }) {
  const cfg = {
    green:  { bg: "bg-emerald-soft border-emerald/30",  icon: "text-emerald-ink"  },
    red:    { bg: "bg-rose-soft border-rose/30",       icon: "text-rose-ink"    },
    purple: { bg: "bg-indigo-soft border-indigo/30", icon: "text-indigo-ink" },
    orange: { bg: "bg-amber-soft border-amber/30", icon: "text-amber" },
    yellow: { bg: "bg-amber-soft border-amber/30", icon: "text-amber-ink" },
  }[color];
  const Icon = active ? CheckCircle : AlertCircle;
  return (
    <div className={`flex items-start gap-3 p-3.5 border rounded-xl ${cfg.bg}`}>
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${active ? cfg.icon : "text-ink-4"}`} />
      <p className="text-sm text-ink-2">{active ? activeMsg : inactiveMsg}</p>
    </div>
  );
}

export function SFooter({ children }: { children: ReactNode }) {
  return <div className="px-6 py-4 border-t border-hairline bg-paper-2/60 flex items-center gap-3">{children}</div>;
}

/** Inline skeleton matching the toggle-card layout used by every settings section. */
export function SettingsContentSkeleton() {
  return (
    <div className="space-y-5">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
          {/* Card header */}
          <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center justify-between gap-4">
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
          <div className="px-6 py-4 border-t border-hairline bg-paper-2/60 flex items-center gap-3">
            <div className="h-9 w-44 rounded-xl skeleton" />
          </div>
        </div>
      ))}
    </div>
  );
}
