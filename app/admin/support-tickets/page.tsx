"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "react-hot-toast";
import {
  MessageCircle, Clock, CheckCircle2, XCircle, AlertCircle,
  Search, ChevronRight, RefreshCw, Loader2, Inbox,
  Tag, Server, CreditCard, Wrench, HelpCircle,
} from "lucide-react";
import Link from "next/link";
import AdminLayout from "@/components/admin/AdminLayout";
import { AdminLayoutSkeleton, AdminSupportPageSkeleton } from "@/components/skeletons/PageSkeletons";
import { performLogout } from "@/lib/logout";
import { safeLocalStorage } from "@/lib/storage";
import { formatIndianDateTime } from "@/lib/dateUtils";

const STATUS_TABS = ["all", "open", "in_progress", "resolved", "closed"] as const;
type StatusTab = typeof STATUS_TABS[number];

interface Ticket {
  _id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  userEmail: string;
  userName: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: { authorRole: string };
}

const STATUS_CFG: Record<string, { label: string; cls: string; dot: string; icon: React.ElementType }> = {
  open:        { label: "Open",        cls: "bg-blue-50 text-blue-700 border-blue-200",    dot: "bg-blue-500",   icon: Clock },
  in_progress: { label: "In Progress", cls: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500",  icon: AlertCircle },
  resolved:    { label: "Resolved",    cls: "bg-green-50 text-green-700 border-green-200", dot: "bg-green-500",  icon: CheckCircle2 },
  closed:      { label: "Closed",      cls: "bg-gray-100 text-gray-500 border-gray-200",   dot: "bg-gray-400",   icon: XCircle },
};

const PRIORITY_CFG: Record<string, { dot: string; label: string; cls: string }> = {
  high:   { dot: "bg-red-500",   label: "High",   cls: "text-red-600 bg-red-50 border-red-200" },
  medium: { dot: "bg-amber-400", label: "Medium", cls: "text-amber-600 bg-amber-50 border-amber-200" },
  low:    { dot: "bg-gray-300",  label: "Low",    cls: "text-gray-500 bg-gray-50 border-gray-200" },
};

const CATEGORY_META: Record<string, { icon: React.ElementType; color: string }> = {
  domain:    { icon: Tag,        color: "text-violet-600 bg-violet-50" },
  hosting:   { icon: Server,     color: "text-blue-600 bg-blue-50" },
  billing:   { icon: CreditCard, color: "text-emerald-600 bg-emerald-50" },
  technical: { icon: Wrench,     color: "text-orange-600 bg-orange-50" },
  other:     { icon: HelpCircle, color: "text-gray-500 bg-gray-100" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_CFG[status] ?? STATUS_CFG.open;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${c.cls}`}>
      <Icon className="h-3 w-3" />{c.label}
    </span>
  );
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(" ");
  const initials = parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0">
      <span className="text-xs font-bold text-white uppercase">{initials}</span>
    </div>
  );
}

const TAB_LABELS: Record<StatusTab, string> = {
  all: "All", open: "Open", in_progress: "In Progress", resolved: "Resolved", closed: "Closed",
};

export default function AdminSupportTicketsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [user, setUser] = useState<{ firstName: string; lastName: string; role: string } | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<StatusTab>("open");
  const [search, setSearch] = useState("");

  const getAuthToken = useCallback(() => {
    const getCookieValue = (name: string) => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop()?.split(";").shift();
      return null;
    };
    return getCookieValue("token") || safeLocalStorage.getItem("token");
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    const checkAuth = async () => {
      try {
        const token = getAuthToken();
        const headers: HeadersInit = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/v1/auth/me", { method: "GET", headers, credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (data.user?.role === "admin") { setUser(data.user); setIsAuthLoading(false); }
          else { toast.error("Access denied"); setTimeout(() => router.push("/dashboard"), 2000); }
        } else if (session?.user && session.user.role === "admin") {
          const sUser = session.user;
          const [firstName = "", ...rest] = (sUser.name ?? "").split(" ");
          setUser({ firstName, lastName: rest.join(" "), role: sUser.role ?? "admin" });
          setIsAuthLoading(false);
        } else { router.push("/login"); }
      } catch { router.push("/login"); }
    };
    void checkAuth();
  }, [status, router, getAuthToken, session?.user]);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/v1/admin/support-tickets?status=${activeTab}`, { headers, credentials: "include" });
      const data = await res.json();
      if (res.ok) setTickets(data.tickets ?? []);
      else toast.error(data.error ?? "Failed to load tickets");
    } catch { toast.error("Network error"); }
    finally { setLoading(false); }
  }, [activeTab, getAuthToken]);

  useEffect(() => {
    if (!isAuthLoading && user) void fetchTickets();
  }, [isAuthLoading, user, fetchTickets]);

  if (isAuthLoading) {
    return (
      <AdminLayoutSkeleton>
        <AdminSupportPageSkeleton />
      </AdminLayoutSkeleton>
    );
  }

  const filtered = tickets.filter(
    (t) => !search ||
      t.subject.toLowerCase().includes(search.toLowerCase()) ||
      t.ticketNumber.toLowerCase().includes(search.toLowerCase()) ||
      t.userEmail.toLowerCase().includes(search.toLowerCase()) ||
      t.userName.toLowerCase().includes(search.toLowerCase())
  );

  const highCount = tickets.filter(t => t.priority === "high" && (t.status === "open" || t.status === "in_progress")).length;
  const userReplied = tickets.filter(t => t.lastMessage?.authorRole === "user" && (t.status === "open" || t.status === "in_progress")).length;

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
              <MessageCircle className="h-6 w-6 text-blue-600" />
              Support Tickets
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage customer support requests</p>
          </div>
          <button
            onClick={fetchTickets}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Alert strips */}
        {(highCount > 0 || userReplied > 0) && (
          <div className="flex flex-col sm:flex-row gap-2">
            {highCount > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800 font-medium">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                {highCount} high-priority ticket{highCount > 1 ? "s" : ""} need attention
              </div>
            )}
            {userReplied > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 font-medium">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                {userReplied} ticket{userReplied > 1 ? "s" : ""} awaiting your reply
              </div>
            )}
          </div>
        )}

        {/* Tabs + search */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === tab
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by ticket, name, email, subject…"
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Ticket cards */}
        {loading ? (
          <div className="flex items-center justify-center h-48 bg-white border border-gray-200 rounded-2xl">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 bg-white border border-gray-200 rounded-2xl text-gray-400">
            <Inbox className="h-10 w-10 mb-2 opacity-40" />
            <p className="text-sm font-medium">{search ? "No tickets match your search" : `No ${activeTab === "all" ? "" : TAB_LABELS[activeTab].toLowerCase() + " "}tickets`}</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  {["User", "Ticket", "Priority", "Status", "Updated", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider first:pl-5 last:pr-4">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((ticket) => {
                  const catMeta = CATEGORY_META[ticket.category] ?? CATEGORY_META.other;
                  const CatIcon = catMeta.icon;
                  const priCfg = PRIORITY_CFG[ticket.priority] ?? PRIORITY_CFG.low;
                  const awaitingReply = ticket.lastMessage?.authorRole === "user" && (ticket.status === "open" || ticket.status === "in_progress");

                  return (
                    <tr key={ticket._id} className="hover:bg-blue-50/40 transition-colors group cursor-pointer">
                      {/* User */}
                      <td className="px-4 py-3.5 pl-5">
                        <div className="flex items-center gap-2.5">
                          <Initials name={ticket.userName || "U"} />
                          <div>
                            <p className="text-xs font-semibold text-gray-900">{ticket.userName}</p>
                            <p className="text-xs text-gray-400">{ticket.userEmail}</p>
                          </div>
                        </div>
                      </td>
                      {/* Ticket */}
                      <td className="px-4 py-3.5 max-w-xs">
                        <div className="flex items-start gap-2">
                          <div className={`p-1.5 rounded-lg shrink-0 mt-0.5 ${catMeta.color}`}>
                            <CatIcon className="h-3 w-3" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="font-mono text-xs text-gray-400">{ticket.ticketNumber}</span>
                              {awaitingReply && (
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" title="Awaiting your reply" />
                              )}
                            </div>
                            <p className="truncate text-sm font-medium text-gray-800">{ticket.subject}</p>
                            <p className="text-xs text-gray-400">{ticket.messageCount} msg · {ticket.category}</p>
                          </div>
                        </div>
                      </td>
                      {/* Priority */}
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border ${priCfg.cls}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${priCfg.dot}`} />
                          {priCfg.label}
                        </span>
                      </td>
                      {/* Status */}
                      <td className="px-4 py-3.5">
                        <StatusBadge status={ticket.status} />
                      </td>
                      {/* Updated */}
                      <td className="px-4 py-3.5 text-xs text-gray-400 whitespace-nowrap">
                        {formatIndianDateTime(ticket.updatedAt)}
                      </td>
                      {/* Action */}
                      <td className="px-4 py-3.5 pr-4">
                        <Link
                          href={`/admin/support-tickets/${ticket._id}`}
                          className="flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-semibold opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          Open <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
