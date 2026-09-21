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
import { apiClient } from '@/lib/api-client';
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
  open:        { label: 'Open',        cls: 'bg-indigo-soft text-indigo-ink border-indigo/25',    icon: Clock },
  in_progress: { label: 'In Progress', cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: AlertCircle },
  resolved:    { label: 'Resolved',    cls: 'bg-green-50 text-green-700 border-green-200', icon: CheckCircle2 },
  closed:      { label: 'Closed',      cls: 'bg-paper-2 text-ink-3 border-hairline',   icon: XCircle },
};

const CATEGORY_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  domain:    { label: 'Domain',    icon: Tag,        color: 'text-violet-600 bg-violet-50' },
  hosting:   { label: 'Hosting',   icon: Server,     color: 'text-indigo-ink bg-indigo-soft' },
  billing:   { label: 'Billing',   icon: CreditCard, color: 'text-emerald-600 bg-emerald-50' },
  technical: { label: 'Technical', icon: Wrench,     color: 'text-orange-600 bg-orange-50' },
  other:     { label: 'Other',     icon: HelpCircle, color: 'text-ink-3 bg-paper-2' },
};

const PRIORITY_CLS: Record<string, string> = {
  high:   'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low:    'bg-paper-2 text-ink-3 border-hairline',
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
    const result = await apiClient.patch(`/api/v1/user/support/${params.id}`, { status: 'closed' });
    if (!result.ok) {
      toast.error(result.error.status === 0 ? 'Network error' : result.error.message || 'Failed to close ticket');
      setClosing(false);
      return;
    }
    void mutate();
    toast.success('Ticket closed');
    setClosing(false);
  };

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    const result = await apiClient.post(`/api/v1/user/support/${params.id}`, { message: reply.trim(), attachments });
    if (!result.ok) {
      toast.error(result.error.status === 0 ? 'Network error' : result.error.message || 'Failed to send reply');
      setSending(false);
      return;
    }
    setReply('');
    setAttachments([]);
    void mutate();
    toast.success('Reply sent');
    setSending(false);
  };

  if (isAuthLoading || isLoading) {
    return <DashboardLayoutSkeleton><TicketDetailPageSkeleton /></DashboardLayoutSkeleton>;
  }

  if (error || !ticket) {
    return (
      <ClientOnly>
        <UserLayout user={user} onLogout={performLogout}>
          <div className="max-w-2xl mx-auto px-4 py-16 text-center">
            <div className="w-16 h-16 bg-paper-2 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-ink-4" />
            </div>
            <p className="text-ink-2 font-semibold text-lg">Ticket not found</p>
            <p className="text-ink-4 text-sm mt-1 mb-5">This ticket doesn't exist or doesn't belong to your account</p>
            <Link href="/dashboard/support" className="inline-flex items-center gap-2 text-sm text-amber-ink hover:underline font-medium">
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
            className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to support
          </Link>

          {/* ── Header strip ── */}
          <div className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 sm:px-6 py-4 sm:py-5 flex items-start gap-4">
              <div className="p-2.5 bg-amber-soft rounded-xl shrink-0">
                <LifeBuoy className="h-5 w-5 text-amber" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-[11px] font-mono text-ink-3 bg-paper-2 px-2 py-0.5 rounded">{ticket.ticketNumber}</span>
                  <StatusBadge status={ticket.status} />
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border ${PRIORITY_CLS[ticket.priority] ?? ''}`}>
                    <Flag className="h-3 w-3" />
                    {ticket.priority} priority
                  </span>
                </div>
                <h1 className="text-xl sm:text-2xl font-bold text-ink break-words">{ticket.subject}</h1>
              </div>
              {!isClosed && (
                <button
                  onClick={handleCloseTicket}
                  disabled={closing}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-ink-2 bg-paper hover:bg-paper-2 border border-hairline hover:border-hairline-strong rounded-xl transition-colors disabled:opacity-60 disabled:cursor-wait"
                  title="Close this ticket"
                >
                  {closing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 text-ink-3" />
                  )}
                  {closing ? 'Closing…' : 'Close ticket'}
                </button>
              )}
            </div>

            {/* Vitals row */}
            <div className="border-t border-hairline bg-paper-2/60 px-5 sm:px-6 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="flex items-center gap-2 text-ink-2">
                <div className={`p-1.5 rounded-lg ${catMeta.color}`}>
                  <CatIcon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-ink-4 font-semibold">Category</p>
                  <p className="font-medium truncate">{catMeta.label}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-ink-2">
                <div className="p-1.5 rounded-lg bg-indigo-soft">
                  <Calendar className="h-3.5 w-3.5 text-indigo-ink" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-ink-4 font-semibold">Opened</p>
                  <p className="font-medium truncate">{formatIndianDateTime(ticket.createdAt)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-ink-2">
                <div className="p-1.5 rounded-lg bg-indigo-soft">
                  <MessageSquare className="h-3.5 w-3.5 text-indigo-ink" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-ink-4 font-semibold">Messages</p>
                  <p className="font-medium">{ticket.messages.length}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-ink-2">
                <div className={`p-1.5 rounded-lg ${ticket.resolvedAt ? 'bg-green-50' : 'bg-paper-2'}`}>
                  <Activity className={`h-3.5 w-3.5 ${ticket.resolvedAt ? 'text-green-600' : 'text-ink-3'}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-ink-4 font-semibold">
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
            <div className="flex items-start gap-3 px-4 py-3 bg-emerald-soft border border-emerald/25 rounded-xl text-sm text-emerald-ink">
              <CheckCircle2 className="h-4 w-4 text-emerald shrink-0 mt-0.5" />
              <span>This ticket has been marked as resolved. Reply below to reopen it if you need further help.</span>
            </div>
          )}

          {/* Conversation */}
          <div className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-hairline bg-paper-2/60 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-ink-3" />
                <h3 className="text-sm font-semibold text-ink">Conversation</h3>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 bg-paper border border-hairline px-2.5 py-1 rounded-full">
                {ticket.messages.length} message{ticket.messages.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="p-5 space-y-5 min-h-[280px]">
              {ticket.messages.length === 0 && (
                <p className="text-center text-ink-4 text-sm py-8">No messages yet</p>
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
                    <div className={`p-2 rounded-full shrink-0 self-end ${isAdmin ? 'bg-amber-soft' : 'bg-paper-2'}`}>
                      {isAdmin
                        ? <ShieldCheck className="h-4 w-4 text-amber" />
                        : <User className="h-4 w-4 text-ink-3" />}
                    </div>
                    <div className={`max-w-[78%] flex flex-col gap-1 ${isAdmin ? 'items-start' : 'items-end'}`}>
                      <div className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed shadow-sm ${
                        isAdmin
                          ? 'bg-paper border border-hairline text-ink rounded-tl-none'
                          : 'bg-amber text-white rounded-tr-none'
                      }`}>
                        {msg.content}
                      </div>
                      <MessageAttachments attachments={msg.attachments} align={isAdmin ? 'left' : 'right'} />
                      <span className="text-xs text-ink-4 px-1">
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
            <div className="flex items-center gap-3 px-5 py-4 bg-paper-2/60 border border-dashed border-hairline-strong rounded-2xl text-sm text-ink-3">
              <Lock className="h-4 w-4 shrink-0 text-ink-4" />
              <span>This ticket is closed. <Link href="/dashboard/support" className="text-amber-ink hover:underline font-medium">Open a new ticket</Link> if you need further help.</span>
            </div>
          ) : (
            <form onSubmit={handleReply} className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={5000}
                rows={4}
                placeholder="Write your reply…"
                className="w-full px-5 pt-4 pb-2 text-sm focus:outline-none resize-none text-ink placeholder-ink-4"
              />
              <div className="px-5 pb-3">
                <AttachmentPicker
                  attachments={attachments}
                  onChange={setAttachments}
                  disabled={sending}
                  label="Attach screenshots"
                />
              </div>
              <div className="flex justify-between items-center px-5 py-3 border-t border-hairline bg-paper-2/60">
                <span className="text-xs text-ink-4">{reply.length}/5000</span>
                <button
                  type="submit"
                  disabled={sending || !reply.trim()}
                  className="flex items-center gap-2 px-5 py-2 bg-amber hover:brightness-90 disabled:bg-amber/40 text-white text-sm font-semibold rounded-xl transition-colors"
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
