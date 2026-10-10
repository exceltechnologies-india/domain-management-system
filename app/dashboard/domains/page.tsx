'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { performLogout } from '@/lib/logout';
import {
  Globe, Search, Plus, RefreshCw, Shield, Clock, Loader2, CheckCircle, AlertTriangle,
  Network, ArrowRightLeft, Inbox,
} from 'lucide-react';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { useUser } from '@/hooks/useUser';
import { formatIndianDateTime, isWithinRenewalWindow } from '@/lib/dateUtils';
import UserLayout from '@/components/user/UserLayout';
import { PageHeader } from '@/components/dashboard/DashboardParts';
import { DashboardLayoutSkeleton, DomainsPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import RefreshButton from '@/components/dashboard/RefreshButton';
import RenewViaResellerOs from '@/components/billing/RenewViaResellerOs';
import ExpiryBadge from '@/components/dashboard/ExpiryBadge';
import { buyHref } from '@/lib/purchase/buy-dialog';

interface Domain {
  id: string;
  name: string;
  status: 'active' | 'expired' | 'pending' | 'processing' | 'failed' | 'suspended' | 'registered';
  registrationDate: string;
  expiryDate: string;
  registrar: string;
  nameservers: string[];
  autoRenew: boolean;
  bookingStatus?: {
    step: string;
    message: string;
    timestamp: Date;
    progress: number;
  }[];
  orderId?: string;
}

export default function UserDomains() {
  const { user, isLoading: isAuthLoading } = useUser();
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [isRenewalModalOpen, setIsRenewalModalOpen] = useState(false);
  const [selectedDomainName, setSelectedDomainName] = useState('');

  const {
    data: domainsData,
    isLoading: isLoadingDomains,
    isValidating,
    mutate,
  } = useSWR<{ domains: Domain[] }>(
    user ? '/api/v1/user/domains' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const domains = domainsData?.domains ?? [];

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
      case 'registered':
        return 'bg-emerald-soft text-emerald-ink border-emerald/30';
      case 'expired':
      case 'failed':
        return 'bg-rose-soft text-rose-ink border-rose/30';
      case 'pending':
        return 'bg-amber-soft text-amber-ink border-amber/30';
      case 'processing':
        return 'bg-indigo-soft text-indigo-ink border-indigo/25';
      case 'suspended':
        return 'bg-paper-2 text-ink-2 border-hairline';
      default:
        return 'bg-paper-2 text-ink-2 border-hairline';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <CheckCircle className="h-3 w-3" />;
      case 'expired':
        return <AlertTriangle className="h-3 w-3" />;
      case 'pending':
        return <Clock className="h-3 w-3" />;
      case 'processing':
        return <Loader2 className="h-3 w-3 animate-spin" />;
      case 'failed':
        return <AlertTriangle className="h-3 w-3" />;
      case 'suspended':
        return <Shield className="h-3 w-3" />;
      case 'registered':
        return <Globe className="h-3 w-3" />;
      default:
        return <Globe className="h-3 w-3" />;
    }
  };


  // Filter domains based on search term and status
  const filteredDomains = domains.filter(domain => {
    const matchesSearch = domain.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || domain.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  if (!user || isAuthLoading) {
    return <DashboardLayoutSkeleton><DomainsPageSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout}>
        <div className="mx-auto max-w-[1240px] space-y-6 p-4 sm:p-6 lg:p-8">

          {/* ── Page header ── */}
          <PageHeader
            title="Your domains"
            subtitle="Renew, manage DNS, or transfer a domain in."
            actions={<>
              <button
                onClick={() => router.push('/dashboard/domains/transfer')}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-ink-2 bg-paper border border-hairline rounded-xl hover:bg-paper-2 transition-colors shadow-sm"
              >
                <ArrowRightLeft className="h-4 w-4" />
                Transfer Domain
              </button>
              <button
                onClick={() => router.push(buyHref('domain'))}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-paper bg-amber rounded-xl hover:brightness-90 transition-colors shadow-sm"
              >
                <Plus className="h-4 w-4" />
                Register domain
              </button>
            </>}
          />

          {/* ── Domains card ── */}
          {isLoadingDomains ? (
            <DomainsPageSkeleton />
          ) : (
            <div className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
              {/* Card header with search + filter */}
              <div className="px-5 py-4 border-b border-hairline bg-paper-2/60 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4" />
                  <input
                    type="text"
                    placeholder="Search domains or order IDs…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-paper border border-hairline rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber focus:border-transparent transition-shadow"
                  />
                </div>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="sm:w-44 px-3 py-2 bg-paper border border-hairline rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber focus:border-transparent transition-shadow"
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="expired">Expired</option>
                  <option value="pending">Pending</option>
                  <option value="suspended">Suspended</option>
                </select>
                <RefreshButton onClick={() => mutate()} isLoading={isValidating} />
              </div>

              {filteredDomains.length === 0 ? (
                <div className="py-16 px-6 text-center">
                  <div className="w-14 h-14 bg-paper-2 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Inbox className="h-7 w-7 text-ink-4" />
                  </div>
                  <h3 className="text-sm font-semibold text-ink mb-1.5">No domains found</h3>
                  <p className="text-sm text-ink-3 mb-5">
                    {searchTerm || filterStatus !== 'all'
                      ? 'Try adjusting your search or filter criteria.'
                      : "You haven't registered any domains yet."}
                  </p>
                  {!searchTerm && filterStatus === 'all' && (
                    <button
                      onClick={() => router.push(buyHref('domain'))}
                      className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber text-paper text-sm font-semibold rounded-xl hover:brightness-90 transition-colors shadow-sm"
                    >
                      <Plus className="h-4 w-4" />
                      Search Domains
                    </button>
                  )}
                </div>
              ) : (
                <>
                {/* Phones: one card per domain (10 Oct 2026). The table hid Expiry, Manage DNS and
                    Renew behind a sideways scroll inside the card. */}
                <ul className="divide-y divide-hairline md:hidden">
                  {filteredDomains.map((domain) => {
                    const inactive = ['pending', 'processing', 'failed'].includes(domain.status);
                    const canRenew = !inactive && isWithinRenewalWindow(domain.expiryDate);
                    return (
                      <li key={domain.id} className="space-y-3 px-4 py-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-amber-soft" aria-hidden>
                              <Globe className="h-4 w-4 text-amber" />
                            </span>
                            <p className="min-w-0 break-words text-base font-semibold text-ink [overflow-wrap:anywhere]">{domain.name}</p>
                          </div>
                          <span className={`inline-flex flex-none items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getStatusColor(domain.status)}`}>
                            {getStatusIcon(domain.status)}
                            <span className="capitalize">{domain.status}</span>
                          </span>
                        </div>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <dt className="text-xs text-ink-3">Registered</dt>
                            <dd className="text-ink-2">{domain.status === 'pending' ? 'Pending' : formatIndianDateTime(domain.registrationDate).split(',')[0]}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-ink-3">Expires</dt>
                            <dd className="text-ink-2">
                              {domain.status === 'pending' || domain.status === 'processing' ? 'Pending'
                                : domain.status === 'failed' || !domain.expiryDate ? 'N/A'
                                : <ExpiryBadge expiryDate={domain.expiryDate} />}
                            </dd>
                          </div>
                        </dl>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { if (!inactive) router.push(`/dashboard/dns-management?domainId=${domain.id}`); }}
                            disabled={inactive}
                            className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold ${
                              inactive ? 'cursor-not-allowed bg-paper-2/60 text-ink-4' : 'border border-amber/25 bg-amber-soft text-amber-ink'
                            }`}
                          >
                            <Network className="h-4 w-4" />
                            {inactive ? 'DNS after setup' : 'Manage DNS'}
                          </button>
                          {canRenew && (
                            <button
                              onClick={() => { setSelectedDomainName(domain.name); setIsRenewalModalOpen(true); }}
                              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-emerald/30 bg-emerald-soft px-3 text-sm font-semibold text-emerald-ink"
                            >
                              <RefreshCw className="h-4 w-4" />
                              Renew
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-paper-2/60 border-b border-hairline">
                        <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Domain</th>
                        <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                        <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Registration Date</th>
                        <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Expiry Date</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-ink-3 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {filteredDomains.map((domain, index) => {
                        const inactive = ['pending', 'processing', 'failed'].includes(domain.status);
                        return (
                          <motion.tr
                            key={domain.id}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.04 }}
                            className="hover:bg-paper-2/60 transition-colors group"
                          >
                            <td className="px-5 py-3.5 whitespace-nowrap">
                              <div className="flex items-center gap-3">
                                <div className="flex-shrink-0 h-9 w-9 bg-amber-soft rounded-xl flex items-center justify-center">
                                  <Globe className="h-4 w-4 text-amber" />
                                </div>
                                <div className="text-sm font-semibold text-ink">{domain.name}</div>
                              </div>
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusColor(domain.status)}`}>
                                {getStatusIcon(domain.status)}
                                <span className="capitalize">{domain.status}</span>
                              </span>
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-sm text-ink-2">
                              {domain.status === 'pending' ? (
                                <span className="text-ink-4 italic">Pending</span>
                              ) : (
                                formatIndianDateTime(domain.registrationDate)
                              )}
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-sm text-ink-2">
                              {domain.status === 'pending' || domain.status === 'processing' ? (
                                <span className="text-ink-4 italic">Pending</span>
                              ) : domain.status === 'failed' || !domain.expiryDate ? (
                                <span className="text-ink-4">N/A</span>
                              ) : (
                                <ExpiryBadge
                                  expiryDate={domain.expiryDate}
                                  onRenew={() => {
                                    setSelectedDomainName(domain.name);
                                    setIsRenewalModalOpen(true);
                                  }}
                                />
                              )}
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-right">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => {
                                    if (!inactive) {
                                      router.push(`/dashboard/dns-management?domainId=${domain.id}`);
                                    }
                                  }}
                                  disabled={inactive}
                                  title="Manage DNS"
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                                    inactive
                                      ? 'text-ink-4 bg-paper-2/60 cursor-not-allowed'
                                      : 'text-amber-ink bg-amber-soft hover:brightness-95 border border-amber/25'
                                  }`}
                                >
                                  <Network className="h-3.5 w-3.5" />
                                  Manage DNS
                                </button>
                                {!inactive && isWithinRenewalWindow(domain.expiryDate) && (
                                  <button
                                    onClick={() => {
                                      setSelectedDomainName(domain.name);
                                      setIsRenewalModalOpen(true);
                                    }}
                                    title="Renew domain"
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-ink bg-emerald-soft hover:bg-emerald/15 border border-emerald/30 rounded-lg transition-colors"
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    Renew
                                  </button>
                                )}
                              </div>
                            </td>
                          </motion.tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </>
              )}
            </div>
          )}

        </div>

        {/* Renewals are ResellerOS's (owner decisions, 24-25 Sep 2026). */}
        <RenewViaResellerOs
          isOpen={isRenewalModalOpen}
          onClose={() => setIsRenewalModalOpen(false)}
          serviceName={selectedDomainName}
          serviceType="domain"
        />
      </UserLayout>
    </ClientOnly >
  );
}
