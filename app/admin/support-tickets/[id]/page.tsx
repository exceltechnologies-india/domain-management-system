"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "react-hot-toast";
import {
  ArrowLeft, Send, Loader2, User, ShieldCheck,
  Clock, CheckCircle2, XCircle, AlertCircle,
  Tag, Server, CreditCard, Wrench, HelpCircle,
  Mail, Hash, MessageSquare, Calendar,
  LifeBuoy, Flag, Activity,
} from "lucide-react";
import Link from "next/link";
import AdminLayoutNew from "@/components/admin/AdminLayoutNew";
import { AdminLayoutSkeleton, TicketDetailPageSkeleton } from "@/components/skeletons/PageSkeletons";
import { performLogout } from "@/lib/logout";
import { safeLocalStorage } from "@/lib/storage";
import { formatIndianDateTime } from "@/lib/dateUtils";
import AttachmentPicker, { PickedAttachment } from "@/components/support/AttachmentPicker";
import MessageAttachments from "@/components/support/MessageAttachments";

interface MessageAttachment {
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface Message {
  _id: string;
  content: string;
  authorRole: "user" | "admin";
  authorName: string;
  createdAt: string;
  attachments?: MessageAttachment[];
}

interface Ticket {
  _id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  userEmail: string;
  userName: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

const STATUS_OPTIONS = ["open", "in_progress", "resolved", "closed"] as const;
const PRIORITY_OPTIONS = ["low", "medium", "high"] as const;

const STATUS_CFG: Record<string, { label: string; activeClass: string; inactiveClass: string; icon: React.ElementType }> = {
  open:        { label: "Open",        icon: Clock,        activeClass: "bg-blue-600 text-white border-blue-600",    inactiveClass: "border-gray-200 text-gray-600 hover:border-blue-400 hover:text-blue-600" },
  in_progress: { label: "In Progress", icon: AlertCircle,  activeClass: "bg-amber-500 text-white border-amber-500",  inactiveClass: "border-gray-200 text-gray-600 hover:border-amber-400 hover:text-amber-600" },
  resolved:    { label: "Resolved",    icon: CheckCircle2, activeClass: "bg-green-600 text-white border-green-600",  inactiveClass: "border-gray-200 text-gray-600 hover:border-green-400 hover:text-green-600" },
  closed:      { label: "Closed",      icon: XCircle,      activeClass: "bg-gray-700 text-white border-gray-700",    inactiveClass: "border-gray-200 text-gray-600 hover:border-gray-400" },
};

const PRIORITY_CFG: Record<string, { label: string; activeClass: string; inactiveClass: string }> = {
  low:    { label: "Low",    activeClass: "bg-gray-600 text-white border-gray-600",    inactiveClass: "border-gray-200 text-gray-500 hover:border-gray-400" },
  medium: { label: "Medium", activeClass: "bg-amber-500 text-white border-amber-500",  inactiveClass: "border-gray-200 text-gray-600 hover:border-amber-400 hover:text-amber-600" },
  high:   { label: "High",   activeClass: "bg-red-600 text-white border-red-600",      inactiveClass: "border-gray-200 text-gray-600 hover:border-red-400 hover:text-red-600" },
};

const CATEGORY_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  domain:    { label: "Domain",    icon: Tag,        color: "text-violet-600 bg-violet-50" },
  hosting:   { label: "Hosting",   icon: Server,     color: "text-blue-600 bg-blue-50" },
  billing:   { label: "Billing",   icon: CreditCard, color: "text-emerald-600 bg-emerald-50" },
  technical: { label: "Technical", icon: Wrench,     color: "text-orange-600 bg-orange-50" },
  other:     { label: "Other",     icon: HelpCircle, color: "text-gray-500 bg-gray-100" },
};

function StatusHeaderBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? STATUS_CFG.open;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${cfg.activeClass}`}>
      <Icon className="h-3.5 w-3.5" />{cfg.label}
    </span>
  );
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(" ");
  const initials = parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return (
    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0">
      <span className="text-sm font-bold text-white uppercase">{initials}</span>
    </div>
  );
}

export default function AdminTicketDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [user, setUser] = useState<{ firstName: string; lastName: string; role: string } | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
        const res = await fetch("/api/auth/me", { method: "GET", headers, credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (data.user?.role === "admin") { setUser(data.user); setIsAuthLoading(false); }
          else { toast.error("Access denied"); router.push("/dashboard"); }
        } else if (session?.user && (session.user as any).role === "admin") {
          setUser(session.user as any); setIsAuthLoading(false);
        } else { router.push("/login"); }
      } catch { router.push("/login"); }
    };
    checkAuth();
  }, [status, router, getAuthToken, session?.user]);

  const fetchTicket = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/admin/support-tickets/${params.id}`, { headers, credentials: "include" });
      const data = await res.json();
      if (res.ok) setTicket(data.ticket);
      else toast.error(data.error ?? "Failed to load ticket");
    } catch { toast.error("Network error"); }
    finally { setLoading(false); }
  }, [params.id, getAuthToken]);

  useEffect(() => {
    if (!isAuthLoading && user) fetchTicket();
  }, [isAuthLoading, user, fetchTicket]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [ticket?.messages.length]);

  const authHeaders = (): HeadersInit => {
    const token = getAuthToken();
    const h: HeadersInit = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  };

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/admin/support-tickets/${params.id}`, {
        method: "POST", headers: authHeaders(), credentials: "include",
        body: JSON.stringify({ message: reply.trim(), attachments }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to send reply"); return; }
      setTicket(data.ticket);
      setReply("");
      setAttachments([]);
      toast.success("Reply sent to customer");
    } catch { toast.error("Network error"); }
    finally { setSending(false); }
  };

  const handleStatusChange = async (newStatus: string) => {
    if (ticket?.status === newStatus) return;
    setUpdatingStatus(true);
    try {
      const res = await fetch(`/api/admin/support-tickets/${params.id}`, {
        method: "PATCH", headers: authHeaders(), credentials: "include",
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (res.ok) { setTicket(data.ticket); toast.success(`Status → ${STATUS_CFG[newStatus]?.label}`); }
      else toast.error(data.error ?? "Failed to update status");
    } catch { toast.error("Network error"); }
    finally { setUpdatingStatus(false); }
  };

  const handlePriorityChange = async (newPriority: string) => {
    if (ticket?.priority === newPriority) return;
    try {
      const res = await fetch(`/api/admin/support-tickets/${params.id}`, {
        method: "PATCH", headers: authHeaders(), credentials: "include",
        body: JSON.stringify({ priority: newPriority }),
      });
      const data = await res.json();
      if (res.ok) { setTicket(data.ticket); toast.success(`Priority → ${PRIORITY_CFG[newPriority]?.label}`); }
      else toast.error(data.error ?? "Failed to update priority");
    } catch { toast.error("Network error"); }
  };

  if (isAuthLoading || loading) {
    return (
      <AdminLayoutSkeleton>
        <TicketDetailPageSkeleton />
      </AdminLayoutSkeleton>
    );
  }

  if (!ticket) {
    return (
      <AdminLayoutNew user={user} onLogout={performLogout}>
        <div className="p-6 text-center">
          <AlertCircle className="h-10 w-10 text-gray-300 mx-auto mb-2" />
          <p className="text-gray-500">Ticket not found.</p>
          <Link href="/admin/support-tickets" className="mt-3 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
            <ArrowLeft className="h-4 w-4" /> Back to tickets
          </Link>
        </div>
      </AdminLayoutNew>
    );
  }

  const isClosed = ticket.status === "closed";
  const catMeta = CATEGORY_META[ticket.category] ?? CATEGORY_META.other;
  const CatIcon = catMeta.icon;
  const lastUserMsg = [...ticket.messages].reverse().find(m => m.authorRole === "user");
  const awaitingReply = lastUserMsg && ticket.messages[ticket.messages.length - 1]?.authorRole === "user";

  return (
    <AdminLayoutNew user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* ── Back link ── */}
        <Link
          href="/admin/support-tickets"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to tickets
        </Link>

        {/* ── Header strip ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 sm:px-6 py-4 sm:py-5 flex items-start gap-4">
            <div className="p-2.5 bg-blue-50 rounded-xl shrink-0">
              <LifeBuoy className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-[11px] font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{ticket.ticketNumber}</span>
                <StatusHeaderBadge status={ticket.status} />
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border ${PRIORITY_CFG[ticket.priority]?.activeClass ?? ""}`}>
                  <Flag className="h-3 w-3" />
                  {ticket.priority} priority
                </span>
                {awaitingReply && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                    Awaiting your reply
                  </span>
                )}
              </div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 break-words">{ticket.subject}</h1>
              <p className="text-xs text-gray-500 mt-1">From {ticket.userName} · {ticket.userEmail}</p>
            </div>
          </div>

          {/* Vitals row */}
          <div className="border-t border-gray-100 bg-gray-50/60 px-5 sm:px-6 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="flex items-center gap-2 text-gray-700">
              <div className={`p-1.5 rounded-lg ${catMeta.color}`}>
                <CatIcon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Category</p>
                <p className="font-medium truncate">{catMeta.label}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <div className="p-1.5 rounded-lg bg-blue-50">
                <Calendar className="h-3.5 w-3.5 text-blue-600" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Opened</p>
                <p className="font-medium truncate">{formatIndianDateTime(ticket.createdAt)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <div className="p-1.5 rounded-lg bg-indigo-50">
                <MessageSquare className="h-3.5 w-3.5 text-indigo-600" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Messages</p>
                <p className="font-medium">{ticket.messages.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <div className={`p-1.5 rounded-lg ${ticket.resolvedAt ? "bg-green-50" : "bg-gray-100"}`}>
                <Activity className={`h-3.5 w-3.5 ${ticket.resolvedAt ? "text-green-600" : "text-gray-500"}`} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
                  {ticket.resolvedAt ? "Resolved" : "Last activity"}
                </p>
                <p className="font-medium truncate">
                  {formatIndianDateTime(ticket.resolvedAt || ticket.updatedAt)}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Thread — left 2/3 */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-gray-500" />
                  <h3 className="text-sm font-semibold text-gray-900">Conversation</h3>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
                  {ticket.messages.length} message{ticket.messages.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="p-5 space-y-5 min-h-[280px]">
              {ticket.messages.map((msg, i) => {
                const isAdmin = msg.authorRole === "admin";
                return (
                  <div key={msg._id ?? i} className={`flex gap-3 ${isAdmin ? "flex-row-reverse" : ""}`}>
                    <div className={`p-2 rounded-full shrink-0 self-end ${isAdmin ? "bg-blue-100" : "bg-gray-100"}`}>
                      {isAdmin
                        ? <ShieldCheck className="h-4 w-4 text-blue-600" />
                        : <User className="h-4 w-4 text-gray-500" />}
                    </div>
                    <div className={`max-w-[78%] flex flex-col gap-1 ${isAdmin ? "items-end" : "items-start"}`}>
                      <div className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed shadow-sm ${
                        isAdmin
                          ? "bg-blue-600 text-white rounded-tr-none"
                          : "bg-white border border-gray-200 text-gray-800 rounded-tl-none"
                      }`}>
                        {msg.content}
                      </div>
                      <MessageAttachments attachments={msg.attachments} align={isAdmin ? "right" : "left"} />
                      <span className="text-xs text-gray-400 px-1">
                        {msg.authorRole === "admin" ? msg.authorName : ticket.userName} · {formatIndianDateTime(msg.createdAt)}
                      </span>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
              </div>
            </div>

            {/* Reply box */}
            {isClosed ? (
              <div className="flex items-center gap-2 px-5 py-4 bg-gray-50 border border-dashed border-gray-300 rounded-2xl text-sm text-gray-400">
                <XCircle className="h-4 w-4 shrink-0" />
                Ticket is closed — change status to reopen it
              </div>
            ) : (
              <form onSubmit={handleReply} className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 text-blue-600" />
                  <span className="text-xs font-semibold text-blue-700">Reply as Support Team — customer will be notified by email</span>
                </div>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  maxLength={5000}
                  rows={4}
                  placeholder="Write your reply to the customer…"
                  className="w-full px-5 pt-4 pb-2 text-sm focus:outline-none resize-none text-gray-800 placeholder-gray-400"
                />
                <div className="px-5 pb-3">
                  <AttachmentPicker
                    attachments={attachments}
                    onChange={setAttachments}
                    disabled={sending}
                    label="Attach screenshots"
                  />
                </div>
                <div className="flex justify-between items-center px-5 py-3 border-t border-gray-100 bg-gray-50">
                  <span className="text-xs text-gray-400">{reply.length}/5000</span>
                  <button
                    type="submit"
                    disabled={sending || !reply.trim()}
                    className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold rounded-xl transition-colors"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {sending ? "Sending…" : "Send Reply"}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">

            {/* Customer */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Customer</h3>
              <div className="flex items-center gap-3 mb-3">
                <Initials name={ticket.userName || "U"} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{ticket.userName}</p>
                  <p className="text-xs text-gray-400 truncate">{ticket.userEmail}</p>
                </div>
              </div>
              <a href={`mailto:${ticket.userEmail}`} className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline">
                <Mail className="h-3.5 w-3.5" /> Send email directly
              </a>
            </div>

            {/* Status */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">
                Status {updatingStatus && <Loader2 className="inline h-3 w-3 animate-spin ml-1" />}
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {STATUS_OPTIONS.map((s) => {
                  const cfg = STATUS_CFG[s];
                  const Icon = cfg.icon;
                  const isActive = ticket.status === s;
                  return (
                    <button
                      key={s}
                      onClick={() => handleStatusChange(s)}
                      disabled={updatingStatus}
                      className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs font-semibold border transition-all ${
                        isActive ? cfg.activeClass : cfg.inactiveClass
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Priority */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Priority</h3>
              <div className="flex gap-1.5">
                {PRIORITY_OPTIONS.map((p) => {
                  const cfg = PRIORITY_CFG[p];
                  const isActive = ticket.priority === p;
                  return (
                    <button
                      key={p}
                      onClick={() => handlePriorityChange(p)}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
                        isActive ? cfg.activeClass : cfg.inactiveClass
                      }`}
                    >
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminLayoutNew>
  );
}
