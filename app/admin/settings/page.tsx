"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { motion } from "framer-motion";
import {
  Settings, Server, Wifi, RefreshCw, CheckCircle, AlertTriangle, AlertCircle,
  Copy, Loader2, Globe, Plus, X, Save, Database, Trash2, ChevronDown,
  Wrench, Power, Shield, Tag,
} from "lucide-react";
import RefreshButton from "@/components/dashboard/RefreshButton";
import AdminLayoutNew from "@/components/admin/AdminLayoutNew";
import { AdminLayoutSkeleton, AdminSettingsPageSkeleton } from "@/components/skeletons/PageSkeletons";
import { formatIndianDateTime } from "@/lib/dateUtils";
import { performLogout } from "@/lib/logout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { showSuccessToast, showErrorToast } from "@/lib/toast";
import { safeLocalStorage } from "@/lib/storage";

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

type ActiveSection = "general" | "performance" | "security" | "promotions";

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

function Toggle({ checked, onChange, color = "blue" }: { checked: boolean; onChange: (v: boolean) => void; color?: "blue" | "red" | "purple" | "orange" }) {
  const ring = { blue: "peer-focus:ring-blue-300 peer-checked:bg-blue-600", red: "peer-focus:ring-red-300 peer-checked:bg-red-600", purple: "peer-focus:ring-purple-300 peer-checked:bg-purple-600", orange: "peer-focus:ring-orange-300 peer-checked:bg-orange-500" }[color];
  return (
    <label className="relative inline-flex items-center cursor-pointer shrink-0">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
      <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${ring}`} />
    </label>
  );
}

function SaveBtn({ onClick, loading, label, color = "blue", disabled = false }: { onClick: () => void; loading: boolean; label: string; color?: "blue" | "red" | "purple" | "orange"; disabled?: boolean }) {
  const cls = { blue: "bg-blue-600 hover:bg-blue-700", red: "bg-red-600 hover:bg-red-700", purple: "bg-purple-600 hover:bg-purple-700", orange: "bg-orange-500 hover:bg-orange-600" }[color];
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

  // Captcha
  const [captchaEnabled, setCaptchaEnabled] = useState(true);
  const [isSavingCaptcha, setIsSavingCaptcha] = useState(false);

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

  // ── Auth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === "loading") return;
    if (session?.user) {
      const u = { firstName: session.user.name?.split(" ")[0] || "", lastName: session.user.name?.split(" ").slice(1).join(" ") || "", role: (session.user as { role?: string }).role || "user" };
      if (u.role !== "admin") { router.push("/dashboard"); return; }
      setUser(u); setIsAuthLoading(false); loadAllSettings(); return;
    }
    const getCookieValue = (name: string) => { const v = `; ${document.cookie}`; const p = v.split(`; ${name}=`); if (p.length === 2) return p.pop()?.split(";").shift(); return null; };
    const token = getCookieValue("token") || safeLocalStorage.getItem("token");
    const userData = safeLocalStorage.getItem("user");
    if (!token || !userData) { router.push("/login"); return; }
    const u = JSON.parse(userData);
    if (u.role !== "admin") { router.push("/dashboard"); return; }
    setUser(u); setIsAuthLoading(false); loadAllSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  // ── Data loading ──────────────────────────────────────────────────────────
  const authHeaders = (extra: Record<string, string> = {}): HeadersInit => {
    const token = safeLocalStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}`, ...extra } : extra;
  };

  const loadAllSettings = async () => {
    setIsDataLoading(true);
    await Promise.all([loadSavedIPData(), loadCacheSettings(), loadIPWhitelistSettings(), loadCORSSettings(), loadCaptchaSettings(), loadHostingTrialSettings(), loadTestPlanSettings(), loadMaintenanceSettings()]);
    if (typeof window !== "undefined") setCurrentOrigin(window.location.origin);
    setIsDataLoading(false);
  };

  const loadSavedIPData = async () => {
    try {
      const res = await fetch("/api/v1/admin/ip-status", { headers: authHeaders(), credentials: "include" });
      if (res.ok) { const d = await res.json(); setIpData(d); if (d.lastChecked) setLastChecked(new Date(d.lastChecked)); }
    } catch {}
  };

  const loadCacheSettings = async () => {
    try {
      const [sr, cr] = await Promise.all([
        fetch("/api/v1/admin/tld-pricing/cache", { headers: authHeaders(), credentials: "include" }),
        fetch("/api/v1/admin/settings", { headers: authHeaders(), credentials: "include" }),
      ]);
      if (sr.ok) { const d = await sr.json(); setCacheStatus(d.cache); setCacheTTL(d.ttl || 60); }
      if (cr.ok) {
        const d = await cr.json(); const s = d.settings || {};
        if (s.tld_pricing_cache_enabled !== undefined) setCacheEnabled(s.tld_pricing_cache_enabled.value !== false);
        if (s.tld_pricing_cache_ttl !== undefined) setCacheTTL(parseInt(s.tld_pricing_cache_ttl.value) || 60);
      }
    } catch {}
  };

  const loadIPWhitelistSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings", { headers: authHeaders(), credentials: "include" });
      if (!res.ok) return;
      const d = await res.json(); const s = d.settings || {};
      const en = s["admin_ip_whitelist_enabled"];
      setIpWhitelistEnabled(en?.value === true || en?.value === "true");
      const storedUser = safeLocalStorage.getItem("user");
      const userId = storedUser ? JSON.parse(storedUser)._id || JSON.parse(storedUser).id : "";
      if (userId) {
        const ws = s[`admin_ip_whitelist_${userId}`];
        if (ws?.value) setWhitelistedIPs(Array.isArray(ws.value) ? ws.value : typeof ws.value === "string" ? ws.value.split(",").map((i: string) => i.trim()) : []);
      }
    } catch {}
  };

  const loadCORSSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings", { headers: authHeaders(), credentials: "include" });
      if (!res.ok) return;
      const d = await res.json(); const s = d.settings || {};
      const en = s["cors_protection_enabled"];
      setCorsProtectionEnabled(en?.value === true || en?.value === "true");
      const os = s["cors_allowed_origins"];
      if (os?.value) setAllowedOrigins(Array.isArray(os.value) ? os.value : typeof os.value === "string" ? os.value.split(",").map((o: string) => o.trim()) : []);
    } catch {}
  };

  const loadCaptchaSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings", { headers: authHeaders(), credentials: "include" });
      if (!res.ok) return;
      const d = await res.json(); const s = d.settings?.captcha_enabled;
      if (s !== undefined) setCaptchaEnabled(s.value === true || s.value === "true");
    } catch {}
  };

  const loadHostingTrialSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings", { headers: authHeaders(), credentials: "include" });
      if (!res.ok) return;
      const d = await res.json();
      const s = d.settings?.hosting_trial_enabled;
      if (s !== undefined) setHostingTrialEnabled(s.value !== false);
      const otp = d.settings?.hosting_trial_otp_required;
      if (otp !== undefined) setTrialOtpRequired(otp.value === true || otp.value === "true");
    } catch {}
  };

  const loadTestPlanSettings = async () => {
    setIsLoadingTestPlan(true);
    try {
      const res = await fetch("/api/v1/admin/hosting/test-plan", { headers: authHeaders(), credentials: "include" });
      if (res.ok) { const d = await res.json(); setTestPlanEnabled(d.enabled === true); const id = d.plan?.razorpayPlans?.monthly || ""; setTestPlanRazorpayId(id); setTestPlanRazorpayInput(id); }
    } catch {} finally { setIsLoadingTestPlan(false); }
  };

  const loadMaintenanceSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings", { headers: authHeaders(), credentials: "include" });
      if (!res.ok) return;
      const d = await res.json(); const setting = (d.settings || {})["maintenance_mode"];
      if (setting?.value) {
        setMaintenanceEnabled(!!setting.value.enabled);
        setMaintenanceMessage(setting.value.message || "");
        if (setting.value.scheduledEnd) { const local = new Date(setting.value.scheduledEnd); local.setMinutes(local.getMinutes() - local.getTimezoneOffset()); setMaintenanceScheduledEnd(local.toISOString().slice(0, 16)); }
      }
    } catch {}
  };

  // ── Handlers ──────────────────────────────────────────────────────────────
  const updateCacheSettings = async () => {
    setCacheLoading(true);
    try {
      const res = await fetch("/api/v1/admin/tld-pricing/cache", { method: "PUT", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ enabled: cacheEnabled, ttlMinutes: cacheTTL }) });
      if ((await res.json()).success) { showSuccessToast("Cache settings updated"); await loadCacheSettings(); } else showErrorToast("Failed to update cache settings");
    } catch { showErrorToast("Failed to update cache settings"); } finally { setCacheLoading(false); }
  };

  const purgeCache = async () => {
    setCacheLoading(true);
    try {
      const res = await fetch("/api/v1/admin/tld-pricing/cache", { method: "DELETE", headers: authHeaders(), credentials: "include" });
      if ((await res.json()).success) { showSuccessToast("Cache purged"); await loadCacheSettings(); } else showErrorToast("Failed to purge cache");
    } catch { showErrorToast("Failed to purge cache"); } finally { setCacheLoading(false); }
  };

  const fetchOutboundIP = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/admin/check-ip", { headers: authHeaders(), credentials: "include" });
      const d = await res.json(); setIpData(d); setLastChecked(new Date());
      if (d.success) showSuccessToast("Outbound IP refreshed"); else showErrorToast("Failed to check outbound IP");
    } catch { showErrorToast("Network error"); } finally { setIsLoading(false); }
  };

  const fetchCurrentIP = async () => {
    setIsLoadingIP(true);
    try {
      const res = await fetch("/api/v1/admin/check-ip", { headers: authHeaders(), credentials: "include" });
      if (res.ok) { const d = await res.json(); if (d.success && d.data?.primaryIP) setCurrentIP(d.data.primaryIP); }
    } catch {} finally { setIsLoadingIP(false); }
  };

  useEffect(() => { if (ipData?.data?.primaryIP) setCurrentIP(ipData.data.primaryIP); }, [ipData]);

  const saveIPWhitelistSettings = async () => {
    if (!user) return;
    setIsSavingWhitelist(true);
    try {
      const userObj = session?.user || JSON.parse(safeLocalStorage.getItem("user") || "{}");
      const userId = userObj._id || userObj.id || "";
      if (!userId) { showErrorToast("User ID not found"); return; }
      await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: "admin_ip_whitelist_enabled", value: ipWhitelistEnabled, description: "Enable IP whitelisting for admin APIs", category: "security" }) });
      await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: `admin_ip_whitelist_${userId}`, value: whitelistedIPs, description: "Whitelisted IP addresses for admin access", category: "security" }) });
      showSuccessToast("IP whitelist settings saved");
    } catch { showErrorToast("Failed to save IP whitelist settings"); } finally { setIsSavingWhitelist(false); }
  };

  const addIPToWhitelist = (ip: string) => {
    const t = ip.trim(); if (!t) return;
    if (whitelistedIPs.includes(t)) { showErrorToast("IP already in whitelist"); return; }
    setWhitelistedIPs([...whitelistedIPs, t]); setNewIP("");
  };

  const saveCORSSettings = async () => {
    setIsSavingCors(true);
    try {
      await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: "cors_protection_enabled", value: corsProtectionEnabled, description: "Enable CORS protection", category: "security" }) });
      await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: "cors_allowed_origins", value: allowedOrigins, description: "Allowed origins for CORS", category: "security" }) });
      showSuccessToast("CORS settings saved");
    } catch { showErrorToast("Failed to save CORS settings"); } finally { setIsSavingCors(false); }
  };

  const addOriginToWhitelist = (origin: string) => {
    const t = origin.trim(); if (!t) return;
    if (allowedOrigins.includes(t)) { showErrorToast("Origin already in list"); return; }
    setAllowedOrigins([...allowedOrigins, t]); setNewOrigin("");
  };

  const saveCaptchaSettings = async () => {
    setIsSavingCaptcha(true);
    try {
      await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: "captcha_enabled", value: captchaEnabled, description: "Enable Google reCAPTCHA on public forms", category: "security" }) });
      showSuccessToast(`Captcha ${captchaEnabled ? "enabled" : "disabled"}`);
    } catch { showErrorToast("Failed to save captcha settings"); } finally { setIsSavingCaptcha(false); }
  };

  const saveHostingTrialSettings = async () => {
    setIsSavingTrial(true);
    try {
      const res = await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: "hosting_trial_enabled", value: hostingTrialEnabled, description: "15-day free trial for yearly hosting", category: "promotions" }) });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      showSuccessToast(`Hosting trial ${hostingTrialEnabled ? "enabled" : "disabled"}`);
    } catch { showErrorToast("Failed to save trial settings"); } finally { setIsSavingTrial(false); }
  };

  const saveTrialOtpSettings = async () => {
    setIsSavingTrialOtp(true);
    try {
      const res = await fetch("/api/v1/admin/settings", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({
          key: "hosting_trial_otp_required",
          value: trialOtpRequired,
          description: "Require phone OTP verification before claiming the hosting free trial",
          category: "security",
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      showSuccessToast(`Trial phone-OTP gate ${trialOtpRequired ? "enabled" : "disabled"}`);
    } catch { showErrorToast("Failed to save trial OTP settings"); } finally { setIsSavingTrialOtp(false); }
  };

  const saveTestPlan = async (action: "enable" | "disable") => {
    setIsSavingTestPlan(true);
    try {
      const body: Record<string, string> = { action };
      if (action === "enable" && testPlanRazorpayInput.trim()) body.razorpayPlanMonthly = testPlanRazorpayInput.trim();
      const res = await fetch("/api/v1/admin/hosting/test-plan", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setTestPlanEnabled(d.enabled);
      if (d.razorpayPlanMonthly) { setTestPlanRazorpayId(d.razorpayPlanMonthly); setTestPlanRazorpayInput(d.razorpayPlanMonthly); }
      showSuccessToast(action === "enable" ? "₹1 test plan enabled" : "₹1 test plan disabled");
    } catch (e: unknown) { showErrorToast(e instanceof Error ? e.message : "Failed"); } finally { setIsSavingTestPlan(false); }
  };

  const saveMaintenanceSettings = async () => {
    setIsSavingMaintenance(true);
    try {
      const scheduledEnd = maintenanceScheduledEnd ? new Date(maintenanceScheduledEnd).toISOString() : null;
      const res = await fetch("/api/v1/admin/settings", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), credentials: "include", body: JSON.stringify({ key: "maintenance_mode", value: { enabled: maintenanceEnabled, message: maintenanceMessage.trim(), scheduledEnd }, description: "Site-wide maintenance mode", category: "general" }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
      showSuccessToast(maintenanceEnabled ? "Maintenance mode enabled" : "Site is live");
    } catch { showErrorToast("Failed to save maintenance settings"); } finally { setIsSavingMaintenance(false); }
  };

  const getStatusColor = () => { if (isLoading) return "bg-yellow-500"; if (!ipData?.success) return "bg-red-500"; if (ipData?.data?.allIPs && ipData.data.allIPs.length > 1) return "bg-orange-500"; return "bg-green-500"; };
  const getStatusLabel = () => { if (isLoading) return "Checking…"; if (!ipData?.success) return "Error"; if (ipData?.data?.allIPs && ipData.data.allIPs.length > 1) return "Multiple IPs"; return "Connected"; };

  if (isAuthLoading) return <AdminLayoutSkeleton><AdminSettingsPageSkeleton /></AdminLayoutSkeleton>;

  const navItems: { id: ActiveSection; label: string; icon: React.ElementType; description: string }[] = [
    { id: "general",     label: "General",     icon: Wrench,   description: "Maintenance mode" },
    { id: "performance", label: "Performance", icon: Database, description: "Cache & server info" },
    { id: "security",    label: "Security",    icon: Shield,   description: "IP, CORS & captcha" },
    { id: "promotions",  label: "Promotions",  icon: Tag,      description: "Trials & test plans" },
  ];

  return (
    <AdminLayoutNew user={user} onLogout={performLogout}>
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
                            <button onClick={() => { navigator.clipboard.writeText(ipData.data?.primaryIP || ""); showSuccessToast("Copied!"); }} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50">
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

                {/* reCAPTCHA */}
                <SCard>
                  <SCardHead
                    title="Google reCAPTCHA"
                    description="Human verification on all public forms (login, register, contact, password reset)"
                    action={<Toggle checked={captchaEnabled} onChange={setCaptchaEnabled} />}
                  />
                  <div className="p-6">
                    <StatusBanner
                      active={captchaEnabled}
                      color="green"
                      activeMsg="reCAPTCHA is active. All public forms require human verification before submission."
                      inactiveMsg="reCAPTCHA is disabled. Public forms can be submitted without verification — only disable temporarily for testing."
                    />
                  </div>
                  <SFooter>
                    <SaveBtn onClick={saveCaptchaSettings} loading={isSavingCaptcha} label="Save Captcha Settings" />
                  </SFooter>
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

          </div>
        </div>
      </div>
    </AdminLayoutNew>
  );
}
