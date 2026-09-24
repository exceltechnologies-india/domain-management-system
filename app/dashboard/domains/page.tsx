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
import { DashboardLayoutSkeleton, DomainsPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import RefreshButton from '@/components/dashboard/RefreshButton';
import DomainRenewalModal from '@/components/DomainRenewalModal';
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
        return 'bg-green-50 text-green-700 border-green-200';
      case 'expired':
      case 'failed':
        return 'bg-red-50 text-red-700 border-red-200';
      case 'pending':
        return 'bg-amber-50 text-amber-700 border-amber-200';
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
        <div className="p-6 space-y-6">

          {/* ── Page header ── */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-soft rounded-xl">
                <Globe className="h-5 w-5 text-amber" />
              </div>
              <div>
                <h1 className="font-serif text-2xl font-bold text-ink">My Domains</h1>
                <p className="text-sm text-ink-3 mt-0.5">Manage your domain portfolio and settings</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex flex-col sm:flex-row gap-2">
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
                Search Domains
              </button>
            </div>
          </div>

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
                <div className="overflow-x-auto">
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
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors"
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
              )}
            </div>
          )}

        </div>

        <DomainRenewalModal
          isOpen={isRenewalModalOpen}
          onClose={() => setIsRenewalModalOpen(false)}
          domainName={selectedDomainName}
        />
      </UserLayout>
    </ClientOnly >
  );
}
