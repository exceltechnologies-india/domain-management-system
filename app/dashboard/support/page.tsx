'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageCircle, Plus, Clock, CheckCircle2, XCircle, AlertCircle,
  ChevronRight, Loader2, Tag, Server, CreditCard, Wrench, HelpCircle,
  Inbox, ArrowRight, X,
} from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { apiClient } from '@/lib/api-client';
import { useUser } from '@/hooks/useUser';
import { performLogout } from '@/lib/logout';
import { formatIndianDateTime } from '@/lib/dateUtils';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, SupportPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import AttachmentPicker, { PickedAttachment } from '@/components/support/AttachmentPicker';

const CATEGORIES = ['domain', 'hosting', 'billing', 'technical', 'other'] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType; color: string }> = {
  domain:    { label: 'Domain',    icon: Tag,         color: 'text-violet-600 bg-violet-50' },
  hosting:   { label: 'Hosting',   icon: Server,      color: 'text-indigo-ink bg-indigo-soft' },
  billing:   { label: 'Billing',   icon: CreditCard,  color: 'text-emerald-600 bg-emerald-50' },
  technical: { label: 'Technical', icon: Wrench,      color: 'text-orange-600 bg-orange-50' },
  other:     { label: 'Other',     icon: HelpCircle,  color: 'text-ink-2 bg-paper-2' },
};

const PRIORITY_BAR: Record<string, string> = {
  high:   'bg-red-500',
  medium: 'bg-amber-400',
  low:    'bg-hairline-strong',
};

interface Ticket {
  _id: string;
  ticketNumber: string;
  subject: string;
  category: Category;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: { authorRole: string; createdAt: string };
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
    open:        { label: 'Open',        cls: 'bg-indigo-soft text-indigo-ink border-indigo/25',     icon: Clock },
    in_progress: { label: 'In Progress', cls: 'bg-amber-50 text-amber-700 border-amber-200',  icon: AlertCircle },
    resolved:    { label: 'Resolved',    cls: 'bg-green-50 text-green-700 border-green-200',  icon: CheckCircle2 },
    closed:      { label: 'Closed',      cls: 'bg-paper-2 text-ink-3 border-hairline',    icon: XCircle },
  };
  const c = cfg[status] ?? cfg.open;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${c.cls}`}>
      <Icon className="h-3 w-3" />{c.label}
    </span>
  );
}

function NewTicketForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<Category>('other');
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) { toast.error('Subject and message are required'); return; }
    setSaving(true);
    const result = await apiClient.post<{ ticket: { ticketNumber: string } }>('/api/v1/user/support', {
      subject: subject.trim(),
      category,
      message: message.trim(),
      attachments,
    });
    if (!result.ok) {
      toast.error(result.error.status === 0 ? 'Network error' : result.error.message || 'Failed to create ticket');
      setSaving(false);
      return;
    }
    toast.success(`Ticket ${result.data.ticket.ticketNumber} created!`);
    onCreated();
    setSaving(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="bg-paper border border-indigo/25 rounded-2xl shadow-sm overflow-hidden"
    >
      <div className="flex items-center justify-between px-6 py-4 bg-indigo-soft border-b border-indigo/25">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-amber rounded-lg">
            <Plus className="h-4 w-4 text-white" />
          </div>
          <h2 className="font-semibold text-ink">New Support Ticket</h2>
        </div>
        <button onClick={onCancel} className="p-1.5 text-ink-4 hover:text-ink-2 hover:bg-paper rounded-lg transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={submit} className="p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2 space-y-1.5">
            <label className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              placeholder="Brief description of your issue"
              className="w-full border border-hairline rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber focus:border-transparent transition-shadow"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Category</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CATEGORIES.map((c) => {
                const meta = CATEGORY_META[c];
                const Icon = meta.icon;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                      category === c
                        ? 'border-amber bg-amber-soft text-amber-ink shadow-sm'
                        : 'border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Message</label>
            <span className="text-xs text-ink-4">{message.length}/5000</span>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={5000}
            rows={5}
            placeholder="Describe your issue in detail — include any error messages, order numbers, or domain names involved…"
            className="w-full border border-hairline rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber focus:border-transparent resize-none transition-shadow"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Screenshots (optional)</label>
          <AttachmentPicker
            attachments={attachments}
            onChange={setAttachments}
            disabled={saving}
            label="Attach screenshots"
          />
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2.5 text-sm font-medium text-ink-2 bg-paper-2 hover:bg-hairline rounded-xl transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !subject.trim() || !message.trim()}
            className="flex items-center gap-2 px-6 py-2.5 bg-amber hover:brightness-90 disabled:bg-amber/40 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {saving ? 'Submitting…' : 'Submit Ticket'}
          </button>
        </div>
      </form>
    </motion.div>
  );
}

export default function SupportPage() {
  const { user, isLoading: isAuthLoading } = useUser();
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading, mutate } = useSWR<{ tickets: Ticket[] }>(
    user ? '/api/v1/user/support' : null,
    fetcher
  );

  if (isAuthLoading || isLoading) {
    return <DashboardLayoutSkeleton><SupportPageSkeleton /></DashboardLayoutSkeleton>;
  }

  const tickets = data?.tickets ?? [];
  const openCount = tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length;
  const resolvedCount = tickets.filter(t => t.status === 'resolved' || t.status === 'closed').length;
  const awaitingReply = tickets.filter(t => t.lastMessage?.authorRole === 'admin' && (t.status === 'open' || t.status === 'in_progress')).length;

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout}>
        <div className="space-y-6 p-6">

          {/* Header */}
          <div className="bg-ink rounded-2xl p-6 text-white shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-paper/20 rounded-xl backdrop-blur-sm">
                  <MessageCircle className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h1 className="text-xl font-bold">Support</h1>
                  <p className="text-paper-2/80 text-sm">We typically reply within 24 hours</p>
                </div>
              </div>
              <button
                onClick={() => setShowForm((v) => !v)}
                className="flex items-center gap-2 px-4 py-2 bg-paper text-amber-ink text-sm font-bold rounded-xl hover:bg-amber-soft transition-colors shadow-sm"
              >
                <Plus className="h-4 w-4" />
                New Ticket
              </button>
            </div>

            {tickets.length > 0 && (
              <div className="mt-5 grid grid-cols-3 gap-3">
                {[
                  { label: 'Active', value: openCount, color: 'bg-paper/20' },
                  { label: 'Awaiting Reply', value: awaitingReply, color: 'bg-amber-400/30' },
                  { label: 'Resolved', value: resolvedCount, color: 'bg-green-400/20' },
                ].map(({ label, value, color }) => (
                  <div key={label} className={`${color} rounded-xl px-3 py-2.5 text-center backdrop-blur-sm`}>
                    <p className="text-2xl font-bold text-white">{value}</p>
                    <p className="text-xs text-paper-2/80 mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* New ticket form */}
          <AnimatePresence>
            {showForm && (
              <NewTicketForm
                onCreated={() => { setShowForm(false); void mutate(); }}
                onCancel={() => setShowForm(false)}
              />
            )}
          </AnimatePresence>

          {/* Ticket list */}
          {tickets.length === 0 ? (
            <div className="bg-paper border border-hairline rounded-2xl p-14 text-center shadow-sm">
              <div className="w-16 h-16 bg-amber-soft rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Inbox className="h-8 w-8 text-amber" />
              </div>
              <p className="text-ink font-semibold text-lg">No tickets yet</p>
              <p className="text-sm text-ink-4 mt-1 mb-5">Submit a ticket and our team will get back to you</p>
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber hover:brightness-90 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                <Plus className="h-4 w-4" /> Create First Ticket
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {tickets.map((ticket, i) => {
                const catMeta = CATEGORY_META[ticket.category] ?? CATEGORY_META.other;
                const CatIcon = catMeta.icon;
                const hasAdminReply = ticket.lastMessage?.authorRole === 'admin';
                const isActive = ticket.status === 'open' || ticket.status === 'in_progress';

                return (
                  <motion.div
                    key={ticket._id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                  >
                    <Link
                      href={`/dashboard/support/${ticket._id}`}
                      className="flex items-stretch gap-0 bg-paper border border-hairline rounded-2xl hover:border-amber/40 hover:shadow-md transition-all group overflow-hidden"
                    >
                      {/* Priority bar */}
                      <div className={`w-1 shrink-0 ${PRIORITY_BAR[ticket.priority] ?? 'bg-hairline'}`} />

                      <div className="flex-1 flex items-center gap-4 px-5 py-4">
                        {/* Category icon */}
                        <div className={`p-2.5 rounded-xl shrink-0 ${catMeta.color}`}>
                          <CatIcon className="h-4 w-4" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-xs font-mono text-ink-4">{ticket.ticketNumber}</span>
                            <StatusBadge status={ticket.status} />
                            {hasAdminReply && isActive && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                Reply waiting
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-semibold text-ink truncate">{ticket.subject}</p>
                          <p className="text-xs text-ink-4 mt-0.5">
                            {ticket.messageCount} message{ticket.messageCount !== 1 ? 's' : ''} · Updated {formatIndianDateTime(ticket.updatedAt)}
                          </p>
                        </div>

                        <ChevronRight className="h-4 w-4 text-ink-4 group-hover:text-amber group-hover:translate-x-0.5 transition-all shrink-0" />
                      </div>
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
