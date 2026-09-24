'use client';

/**
 * Admin → Integration Health.
 *
 * Aggregated upstream-provider error feed. Each card is one provider
 * (DirectAdmin, invoicing, ResellerClub, Razorpay); within a card,
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
import { performLogout } from '@/lib/logout';

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
  invoicing: 'GST tax-invoice generation after payment (our own engine).',
  resellerclub: 'Domain registration, transfer, and DNS management.',
  razorpay: 'Payment authorization, capture, and webhook handling.',
  email: 'Outbound SMTP — order confirmations, activation links, password resets.',
  whatsapp: 'WhatsApp Cloud API — reminders, payment confirmations, suspension notices + inbound STOP/delivery webhook.',
  auth: 'Sign-in, 2FA, JWT verification, rate-limit triggers.',
  background: 'Cron jobs and worker queues — renewal invoicing, RC pricing sync, daily cleanup.',
  application: 'Other server-side errors — middleware, API routes, business logic.',
  unknown: 'Errors that did not match any known upstream-provider signature.',
};

export default function IntegrationHealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(1);
  const [liveDown, setLiveDown] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Active live-reachability probe — distinct from the recorded-failure feed.
  // A provider can show "0 recorded failures" yet be currently unreachable
  // (no live traffic to log an error), so we surface the System Health probe
  // here too. Fire-and-forget so it never blocks the feed (a hung provider's
  // probe can take ~30s).
  const probeLive = useCallback(async () => {
    try {
      const sh = await apiClient.get<{ externalApis?: Record<string, { status?: string }> }>(
        '/api/v1/admin/system-health',
      );
      if (sh.ok && sh.data.externalApis) {
        const labels: Record<string, string> = {
          directAdmin: 'DirectAdmin', resellerClub: 'ResellerClub', razorpay: 'Razorpay',
        };
        setLiveDown(
          Object.entries(sh.data.externalApis)
            .filter(([, v]) => v?.status === 'down')
            .map(([k]) => labels[k] || k),
        );
      }
    } catch { /* ignore probe errors — the recorded-failure feed still renders */ }
  }, []);
  const [currentUser, setCurrentUser] = useState<{ firstName: string; lastName: string; email: string; role: string } | null>(null);

  const fetchData = useCallback(async (days: number) => {
    setIsLoading(true);
    void probeLive(); // fire-and-forget; updates the live banner when it resolves
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
  }, [probeLive]);

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
    <AdminLayout user={currentUser || { firstName: 'Admin', lastName: '', email: '', role: 'admin' }} onLogout={performLogout}>
      <div className="space-y-6">
        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-50 rounded-xl">
              <ShieldAlert className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ink">Integration Health</h1>
              <p className="text-sm text-ink-3 mt-0.5 max-w-2xl">
                Aggregated error feed for every upstream service — DirectAdmin, invoicing, ResellerClub, Razorpay, Email, WhatsApp. Recurring failures cluster into one row with a count + remediation hint.
              </p>
            </div>
          </div>
          <RefreshButton onClick={() => void fetchData(windowDays)} isLoading={isLoading} />
        </div>

        {/* ── Summary stat cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
            <div className="p-2 bg-green-50 rounded-xl"><CheckCircle2 className="h-4 w-4 text-green-600" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink-3">Healthy providers</p>
              <p className="text-xl font-bold text-ink">{data ? healthyCount : '—'}</p>
            </div>
          </div>
          <div className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 ${failingCount > 0 ? 'border-amber-300 ring-2 ring-amber-100' : 'border-hairline'}`}>
            <div className="p-2 bg-amber-50 rounded-xl"><AlertTriangle className="h-4 w-4 text-amber-600" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink-3">With failures</p>
              <p className="text-xl font-bold text-ink">{data ? failingCount : '—'}</p>
            </div>
          </div>
          <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
            <div className="p-2 bg-indigo-soft rounded-xl"><Activity className="h-4 w-4 text-indigo-ink" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink-3">Total failures</p>
              <p className="text-xl font-bold text-ink">{data ? totalAcrossProviders : '—'}</p>
            </div>
          </div>
        </div>

        {/* ── Live reachability banner (active probe — separate from the recorded-failure feed) ── */}
        {liveDown.length > 0 && (
          <div className="rounded-2xl border-2 border-red-300 bg-red-50 shadow-sm p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-bold text-red-900">
                Live reachability: {liveDown.join(', ')} {liveDown.length === 1 ? 'is' : 'are'} currently UNREACHABLE (probed just now).
              </div>
              <div className="text-xs text-red-800/90 mt-1">
                The feed below reports <strong>recorded operation failures</strong> — a provider with no live traffic can show &quot;all clear&quot; here yet be down. This live probe (same as Dashboard → System Health) is the source of truth for reachability.
              </div>
            </div>
          </div>
        )}

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
                      : `No recorded operation failures in the last ${data.windowDays} day${data.windowDays === 1 ? '' : 's'}`}
                  </div>
                  <div className="text-xs text-ink-3 mt-1">
                    Snapshot generated {formatIndianDateTime(data.generatedAt)}.
                  </div>
                </div>
              </div>
              <div className="inline-flex bg-paper/70 border border-paper rounded-xl p-1 shrink-0">
                {WINDOW_OPTIONS.map((w) => (
                  <button
                    key={w.value}
                    onClick={() => setWindowDays(w.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${windowDays === w.value ? 'bg-paper text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}
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
          <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-10 flex flex-col items-center justify-center gap-3 text-sm text-ink-4">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-ink" />
            Loading integration health…
          </div>
        )}

        {data && data.providers.length === 0 && (
          <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-10 text-center text-sm text-ink-3">
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
              className={`bg-paper border rounded-2xl shadow-sm overflow-hidden transition-shadow hover:shadow-md ${hasErrors ? 'border-amber-200' : 'border-hairline'}`}
            >
              <button
                onClick={() => {
                  const next = new Set(expanded);
                  if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                  setExpanded(next);
                }}
                className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-paper-2 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {isOpen ? <ChevronDown className="h-4 w-4 text-ink-4 shrink-0" /> : <ChevronRight className="h-4 w-4 text-ink-4 shrink-0" />}
                  {hasErrors ? (
                    <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  )}
                  <div className="min-w-0 text-left">
                    <div className="font-semibold text-ink">{p.label}</div>
                    <div className="text-xs text-ink-3 truncate">{PROVIDER_DESCRIPTIONS[p.id] || ''}</div>
                  </div>
                </div>
                <div className={`text-sm font-semibold shrink-0 ${hasErrors ? 'text-amber-700' : 'text-green-700'}`}>
                  {p.totalErrors === 0 ? 'All clear' : `${p.totalErrors} failure${p.totalErrors === 1 ? '' : 's'}`}
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-hairline px-5 py-4 space-y-4">
                  {p.patterns.length === 0 ? (
                    <div className="text-sm text-ink-3 italic">No failures recorded for {p.label} in this window.</div>
                  ) : (
                    p.patterns.map((pattern, i) => (
                      <div key={i} className="border border-hairline rounded-lg overflow-hidden bg-paper-2/40">
                        <div className="px-4 py-3 border-b border-hairline bg-paper">
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                              {pattern.count} occurrence{pattern.count === 1 ? '' : 's'}
                            </div>
                            <div className="text-[11px] text-ink-3">
                              First: {formatIndianDateTime(pattern.firstSeen)} · Last: {formatIndianDateTime(pattern.lastSeen)}
                            </div>
                          </div>
                          <pre className="mt-2 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                            {pattern.exemplarMessage}
                          </pre>
                        </div>
                        {pattern.hint && (
                          <div className="px-4 py-3 bg-indigo-soft/50 border-b border-indigo/25">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-ink mb-1">
                              Suggested action
                            </div>
                            <div className="text-xs text-indigo-ink">{pattern.hint}</div>
                          </div>
                        )}
                        <div className="px-4 py-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-2">
                            Affected orders ({pattern.affectedOrders.length}{pattern.count > pattern.affectedOrders.length ? ` of ${pattern.count}, capped at 20` : ''})
                          </div>
                          <div className="space-y-1">
                            {pattern.affectedOrders.map((o, j) => (
                              <div key={j} className="flex items-center justify-between gap-2 text-xs">
                                <Link
                                  href={`/admin/order-management?orderId=${encodeURIComponent(o.orderId)}`}
                                  className="font-mono text-amber-ink hover:underline inline-flex items-center gap-1"
                                >
                                  {o.orderId}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                                <div className="text-ink-2 truncate flex-1 mx-2">
                                  {o.userName || o.userEmail || '—'}
                                  {o.itemType === 'hosting' && o.domainName && (
                                    <span className="text-ink-4 ml-2">({o.domainName})</span>
                                  )}
                                </div>
                                <div className="text-ink-3 shrink-0">
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
