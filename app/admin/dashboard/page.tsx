"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Server,
  Database,
  CreditCard,
  Clock,
  XCircle,
  RefreshCw,
  FileText,
  Globe,
  HardDrive,
  Cpu,
  Users,
  ShoppingCart,
  LayoutGrid,
  MessageSquare,
  Zap,
  TrendingUp,
  Package,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "react-hot-toast";
import AdminLayout from "@/components/admin/AdminLayoutNew";
import { AdminLayoutSkeleton, AdminDashboardSkeleton } from "@/components/skeletons/PageSkeletons";
import { performLogout } from "@/lib/logout";
import { safeLocalStorage } from "@/lib/storage";
import { logger } from "@/lib/logger";

interface SystemHealthData {
  database: {
    status: "operational" | "down";
    latencyMs: number;
    stats: {
      users: number;
      orders: number;
      domains: number;
      openTickets: number;
      pendingDomains: number;
      pendingHosting: number;
    };
  };
  queueBacklog: { domains: number; hosting: number; total: number };
  failedJobs: { domains: number; hosting: number; total: number };
  externalApis: {
    resellerClub: {
      status: "operational" | "down";
      accountStatus?: string;
      billingMode?: string;
      balance: string | null;
      latencyMs: number;
    };
    directAdmin: {
      status: "operational" | "down";
      packageCount: number;
      latencyMs: number;
    };
    razorpay: {
      status: "operational" | "down";
      mode: "live" | "test";
      latencyMs: number;
    };
    zohoBooks: {
      status: "operational" | "down";
      planStatus: "active" | "trial" | "trial_expiring" | "expired" | "misconfigured";
      planName?: string;
      planType?: string;
      planExpiryDate?: string | null;
      daysUntilExpiry?: number | null;
      latencyMs: number;
    };
  };
  server: {
    uptimeSeconds: number;
    memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number };
    nodeVersion: string;
    environment: "production" | "development";
    appVersion: string;
    totalResponseMs: number;
  };
  timestamp: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-IN");
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: "operational" | "down" | "warning" }) {
  if (status === "operational")
    return <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse inline-block" />;
  if (status === "warning")
    return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse inline-block" />;
  return <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />;
}

function StatusBadge({ status, label }: { status: "operational" | "down" | "warning"; label?: string }) {
  if (status === "operational")
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <StatusDot status="operational" />
        {label ?? "Operational"}
      </span>
    );
  if (status === "warning")
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
        <StatusDot status="warning" />
        {label ?? "Degraded"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
      <StatusDot status="down" />
      {label ?? "Down"}
    </span>
  );
}

function LatencyBadge({ ms }: { ms: number }) {
  if (ms === 0) return null;
  const color =
    ms < 200 ? "text-emerald-600 bg-emerald-50 border-emerald-200"
    : ms < 600 ? "text-amber-600 bg-amber-50 border-amber-200"
    : "text-red-600 bg-red-50 border-red-200";
  return (
    <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border ${color}`}>
      {ms}ms
    </span>
  );
}

function MetricRow({ label, value, icon: Icon }: { label: string; value: string | number; icon?: React.ElementType }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        {Icon && <Icon className="w-3.5 h-3.5 text-gray-400" />}
        {label}
      </div>
      <span className="text-sm font-semibold text-gray-800">{value}</span>
    </div>
  );
}

function MemoryBar({ used, total }: { used: number; total: number }) {
  const pct = Math.min(100, Math.round((used / total) * 100));
  const color = pct < 60 ? "bg-emerald-500" : pct < 80 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="mt-1">
      <div className="flex justify-between text-[10px] text-gray-400 mb-1">
        <span>{used} MB used</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5 text-right">{total} MB total</div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, color }: { icon: React.ElementType; title: string; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className={`p-1.5 rounded-lg ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <h2 className="text-sm font-bold text-gray-500 uppercase tracking-widest">{title}</h2>
    </div>
  );
}

// ── Service Card ──────────────────────────────────────────────────────────────

interface ServiceCardProps {
  name: string;
  description: string;
  icon: React.ElementType;
  iconBg: string;
  status: "operational" | "down" | "warning";
  statusLabel?: string;
  latencyMs?: number;
  details: Array<{ label: string; value: string | number | React.ReactNode }>;
  tags?: React.ReactNode;
}

function ServiceCard({ name, description, icon: Icon, iconBg, status, statusLabel, latencyMs, details, tags }: ServiceCardProps) {
  const borderColor =
    status === "operational" ? "border-l-emerald-400"
    : status === "warning" ? "border-l-amber-400"
    : "border-l-red-400";

  return (
    <div className={`bg-white rounded-xl border border-gray-200 border-l-4 ${borderColor} shadow-sm overflow-hidden flex flex-col`}>
      <div className="p-4 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${iconBg} shrink-0`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <div className="font-semibold text-gray-900 text-sm leading-tight">{name}</div>
            <div className="text-xs text-gray-400 mt-0.5">{description}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0 ml-2">
          <StatusBadge status={status} label={statusLabel} />
          {latencyMs !== undefined && latencyMs > 0 && <LatencyBadge ms={latencyMs} />}
        </div>
      </div>

      {tags && <div className="px-4 pb-2 flex flex-wrap gap-1.5">{tags}</div>}

      <div className="px-4 pb-4 flex-1">
        <div className="bg-gray-50 rounded-lg p-3 space-y-0 divide-y divide-gray-100">
          {details.map((d, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 first:pt-0 last:pb-0">
              <span className="text-xs text-gray-400">{d.label}</span>
              <span className="text-xs font-semibold text-gray-700">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [user, setUser] = useState<{
    _id?: string;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
  } | null>(null);
  const [data, setData] = useState<SystemHealthData | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const { data: session, status } = useSession();

  const fetchHealth = useCallback(async () => {
    try {
      setLoading(true);
      const res = await axios.get(`/api/v1/admin/system-health?_t=${Date.now()}`);
      setData(res.data);
    } catch (error) {
      toast.error("Failed to fetch system health data.");
      logger.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "loading") return;

    if (session?.user) {
      const sUser = session.user as { id?: string; role?: string };
      const userObj = {
        _id: sUser.id,
        firstName: session.user.name?.split(" ")[0] || "",
        lastName: session.user.name?.split(" ").slice(1).join(" ") || "",
        email: session.user.email || "",
        role: sUser.role || "user",
      };
      if (userObj.role !== "admin") { router.push("/dashboard"); return; }
      setUser(userObj);
      setIsAuthLoading(false);
      void fetchHealth();
      return;
    }

    setIsAuthLoading(false);
    router.push("/login");
  }, [router, status, session?.user, fetchHealth]);

  useEffect(() => {
    if (!user) return;
    const interval = setInterval(fetchHealth, 60000);
    return () => clearInterval(interval);
  }, [user, fetchHealth]);

  if (isAuthLoading) {
    return <AdminLayoutSkeleton><AdminDashboardSkeleton /></AdminLayoutSkeleton>;
  }

  // Determine overall system status
  const allServices = data
    ? [
        data.database.status,
        data.externalApis.resellerClub.status,
        data.externalApis.directAdmin.status,
        data.externalApis.razorpay.status,
        data.externalApis.zohoBooks.status,
      ]
    : [];
  const downCount = allServices.filter((s) => s === "down").length;
  const overallStatus = downCount === 0 ? "operational" : downCount >= 3 ? "down" : "warning";
  const overallLabel =
    downCount === 0
      ? "All Systems Operational"
      : downCount === 1
      ? "1 Service Degraded"
      : `${downCount} Services Degraded`;

  const zb = data?.externalApis.zohoBooks;
  const zohoServiceStatus: "operational" | "down" | "warning" =
    zb?.planStatus === "trial_expiring" ? "warning"
    : zb?.status === "down" ? "down"
    : "operational";

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">System Health</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {data
                ? <>Last updated: <span className="font-medium text-gray-600">{formatTime(data.timestamp)}</span> · Auto-refresh every 60s</>
                : "Loading system status…"}
            </p>
          </div>
          <button
            onClick={fetchHealth}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {/* ── Overall Status Banner ────────────────────────────────────────── */}
        {data && (
          <div className={`rounded-xl border px-5 py-4 flex items-center justify-between ${
            overallStatus === "operational"
              ? "bg-emerald-50 border-emerald-200"
              : overallStatus === "warning"
              ? "bg-amber-50 border-amber-200"
              : "bg-red-50 border-red-200"
          }`}>
            <div className="flex items-center gap-3">
              {overallStatus === "operational" ? (
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
              ) : overallStatus === "warning" ? (
                <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0" />
              ) : (
                <XCircle className="w-6 h-6 text-red-600 shrink-0" />
              )}
              <div>
                <div className={`font-bold text-base ${
                  overallStatus === "operational" ? "text-emerald-800"
                  : overallStatus === "warning" ? "text-amber-800"
                  : "text-red-800"
                }`}>
                  {overallLabel}
                </div>
                <div className={`text-xs mt-0.5 ${
                  overallStatus === "operational" ? "text-emerald-600"
                  : overallStatus === "warning" ? "text-amber-600"
                  : "text-red-600"
                }`}>
                  {allServices.length} services monitored · Health check completed in {data.server.totalResponseMs}ms
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {allServices.map((s, i) => (
                <StatusDot key={i} status={s === "operational" ? "operational" : "down"} />
              ))}
            </div>
          </div>
        )}

        {loading && !data && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-40 rounded-xl" />
            ))}
          </div>
        )}

        {data && (
          <>
            {/* ── External Services ──────────────────────────────────────── */}
            <div>
              <SectionHeader icon={Wifi} title="External Services" color="bg-purple-100 text-purple-600" />
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">

                {/* ResellerClub */}
                <ServiceCard
                  name="ResellerClub"
                  description="Domain Registrar"
                  icon={Globe}
                  iconBg="bg-blue-100 text-blue-600"
                  status={data.externalApis.resellerClub.status}
                  latencyMs={data.externalApis.resellerClub.latencyMs}
                  details={[
                    {
                      label: "Account Status",
                      value: data.externalApis.resellerClub.accountStatus || "—",
                    },
                    {
                      label: "Billing Mode",
                      value: data.externalApis.resellerClub.billingMode === "NoBilling"
                        ? "Credit Account"
                        : data.externalApis.resellerClub.billingMode || "—",
                    },
                    {
                      label: "Balance",
                      value: data.externalApis.resellerClub.balance !== null
                        ? `₹${data.externalApis.resellerClub.balance}`
                        : "N/A (Credit)",
                    },
                  ]}
                />

                {/* DirectAdmin */}
                <ServiceCard
                  name="DirectAdmin"
                  description="Hosting Control Panel"
                  icon={Server}
                  iconBg="bg-indigo-100 text-indigo-600"
                  status={data.externalApis.directAdmin.status}
                  latencyMs={data.externalApis.directAdmin.latencyMs}
                  details={[
                    {
                      label: "Packages Available",
                      value: data.externalApis.directAdmin.packageCount,
                    },
                    { label: "API Version", value: "v1" },
                    { label: "Protocol", value: "HTTPS" },
                  ]}
                />

                {/* Razorpay */}
                <ServiceCard
                  name="Razorpay"
                  description="Payment Gateway"
                  icon={CreditCard}
                  iconBg="bg-sky-100 text-sky-600"
                  status={data.externalApis.razorpay.status}
                  latencyMs={data.externalApis.razorpay.latencyMs}
                  tags={
                    <span className={`text-[9px] px-2 py-0.5 rounded border font-bold uppercase tracking-wider ${
                      data.externalApis.razorpay.mode === "live"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-amber-50 text-amber-700 border-amber-200"
                    }`}>
                      {data.externalApis.razorpay.mode === "live" ? "🟢 Live Mode" : "🟡 Test Mode"}
                    </span>
                  }
                  details={[
                    {
                      label: "Mode",
                      value: data.externalApis.razorpay.mode === "live" ? "Production" : "Test / Sandbox",
                    },
                    { label: "Currency", value: "INR" },
                    { label: "API Version", value: "v1" },
                  ]}
                />

                {/* Zoho Books */}
                <ServiceCard
                  name="Zoho Books"
                  description="Invoicing & Accounting"
                  icon={FileText}
                  iconBg="bg-orange-100 text-orange-600"
                  status={zohoServiceStatus}
                  statusLabel={
                    zb?.planStatus === "trial_expiring" ? "Expiring Soon"
                    : zb?.planStatus === "expired" ? "Expired"
                    : zb?.planStatus === "misconfigured" ? "Not Configured"
                    : zb?.status === "operational" ? "Operational"
                    : "Down"
                  }
                  latencyMs={data.externalApis.zohoBooks.latencyMs}
                  tags={
                    zb?.planName ? (
                      <span className="text-[10px] px-2 py-0.5 rounded border bg-gray-50 text-gray-500 border-gray-200 font-medium">
                        {zb.planName}
                      </span>
                    ) : undefined
                  }
                  details={[
                    {
                      label: "Plan Type",
                      value: zb?.planType
                        ? zb.planType.charAt(0).toUpperCase() + zb.planType.slice(1)
                        : "—",
                    },
                    {
                      label: "Subscription",
                      value: zb?.planStatus === "active" ? "Active"
                        : zb?.planStatus === "trial" ? "Trial"
                        : zb?.planStatus === "trial_expiring" ? `Expiring in ${zb.daysUntilExpiry}d`
                        : zb?.planStatus === "expired" ? "Expired"
                        : "Not Configured",
                    },
                    {
                      label: "Expiry Date",
                      value: zb?.planExpiryDate
                        ? new Date(zb.planExpiryDate).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "—",
                    },
                  ]}
                />
              </div>
            </div>

            {/* ── Core Infrastructure ─────────────────────────────────────── */}
            <div>
              <SectionHeader icon={HardDrive} title="Core Infrastructure" color="bg-blue-100 text-blue-600" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Database */}
                <div className={`bg-white rounded-xl border border-gray-200 border-l-4 shadow-sm ${
                  data.database.status === "operational" ? "border-l-emerald-400" : "border-l-red-400"
                }`}>
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                        <Database className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">MongoDB</div>
                        <div className="text-xs text-gray-400">Primary Database</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={data.database.status} />
                      <LatencyBadge ms={data.database.latencyMs} />
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      {[
                        { label: "Users", value: data.database.stats.users, icon: Users, color: "blue" },
                        { label: "Orders", value: data.database.stats.orders, icon: ShoppingCart, color: "green" },
                        { label: "Domains", value: data.database.stats.domains, icon: Globe, color: "purple" },
                      ].map(({ label, value, icon: Icon, color }) => (
                        <div key={label} className="bg-gray-50 rounded-lg p-3 text-center border border-gray-100">
                          <div className="text-xl font-bold text-gray-800">{formatNumber(value)}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{label}</div>
                        </div>
                      ))}
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 divide-y divide-gray-100">
                      <MetricRow label="Open Support Tickets" value={formatNumber(data.database.stats.openTickets)} icon={MessageSquare} />
                      <MetricRow label="Pending Domain Orders" value={data.database.stats.pendingDomains} icon={Clock} />
                      <MetricRow label="Pending Hosting Orders" value={data.database.stats.pendingHosting} icon={Clock} />
                      <MetricRow label="Connection Latency" value={`${data.database.latencyMs}ms`} icon={Zap} />
                    </div>
                  </div>
                </div>

                {/* Application Server */}
                <div className="bg-white rounded-xl border border-gray-200 border-l-4 border-l-emerald-400 shadow-sm">
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-emerald-100 text-emerald-600 rounded-lg">
                        <Cpu className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">Application Server</div>
                        <div className="text-xs text-gray-400">Next.js Runtime</div>
                      </div>
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
                      data.server.environment === "production"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-amber-50 text-amber-700 border-amber-200"
                    }`}>
                      {data.server.environment === "production" ? "PRODUCTION" : "DEVELOPMENT"}
                    </span>
                  </div>
                  <div className="p-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                        <div className="text-xs text-gray-400 mb-1">Uptime</div>
                        <div className="font-bold text-gray-800">{formatUptime(data.server.uptimeSeconds)}</div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                        <div className="text-xs text-gray-400 mb-1">App Version</div>
                        <div className="font-bold text-gray-800">v{data.server.appVersion}</div>
                      </div>
                    </div>

                    <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                      <div className="text-xs text-gray-400 mb-2 font-medium">Heap Memory</div>
                      <MemoryBar used={data.server.memory.heapUsedMB} total={data.server.memory.heapTotalMB} />
                    </div>

                    <div className="bg-gray-50 rounded-lg p-3 divide-y divide-gray-100">
                      <MetricRow label="Node.js Version" value={data.server.nodeVersion} icon={TrendingUp} />
                      <MetricRow label="RSS Memory" value={`${data.server.memory.rssMB} MB`} icon={HardDrive} />
                      <MetricRow label="Health Check Duration" value={`${data.server.totalResponseMs}ms`} icon={Zap} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Background Jobs ──────────────────────────────────────────── */}
            <div>
              <SectionHeader icon={Activity} title="Background Jobs" color="bg-orange-100 text-orange-600" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Queue Backlog */}
                <div className={`bg-white rounded-xl border border-gray-200 border-l-4 shadow-sm ${
                  data.queueBacklog.total === 0 ? "border-l-emerald-400" : "border-l-amber-400"
                }`}>
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${
                        data.queueBacklog.total === 0 ? "bg-emerald-100 text-emerald-600" : "bg-amber-100 text-amber-600"
                      }`}>
                        <Clock className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">Pending Queue</div>
                        <div className="text-xs text-gray-400">Awaiting processing</div>
                      </div>
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      data.queueBacklog.total === 0
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}>
                      {data.queueBacklog.total} Pending
                    </span>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className={`rounded-lg p-4 border text-center ${
                        data.queueBacklog.domains > 0 ? "bg-amber-50/60 border-amber-100" : "bg-gray-50 border-gray-100"
                      }`}>
                        <div className={`text-3xl font-bold ${data.queueBacklog.domains > 0 ? "text-amber-700" : "text-gray-700"}`}>
                          {data.queueBacklog.domains}
                        </div>
                        <div className="text-xs font-medium text-gray-500 mt-1 flex items-center justify-center gap-1">
                          <Globe className="w-3 h-3" /> Domain Orders
                        </div>
                      </div>
                      <div className={`rounded-lg p-4 border text-center ${
                        data.queueBacklog.hosting > 0 ? "bg-amber-50/60 border-amber-100" : "bg-gray-50 border-gray-100"
                      }`}>
                        <div className={`text-3xl font-bold ${data.queueBacklog.hosting > 0 ? "text-amber-700" : "text-gray-700"}`}>
                          {data.queueBacklog.hosting}
                        </div>
                        <div className="text-xs font-medium text-gray-500 mt-1 flex items-center justify-center gap-1">
                          <Server className="w-3 h-3" /> Hosting Orders
                        </div>
                      </div>
                    </div>
                    {data.queueBacklog.total === 0 && (
                      <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-100">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        Queue is clear — all orders processed
                      </div>
                    )}
                  </div>
                </div>

                {/* Failed Jobs */}
                <div className={`bg-white rounded-xl border border-gray-200 border-l-4 shadow-sm ${
                  data.failedJobs.total === 0 ? "border-l-emerald-400" : "border-l-red-400"
                }`}>
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${
                        data.failedJobs.total === 0 ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600"
                      }`}>
                        <AlertCircle className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">Failed Jobs</div>
                        <div className="text-xs text-gray-400">Require manual review</div>
                      </div>
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      data.failedJobs.total === 0
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-red-100 text-red-700"
                    }`}>
                      {data.failedJobs.total} Failed
                    </span>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className={`rounded-lg p-4 border text-center ${
                        data.failedJobs.domains > 0 ? "bg-red-50/60 border-red-100" : "bg-gray-50 border-gray-100"
                      }`}>
                        <div className={`text-3xl font-bold ${data.failedJobs.domains > 0 ? "text-red-700" : "text-gray-700"}`}>
                          {data.failedJobs.domains}
                        </div>
                        <div className="text-xs font-medium text-gray-500 mt-1 flex items-center justify-center gap-1">
                          <Globe className="w-3 h-3" /> Domain Orders
                        </div>
                      </div>
                      <div className={`rounded-lg p-4 border text-center ${
                        data.failedJobs.hosting > 0 ? "bg-red-50/60 border-red-100" : "bg-gray-50 border-gray-100"
                      }`}>
                        <div className={`text-3xl font-bold ${data.failedJobs.hosting > 0 ? "text-red-700" : "text-gray-700"}`}>
                          {data.failedJobs.hosting}
                        </div>
                        <div className="text-xs font-medium text-gray-500 mt-1 flex items-center justify-center gap-1">
                          <Server className="w-3 h-3" /> Hosting Orders
                        </div>
                      </div>
                    </div>
                    {data.failedJobs.total === 0 ? (
                      <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-100">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        No failed jobs — everything looks good
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 border border-red-100">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          Failed jobs require manual review
                        </div>
                        <div className="flex gap-2">
                          {data.failedJobs.domains > 0 && (
                            <a
                              href="/admin/pending-domains"
                              className="flex-1 text-center text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg px-3 py-2 transition-colors"
                            >
                              Review {data.failedJobs.domains} Domain{data.failedJobs.domains > 1 ? 's' : ''} →
                            </a>
                          )}
                          {data.failedJobs.hosting > 0 && (
                            <a
                              href="/admin/hosting"
                              className="flex-1 text-center text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg px-3 py-2 transition-colors"
                            >
                              Review {data.failedJobs.hosting} Hosting{data.failedJobs.hosting > 1 ? ' Orders' : ' Order'} →
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
