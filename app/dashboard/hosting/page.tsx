"use client";

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Server, Plus, RefreshCw, CheckCircle, AlertTriangle, Clock, Shield, HardDrive, Wifi, Settings, ArrowUp, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { formatBytes } from '@/lib/format-utils';
import { getRelativeTime, formatIndianDateTime, isWithinRenewalWindow } from '@/lib/dateUtils';
import { useRouter } from 'next/navigation';
import { useUser } from '@/hooks/useUser';
import { confirmDialog } from '@/lib/confirm-dialog';
import UserLayout from '@/components/user/UserLayout';
import { safeLocalStorage } from "@/lib/storage";
import { performLogout } from '@/lib/logout';
import { DashboardLayoutSkeleton, HostingPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { clientLogger } from '@/lib/client-logger';
import RefreshButton from '@/components/dashboard/RefreshButton';
import HostingRenewalModal from '@/components/HostingRenewalModal';
import HostingUpgradeModal from '@/components/HostingUpgradeModal';
import ExpiryBadge from '@/components/dashboard/ExpiryBadge';

interface HostingStats {
  domain: string;
  username: string;
  status: 'active' | 'expired' | 'pending' | 'failed' | 'terminated';
  ip: string;
  nameservers: string[];
  expires_at: string | null;
  created_at: string | null;
  usage: {
    bandwidth_used: string;
    bandwidth_limit: string;
    disk_used: string;
    disk_limit: string;
    databases: { used: string; limit: string };
    emails: { used: string; limit: string };
    ftp: { used: string; limit: string };
    subdomains: { used: string; limit: string };
  };
  features: {
    ssl: boolean;
    cgi: boolean;
    php: boolean;
    spam: boolean;
  };
  package?: string;
  planDetails?: {
    name: string;
    description: string;
    features: string[];
    price: number;
    currency: string;
  }
  php?: string;
  isPrimary?: boolean;
  hostingId?: string | null;
  autoRenew?: boolean;
  billingType?: 'subscription' | 'manual';
  isTrial?: boolean;
}

interface HostingStatsResponse {
  success: boolean;
  data?: HostingStats | HostingStats[];
  code?: string;
  error?: string;
}

export default function HostingPage() {
  const router = useRouter();
  const { user, isLoading: isAuthLoading } = useUser();

  const [isRenewalModalOpen, setIsRenewalModalOpen] = useState(false);
  const [selectedDomainName, setSelectedDomainName] = useState('');
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [upgradeDomainName, setUpgradeDomainName] = useState('');
  const [autoRenewLoading, setAutoRenewLoading] = useState<Record<string, boolean>>({});
  const [isCancellingTrial, setIsCancellingTrial] = useState(false);

  const {
    data: hostingResponse,
    error: swrError,
    isLoading: isLoadingStats,
    isValidating: refreshing,
    mutate,
  } = useSWR<HostingStatsResponse>(
    user ? '/api/user/hosting/stats' : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  // Derive list and error from SWR response
  const hostingStatsList: HostingStats[] = (() => {
    if (!hostingResponse?.success) return [];
    if (Array.isArray(hostingResponse.data)) return hostingResponse.data;
    if (hostingResponse.data) return [hostingResponse.data as HostingStats];
    return [];
  })();

  const error: string | null = (() => {
    if (swrError) return 'Hosting Server is currently unreachable. Please try again later.';
    if (!hostingResponse?.success && hostingResponse?.code === 'DA_SERVER_DOWN') {
      return 'Hosting Server is currently unreachable. Please try again later.';
    }
    if (!hostingResponse?.success && hostingResponse?.code !== 'NO_HOSTING' && hostingResponse?.error) {
      return hostingResponse.error;
    }
    return null;
  })();

  const handleSSOLogin = (username?: string) => {
    const token = safeLocalStorage.getItem('token');
    // Point to the correct custom API route, passing the JWT token for auth
    const url = username
      ? `/api/user/hosting/sso?username=${username}&token=${token}`
      : `/api/user/hosting/sso?token=${token}`;
    window.open(url, '_blank');
  };

  const getUsagePercentage = (used: string, limit: string) => {
    if (limit === 'Unlimited' || limit === '0') return 0;
    const usedVal = parseFloat(used);
    const limitVal = parseFloat(limit);
    if (isNaN(usedVal) || isNaN(limitVal) || limitVal === 0) return 0;
    return Math.min(100, (usedVal / limitVal) * 100);
  };

  // Use centralized date formatting including time for accuracy
  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A';
    // Use formatIndianDateTime to show both date and time as requested
    // This is especially important for 10-minute hosting plans
    return formatIndianDateTime(dateString);
  };


  const handleCancelTrial = async (hostingId: string) => {
    const ok = await confirmDialog({
      title: 'Cancel free trial?',
      message: "Your hosting will be terminated immediately and you won't be charged. This can't be undone.",
      confirmText: 'Cancel trial',
      cancelText: 'Keep trial',
      tone: 'danger',
    });
    if (!ok) return;
    setIsCancellingTrial(true);
    try {
      const res = await fetch('/api/user/hosting/cancel-trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hostingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel trial');
      toast.success('Free trial cancelled. Your hosting has been terminated.');
      mutate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to cancel trial');
    } finally {
      setIsCancellingTrial(false);
    }
  };

  const handleAutoRenewToggle = async (hostingStats: HostingStats, newValue: boolean) => {
    if (!hostingStats.hostingId) return;
    const key = hostingStats.domain;
    setAutoRenewLoading(prev => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(`/api/user/hosting/${hostingStats.hostingId}/auto-renew`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ autoRenew: newValue }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      toast.success(newValue ? 'Auto-renewal enabled' : 'Auto-renewal disabled');
      mutate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update auto-renewal');
    } finally {
      setAutoRenewLoading(prev => ({ ...prev, [key]: false }));
    }
  };

  if (!user || isAuthLoading) {
    return <DashboardLayoutSkeleton><HostingPageSkeleton /></DashboardLayoutSkeleton>;
  }

  // Render Functions for Cleanliness
  const renderHostingCard = (hostingStats: HostingStats) => (
    <motion.div
      key={hostingStats.username}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden"
    >
      {/* Header */}
      <div className="p-6 border-b border-gray-100 bg-gray-50/60">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="bg-blue-100 p-3 rounded-xl border border-blue-200">
              <Server className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-gray-900">{hostingStats.domain}</h2>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500 mt-1">
                <span className="font-medium">{hostingStats.planDetails?.name || hostingStats.package || 'Standard'}</span>
                {hostingStats.ip && (
                  <>
                    <span>•</span>
                    <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">{hostingStats.ip}</span>
                  </>
                )}
              </div>
              {hostingStats.expires_at && (
                <div className="mt-2">
                  {hostingStats.isTrial ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200">
                      <Clock className="h-3 w-3" />
                      Trial ends {formatDate(hostingStats.expires_at)}
                    </span>
                  ) : (
                    <ExpiryBadge
                      expiryDate={hostingStats.expires_at}
                      onRenew={() => {
                        setSelectedDomainName(hostingStats.domain);
                        setIsRenewalModalOpen(true);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className={`px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1.5 ${hostingStats.status === 'active' ? 'bg-green-50 text-green-700 border-green-200' :
              hostingStats.status === 'pending' ? 'bg-yellow-50 text-yellow-700 border-yellow-200' :
                'bg-red-50 text-red-700 border-red-200'
              }`}>
              {hostingStats.status === 'active' ? <CheckCircle className="h-3 w-3" /> :
                hostingStats.status === 'pending' ? <Clock className="h-3 w-3" /> :
                  <AlertTriangle className="h-3 w-3" />}
              {hostingStats.status.toUpperCase()}
            </div>
            {hostingStats.isTrial && (
              <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-purple-100 text-purple-700 border border-purple-200">
                FREE TRIAL
              </span>
            )}

            <button
              onClick={() => handleSSOLogin(hostingStats.username)}
              disabled={hostingStats.status === 'expired'}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-all shadow-sm hover:shadow text-sm font-medium ${
                hostingStats.status === 'expired'
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-900 text-white hover:bg-gray-800'
              }`}
            >
              <Settings className="h-4 w-4" />
              Control Panel
            </button>

            {hostingStats.status === 'active' && (
              <button
                onClick={() =>
                  toast(
                    'Plan upgrades are coming soon. Contact support@anutech.in to upgrade your hosting in the meantime.',
                    { icon: '🚀', duration: 5000 }
                  )
                }
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors shadow-sm text-sm font-medium"
                title="Coming soon"
              >
                <ArrowUp className="h-4 w-4" />
                Upgrade
                <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-white border border-blue-200 px-1.5 py-0.5 rounded-full">
                  Soon
                </span>
              </button>
            )}

            {!hostingStats.isTrial && (isWithinRenewalWindow(hostingStats.expires_at) || hostingStats.status === 'expired') && (
              <button
                onClick={() => {
                  setSelectedDomainName(hostingStats.domain);
                  setIsRenewalModalOpen(true);
                }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-all shadow-sm hover:shadow text-sm font-medium"
              >
                <RefreshCw className="h-4 w-4" />
                {hostingStats.status === 'expired' ? 'Pay Now to Restore' : 'Renew'}
              </button>
            )}

            {hostingStats.isTrial && hostingStats.hostingId && hostingStats.status === 'active' && (
              <button
                onClick={() => handleCancelTrial(hostingStats.hostingId!)}
                disabled={isCancellingTrial}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-all disabled:opacity-50"
              >
                {isCancellingTrial ? 'Cancelling...' : 'Cancel Trial'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content Grid */}
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">

        {/* Disk Usage */}
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
          <div className="flex items-center gap-2 text-gray-600 mb-3">
            <HardDrive className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-medium">Disk Usage</span>
          </div>
          <div className="space-y-2">
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${getUsagePercentage(hostingStats.usage.disk_used, hostingStats.usage.disk_limit)}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-xs text-gray-600 font-medium">
              <span>{formatBytes(hostingStats.usage.disk_used, 'MB')}</span>
              <span>{formatBytes(hostingStats.usage.disk_limit, 'MB')}</span>
            </div>
          </div>
        </div>

        {/* Bandwidth */}
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
          <div className="flex items-center gap-2 text-gray-600 mb-3">
            <Wifi className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium">Bandwidth</span>
          </div>
          <div className="space-y-2">
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div
                className="bg-green-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${getUsagePercentage(hostingStats.usage.bandwidth_used, hostingStats.usage.bandwidth_limit)}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-xs text-gray-600 font-medium">
              <span>{formatBytes(hostingStats.usage.bandwidth_used, 'MB')}</span>
              <span>{formatBytes(hostingStats.usage.bandwidth_limit, 'MB')}</span>
            </div>
          </div>
        </div>

        {/* Server Info */}
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 col-span-1 md:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <Shield className="h-4 w-4 text-purple-500" />
              Server Details
            </h3>
            {hostingStats.php && (
              <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded border border-purple-200">PHP {hostingStats.php}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-gray-500 mb-1">Nameserver 1</p>
              <p className="font-mono text-gray-700 bg-white p-1.5 rounded border border-gray-200 truncate" title={hostingStats.nameservers[0]}>
                {hostingStats.nameservers[0] || 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Nameserver 2</p>
              <p className="font-mono text-gray-700 bg-white p-1.5 rounded border border-gray-200 truncate" title={hostingStats.nameservers[1]}>
                {hostingStats.nameservers[1] || 'N/A'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="px-4 py-4 md:px-6 md:py-3 bg-gray-50 border-t border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs text-gray-500">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 flex-shrink-0" />
            <span className="whitespace-nowrap">Created:</span> <span className="cursor-help truncate" title={getRelativeTime(hostingStats.created_at)}>{formatDate(hostingStats.created_at)}</span>
          </div>
          {hostingStats.expires_at && (
            <ExpiryBadge
              expiryDate={hostingStats.expires_at}
              onRenew={() => {
                setSelectedDomainName(hostingStats.domain);
                setIsRenewalModalOpen(true);
              }}
            />
          )}
        </div>
        <div className="flex items-center gap-4 mt-1 md:mt-0 pt-2 md:pt-0 border-t md:border-0 border-gray-200/60">
          {/* Auto-Renewal Toggle */}
          <div className="flex items-center gap-2">
            <RotateCcw className="h-3 w-3 text-gray-400 flex-shrink-0" />
            <span className="whitespace-nowrap">Auto-Renewal:</span>
            {hostingStats.billingType === 'subscription' && hostingStats.hostingId && hostingStats.status === 'active' ? (
              <button
                onClick={() => handleAutoRenewToggle(hostingStats, !hostingStats.autoRenew)}
                disabled={autoRenewLoading[hostingStats.domain]}
                className={`relative inline-flex h-4 w-8 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
                  hostingStats.autoRenew ? 'bg-green-500' : 'bg-gray-300'
                }`}
                title={hostingStats.autoRenew ? 'Click to disable auto-renewal' : 'Click to enable auto-renewal'}
              >
                <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  hostingStats.autoRenew ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            ) : (
              <span
                className="text-gray-400 cursor-default"
                title={hostingStats.billingType !== 'subscription' ? 'Set up a subscription plan to enable auto-renewal' : undefined}
              >
                {hostingStats.billingType !== 'subscription' ? 'Requires subscription' : hostingStats.autoRenew ? 'On' : 'Off'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            DA User: <span className="font-mono font-medium text-gray-700 truncate max-w-[150px] sm:max-w-[200px]">{hostingStats.username}</span>
          </div>
        </div>
      </div>
    </motion.div >
  );

  return (
    <UserLayout user={user} onLogout={performLogout}>
      <div className="p-6 space-y-6">

        {/* ── Page header ── */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Server className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">My Hosting</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage your web hosting packages and servers</p>
            </div>
          </div>
          <div className="flex gap-3">
            <RefreshButton onClick={() => mutate()} isLoading={refreshing} />
          </div>
        </div>

        {isLoadingStats ? (
          <HostingPageSkeleton />
        ) : error ? (
          <div className={`bg-white border rounded-2xl shadow-sm p-5 flex items-start gap-3 ${error.includes('unreachable') ? 'border-amber-200' : 'border-red-200'}`}>
            <div className={`p-2 rounded-xl shrink-0 ${error.includes('unreachable') ? 'bg-amber-50' : 'bg-red-50'}`}>
              {error.includes('unreachable')
                ? <Shield className="h-4 w-4 text-amber-600" />
                : <AlertTriangle className="h-4 w-4 text-red-600" />}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className={`text-sm font-semibold ${error.includes('unreachable') ? 'text-amber-900' : 'text-red-900'}`}>
                {error.includes('unreachable') ? 'Service Unavailable' : 'Error'}
              </h3>
              <p className={`text-sm mt-0.5 ${error.includes('unreachable') ? 'text-amber-700' : 'text-red-700'}`}>{error}</p>
              <button
                onClick={() => mutate()}
                disabled={refreshing}
                className={`mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border disabled:opacity-50 transition-colors ${error.includes('unreachable') ? 'text-amber-700 border-amber-200 bg-amber-50 hover:bg-amber-100' : 'text-red-700 border-red-200 bg-red-50 hover:bg-red-100'}`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Retrying…' : 'Try Again'}
              </button>
            </div>
          </div>
        ) : !hostingStatsList || hostingStatsList.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm py-16 px-6 text-center">
            <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Server className="h-7 w-7 text-blue-500" />
            </div>
            <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No Hosting Services</h3>
            <p className="text-sm text-gray-500 mb-5 max-w-sm mx-auto">You don't have any active hosting packages yet — pick a plan to get started.</p>
            <button
              onClick={() => router.push('/hosting#pricing')}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
            >
              <Plus className="h-4 w-4" />
              Buy Hosting
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            {hostingStatsList.map(stats => renderHostingCard(stats))}
          </div>
        )}
      </div>

      <HostingRenewalModal
        isOpen={isRenewalModalOpen}
        onClose={() => setIsRenewalModalOpen(false)}
        domainName={selectedDomainName}
      />

      <HostingUpgradeModal
        isOpen={isUpgradeModalOpen}
        onClose={() => setIsUpgradeModalOpen(false)}
        domainName={upgradeDomainName}
      />
    </UserLayout>
  );
}
