'use client';

/**
 * Admin → Integration Health.
 *
 * Aggregated upstream-provider error feed. Each card is one provider
 * (DirectAdmin, Zoho Books, ResellerClub, Razorpay); within a card,
 * errors are clustered by pattern so a recurring failure shows as a
 * single row with a count + actionable hint, not N separate rows.
 *
 * Built 2026-06-22 after the senior reviewer's hosting-failure
 * investigation surfaced the DA license-cap that had been silently
 * blocking every hosting checkout — the kind of upstream-service event
 * that's now trivially visible from this one page instead of buried in
 * Cloud Run logs, MongoDB shells, and the per-order admin view.
 */

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, ShieldAlert, Activity } from 'lucide-react';
import Link from 'next/link';
import AdminLayout from '@/components/admin/AdminLayout';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { apiClient } from '@/lib/api-client';
import { formatIndianDateTime } from '@/lib/dateUtils';
import { safeLocalStorage } from '@/lib/storage';

interface AffectedOrder {
  orderId: string;
  userEmail?: string;
  userName?: string;
  amount: number;
  createdAt: string;
  domainName?: string;
  itemType?: string;
}

interface ErrorPattern {
  exemplarMessage: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  hint?: string;
  affectedOrders: AffectedOrder[];
}

interface ProviderHealth {
  id: string;
  label: string;
  totalErrors: number;
  patterns: ErrorPattern[];
}

interface HealthResponse {
  windowDays: number;
  generatedAt: string;
  providers: ProviderHealth[];
}

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  directadmin: 'Customer hosting account provisioning (create-user, suspend, delete).',
  zoho: 'Tax-compliant invoice generation post-payment.',
  resellerclub: 'Domain registration, transfer, and DNS management.',
  razorpay: 'Payment authorization, capture, and webhook handling.',
  email: 'Outbound SMTP — order confirmations, activation links, password resets.',
  whatsapp: 'WhatsApp Cloud API — reminders, payment confirmations, suspension notices + inbound STOP/delivery webhook.',
  auth: 'Sign-in, 2FA, JWT verification, rate-limit triggers.',
  background: 'Cron jobs and worker queues — Zoho retry, RC pricing sync, daily cleanup.',
  application: 'Other server-side errors — middleware, API routes, business logic.',
  unknown: 'Errors that did not match any known upstream-provider signature.',
};

export default function IntegrationHealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [currentUser, setCurrentUser] = useState<{ firstName: string; lastName: string; email: string; role: string } | null>(null);

  const fetchData = useCallback(async (days: number) => {
    setIsLoading(true);
    const result = await apiClient.get<HealthResponse>(`/api/v1/admin/integration-health?windowDays=${days}`);
    if (result.ok) {
      setData(result.data);
      // Auto-expand any provider with errors so the operator doesn't have
      // to click in — failure data wants to be in your face, not collapsed.
      const ids = new Set<string>();
      for (const p of result.data.providers) {
        if (p.totalErrors > 0) ids.add(p.id);
      }
      setExpanded(ids);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    // Pull the cached user from localStorage so AdminLayout has a name to
    // render in the sidebar. Same pattern other admin pages use.
    const raw = safeLocalStorage.getItem('user');
    if (raw) {
      try {
        const u = JSON.parse(raw);
        setCurrentUser({
          firstName: u.firstName || 'Admin',
          lastName: u.lastName || '',
          email: u.email || '',
          role: u.role || 'admin',
        });
      } catch { /* ignore */ }
    }
    void fetchData(windowDays);
  }, [fetchData, windowDays]);

  const totalAcrossProviders = data?.providers.reduce((s, p) => s + p.totalErrors, 0) || 0;
  const healthyCount = data?.providers.filter((p) => p.totalErrors === 0).length || 0;
  const failingCount = data?.providers.filter((p) => p.totalErrors > 0).length || 0;

  const WINDOW_OPTIONS = [
    { value: 1, label: '24 hours' },
    { value: 7, label: '7 days' },
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
  ];

  return (
    <AdminLayout user={currentUser || { firstName: 'Admin', lastName: '', email: '', role: 'admin' }} onLogout={() => { window.location.href = '/login'; }}>
      <div className="space-y-6">
        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-50 rounded-xl">
              <ShieldAlert className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Integration Health</h1>
              <p className="text-sm text-gray-500 mt-0.5 max-w-2xl">
                Aggregated error feed for every upstream service — DirectAdmin, Zoho, ResellerClub, Razorpay, Email, WhatsApp. Recurring failures cluster into one row with a count + remediation hint.
              </p>
            </div>
          </div>
          <RefreshButton onClick={() => void fetchData(windowDays)} isLoading={isLoading} />
        </div>

        {/* ── Summary stat cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
            <div className="p-2 bg-green-50 rounded-xl"><CheckCircle2 className="h-4 w-4 text-green-600" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-500">Healthy providers</p>
              <p className="text-xl font-bold text-gray-900">{data ? healthyCount : '—'}</p>
            </div>
          </div>
          <div className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 ${failingCount > 0 ? 'border-amber-300 ring-2 ring-amber-100' : 'border-gray-200'}`}>
            <div className="p-2 bg-amber-50 rounded-xl"><AlertTriangle className="h-4 w-4 text-amber-600" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-500">With failures</p>
              <p className="text-xl font-bold text-gray-900">{data ? failingCount : '—'}</p>
            </div>
          </div>
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl"><Activity className="h-4 w-4 text-blue-600" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-500">Total failures</p>
              <p className="text-xl font-bold text-gray-900">{data ? totalAcrossProviders : '—'}</p>
            </div>
          </div>
        </div>

        {/* ── Overall status banner + window filter ── */}
        {data && (
          <div className={`rounded-2xl border shadow-sm ${totalAcrossProviders > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
            <div className="p-4 flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                {totalAcrossProviders > 0 ? (
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
                )}
                <div>
                  <div className={`text-sm font-semibold ${totalAcrossProviders > 0 ? 'text-amber-900' : 'text-green-900'}`}>
                    {totalAcrossProviders > 0
                      ? `${totalAcrossProviders} upstream failure${totalAcrossProviders === 1 ? '' : 's'} in the last ${data.windowDays} day${data.windowDays === 1 ? '' : 's'}`
                      : `All upstream providers are healthy — no failures in the last ${data.windowDays} day${data.windowDays === 1 ? '' : 's'}`}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Snapshot generated {formatIndianDateTime(data.generatedAt)}.
                  </div>
                </div>
              </div>
              <div className="inline-flex bg-white/70 border border-white rounded-xl p-1 shrink-0">
                {WINDOW_OPTIONS.map((w) => (
                  <button
                    key={w.value}
                    onClick={() => setWindowDays(w.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${windowDays === w.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Provider cards */}
        {isLoading && !data && (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-10 flex flex-col items-center justify-center gap-3 text-sm text-gray-400">
            <RefreshCw className="h-6 w-6 animate-spin text-blue-600" />
            Loading integration health…
          </div>
        )}

        {data && data.providers.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-10 text-center text-sm text-gray-500">
            No upstream-provider errors recorded in the last {data.windowDays} day{data.windowDays === 1 ? '' : 's'}. Nothing to act on.
          </div>
        )}

        <div className="space-y-4">
        {data && data.providers.map((p) => {
          const isOpen = expanded.has(p.id);
          const hasErrors = p.totalErrors > 0;
          return (
            <div
              key={p.id}
              className={`bg-white border rounded-2xl shadow-sm overflow-hidden transition-shadow hover:shadow-md ${hasErrors ? 'border-amber-200' : 'border-gray-200'}`}
            >
              <button
                onClick={() => {
                  const next = new Set(expanded);
                  if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                  setExpanded(next);
                }}
                className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {isOpen ? <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" /> : <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />}
                  {hasErrors ? (
                    <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  )}
                  <div className="min-w-0 text-left">
                    <div className="font-semibold text-gray-900">{p.label}</div>
                    <div className="text-xs text-gray-500 truncate">{PROVIDER_DESCRIPTIONS[p.id] || ''}</div>
                  </div>
                </div>
                <div className={`text-sm font-semibold shrink-0 ${hasErrors ? 'text-amber-700' : 'text-green-700'}`}>
                  {p.totalErrors === 0 ? 'All clear' : `${p.totalErrors} failure${p.totalErrors === 1 ? '' : 's'}`}
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-gray-100 px-5 py-4 space-y-4">
                  {p.patterns.length === 0 ? (
                    <div className="text-sm text-gray-500 italic">No failures recorded for {p.label} in this window.</div>
                  ) : (
                    p.patterns.map((pattern, i) => (
                      <div key={i} className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50/40">
                        <div className="px-4 py-3 border-b border-gray-200 bg-white">
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                              {pattern.count} occurrence{pattern.count === 1 ? '' : 's'}
                            </div>
                            <div className="text-[11px] text-gray-500">
                              First: {formatIndianDateTime(pattern.firstSeen)} · Last: {formatIndianDateTime(pattern.lastSeen)}
                            </div>
                          </div>
                          <pre className="mt-2 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                            {pattern.exemplarMessage}
                          </pre>
                        </div>
                        {pattern.hint && (
                          <div className="px-4 py-3 bg-blue-50/50 border-b border-blue-100">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 mb-1">
                              Suggested action
                            </div>
                            <div className="text-xs text-blue-900">{pattern.hint}</div>
                          </div>
                        )}
                        <div className="px-4 py-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                            Affected orders ({pattern.affectedOrders.length}{pattern.count > pattern.affectedOrders.length ? ` of ${pattern.count}, capped at 20` : ''})
                          </div>
                          <div className="space-y-1">
                            {pattern.affectedOrders.map((o, j) => (
                              <div key={j} className="flex items-center justify-between gap-2 text-xs">
                                <Link
                                  href={`/admin/order-management?orderId=${encodeURIComponent(o.orderId)}`}
                                  className="font-mono text-blue-700 hover:underline inline-flex items-center gap-1"
                                >
                                  {o.orderId}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                                <div className="text-gray-600 truncate flex-1 mx-2">
                                  {o.userName || o.userEmail || '—'}
                                  {o.itemType === 'hosting' && o.domainName && (
                                    <span className="text-gray-400 ml-2">({o.domainName})</span>
                                  )}
                                </div>
                                <div className="text-gray-500 shrink-0">
                                  {formatIndianDateTime(o.createdAt)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
        </div>
      </div>
    </AdminLayout>
  );
}
