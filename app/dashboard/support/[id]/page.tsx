'use client';

import { useState, useRef, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Send, Loader2, User, ShieldCheck,
  Clock, CheckCircle2, XCircle, AlertCircle,
  Tag, Server, CreditCard, Wrench, HelpCircle, Lock,
  LifeBuoy, Flag, Activity, MessageSquare, Calendar,
} from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { confirmDialog } from '@/lib/confirm-dialog';
import { useUser } from '@/hooks/useUser';
import { performLogout } from '@/lib/logout';
import { formatIndianDateTime } from '@/lib/dateUtils';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, TicketDetailPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import AttachmentPicker, { PickedAttachment } from '@/components/support/AttachmentPicker';
import MessageAttachments from '@/components/support/MessageAttachments';

interface MessageAttachment {
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface Message {
  _id: string;
  content: string;
  authorRole: 'user' | 'admin';
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
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

const STATUS_CFG: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  open:        { label: 'Open',        cls: 'bg-blue-50 text-blue-700 border-blue-200',    icon: Clock },
  in_progress: { label: 'In Progress', cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: AlertCircle },
  resolved:    { label: 'Resolved',    cls: 'bg-green-50 text-green-700 border-green-200', icon: CheckCircle2 },
  closed:      { label: 'Closed',      cls: 'bg-gray-100 text-gray-500 border-gray-200',   icon: XCircle },
};

const CATEGORY_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  domain:    { label: 'Domain',    icon: Tag,        color: 'text-violet-600 bg-violet-50' },
  hosting:   { label: 'Hosting',   icon: Server,     color: 'text-blue-600 bg-blue-50' },
  billing:   { label: 'Billing',   icon: CreditCard, color: 'text-emerald-600 bg-emerald-50' },
  technical: { label: 'Technical', icon: Wrench,     color: 'text-orange-600 bg-orange-50' },
  other:     { label: 'Other',     icon: HelpCircle, color: 'text-gray-500 bg-gray-100' },
};

const PRIORITY_CLS: Record<string, string> = {
  high:   'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low:    'bg-gray-100 text-gray-500 border-gray-200',
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_CFG[status] ?? STATUS_CFG.open;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${c.cls}`}>
      <Icon className="h-3.5 w-3.5" />{c.label}
    </span>
  );
}

export default function SupportTicketDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, isLoading: isAuthLoading } = useUser();
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error, mutate } = useSWR<{ ticket: Ticket }>(
    user && params.id ? `/api/v1/user/support/${params.id}` : null,
    fetcher
  );

  const ticket = data?.ticket;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ticket?.messages.length]);

  const handleCloseTicket = async () => {
    const ok = await confirmDialog({
      title: 'Close this ticket?',
      message: "You won't be able to reply on this thread once it's closed — open a new ticket if you need further help.",
      confirmText: 'Close ticket',
      tone: 'warning',
    });
    if (!ok) return;
    setClosing(true);
    try {
      const res = await fetch(`/api/v1/user/support/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? 'Failed to close ticket'); return; }
      mutate();
      toast.success('Ticket closed');
    } catch { toast.error('Network error'); }
    finally { setClosing(false); }
  };

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/v1/user/support/${params.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: reply.trim(), attachments }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? 'Failed to send reply'); return; }
      setReply('');
      setAttachments([]);
      mutate();
      toast.success('Reply sent');
    } catch { toast.error('Network error'); }
    finally { setSending(false); }
  };

  if (isAuthLoading || isLoading) {
    return <DashboardLayoutSkeleton><TicketDetailPageSkeleton /></DashboardLayoutSkeleton>;
  }

  if (error || !ticket) {
    return (
      <ClientOnly>
        <UserLayout user={user} onLogout={performLogout}>
          <div className="max-w-2xl mx-auto px-4 py-16 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-gray-400" />
            </div>
            <p className="text-gray-700 font-semibold text-lg">Ticket not found</p>
            <p className="text-gray-400 text-sm mt-1 mb-5">This ticket doesn't exist or doesn't belong to your account</p>
            <Link href="/dashboard/support" className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline font-medium">
              <ArrowLeft className="h-4 w-4" /> Back to Support
            </Link>
          </div>
        </UserLayout>
      </ClientOnly>
    );
  }

  const isClosed = ticket.status === 'closed';
  const isResolved = ticket.status === 'resolved';
  const statusCfg = STATUS_CFG[ticket.status] ?? STATUS_CFG.open;
  const catMeta = CATEGORY_META[ticket.category] ?? CATEGORY_META.other;
  const CatIcon = catMeta.icon;

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout}>
        <div className="p-4 sm:p-6 lg:p-8 space-y-6">

          {/* ── Back link ── */}
          <Link
            href="/dashboard/support"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to support
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
                  <StatusBadge status={ticket.status} />
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border ${PRIORITY_CLS[ticket.priority] ?? ''}`}>
                    <Flag className="h-3 w-3" />
                    {ticket.priority} priority
                  </span>
                </div>
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900 break-words">{ticket.subject}</h1>
              </div>
              {!isClosed && (
                <button
                  onClick={handleCloseTicket}
                  disabled={closing}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 rounded-xl transition-colors disabled:opacity-60 disabled:cursor-wait"
                  title="Close this ticket"
                >
                  {closing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 text-gray-500" />
                  )}
                  {closing ? 'Closing…' : 'Close ticket'}
                </button>
              )}
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
                <div className={`p-1.5 rounded-lg ${ticket.resolvedAt ? 'bg-green-50' : 'bg-gray-100'}`}>
                  <Activity className={`h-3.5 w-3.5 ${ticket.resolvedAt ? 'text-green-600' : 'text-gray-500'}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
                    {ticket.resolvedAt ? 'Resolved' : 'Last activity'}
                  </p>
                  <p className="font-medium truncate">
                    {formatIndianDateTime(ticket.resolvedAt || ticket.updatedAt)}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Resolved notice */}
          {isResolved && (
            <div className="flex items-start gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
              <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
              <span>This ticket has been marked as resolved. Reply below to reopen it if you need further help.</span>
            </div>
          )}

          {/* Conversation */}
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-gray-500" />
                <h3 className="text-sm font-semibold text-gray-900">Conversation</h3>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
                {ticket.messages.length} message{ticket.messages.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="p-5 space-y-5 min-h-[280px]">
              {ticket.messages.length === 0 && (
                <p className="text-center text-gray-400 text-sm py-8">No messages yet</p>
              )}
              {ticket.messages.map((msg, i) => {
                const isAdmin = msg.authorRole === 'admin';
                return (
                  <motion.div
                    key={msg._id ?? i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className={`flex gap-3 ${isAdmin ? '' : 'flex-row-reverse'}`}
                  >
                    <div className={`p-2 rounded-full shrink-0 self-end ${isAdmin ? 'bg-blue-100' : 'bg-gray-100'}`}>
                      {isAdmin
                        ? <ShieldCheck className="h-4 w-4 text-blue-600" />
                        : <User className="h-4 w-4 text-gray-500" />}
                    </div>
                    <div className={`max-w-[78%] flex flex-col gap-1 ${isAdmin ? 'items-start' : 'items-end'}`}>
                      <div className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed shadow-sm ${
                        isAdmin
                          ? 'bg-white border border-gray-200 text-gray-800 rounded-tl-none'
                          : 'bg-blue-600 text-white rounded-tr-none'
                      }`}>
                        {msg.content}
                      </div>
                      <MessageAttachments attachments={msg.attachments} align={isAdmin ? 'left' : 'right'} />
                      <span className="text-xs text-gray-400 px-1">
                        {isAdmin ? 'Support Team' : 'You'} · {formatIndianDateTime(msg.createdAt)}
                      </span>
                    </div>
                  </motion.div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* Reply box / closed state */}
          {isClosed ? (
            <div className="flex items-center gap-3 px-5 py-4 bg-gray-50 border border-dashed border-gray-300 rounded-2xl text-sm text-gray-500">
              <Lock className="h-4 w-4 shrink-0 text-gray-400" />
              <span>This ticket is closed. <Link href="/dashboard/support" className="text-blue-600 hover:underline font-medium">Open a new ticket</Link> if you need further help.</span>
            </div>
          ) : (
            <form onSubmit={handleReply} className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={5000}
                rows={4}
                placeholder="Write your reply…"
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
                  {sending ? 'Sending…' : 'Send Reply'}
                </button>
              </div>
            </form>
          )}
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
