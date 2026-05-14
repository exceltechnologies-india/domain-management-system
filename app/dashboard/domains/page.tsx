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
    user ? '/api/user/domains' : null,
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
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'suspended':
        return 'bg-gray-100 text-gray-600 border-gray-200';
      default:
        return 'bg-gray-100 text-gray-600 border-gray-200';
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
              <div className="p-2 bg-blue-50 rounded-xl">
                <Globe className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">My Domains</h1>
                <p className="text-sm text-gray-500 mt-0.5">Manage your domain portfolio and settings</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => router.push('/dashboard/domains/transfer')}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors shadow-sm"
              >
                <ArrowRightLeft className="h-4 w-4" />
                Transfer Domain
              </button>
              <button
                onClick={() => router.push('/')}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
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
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
              {/* Card header with search + filter */}
              <div className="px-5 py-4 border-b border-gray-100 bg-gray-50/60 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search domains or order IDs…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                  />
                </div>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="sm:w-44 px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
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
                  <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Inbox className="h-7 w-7 text-gray-400" />
                  </div>
                  <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No domains found</h3>
                  <p className="text-sm text-gray-500 mb-5">
                    {searchTerm || filterStatus !== 'all'
                      ? 'Try adjusting your search or filter criteria.'
                      : "You haven't registered any domains yet."}
                  </p>
                  {!searchTerm && filterStatus === 'all' && (
                    <button
                      onClick={() => router.push('/')}
                      className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
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
                      <tr className="bg-gray-50/60 border-b border-gray-100">
                        <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Domain</th>
                        <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                        <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Registration Date</th>
                        <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Expiry Date</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filteredDomains.map((domain, index) => {
                        const inactive = ['pending', 'processing', 'failed'].includes(domain.status);
                        return (
                          <motion.tr
                            key={domain.id}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.04 }}
                            className="hover:bg-blue-50/30 transition-colors group"
                          >
                            <td className="px-5 py-3.5 whitespace-nowrap">
                              <div className="flex items-center gap-3">
                                <div className="flex-shrink-0 h-9 w-9 bg-blue-50 rounded-xl flex items-center justify-center">
                                  <Globe className="h-4 w-4 text-blue-600" />
                                </div>
                                <div className="text-sm font-semibold text-gray-900">{domain.name}</div>
                              </div>
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusColor(domain.status)}`}>
                                {getStatusIcon(domain.status)}
                                <span className="capitalize">{domain.status}</span>
                              </span>
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-sm text-gray-700">
                              {domain.status === 'pending' ? (
                                <span className="text-gray-400 italic">Pending</span>
                              ) : (
                                formatIndianDateTime(domain.registrationDate)
                              )}
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-sm text-gray-700">
                              {domain.status === 'pending' || domain.status === 'processing' ? (
                                <span className="text-gray-400 italic">Pending</span>
                              ) : domain.status === 'failed' || !domain.expiryDate ? (
                                <span className="text-gray-400">N/A</span>
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
                                      ? 'text-gray-400 bg-gray-50 cursor-not-allowed'
                                      : 'text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200'
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
