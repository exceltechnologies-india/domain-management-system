"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { motion } from "framer-motion";
import {
  Settings, Server, Wifi, RefreshCw, CheckCircle, AlertTriangle, AlertCircle,
  Copy, Loader2, Globe, Plus, X, Save, Database, Trash2, ChevronDown,
  Wrench, Power, Shield, Tag, MessageCircle, Send, BarChart3,
} from "lucide-react";
import RefreshButton from "@/components/dashboard/RefreshButton";
import AdminLayout from "@/components/admin/AdminLayout";
import { AdminLayoutSkeleton, AdminSettingsPageSkeleton } from "@/components/skeletons/PageSkeletons";
import { formatIndianDateTime } from "@/lib/dateUtils";
import { performLogout } from "@/lib/logout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { showSuccessToast, showErrorToast } from "@/lib/toast";
import { apiClient } from "@/lib/api-client";

interface IPData {
  success: boolean;
  message: string;
  data?: {
    primaryIP: string;
    allIPs: string[];
    timestamp: string;
    services: Record<string, any>;
    serverInfo?: { userAgent?: string; host?: string; forwarded?: string; realIP?: string };
  };
  error?: string;
  lastChecked?: string;
  checkedBy?: { firstName: string; lastName: string; email: string };
}

type ActiveSection = "general" | "performance" | "security" | "promotions" | "integrations" | "tracking";

// Client-side ID preview — mirrors lib/services/tracking.ts extraction so the
// admin sees the detected ID as they paste. The SERVER re-extracts on save
// (the authoritative boundary); this is UX feedback only. Kept inline so the
// client bundle doesn't import the server-only tracking service (which pulls
// mongodb).
function previewTrackingId(provider: "ga4" | "gtm" | "meta" | "googleAds", raw: string): string {
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

function SCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

function SCardHead({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
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

function Toggle({ checked, onChange, color = "blue" }: { checked: boolean; onChange: (v: boolean) => void; color?: "blue" | "red" | "purple" | "orange" | "green" }) {
  const ring = { blue: "peer-focus:ring-blue-300 peer-checked:bg-blue-600", red: "peer-focus:ring-red-300 peer-checked:bg-red-600", purple: "peer-focus:ring-purple-300 peer-checked:bg-purple-600", orange: "peer-focus:ring-orange-300 peer-checked:bg-orange-500", green: "peer-focus:ring-green-300 peer-checked:bg-green-600" }[color];
  return (
    <label className="relative inline-flex items-center cursor-pointer shrink-0">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
      <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${ring}`} />
    </label>
  );
}

function SaveBtn({ onClick, loading, label, color = "blue", disabled = false }: { onClick: () => void; loading: boolean; label: string; color?: "blue" | "red" | "purple" | "orange" | "green"; disabled?: boolean }) {
  const cls = { blue: "bg-blue-600 hover:bg-blue-700", red: "bg-red-600 hover:bg-red-700", purple: "bg-purple-600 hover:bg-purple-700", orange: "bg-orange-500 hover:bg-orange-600", green: "bg-green-600 hover:bg-green-700" }[color];
  return (
    <button onClick={onClick} disabled={loading || disabled} className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${cls}`}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {loading ? "Saving…" : label}
    </button>
  );
}

function StatusBanner({ active, activeMsg, inactiveMsg, color = "green" }: { active: boolean; activeMsg: string; inactiveMsg: string; color?: "green" | "red" | "purple" | "orange" | "yellow" }) {
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

function SFooter({ children }: { children: React.ReactNode }) {
  return <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60 flex items-center gap-3">{children}</div>;
}

/** Inline skeleton matching the toggle-card layout used by every settings section. */
function SettingsContentSkeleton() {
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

// ── Main component ─────────────────────────────────────────────────────────────

export default function AdminSettings() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [ipData, setIpData] = useState<IPData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [user, setUser] = useState<{ firstName: string; lastName: string; role: string } | null>(null);
  const [activeSection, setActiveSection] = useState<ActiveSection>("general");

  // Cache
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [cacheTTL, setCacheTTL] = useState(60);
  const [cacheStatus, setCacheStatus] = useState<{
    hasData?: boolean;
    itemCount?: number;
    lastUpdated?: string | Date | null;
  } | null>(null);
  const [cacheLoading, setCacheLoading] = useState(false);

  // IP Whitelist
  const [ipWhitelistEnabled, setIpWhitelistEnabled] = useState(false);
  const [whitelistedIPs, setWhitelistedIPs] = useState<string[]>([]);
  const [currentIP, setCurrentIP] = useState<string>("");
  const [newIP, setNewIP] = useState("");
  const [isLoadingIP, setIsLoadingIP] = useState(false);
  const [isSavingWhitelist, setIsSavingWhitelist] = useState(false);

  // CORS
  const [corsProtectionEnabled, setCorsProtectionEnabled] = useState(false);
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [currentOrigin, setCurrentOrigin] = useState<string>("");
  const [isSavingCors, setIsSavingCors] = useState(false);

  // Trial
  const [hostingTrialEnabled, setHostingTrialEnabled] = useState(true);
  const [isSavingTrial, setIsSavingTrial] = useState(false);

  // Trial — phone OTP gate (wired but off by default)
  const [trialOtpRequired, setTrialOtpRequired] = useState(false);
  const [isSavingTrialOtp, setIsSavingTrialOtp] = useState(false);

  // Test plan
  const [testPlanEnabled, setTestPlanEnabled] = useState(false);
  const [testPlanRazorpayId, setTestPlanRazorpayId] = useState("");
  const [isLoadingTestPlan, setIsLoadingTestPlan] = useState(false);
  const [isSavingTestPlan, setIsSavingTestPlan] = useState(false);
  const [testPlanRazorpayInput, setTestPlanRazorpayInput] = useState("");

  // Server info
  const [serverInfoExpanded, setServerInfoExpanded] = useState(false);

  // Maintenance
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [maintenanceScheduledEnd, setMaintenanceScheduledEnd] = useState("");
  const [isSavingMaintenance, setIsSavingMaintenance] = useState(false);

  // WhatsApp (operational config is admin-managed; token stays in Secret Manager)
  const [waEnabled, setWaEnabled] = useState(false);
  const [waHasToken, setWaHasToken] = useState(false);
  const [waReady, setWaReady] = useState(false);
  const [waPhoneNumberId, setWaPhoneNumberId] = useState("");
  const [waBusinessNumber, setWaBusinessNumber] = useState("");
  const [waTplReminder, setWaTplReminder] = useState("");
  const [waTplPayment, setWaTplPayment] = useState("");
  const [waTplSuspended, setWaTplSuspended] = useState("");
  const [waTplWelcome, setWaTplWelcome] = useState("");
  const [isSavingWa, setIsSavingWa] = useState(false);
  const [isLoadingWa, setIsLoadingWa] = useState(false);
  const [waTestNumber, setWaTestNumber] = useState("");
  const [isSendingWaTest, setIsSendingWaTest] = useState(false);

  // Analytics / marketing tracking. The text inputs hold either a pasted
  // snippet or a bare ID; previewTrackingId() shows what will be extracted,
  // and the server re-extracts to the canonical ID on save.
  const [trEnabled, setTrEnabled] = useState(false);
  const [trGa4, setTrGa4] = useState("");
  const [trGtm, setTrGtm] = useState("");
  const [trMeta, setTrMeta] = useState("");
  const [trAds, setTrAds] = useState("");
  const [trLoadOnAdmin, setTrLoadOnAdmin] = useState(false);
  const [isSavingTracking, setIsSavingTracking] = useState(false);
  const [isLoadingTracking, setIsLoadingTracking] = useState(false);

  // ── Auth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === "loading") return;
    if (session?.user) {
      const u = { firstName: session.user.name?.split(" ")[0] || "", lastName: session.user.name?.split(" ").slice(1).join(" ") || "", role: session.user.role || "user" };
      if (u.role !== "admin") { router.push("/dashboard"); return; }
      setUser(u); setIsAuthLoading(false); void loadAllSettings(); return;
    }
    router.push("/login");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadAllSettings = async () => {
    setIsDataLoading(true);
    await Promise.all([loadSavedIPData(), loadCacheSettings(), loadIPWhitelistSettings(), loadCORSSettings(), loadHostingTrialSettings(), loadTestPlanSettings(), loadMaintenanceSettings(), loadWhatsAppSettings(), loadTrackingSettings()]);
    if (typeof window !== "undefined") setCurrentOrigin(window.location.origin);
    setIsDataLoading(false);
  };

  const loadSavedIPData = async () => {
    const result = await apiClient.get<IPData>("/api/v1/admin/ip-status");
    if (result.ok) { setIpData(result.data); if (result.data.lastChecked) setLastChecked(new Date(result.data.lastChecked)); }
  };

  const loadCacheSettings = async () => {
    const [sr, cr] = await Promise.all([
      apiClient.get<{ cache?: { hasData?: boolean; itemCount?: number; lastUpdated?: string | Date | null }; ttl?: number }>("/api/v1/admin/tld-pricing/cache"),
      apiClient.get<{ settings?: Record<string, { value?: unknown }> }>("/api/v1/admin/settings"),
    ]);
    if (sr.ok) { setCacheStatus(sr.data.cache ?? null); setCacheTTL(sr.data.ttl || 60); }
    if (cr.ok) {
      const s = cr.data.settings || {};
      if (s.tld_pricing_cache_enabled !== undefined) setCacheEnabled(s.tld_pricing_cache_enabled.value !== false);
      if (s.tld_pricing_cache_ttl !== undefined) setCacheTTL(parseInt(String(s.tld_pricing_cache_ttl.value)) || 60);
    }
  };

  const loadIPWhitelistSettings = async () => {
    const result = await apiClient.get<{ settings?: Record<string, { value?: unknown }> }>("/api/v1/admin/settings");
    if (!result.ok) return;
    const s = result.data.settings || {};
    const en = s["admin_ip_whitelist_enabled"];
    setIpWhitelistEnabled(en?.value === true || en?.value === "true");
    const sessionUser = session?.user as { _id?: string; id?: string } | undefined;
    const userId = sessionUser?._id || sessionUser?.id || "";
    if (userId) {
      const ws = s[`admin_ip_whitelist_${userId}`];
      if (ws?.value) setWhitelistedIPs(Array.isArray(ws.value) ? ws.value : typeof ws.value === "string" ? ws.value.split(",").map((i: string) => i.trim()) : []);
    }
  };

  const loadCORSSettings = async () => {
    const result = await apiClient.get<{ settings?: Record<string, { value?: unknown }> }>("/api/v1/admin/settings");
    if (!result.ok) return;
    const s = result.data.settings || {};
    const en = s["cors_protection_enabled"];
    setCorsProtectionEnabled(en?.value === true || en?.value === "true");
    const os = s["cors_allowed_origins"];
    if (os?.value) setAllowedOrigins(Array.isArray(os.value) ? os.value : typeof os.value === "string" ? os.value.split(",").map((o: string) => o.trim()) : []);
  };

  const loadHostingTrialSettings = async () => {
    const result = await apiClient.get<{ settings?: Record<string, { value?: unknown }> }>("/api/v1/admin/settings");
    if (!result.ok) return;
    const s = result.data.settings?.hosting_trial_enabled;
    if (s !== undefined) setHostingTrialEnabled(s.value !== false);
    const otp = result.data.settings?.hosting_trial_otp_required;
    if (otp !== undefined) setTrialOtpRequired(otp.value === true || otp.value === "true");
  };

  const loadTestPlanSettings = async () => {
    setIsLoadingTestPlan(true);
    const result = await apiClient.get<{ enabled?: boolean; plan?: { razorpayPlans?: { monthly?: string } } }>("/api/v1/admin/hosting/test-plan");
    if (result.ok) { setTestPlanEnabled(result.data.enabled === true); const id = result.data.plan?.razorpayPlans?.monthly || ""; setTestPlanRazorpayId(id); setTestPlanRazorpayInput(id); }
    setIsLoadingTestPlan(false);
  };

  const loadMaintenanceSettings = async () => {
    const result = await apiClient.get<{ settings?: Record<string, { value?: { enabled?: boolean; message?: string; scheduledEnd?: string } }> }>("/api/v1/admin/settings");
    if (!result.ok) return;
    const setting = (result.data.settings || {})["maintenance_mode"];
    if (setting?.value) {
      setMaintenanceEnabled(!!setting.value.enabled);
      setMaintenanceMessage(setting.value.message || "");
      if (setting.value.scheduledEnd) { const local = new Date(setting.value.scheduledEnd); local.setMinutes(local.getMinutes() - local.getTimezoneOffset()); setMaintenanceScheduledEnd(local.toISOString().slice(0, 16)); }
    }
  };

  // ── Handlers ──────────────────────────────────────────────────────────────
  const updateCacheSettings = async () => {
    setCacheLoading(true);
    const result = await apiClient.put<{ success?: boolean }>("/api/v1/admin/tld-pricing/cache", { enabled: cacheEnabled, ttlMinutes: cacheTTL });
    if (result.ok && result.data.success) { showSuccessToast("Cache settings updated"); await loadCacheSettings(); } else showErrorToast("Failed to update cache settings");
    setCacheLoading(false);
  };

  const purgeCache = async () => {
    setCacheLoading(true);
    const result = await apiClient.delete<{ success?: boolean }>("/api/v1/admin/tld-pricing/cache");
    if (result.ok && result.data.success) { showSuccessToast("Cache purged"); await loadCacheSettings(); } else showErrorToast("Failed to purge cache");
    setCacheLoading(false);
  };

  const fetchOutboundIP = async () => {
    setIsLoading(true);
    const result = await apiClient.get<IPData>("/api/v1/admin/check-ip");
    if (result.ok) { setIpData(result.data); setLastChecked(new Date()); if (result.data.success) showSuccessToast("Outbound IP refreshed"); else showErrorToast("Failed to check outbound IP"); }
    else showErrorToast("Network error");
    setIsLoading(false);
  };

  const fetchCurrentIP = async () => {
    setIsLoadingIP(true);
    const result = await apiClient.get<{ success?: boolean; data?: { primaryIP?: string } }>("/api/v1/admin/check-ip");
    if (result.ok && result.data.success && result.data.data?.primaryIP) setCurrentIP(result.data.data.primaryIP);
    setIsLoadingIP(false);
  };

  useEffect(() => { if (ipData?.data?.primaryIP) setCurrentIP(ipData.data.primaryIP); }, [ipData]);

  const saveIPWhitelistSettings = async () => {
    if (!user) return;
    setIsSavingWhitelist(true);
    try {
      const userObj = (session?.user || {}) as { _id?: string; id?: string };
      const userId = userObj._id || userObj.id || "";
      if (!userId) { showErrorToast("User ID not found"); setIsSavingWhitelist(false); return; }
      const [r1, r2] = await Promise.all([
        apiClient.post("/api/v1/admin/settings", { key: "admin_ip_whitelist_enabled", value: ipWhitelistEnabled, description: "Enable IP whitelisting for admin APIs", category: "security" }),
        apiClient.post("/api/v1/admin/settings", { key: `admin_ip_whitelist_${userId}`, value: whitelistedIPs, description: "Whitelisted IP addresses for admin access", category: "security" }),
      ]);
      if (r1.ok && r2.ok) showSuccessToast("IP whitelist settings saved");
      else showErrorToast("Failed to save IP whitelist settings");
    } finally { setIsSavingWhitelist(false); }
  };

  const addIPToWhitelist = (ip: string) => {
    const t = ip.trim(); if (!t) return;
    if (whitelistedIPs.includes(t)) { showErrorToast("IP already in whitelist"); return; }
    setWhitelistedIPs([...whitelistedIPs, t]); setNewIP("");
  };

  const saveCORSSettings = async () => {
    setIsSavingCors(true);
    const [r1, r2] = await Promise.all([
      apiClient.post("/api/v1/admin/settings", { key: "cors_protection_enabled", value: corsProtectionEnabled, description: "Enable CORS protection", category: "security" }),
      apiClient.post("/api/v1/admin/settings", { key: "cors_allowed_origins", value: allowedOrigins, description: "Allowed origins for CORS", category: "security" }),
    ]);
    if (r1.ok && r2.ok) showSuccessToast("CORS settings saved");
    else showErrorToast("Failed to save CORS settings");
    setIsSavingCors(false);
  };

  const addOriginToWhitelist = (origin: string) => {
    const t = origin.trim(); if (!t) return;
    if (allowedOrigins.includes(t)) { showErrorToast("Origin already in list"); return; }
    setAllowedOrigins([...allowedOrigins, t]); setNewOrigin("");
  };

  const saveHostingTrialSettings = async () => {
    setIsSavingTrial(true);
    const result = await apiClient.post("/api/v1/admin/settings", { key: "hosting_trial_enabled", value: hostingTrialEnabled, description: "15-day free trial for yearly hosting", category: "promotions" });
    if (result.ok) showSuccessToast(`Hosting trial ${hostingTrialEnabled ? "enabled" : "disabled"}`);
    else showErrorToast("Failed to save trial settings");
    setIsSavingTrial(false);
  };

  const saveTrialOtpSettings = async () => {
    setIsSavingTrialOtp(true);
    const result = await apiClient.post("/api/v1/admin/settings", {
      key: "hosting_trial_otp_required",
      value: trialOtpRequired,
      description: "Require phone OTP verification before claiming the hosting free trial",
      category: "security",
    });
    if (result.ok) showSuccessToast(`Trial phone-OTP gate ${trialOtpRequired ? "enabled" : "disabled"}`);
    else showErrorToast("Failed to save trial OTP settings");
    setIsSavingTrialOtp(false);
  };

  const saveTestPlan = async (action: "enable" | "disable") => {
    setIsSavingTestPlan(true);
    const body: Record<string, string> = { action };
    if (action === "enable" && testPlanRazorpayInput.trim()) body.razorpayPlanMonthly = testPlanRazorpayInput.trim();
    const result = await apiClient.post<{ enabled?: boolean; razorpayPlanMonthly?: string }>("/api/v1/admin/hosting/test-plan", body);
    if (result.ok) {
      setTestPlanEnabled(!!result.data.enabled);
      if (result.data.razorpayPlanMonthly) { setTestPlanRazorpayId(result.data.razorpayPlanMonthly); setTestPlanRazorpayInput(result.data.razorpayPlanMonthly); }
      showSuccessToast(action === "enable" ? "₹1 test plan enabled" : "₹1 test plan disabled");
    } else {
      showErrorToast(result.error.message || "Failed");
    }
    setIsSavingTestPlan(false);
  };

  // ── WhatsApp ────────────────────────────────────────────────────────────────
  const loadWhatsAppSettings = async () => {
    setIsLoadingWa(true);
    // Read the RESOLVED status (DB override OR env fallback) — never the
    // token value, only whether it's present (hasToken).
    const result = await apiClient.get<{
      success?: boolean;
      status?: {
        enabled: boolean;
        hasToken: boolean;
        phoneNumberId: string;
        businessNumber: string;
        templates: { reminder: string; payment: string; suspended: string; welcome: string };
        ready: boolean;
      };
    }>("/api/v1/admin/whatsapp/status");
    if (result.ok && result.data.status) {
      const s = result.data.status;
      setWaEnabled(s.enabled);
      setWaHasToken(s.hasToken);
      setWaReady(s.ready);
      setWaPhoneNumberId(s.phoneNumberId);
      setWaBusinessNumber(s.businessNumber);
      setWaTplReminder(s.templates.reminder);
      setWaTplPayment(s.templates.payment);
      setWaTplSuspended(s.templates.suspended);
      setWaTplWelcome(s.templates.welcome);
    }
    setIsLoadingWa(false);
  };

  const saveWhatsAppSettings = async () => {
    setIsSavingWa(true);
    // All operational keys in one batch. None are secrets (token is
    // env-only) so no step-up re-auth is triggered.
    const results = await Promise.all([
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_enabled", value: waEnabled, description: "Master on/off for WhatsApp notifications", category: "integrations" }),
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_phone_number_id", value: waPhoneNumberId.trim(), description: "Meta WhatsApp phone-number ID", category: "integrations" }),
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_business_number", value: waBusinessNumber.trim(), description: "Display business number", category: "integrations" }),
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_template_reminder", value: waTplReminder.trim(), description: "Approved reminder template name", category: "integrations" }),
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_template_payment", value: waTplPayment.trim(), description: "Approved payment template name", category: "integrations" }),
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_template_suspended", value: waTplSuspended.trim(), description: "Approved suspension template name", category: "integrations" }),
      apiClient.post("/api/v1/admin/settings", { key: "whatsapp_template_welcome", value: waTplWelcome.trim(), description: "Approved hosting-provisioned/welcome template name", category: "integrations" }),
    ]);
    if (results.every((r) => r.ok)) {
      showSuccessToast("WhatsApp settings saved");
      await loadWhatsAppSettings();
    } else {
      showErrorToast("Failed to save some WhatsApp settings");
    }
    setIsSavingWa(false);
  };

  const sendWhatsAppTest = async () => {
    const to = waTestNumber.trim();
    if (!to) { showErrorToast("Enter a number to send the test to"); return; }
    setIsSendingWaTest(true);
    const result = await apiClient.post<{ success?: boolean; sent?: boolean; reason?: string }>("/api/v1/admin/whatsapp/test", { to });
    if (result.ok && result.data.sent) {
      showSuccessToast(`Test message sent to ${to}`);
    } else {
      showErrorToast(result.ok ? (result.data.reason || "Test send failed") : "Test send failed");
    }
    setIsSendingWaTest(false);
  };

  const loadTrackingSettings = async () => {
    setIsLoadingTracking(true);
    const result = await apiClient.get<{ success?: boolean; settings?: Record<string, { value?: unknown }> }>("/api/v1/admin/settings");
    if (result.ok && result.data.settings) {
      const s = result.data.settings;
      const str = (k: string) => (typeof s[k]?.value === "string" ? (s[k]!.value as string) : "");
      const bool = (k: string) => s[k]?.value === true || s[k]?.value === "true";
      setTrEnabled(bool("tracking_enabled"));
      setTrGa4(str("tracking_ga4_id"));
      setTrGtm(str("tracking_gtm_id"));
      setTrMeta(str("tracking_meta_pixel_id"));
      setTrAds(str("tracking_google_ads_id"));
      setTrLoadOnAdmin(bool("tracking_load_on_admin"));
    }
    setIsLoadingTracking(false);
  };

  const saveTrackingSettings = async () => {
    setIsSavingTracking(true);
    // Send the raw field contents — the server extracts + validates each ID
    // (extractTrackingId) so only a clean canonical ID is ever stored.
    const results = await Promise.all([
      apiClient.post("/api/v1/admin/settings", { key: "tracking_enabled", value: trEnabled, description: "Master on/off for analytics/marketing tags", category: "tracking" }),
      apiClient.post("/api/v1/admin/settings", { key: "tracking_ga4_id", value: trGa4.trim(), description: "Google Analytics 4 Measurement ID (extracted)", category: "tracking" }),
      apiClient.post("/api/v1/admin/settings", { key: "tracking_gtm_id", value: trGtm.trim(), description: "Google Tag Manager container ID (extracted)", category: "tracking" }),
      apiClient.post("/api/v1/admin/settings", { key: "tracking_meta_pixel_id", value: trMeta.trim(), description: "Meta/Facebook Pixel ID (extracted)", category: "tracking" }),
      apiClient.post("/api/v1/admin/settings", { key: "tracking_google_ads_id", value: trAds.trim(), description: "Google Ads conversion ID (extracted)", category: "tracking" }),
      apiClient.post("/api/v1/admin/settings", { key: "tracking_load_on_admin", value: trLoadOnAdmin, description: "Also load tags on /admin + /dashboard", category: "tracking" }),
    ]);
    if (results.every((r) => r.ok)) {
      showSuccessToast("Tracking settings saved");
      await loadTrackingSettings(); // reflect server-extracted canonical IDs
    } else {
      showErrorToast("Failed to save some tracking settings");
    }
    setIsSavingTracking(false);
  };

  const saveMaintenanceSettings = async () => {
    setIsSavingMaintenance(true);
    const scheduledEnd = maintenanceScheduledEnd ? new Date(maintenanceScheduledEnd).toISOString() : null;
    const result = await apiClient.post("/api/v1/admin/settings", { key: "maintenance_mode", value: { enabled: maintenanceEnabled, message: maintenanceMessage.trim(), scheduledEnd }, description: "Site-wide maintenance mode", category: "general" });
    if (result.ok) showSuccessToast(maintenanceEnabled ? "Maintenance mode enabled" : "Site is live");
    else showErrorToast("Failed to save maintenance settings");
    setIsSavingMaintenance(false);
  };

  const getStatusColor = () => { if (isLoading) return "bg-yellow-500"; if (!ipData?.success) return "bg-red-500"; if (ipData?.data?.allIPs && ipData.data.allIPs.length > 1) return "bg-orange-500"; return "bg-green-500"; };
  const getStatusLabel = () => { if (isLoading) return "Checking…"; if (!ipData?.success) return "Error"; if (ipData?.data?.allIPs && ipData.data.allIPs.length > 1) return "Multiple IPs"; return "Connected"; };

  if (isAuthLoading) return <AdminLayoutSkeleton><AdminSettingsPageSkeleton /></AdminLayoutSkeleton>;

  const navItems: { id: ActiveSection; label: string; icon: React.ElementType; description: string }[] = [
    { id: "general",     label: "General",     icon: Wrench,   description: "Maintenance mode" },
    { id: "performance", label: "Performance", icon: Database, description: "Cache & server info" },
    { id: "security",    label: "Security",    icon: Shield,   description: "IP whitelisting & CORS" },
    { id: "promotions",  label: "Promotions",  icon: Tag,      description: "Trials & test plans" },
    { id: "integrations", label: "Integrations", icon: MessageCircle, description: "WhatsApp notifications" },
    { id: "tracking",    label: "Tracking",     icon: BarChart3, description: "Analytics & marketing tags" },
  ];

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
              <Settings className="h-6 w-6 text-blue-600" />
              Admin Settings
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">Configure site-wide behaviour, security and promotions</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">

          {/* ── Left nav ── */}
          <aside className="lg:col-span-1 space-y-1">
            {navItems.map(({ id, label, icon: Icon, description }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all ${
                  activeSection === id
                    ? "bg-blue-50 border border-blue-200 text-blue-700 shadow-sm"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 border border-transparent"
                }`}
              >
                <div className={`p-1.5 rounded-lg ${activeSection === id ? "bg-blue-100" : "bg-gray-100"}`}>
                  <Icon className={`h-4 w-4 ${activeSection === id ? "text-blue-600" : "text-gray-500"}`} />
                </div>
                <div>
                  <p className="text-sm font-medium leading-none">{label}</p>
                  <p className={`text-xs mt-0.5 ${activeSection === id ? "text-blue-500" : "text-gray-400"}`}>{description}</p>
                </div>
              </button>
            ))}
          </aside>

          {/* ── Content ── */}
          <div className="lg:col-span-3 space-y-5">

            {/* Loading skeleton while settings are fetched */}
            {isDataLoading && <SettingsContentSkeleton />}

            {/* ════ GENERAL ════ */}
            {!isDataLoading && activeSection === "general" && (
              <SCard className={maintenanceEnabled ? "border-red-300" : ""}>
                <div className={`px-6 py-4 border-b flex items-center justify-between gap-4 ${maintenanceEnabled ? "bg-red-50 border-red-200" : "bg-gray-50/60 border-gray-100"}`}>
                  <div className="flex items-center gap-3">
                    <div className={`p-1.5 rounded-lg ${maintenanceEnabled ? "bg-red-100" : "bg-gray-100"}`}>
                      <Wrench className={`h-4 w-4 ${maintenanceEnabled ? "text-red-600" : "text-gray-500"}`} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                        Maintenance Mode
                        {maintenanceEnabled && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-600 text-white animate-pulse">ACTIVE</span>}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5">Redirects all non-admin visitors to a maintenance page</p>
                    </div>
                  </div>
                  <Toggle checked={maintenanceEnabled} onChange={setMaintenanceEnabled} color="red" />
                </div>

                <div className="p-6 space-y-5">
                  <StatusBanner
                    active={maintenanceEnabled}
                    color={maintenanceEnabled ? "red" : "green"}
                    activeMsg="Maintenance mode is ON — all non-admin visitors are being redirected right now."
                    inactiveMsg="Site is live and accessible to all visitors. Enable maintenance mode before performing upgrades or database migrations."
                  />

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Message shown to visitors</label>
                    <textarea
                      value={maintenanceMessage}
                      onChange={e => setMaintenanceMessage(e.target.value)}
                      placeholder="We're performing scheduled maintenance to improve your experience. We'll be back shortly."
                      rows={3}
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-shadow"
                    />
                    <p className="text-xs text-gray-400 mt-1">Leave blank to show the default message.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Scheduled end time <span className="font-normal text-gray-400">(optional — auto-disables)</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="datetime-local"
                        value={maintenanceScheduledEnd}
                        onChange={e => setMaintenanceScheduledEnd(e.target.value)}
                        className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {maintenanceScheduledEnd && (
                        <button onClick={() => setMaintenanceScheduledEnd("")} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Maintenance mode will automatically turn off at this time. A countdown is shown to visitors.</p>
                  </div>
                </div>

                <SFooter>
                  <button
                    onClick={saveMaintenanceSettings}
                    disabled={isSavingMaintenance}
                    className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-50 transition-colors ${maintenanceEnabled ? "bg-red-600 hover:bg-red-700" : "bg-gray-700 hover:bg-gray-800"}`}
                  >
                    {isSavingMaintenance ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                    {isSavingMaintenance ? "Saving…" : maintenanceEnabled ? "Enable Maintenance Mode" : "Save (Site Stays Live)"}
                  </button>
                  {maintenanceEnabled && <p className="text-xs text-red-600">Saving will immediately redirect all non-admin visitors.</p>}
                </SFooter>
              </SCard>
            )}

            {/* ════ PERFORMANCE ════ */}
            {!isDataLoading && activeSection === "performance" && (
              <>
                {/* Cache */}
                <SCard>
                  <SCardHead title="TLD Pricing Cache" description="Cache pricing data from ResellerClub to improve page load times" />
                  <div className="p-6 space-y-5">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-700">Enable Caching</p>
                        <p className="text-xs text-gray-400 mt-0.5">Speeds up TLD pricing lookups significantly</p>
                      </div>
                      <Toggle checked={cacheEnabled} onChange={setCacheEnabled} />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Cache TTL (Minutes)</label>
                      <input
                        type="number"
                        value={cacheTTL}
                        onChange={e => setCacheTTL(parseInt(e.target.value) || 0)}
                        min="1"
                        className="w-full max-w-xs px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      <p className="text-xs text-gray-400 mt-1">How long pricing data is cached before refreshing</p>
                    </div>

                    {/* Cache status */}
                    {cacheStatus && (
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { label: "In Memory", value: cacheStatus.hasData ? "Yes" : "No" },
                          { label: "Items Cached", value: cacheStatus.itemCount ?? 0 },
                          { label: "Last Updated", value: cacheStatus.lastUpdated ? formatIndianDateTime(cacheStatus.lastUpdated) : "—" },
                        ].map(({ label, value }) => (
                          <div key={label} className="bg-gray-50 rounded-xl p-3 text-center border border-gray-100">
                            <p className="text-xs text-gray-500 mb-1">{label}</p>
                            <p className="text-sm font-semibold text-gray-900">{value}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <SFooter>
                    <SaveBtn onClick={updateCacheSettings} loading={cacheLoading} label="Save Cache Settings" />
                    <button
                      onClick={purgeCache}
                      disabled={cacheLoading}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-600 border border-red-200 rounded-xl hover:bg-red-50 disabled:opacity-50 transition-colors"
                    >
                      {cacheLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Purge Cache
                    </button>
                  </SFooter>
                </SCard>

                {/* Server Info */}
                <SCard>
                  <div
                    className="flex items-center justify-between px-6 py-4 cursor-pointer select-none"
                    onClick={() => setServerInfoExpanded(v => !v)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-1.5 rounded-lg bg-gray-100">
                        <Server className="h-4 w-4 text-gray-500" />
                      </div>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-sm font-semibold text-gray-900">Server Information</span>
                        <Badge className={`${getStatusColor()} text-white text-xs flex-shrink-0`}>
                          {isLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                          {getStatusLabel()}
                        </Badge>
                        {!isLoading && ipData?.data?.primaryIP && (
                          <span className="font-mono text-sm text-gray-600 hidden sm:inline">{ipData.data.primaryIP}</span>
                        )}
                        {lastChecked && !isLoading && (
                          <span className="text-xs text-gray-400 hidden md:inline">· {formatIndianDateTime(lastChecked)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      <div onClick={e => e.stopPropagation()}>
                        <RefreshButton onClick={fetchOutboundIP} isLoading={isLoading} title="Refresh" />
                      </div>
                      <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${serverInfoExpanded ? "rotate-180" : ""}`} />
                    </div>
                  </div>

                  {serverInfoExpanded && (
                    <div className="border-t border-gray-100 p-6 space-y-4">
                      {(isLoading || (isDataLoading && !ipData)) && (
                        <div className="space-y-3">
                          <div className="h-16 bg-blue-50 rounded-xl animate-pulse" />
                          <div className="h-24 bg-gray-50 rounded-xl animate-pulse" />
                        </div>
                      )}
                      {ipData?.success && ipData.data && !isLoading && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                          <div className="flex items-center justify-between p-4 bg-blue-50 rounded-xl border border-blue-100">
                            <div>
                              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">Primary Outbound IP</p>
                              <p className="text-2xl font-mono text-blue-900">{ipData.data.primaryIP || "N/A"}</p>
                            </div>
                            <button onClick={() => { void navigator.clipboard.writeText(ipData.data?.primaryIP || ""); showSuccessToast("Copied!"); }} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50">
                              <Copy className="h-3.5 w-3.5" /> Copy
                            </button>
                          </div>

                          {ipData.data.services && (
                            <div className="bg-gray-50 rounded-xl border border-gray-100 overflow-hidden">
                              <p className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">Service Results</p>
                              <div className="divide-y divide-gray-100">
                                {Object.entries(ipData.data.services).map(([service, result]: [string, any]) => (
                                  <div key={service} className="flex items-center justify-between px-4 py-2.5 text-sm">
                                    <span className="capitalize font-medium text-gray-700">{service}</span>
                                    <Badge variant={result.ip ? "outline" : "destructive"} className="text-xs font-mono">
                                      {result.ip || "Failed"}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {ipData.data.serverInfo && (
                            <div className="bg-gray-50 rounded-xl border border-gray-100 overflow-hidden">
                              <p className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">Server Headers</p>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                                {Object.entries(ipData.data.serverInfo).map(([key, value]) => (
                                  <div key={key}>
                                    <p className="text-xs text-gray-400 uppercase tracking-wider mb-0.5">{key.replace(/([A-Z])/g, " $1").trim()}</p>
                                    <p className="font-mono text-xs text-gray-800 break-all">{value as React.ReactNode}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </motion.div>
                      )}
                      {!isLoading && !ipData && !isDataLoading && (
                        <p className="text-center text-sm text-gray-400 py-6">No data available — click Refresh to fetch.</p>
                      )}
                    </div>
                  )}
                </SCard>
              </>
            )}

            {/* ════ SECURITY ════ */}
            {!isDataLoading && activeSection === "security" && (
              <>
                {/* IP Whitelist */}
                <SCard>
                  <SCardHead
                    title="IP Whitelisting"
                    description="Restrict admin API access to specific IP addresses"
                    action={<Toggle checked={ipWhitelistEnabled} onChange={setIpWhitelistEnabled} />}
                  />
                  <div className="p-6 space-y-5">
                    {!ipWhitelistEnabled ? (
                      <p className="text-sm text-gray-500">IP whitelisting is off. Enable it to restrict admin API access to specific addresses.</p>
                    ) : (
                      <>
                        <div className="flex items-start gap-3 p-3.5 bg-yellow-50 border border-yellow-200 rounded-xl">
                          <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
                          <p className="text-sm text-yellow-800">Add your current IP before enabling — otherwise you may be locked out.</p>
                        </div>

                        {/* Current IP */}
                        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Your Current IP</p>
                            <p className="font-mono text-sm text-gray-900">{isLoadingIP ? "Loading…" : currentIP || "Not available"}</p>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={fetchCurrentIP} disabled={isLoadingIP} className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 flex items-center gap-1.5 disabled:opacity-50">
                              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingIP ? "animate-spin" : ""}`} /> Check
                            </button>
                            {currentIP && (
                              <button onClick={() => addIPToWhitelist(currentIP)} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1.5">
                                <Plus className="h-3.5 w-3.5" /> Add Mine
                              </button>
                            )}
                          </div>
                        </div>

                        {/* List */}
                        <div>
                          <p className="text-sm font-medium text-gray-700 mb-2">Whitelisted IPs</p>
                          {whitelistedIPs.length === 0 ? (
                            <p className="text-sm text-gray-400 italic">No IPs added yet</p>
                          ) : (
                            <div className="space-y-1.5">
                              {whitelistedIPs.map(ip => (
                                <div key={ip} className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border border-gray-100 rounded-xl">
                                  <div className="flex items-center gap-2">
                                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                                    <span className="font-mono text-sm text-gray-800">{ip}</span>
                                  </div>
                                  <button onClick={() => setWhitelistedIPs(whitelistedIPs.filter(i => i !== ip))} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Add */}
                        <div className="flex gap-2">
                          <input type="text" value={newIP} onChange={e => setNewIP(e.target.value)} onKeyDown={e => e.key === "Enter" && addIPToWhitelist(newIP)} placeholder="1.2.3.4 or 192.168.1.0/24" className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                          <button onClick={() => addIPToWhitelist(newIP)} className="px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 flex items-center gap-1.5">
                            <Plus className="h-4 w-4" /> Add
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  {ipWhitelistEnabled && (
                    <SFooter>
                      <SaveBtn onClick={saveIPWhitelistSettings} loading={isSavingWhitelist} label="Save Whitelist" />
                    </SFooter>
                  )}
                </SCard>

                {/* CORS */}
                <SCard>
                  <SCardHead
                    title="CORS Protection"
                    description="Control which websites can make browser requests to your API"
                    action={<Toggle checked={corsProtectionEnabled} onChange={setCorsProtectionEnabled} />}
                  />
                  <div className="p-6 space-y-5">
                    {!corsProtectionEnabled ? (
                      <p className="text-sm text-gray-500">CORS protection is off. All origins can make API requests from browsers.</p>
                    ) : (
                      <>
                        <div className="flex items-start gap-3 p-3.5 bg-yellow-50 border border-yellow-200 rounded-xl">
                          <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
                          <p className="text-sm text-yellow-800">Add your frontend domain before enabling — otherwise the frontend won't be able to make API requests.</p>
                        </div>

                        {currentOrigin && (
                          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Current Origin</p>
                              <p className="font-mono text-sm text-gray-900">{currentOrigin}</p>
                            </div>
                            <button onClick={() => addOriginToWhitelist(currentOrigin)} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1.5">
                              <Plus className="h-3.5 w-3.5" /> Add Mine
                            </button>
                          </div>
                        )}

                        <div>
                          <p className="text-sm font-medium text-gray-700 mb-2">Allowed Origins</p>
                          {allowedOrigins.length === 0 ? (
                            <p className="text-sm text-gray-400 italic">No origins added yet</p>
                          ) : (
                            <div className="space-y-1.5">
                              {allowedOrigins.map(origin => (
                                <div key={origin} className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border border-gray-100 rounded-xl">
                                  <div className="flex items-center gap-2">
                                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                                    <span className="font-mono text-sm text-gray-800">{origin}</span>
                                  </div>
                                  <button onClick={() => setAllowedOrigins(allowedOrigins.filter(o => o !== origin))} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <input type="text" value={newOrigin} onChange={e => setNewOrigin(e.target.value)} onKeyDown={e => e.key === "Enter" && addOriginToWhitelist(newOrigin)} placeholder="https://yourdomain.com" className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                          <button onClick={() => addOriginToWhitelist(newOrigin)} className="px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 flex items-center gap-1.5">
                            <Plus className="h-4 w-4" /> Add
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  {corsProtectionEnabled && (
                    <SFooter>
                      <SaveBtn onClick={saveCORSSettings} loading={isSavingCors} label="Save CORS Settings" />
                    </SFooter>
                  )}
                </SCard>

              </>
            )}

            {/* ════ PROMOTIONS ════ */}
            {!isDataLoading && activeSection === "promotions" && (
              <>
                {/* Free Trial */}
                <SCard>
                  <SCardHead
                    title="15-Day Free Trial for Hosting"
                    description="When enabled, new customers see a 'Start Free Trial' option on yearly hosting plans with automatic billing on day 15"
                    action={<Toggle checked={hostingTrialEnabled} onChange={setHostingTrialEnabled} color="purple" />}
                  />
                  <div className="p-6">
                    <StatusBanner
                      active={hostingTrialEnabled}
                      color="purple"
                      activeMsg="Free trial is active. Customers can start a 15-day trial on yearly plans (one per user, lifetime). They are charged automatically on day 15."
                      inactiveMsg="Free trial is disabled. The trial button won't appear on the hosting page. Existing trials in progress are not affected."
                    />
                  </div>
                  <SFooter>
                    <SaveBtn onClick={saveHostingTrialSettings} loading={isSavingTrial} label="Save Trial Settings" color="purple" />
                  </SFooter>
                </SCard>

                {/* Trial — Phone OTP Gate (anti-abuse) */}
                <SCard>
                  <SCardHead
                    title="Trial — Phone OTP Verification"
                    description="Require an SMS OTP before a user can claim the free trial. Strongest deterrent against email-rotation abuse. Wired but currently off."
                    action={<Toggle checked={trialOtpRequired} onChange={setTrialOtpRequired} color="purple" />}
                  />
                  <div className="p-6">
                    <StatusBanner
                      active={trialOtpRequired}
                      color="purple"
                      activeMsg="Phone OTP is enforced. Users must verify their mobile number before the trial button works. Make sure SMS_PROVIDER and credentials are configured."
                      inactiveMsg="Phone OTP is off. Disposable-email and IP/device-throttle layers are still active. Flip this on once your SMS provider (MSG91) is wired up."
                    />
                  </div>
                  <SFooter>
                    <SaveBtn onClick={saveTrialOtpSettings} loading={isSavingTrialOtp} label="Save OTP Settings" color="purple" />
                  </SFooter>
                </SCard>

                {/* ₹1 Test Plan */}
                <SCard>
                  <SCardHead
                    title="₹1 Live Payment Test Plan"
                    description="A ₹1/month hosting plan for testing live Razorpay payments — auto-creates a Razorpay subscription plan if needed"
                    action={
                      <span className={`px-3 py-1 rounded-full text-xs font-bold border ${testPlanEnabled ? "bg-orange-50 text-orange-700 border-orange-300" : "bg-gray-100 text-gray-500 border-gray-200"}`}>
                        {isLoadingTestPlan ? "Loading…" : testPlanEnabled ? "ENABLED" : "DISABLED"}
                      </span>
                    }
                  />
                  <div className="p-6 space-y-5">
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                        Razorpay Plan ID <span className="font-normal text-gray-400">(optional — auto-created if blank)</span>
                      </label>
                      <input
                        type="text"
                        value={testPlanRazorpayInput}
                        onChange={e => setTestPlanRazorpayInput(e.target.value)}
                        placeholder="plan_xxxxxxxxxxxxxxxx"
                        className="w-full max-w-sm px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-400"
                      />
                      {testPlanRazorpayId && (
                        <p className="text-xs text-gray-400 mt-1">Active: <code className="bg-gray-50 px-1 rounded font-mono">{testPlanRazorpayId}</code></p>
                      )}
                    </div>

                    <StatusBanner
                      active={testPlanEnabled}
                      color="orange"
                      activeMsg="₹1 test plan is live on the public hosting page. Use it to verify Razorpay live keys are working, then disable it."
                      inactiveMsg="₹1 test plan is hidden. Enable temporarily to test a live Razorpay payment of ₹1, then disable once verified."
                    />
                  </div>
                  <SFooter>
                    {!testPlanEnabled ? (
                      <button onClick={() => saveTestPlan("enable")} disabled={isSavingTestPlan} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-500 rounded-xl hover:bg-orange-600 disabled:opacity-50 transition-colors">
                        {isSavingTestPlan ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                        {isSavingTestPlan ? "Enabling…" : "Enable ₹1 Test Plan"}
                      </button>
                    ) : (
                      <button onClick={() => saveTestPlan("disable")} disabled={isSavingTestPlan} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-50 transition-colors">
                        {isSavingTestPlan ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                        {isSavingTestPlan ? "Disabling…" : "Disable ₹1 Test Plan"}
                      </button>
                    )}
                    <button onClick={loadTestPlanSettings} disabled={isLoadingTestPlan} className="px-3 py-2 text-sm text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50">
                      <RefreshCw className={`h-3.5 w-3.5 ${isLoadingTestPlan ? "animate-spin" : ""}`} /> Refresh
                    </button>
                  </SFooter>
                </SCard>
              </>
            )}

            {!isDataLoading && activeSection === "integrations" && (
              <>
                {/* WhatsApp notifications */}
                <SCard>
                  <SCardHead
                    title="WhatsApp Notifications (Meta Cloud API)"
                    description="Send reminders, payment confirmations & suspension notices over WhatsApp alongside email. The API token is developer-managed in Secret Manager; everything else you manage here."
                    action={<Toggle checked={waEnabled} onChange={setWaEnabled} color="green" />}
                  />
                  <div className="p-6 space-y-5">
                    {/* Status pill row */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`px-3 py-1 rounded-full text-xs font-bold border ${waReady ? "bg-green-50 text-green-700 border-green-300" : "bg-gray-100 text-gray-500 border-gray-200"}`}>
                        {isLoadingWa ? "Loading…" : waReady ? "READY — sends live" : waEnabled ? "ENABLED — not fully configured" : "DISABLED"}
                      </span>
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${waHasToken ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
                        {waHasToken ? "API token: set" : "API token: MISSING (developer sets in Secret Manager)"}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Phone-number ID</label>
                        <input type="text" value={waPhoneNumberId} onChange={e => setWaPhoneNumberId(e.target.value)} placeholder="From Meta WhatsApp Manager" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-400" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Business number <span className="font-normal text-gray-400">(display only)</span></label>
                        <input type="text" value={waBusinessNumber} onChange={e => setWaBusinessNumber(e.target.value)} placeholder="+91 98765 43210" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-400" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Reminder template</label>
                        <input type="text" value={waTplReminder} onChange={e => setWaTplReminder(e.target.value)} placeholder="service_renewal_reminder" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-400" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Payment template</label>
                        <input type="text" value={waTplPayment} onChange={e => setWaTplPayment(e.target.value)} placeholder="payment_confirmed" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-400" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Suspension template</label>
                        <input type="text" value={waTplSuspended} onChange={e => setWaTplSuspended(e.target.value)} placeholder="service_suspended" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-400" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Welcome template</label>
                        <input type="text" value={waTplWelcome} onChange={e => setWaTplWelcome(e.target.value)} placeholder="hosting_provisioned" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-400" />
                      </div>
                    </div>

                    <StatusBanner
                      active={waReady}
                      color="green"
                      activeMsg="WhatsApp is live. Enabled notifications will fire to customers who have a WhatsApp number on file + opted in. Template names must match what's approved in Meta WhatsApp Manager."
                      inactiveMsg="Not sending yet. Needs: master toggle ON + API token in Secret Manager (developer) + a phone-number ID. Templates fall back to sensible defaults if left blank."
                    />

                    {/* Test send — validates config even while disabled */}
                    <div className="border-t border-gray-100 pt-5">
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Send a test message <span className="font-normal text-gray-400">(bypasses the master toggle — validates token + template before going live)</span></label>
                      <div className="flex flex-wrap items-center gap-2">
                        <input type="text" value={waTestNumber} onChange={e => setWaTestNumber(e.target.value)} placeholder="10-digit mobile or +91…" className="flex-1 min-w-[200px] px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-400" />
                        <button onClick={sendWhatsAppTest} disabled={isSendingWaTest} className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-green-600 rounded-xl hover:bg-green-700 disabled:opacity-50 transition-colors">
                          {isSendingWaTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                          {isSendingWaTest ? "Sending…" : "Send test"}
                        </button>
                      </div>
                    </div>
                  </div>
                  <SFooter>
                    <SaveBtn onClick={saveWhatsAppSettings} loading={isSavingWa} label="Save WhatsApp Settings" color="green" />
                    <button onClick={loadWhatsAppSettings} disabled={isLoadingWa} className="px-3 py-2 text-sm text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50">
                      <RefreshCw className={`h-3.5 w-3.5 ${isLoadingWa ? "animate-spin" : ""}`} /> Refresh
                    </button>
                  </SFooter>
                </SCard>
              </>
            )}

            {!isDataLoading && activeSection === "tracking" && (
              <>
                <SCard>
                  <SCardHead
                    title="Analytics & Marketing Tags"
                    description="Paste the code Google or Meta give you — we extract just the ID and load the official tag safely (nonce-signed, first-party). Your pasted markup never runs on the site."
                    action={<Toggle checked={trEnabled} onChange={setTrEnabled} color="blue" />}
                  />
                  <div className="p-6 space-y-5">
                    <StatusBanner
                      active={trEnabled && Boolean(previewTrackingId("ga4", trGa4) || previewTrackingId("gtm", trGtm) || previewTrackingId("meta", trMeta) || previewTrackingId("googleAds", trAds))}
                      color="green"
                      activeMsg="Tags are live on the customer site. Paste a full snippet or a bare ID in any box — the detected ID is shown beneath each field and is what actually gets loaded."
                      inactiveMsg="Not loading yet. Turn on the master toggle and add at least one ID. You can paste the whole snippet — only the ID is extracted and stored."
                    />

                    {([
                      { label: "Google Analytics 4", provider: "ga4" as const, val: trGa4, set: setTrGa4, ph: "Paste the gtag.js snippet, or G-XXXXXXX" },
                      { label: "Google Tag Manager", provider: "gtm" as const, val: trGtm, set: setTrGtm, ph: "Paste the GTM snippet, or GTM-XXXXXX" },
                      { label: "Meta / Facebook Pixel", provider: "meta" as const, val: trMeta, set: setTrMeta, ph: "Paste the Pixel base code, or the numeric ID" },
                      { label: "Google Ads", provider: "googleAds" as const, val: trAds, set: setTrAds, ph: "Paste the Ads tag, or AW-XXXXXXXXX" },
                    ]).map((f) => {
                      const detected = previewTrackingId(f.provider, f.val);
                      const hasInput = f.val.trim().length > 0;
                      return (
                        <div key={f.provider}>
                          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{f.label}</label>
                          <textarea
                            value={f.val}
                            onChange={(e) => f.set(e.target.value)}
                            rows={2}
                            placeholder={f.ph}
                            className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                          {hasInput && (
                            detected ? (
                              <p className="mt-1 text-xs text-green-700 flex items-center gap-1.5"><CheckCircle className="h-3.5 w-3.5" /> Detected ID: <span className="font-mono font-semibold">{detected}</span></p>
                            ) : (
                              <p className="mt-1 text-xs text-red-600 flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" /> No valid ID found in this text</p>
                            )
                          )}
                        </div>
                      );
                    })}

                    <div className="flex items-center justify-between border-t border-gray-100 pt-5">
                      <div>
                        <p className="text-sm font-medium text-gray-900">Also load on admin &amp; dashboard</p>
                        <p className="text-xs text-gray-500 mt-0.5">Off by default — analytics normally shouldn&apos;t count staff/admin sessions.</p>
                      </div>
                      <Toggle checked={trLoadOnAdmin} onChange={setTrLoadOnAdmin} color="blue" />
                    </div>
                  </div>
                  <SFooter>
                    <SaveBtn onClick={saveTrackingSettings} loading={isSavingTracking} label="Save Tracking Settings" />
                    <button onClick={loadTrackingSettings} disabled={isLoadingTracking} className="px-3 py-2 text-sm text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50">
                      <RefreshCw className={`h-3.5 w-3.5 ${isLoadingTracking ? "animate-spin" : ""}`} /> Refresh
                    </button>
                  </SFooter>
                </SCard>
              </>
            )}

          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
