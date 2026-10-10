'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { signOut } from 'next-auth/react';
import toast from 'react-hot-toast';
import useSWR from 'swr';
import Link from 'next/link';
import {
  Globe, Clock, CheckCircle, ArrowRight, Plus, Server, FileText, HardDrive,
  Settings as SettingsIcon, Inbox, Search, MessageCircle,
} from 'lucide-react';
import { SectionLabel, Tile, AttentionCard, Panel, PanelLink, EmptyRow } from '@/components/dashboard/DashboardParts';
import { formatINR } from '@/lib/format-inr';
import type { BillsResponse } from '@/components/billing/ResellerOsBills';
import { safeLocalStorage, safeSessionStorage } from '@/lib/storage';
import { logger } from '@/lib/logger';
import { fetcher } from '@/lib/fetcher';
import { apiClient } from '@/lib/api-client';
import { useUser } from '@/hooks/useUser';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, DashboardHomeSkeleton } from '@/components/skeletons/PageSkeletons';
import { buyHref } from '@/lib/purchase/buy-dialog';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

// Dashboard payloads are loosely shaped server-side reductions of Order /
// Domain / Hosting docs. Each list carries fields specific to its UI
// presentation — `name`, `registeredDate`, `expiryDate` are display strings
// computed server-side rather than raw model fields.
interface RecentOrderSummary {
  _id?: string;
  orderId: string;
  status: string;
  amount?: number;
  createdAt: string;
  [k: string]: unknown;
}

interface RecentDomainSummary {
  _id?: string;
  domainName: string;
  status: string;
  name?: string;
  itemType?: 'domain' | 'hosting';
  expiryDate?: string;
  registeredDate?: string;
  [k: string]: unknown;
}

interface UpcomingRenewal {
  _id?: string;
  domain?: string;
  domainName?: string;
  type: 'Domain' | 'Hosting';
  expiryDate?: string;
  /** Days until it renews, from /api/user/dashboard. */
  daysLeft?: number;
  [k: string]: unknown;
}

interface ActiveHosting {
  _id?: string;
  domainName?: string;
  name?: string;
  status: string;
  expiryDate?: string;
  [k: string]: unknown;
}

interface DashboardStats {
  totalDomains: number;
  activeDomains: number;
  pendingDomains?: number;
  totalOrders: number;
  recentOrders: RecentOrderSummary[];
  recentDomains: RecentDomainSummary[];
  upcomingRenewals: UpcomingRenewal[];
  activeHostings?: ActiveHosting[];
}

interface ServiceStatus {
  hasDomains: boolean;
  hasHosting: boolean;
}


export default function UserDashboard() {
  const { user, isLoading: isAuthLoading } = useUser();
  const [isSyncing, setIsSyncing] = useState(false);
  const hasAutoSynced = useRef(false);

  const {
    data: dashboardData,
    isLoading: isLoadingDashboard,
    mutate: mutateDashboard,
  } = useSWR<{ stats: DashboardStats; serviceStatus: ServiceStatus }>(
    user ? '/api/v1/user/dashboard' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  // The same request the Invoices page makes (one SWR key, so it is shared): bills to pay and recent invoices.
  const { data: bills } = useSWR<BillsResponse>(user ? '/api/v1/user/billing' : null, fetcher, { revalidateOnFocus: false });

  const stats = dashboardData?.stats ?? null;

  // Clear any stale logout flags on mount (only once)
  useEffect(() => {
    // Clear the isLoggingOut flag when mounting the dashboard
    // This handles the case where a user cancels logout or navigates back
    safeSessionStorage.removeItem('isLoggingOut');
  }, []);

  // Define logout function inline to ensure it's always available
  // Memoized with empty deps to ensure stable reference across re-renders
  const handleLogout = useCallback(async () => {
    try {
      // Prevent multiple logout attempts
      // Check if we're already processing a logout to prevent loops
      const alreadyLoggingOut = safeSessionStorage.getItem('isLoggingOut');
      if (alreadyLoggingOut) {
        return;
      }

      // Set flag to prevent multiple logout attempts
      safeSessionStorage.setItem('isLoggingOut', 'true');

      try {
        await signOut({ redirect: false });
      } catch (err) {
        // Silent error handling
      }

      safeLocalStorage.removeItem('token');
      safeLocalStorage.removeItem('user');
      safeLocalStorage.removeItem('rememberMe');
      safeLocalStorage.removeItem('savedEmail');
      safeSessionStorage.clear();

      const cookiesToClear = [
        'token',
        'next-auth.session-token',
        'next-auth.callback-url',
        'next-auth.csrf-token',
        '__Secure-next-auth.session-token',
        '__Host-next-auth.csrf-token'
      ];

      cookiesToClear.forEach(name => {
        document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
        document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax; domain=${window.location.hostname}`;
      });

      toast.success('Logged out successfully');

      // Use replace() for hard redirect (prevents back button issues)
      window.location.replace('/login');
    } catch (error) {
      logger.error('Logout error:', error);
      safeSessionStorage.removeItem('isLoggingOut');
      // Force redirect even on error
      window.location.replace('/login');
    }
  }, []);

  // Auto-sync domains once if the user has none (fires after SWR delivers the first response)
  useEffect(() => {
    if (stats?.totalDomains === 0 && !isSyncing && !hasAutoSynced.current) {
      hasAutoSynced.current = true;
      setTimeout(() => handleSyncDomains(true), 1000);
    }
  // handleSyncDomains is defined below; the ref dependency is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats?.totalDomains]);

  const handleSyncDomains = async (silent: boolean = false) => {
    if (isSyncing) return;

    setIsSyncing(true);
    const loadingToast = silent ? null : toast.loading('Syncing your domains...');

    const result = await apiClient.post<{ success?: boolean; imported?: number; skipped?: number; message?: string; error?: string; code?: string }>('/api/v1/domains/sync', undefined);

    if (result.ok && result.data?.success) {
      const data = result.data;
      if (!silent && loadingToast) {
        toast.success(
          `Successfully imported ${data.imported} domain(s)! ${(data.skipped ?? 0) > 0 ? `Skipped ${data.skipped} existing domain(s).` : ''}`,
          { id: loadingToast }
        );
      } else if (silent && (data.imported ?? 0) > 0) {
        // Show success for auto-sync only if domains were actually imported
        toast.success(`Automatically imported ${data.imported} domain(s)!`);
      }
      // Reload dashboard data to show newly synced domains
      await mutateDashboard();
    } else if (!result.ok && result.error.status === 0) {
      // Network error
      if (!silent && loadingToast) {
        toast.error('Network error. Please check your connection.', { id: loadingToast });
      }
    } else {
      // 200-with-success:false OR an HTTP error carrying a body — same handling
      const body = (result.ok ? result.data : (result.error.body as { message?: string; error?: string; code?: string } | undefined)) || {};
      const errorMessage = body.message || body.error || 'Failed to sync domains';
      const errorCode = body.code;

      // Check if user doesn't have a domain provider account (expected for new users)
      if (errorCode === 'NO_LINKED_ACCOUNT' ||
          errorMessage.includes('No ResellerClub customer') ||
          errorMessage.includes('not linked to a ResellerClub')) {
        if (!silent && loadingToast) {
          toast.error('No domains found. Register your first domain to get started.', { id: loadingToast });
        }
      } else if (!silent && loadingToast) {
        toast.error(errorMessage, { id: loadingToast });
      }
    }

    setIsSyncing(false);
    if (loadingToast) {
      toast.dismiss(loadingToast);
    }
  };

  if (!user || isAuthLoading) {
    return <DashboardLayoutSkeleton><DashboardHomeSkeleton /></DashboardLayoutSkeleton>;
  }

  // ── The ResellerOS dashboard pattern (Pawan, 10 Oct 2026). As there, each attention card keeps its
  // colour by slot: accent (orange in the portal theme) for renewals, indigo for bills, green for services.
  const now = new Date();
  const eyebrow = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const hour = Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const domainsCount = stats?.activeDomains ?? 0;
  const hostings = stats?.activeHostings ?? [];
  const renewals = stats?.upcomingRenewals ?? [];
  const pendingDomains = stats?.pendingDomains ?? 0;
  const services = stats?.recentDomains ?? [];
  const settingUp = services.filter((s) => s.status === 'pending' || s.status === 'processing').length;
  const billsOk = bills?.state === 'ok' ? bills : null;
  const toPay = billsOk ? billsOk.quotes.filter((q) => q.status === 'pending') : [];
  const toPayTotal = toPay.reduce((n, q) => n + q.amount, 0);
  const recentInvoices = billsOk ? billsOk.invoices.slice(0, 4) : [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const soonest = renewals[0];

  return (
    <UserLayout user={user} onLogout={handleLogout}>
      <div className="mx-auto max-w-[1240px] space-y-6 p-4 sm:p-6 lg:p-8">
        {/* ── Greeting ── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{eyebrow}</p>
            <h1 className="mt-1 font-serif text-3xl font-semibold text-ink">
              {greeting}{user?.firstName ? `, ${user.firstName}` : ''}.
            </h1>
            <p className="mt-1 text-sm text-ink-2">
              {plural(domainsCount, 'domain')} · {plural(hostings.length, 'hosting account')} ·{' '}
              {renewals.length > 0 ? `${plural(renewals.length, 'renewal')} in 30 days` : 'nothing to renew this month'}
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 min-[400px]:w-auto min-[400px]:flex-row sm:flex-none">
            <Link href={buyHref('domain')} className="inline-flex min-h-[40px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-hairline bg-paper px-3 text-sm font-medium text-ink-2 hover:bg-paper-2">
              <Search className="h-4 w-4" aria-hidden /> Register domain
            </Link>
            <Link href={buyHref('hosting')} className="inline-flex min-h-[40px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-amber px-3 text-sm font-semibold text-paper hover:brightness-95">
              <Plus className="h-4 w-4" aria-hidden /> Buy hosting
            </Link>
          </div>
        </div>

        {isLoadingDashboard ? (
          <DashboardHomeSkeleton />
        ) : (
          <>
            {/* ── Numbers ── */}
            <div className="space-y-3">
              <SectionLabel>Your services</SectionLabel>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile label="Domains" value={domainsCount} href="/dashboard/domains" note={pendingDomains > 0 ? `${pendingDomains} being registered` : 'Active'} />
                <Tile label="Hosting" value={hostings.length} href="/dashboard/hosting" note="Active accounts" />
                <Tile label="Renewals · 30 days" value={renewals.length} href="/dashboard/domains" note={soonest ? `Next: ${soonest.expiryDate}` : 'None due'} />
                <Tile
                  label="Bills to pay"
                  value={billsOk ? toPay.length : '—'}
                  href="/dashboard/invoices"
                  note={billsOk ? (toPay.length > 0 ? `${formatINR(toPayTotal)} in total` : 'All paid') : bills?.state === 'no_bills' ? 'No bills yet' : 'Couldn’t load bills'}
                />
              </div>
            </div>

            {/* ── What needs attention ── */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {renewals.length > 0 ? (
                <AttentionCard
                  tone="blue"
                  tag="Attention needed"
                  title={`${plural(renewals.length, 'service')} renew in the next 30 days`}
                  text="Pay the renewal bill before the date so nothing stops working."
                  icon={<Clock className="h-5 w-5" />}
                  footer={soonest ? `${soonest.domain} · ${soonest.expiryDate}` : ''}
                  action={{ label: 'Renewal bills', href: '/dashboard/invoices' }}
                />
              ) : (
                <AttentionCard
                  tone="blue"
                  tag="Renewals"
                  title="Nothing to renew this month"
                  text="We email you, and the bill appears here, before anything is due."
                  icon={<CheckCircle className="h-5 w-5" />}
                  footer="Next 30 days"
                  action={{ label: 'View domains', href: '/dashboard/domains' }}
                />
              )}
              {billsOk && toPay.length > 0 ? (
                <AttentionCard
                  tone="indigo"
                  tag="Awaiting payment"
                  title={`${plural(toPay.length, 'bill')} to pay`}
                  text={`${formatINR(toPayTotal)} in total, GST included.`}
                  icon={<FileText className="h-5 w-5" />}
                  footer="Invoices"
                  action={{ label: 'Pay now', href: '/dashboard/invoices' }}
                />
              ) : (
                <AttentionCard
                  tone="indigo"
                  tag="Bills"
                  title={billsOk ? 'All bills paid' : bills?.state === 'no_bills' ? 'No bills yet' : 'Bills couldn’t be loaded'}
                  text={billsOk || bills?.state === 'no_bills' ? 'Every bill and GST invoice is kept on the Invoices page and emailed to you.' : 'This does not mean you have none — they are also in your email. Try again in a minute.'}
                  icon={<FileText className="h-5 w-5" />}
                  footer="Invoices"
                  action={{ label: 'Open invoices', href: '/dashboard/invoices' }}
                />
              )}
              <AttentionCard
                tone="emerald"
                tag={settingUp > 0 ? 'Being set up' : 'Services'}
                title={settingUp > 0 ? `${plural(settingUp, 'service')} being set up` : hostings.length + domainsCount > 0 ? 'Everything is live' : 'No services yet'}
                text={
                  settingUp > 0
                    ? 'This usually takes a few minutes. It appears here when it is ready.'
                    : hostings.length + domainsCount > 0
                      ? 'Manage DNS, email and your hosting control panel from here.'
                      : 'Register a domain or buy hosting to get started.'
                }
                icon={<Server className="h-5 w-5" />}
                footer="Hosting"
                action={hostings.length + domainsCount > 0 ? { label: 'Manage hosting', href: '/dashboard/hosting' } : { label: 'Buy hosting', href: buyHref('hosting') }}
              />
            </div>

            {/* ── Lists ── */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                <Panel title="Your services" subtitle="Domains and hosting, newest first" action={<PanelLink href="/dashboard/domains">All</PanelLink>}>
                  {services.length > 0 ? (
                    <ul className="divide-y divide-hairline">
                      {services.slice(0, 6).map((service, index) => {
                        const isHost = service.itemType === 'hosting';
                        const status = service.status;
                        const live = status === 'active' || status === 'registered' || status === 'provisioned';
                        const pill = live
                          ? 'bg-emerald-soft text-emerald-ink border-emerald/30'
                          : status === 'pending' || status === 'processing'
                            ? 'bg-amber-soft text-amber-ink border-amber/30'
                            : 'bg-paper-2 text-ink-3 border-hairline';
                        return (
                          <li key={index} className="flex items-center justify-between gap-3 px-4 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-paper-2 text-ink-3" aria-hidden>
                                {isHost ? <HardDrive className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
                              </span>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-ink">{service.name}</p>
                                <p className="text-xs text-ink-3">
                                  {isHost ? 'Hosting' : 'Domain'}
                                  {service.expiryDate && service.expiryDate !== 'N/A' ? ` · renews ${service.expiryDate}` : ''}
                                </p>
                              </div>
                            </div>
                            <span className={`flex-none rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${pill}`}>{status}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="px-4 py-10 text-center">
                      <Inbox className="mx-auto h-6 w-6 text-ink-4" aria-hidden />
                      <p className="mt-2 text-sm font-medium text-ink">No services yet</p>
                      <p className="mt-1 text-sm text-ink-3">Register a domain or buy hosting — it appears here once it is set up.</p>
                      <div className="mt-4 flex justify-center gap-2">
                        <Link href={buyHref('domain')} className="inline-flex min-h-[40px] items-center rounded-lg border border-hairline px-3 text-sm font-medium text-ink-2 hover:bg-paper-2">Register domain</Link>
                        <Link href={buyHref('hosting')} className="inline-flex min-h-[40px] items-center rounded-lg bg-amber px-3 text-sm font-semibold text-paper hover:brightness-95">Buy hosting</Link>
                      </div>
                    </div>
                  )}
                </Panel>

                <Panel title="Recent invoices" subtitle="GST invoices from your orders" action={<PanelLink href="/dashboard/invoices">Invoices</PanelLink>}>
                  {recentInvoices.length > 0 ? (
                    <ul className="divide-y divide-hairline">
                      {recentInvoices.map((inv) => (
                        <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-3">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-sm text-ink">{inv.number}</p>
                            <p className="text-xs text-ink-3">{inv.issueDate ? new Date(inv.issueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</p>
                          </div>
                          <div className="flex flex-none items-center gap-3">
                            <span className="text-sm font-medium text-ink tabular-nums">{formatINR(inv.amount)}</span>
                            <span className="rounded-full border border-hairline bg-paper-2 px-2 py-0.5 text-[11px] font-medium capitalize text-ink-2">{inv.status}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyRow>
                      {bills && bills.state === 'unavailable' ? 'We couldn’t load your invoices just now. They are also in your email.' : 'Invoices appear here after your first order.'}
                    </EmptyRow>
                  )}
                </Panel>
              </div>

              <div className="space-y-4">
                <Panel title="Renewals coming up" subtitle="Next 30 days">
                  {renewals.length > 0 ? (
                    <ul className="divide-y divide-hairline">
                      {renewals.map((r, idx) => (
                        <li key={idx} className="flex items-center justify-between gap-3 px-4 py-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-ink">{r.domain}</p>
                            <p className="text-xs text-ink-3">{r.type} · {r.expiryDate}</p>
                          </div>
                          {typeof r.daysLeft === 'number' && (
                            <span className={`flex-none text-xs font-medium ${r.daysLeft <= 7 ? 'text-rose-ink' : 'text-ink-2'}`}>
                              {r.daysLeft} day{r.daysLeft === 1 ? '' : 's'}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyRow>Nothing renews in the next 30 days.</EmptyRow>
                  )}
                </Panel>

                <Panel title="Quick links">
                  <ul className="divide-y divide-hairline">
                    {[
                      { href: buyHref('hosting'), icon: Server, label: 'Buy hosting', note: 'First year of a domain free with yearly hosting' },
                      { href: buyHref('domain'), icon: Search, label: 'Register a domain', note: '1, 2, 3 or 5 years' },
                      { href: '/dashboard/support', icon: MessageCircle, label: 'Support', note: 'Raise a ticket' },
                      { href: '/dashboard/settings', icon: SettingsIcon, label: 'Account settings', note: 'Profile, password, GSTIN' },
                    ].map(({ href, icon: Icon, label, note }) => (
                      <li key={label}>
                        <Link href={href} className="flex min-h-[44px] items-center gap-3 px-4 py-2.5 hover:bg-paper-2">
                          <Icon className="h-4 w-4 flex-none text-ink-3" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-ink">{label}</span>
                            <span className="block truncate text-xs text-ink-3">{note}</span>
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 flex-none text-ink-4" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              </div>
            </div>
          </>
        )}
      </div>
    </UserLayout>
  );
}
