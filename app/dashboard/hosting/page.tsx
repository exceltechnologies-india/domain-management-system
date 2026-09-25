"use client";

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Server, Plus, RefreshCw, CheckCircle, AlertTriangle, Clock, Shield, HardDrive, Wifi, Settings } from 'lucide-react';
import toast from 'react-hot-toast';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { apiClient } from '@/lib/api-client';
import { formatBytes } from '@/lib/format-utils';
import { getRelativeTime, formatIndianDateTime, isWithinRenewalWindow } from '@/lib/dateUtils';
import { useRouter } from 'next/navigation';
import { useUser } from '@/hooks/useUser';
import { confirmDialog } from '@/lib/confirm-dialog';
import UserLayout from '@/components/user/UserLayout';
import { performLogout } from '@/lib/logout';
import { DashboardLayoutSkeleton, HostingPageSkeleton } from '@/components/skeletons/PageSkeletons';
import RefreshButton from '@/components/dashboard/RefreshButton';
import RenewViaResellerOs from '@/components/billing/RenewViaResellerOs';
import HostingUpgradeModal from '@/components/HostingUpgradeModal';
import ExpiryBadge from '@/components/dashboard/ExpiryBadge';
import TrialCountdownBanner from '@/components/dashboard/TrialCountdownBanner';
import { buyHref } from '@/lib/purchase/buy-dialog';

interface HostingStats {
  domain: string;
  username: string;
  status: 'active' | 'expired' | 'pending' | 'failed' | 'terminated';
  ip: string;
  nameservers: string[];
  expires_at: string | null;
  created_at: string | null;
  /**
   * OPTIONAL, and it always was — the type just did not say so.
   *
   * `/api/user/hosting/stats` returns two different shapes. A provisioned
   * account carries usage read from DirectAdmin; a hosting still awaiting
   * provisioning is returned by `fetchPendingHostingEntries` with
   * `status: "pending"`, `username: ""` and NO usage block, because there is
   * no DirectAdmin account to read yet.
   *
   * Declaring it required made `hostingStats.usage.disk_used` compile, and it
   * threw "Cannot read properties of undefined (reading 'disk_used')" for
   * every customer whose hosting had not been provisioned — taking the whole
   * page down to the error boundary, not just the usage panel. 24 of those
   * are in the production systemlogs.
   *
   * Leave it optional. The lie was the bug.
   */
  usage?: {
    bandwidth_used: string;
    bandwidth_limit: string;
    disk_used: string;
    disk_limit: string;
    databases: { used: string; limit: string };
    emails: { used: string; limit: string };
    ftp: { used: string; limit: string };
    subdomains: { used: string; limit: string };
  };
  /** Absent on a pending entry, for the same reason as `usage`. */
  features?: {
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
  // Derived from the Hosting record's razorpayTokenId / subscriptionId
  // by `/api/user/hosting/stats`. 'tokens' triggers the payment-
  // validity note (hard 1-attempt MIT rule); other modes don't.
  mandateMode?: 'tokens' | 'subscriptions' | 'manual';
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
  const [isCancellingTrial, setIsCancellingTrial] = useState(false);

  const {
    data: hostingResponse,
    error: swrError,
    isLoading: isLoadingStats,
    isValidating: refreshing,
    mutate,
  } = useSWR<HostingStatsResponse>(
    user ? '/api/v1/user/hosting/stats' : null,
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
    // The SSO endpoint authenticates via the NextAuth session cookie
    const url = username
      ? `/api/v1/user/hosting/sso?username=${username}`
      : `/api/v1/user/hosting/sso`;
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
    const result = await apiClient.post('/api/v1/user/hosting/cancel-trial', { hostingId });
    if (result.ok) {
      toast.success('Free trial cancelled. Your hosting has been terminated.');
      void mutate();
    } else {
      toast.error(result.error.message || 'Failed to cancel trial');
    }
    setIsCancellingTrial(false);
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
      className="bg-white rounded-2xl shadow-sm border border-hairline overflow-hidden"
    >
      {/* Trial countdown banner — surfaces when within 3 days of trial
          expiry so the customer sees a prominent nudge, not just the
          small "Trial ends <date>" pill in the header. Auto-hides
          outside the 3-day window / on non-trial cards. */}
      <TrialCountdownBanner
        isTrial={hostingStats.isTrial}
        status={hostingStats.status}
        expiryDate={hostingStats.expires_at}
        onConvert={() => {
          setSelectedDomainName(hostingStats.domain);
          setIsRenewalModalOpen(true);
        }}
      />

      {/* Header */}
      <div className="p-6 border-b border-hairline bg-paper-2/60">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="bg-indigo-soft p-3 rounded-xl border border-indigo/25">
              <Server className="h-6 w-6 text-amber-ink" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-ink">{hostingStats.domain}</h2>
              </div>
              <div className="flex items-center gap-2 text-sm text-ink-3 mt-1">
                <span className="font-medium">{hostingStats.planDetails?.name || hostingStats.package || 'Standard'}</span>
                {hostingStats.ip && (
                  <>
                    <span>•</span>
                    <span className="font-mono text-xs bg-paper-2 px-1.5 py-0.5 rounded text-ink-2">{hostingStats.ip}</span>
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
                  ? 'bg-hairline text-ink-3 cursor-not-allowed'
                  : 'bg-ink text-white hover:bg-ink-2'
              }`}
            >
              <Settings className="h-4 w-4" />
              Control Panel
            </button>

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

        {/* Disk + Bandwidth. Absent until DirectAdmin has the account —
            `usage` is undefined on a pending entry, and reading through it is
            what used to take this whole page down to the error boundary.
            Saying "not available yet" beats a 0% bar, which would read as
            "provisioned, using nothing". */}
        {hostingStats.usage ? (
          <>
            {/* Disk Usage */}
            <div className="bg-paper-2/60 rounded-xl p-4 border border-hairline">
              <div className="flex items-center gap-2 text-ink-2 mb-3">
                <HardDrive className="h-4 w-4 text-amber-ink" />
                <span className="text-sm font-medium">Disk Usage</span>
              </div>
              <div className="space-y-2">
                <div className="w-full bg-hairline rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-indigo h-2 rounded-full transition-all duration-500"
                    style={{ width: `${getUsagePercentage(hostingStats.usage.disk_used, hostingStats.usage.disk_limit)}%` }}
                  ></div>
                </div>
                <div className="flex justify-between text-xs text-ink-2 font-medium">
                  <span>{formatBytes(hostingStats.usage.disk_used, 'MB')}</span>
                  <span>{formatBytes(hostingStats.usage.disk_limit, 'MB')}</span>
                </div>
              </div>
            </div>

            {/* Bandwidth */}
            <div className="bg-paper-2/60 rounded-xl p-4 border border-hairline">
              <div className="flex items-center gap-2 text-ink-2 mb-3">
                <Wifi className="h-4 w-4 text-emerald-ink" />
                <span className="text-sm font-medium">Bandwidth</span>
              </div>
              <div className="space-y-2">
                <div className="w-full bg-hairline rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-emerald h-2 rounded-full transition-all duration-500"
                    style={{ width: `${getUsagePercentage(hostingStats.usage.bandwidth_used, hostingStats.usage.bandwidth_limit)}%` }}
                  ></div>
                </div>
                <div className="flex justify-between text-xs text-ink-2 font-medium">
                  <span>{formatBytes(hostingStats.usage.bandwidth_used, 'MB')}</span>
                  <span>{formatBytes(hostingStats.usage.bandwidth_limit, 'MB')}</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="bg-paper-2/60 rounded-xl p-4 border border-hairline md:col-span-2">
            <div className="flex items-center gap-2 text-ink-2 mb-2">
              <HardDrive className="h-4 w-4 text-ink-3" />
              <span className="text-sm font-medium">Disk &amp; bandwidth</span>
            </div>
            <p className="text-xs text-ink-3">
              Not available yet — this account is still being set up on the hosting
              server. Usage appears here once provisioning finishes.
            </p>
          </div>
        )}

        {/* Server Info */}
        <div className="bg-paper-2/60 rounded-xl p-4 border border-hairline col-span-1 md:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
              <Shield className="h-4 w-4 text-purple-500" />
              Server Details
            </h3>
            {hostingStats.php && (
              <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded border border-purple-200">PHP {hostingStats.php}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-ink-3 mb-1">Nameserver 1</p>
              <p className="font-mono text-ink-2 bg-white p-1.5 rounded border border-hairline truncate" title={hostingStats.nameservers[0]}>
                {hostingStats.nameservers[0] || 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-ink-3 mb-1">Nameserver 2</p>
              <p className="font-mono text-ink-2 bg-white p-1.5 rounded border border-hairline truncate" title={hostingStats.nameservers[1]}>
                {hostingStats.nameservers[1] || 'N/A'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Tokens-flow payment-validity note — strict 1-attempt MIT policy.
          Rendered only for customers whose Hosting has a stored mandate
          token (mandateMode='tokens'). Subscriptions-flow customers
          (whose retries are handled by Razorpay's Subscriptions API
          server-side) and manual customers don't see this. Matches the
          welcome-email callout (26b0f51) so the expectation is set in
          both surfaces. */}
      {hostingStats.mandateMode === 'tokens' && hostingStats.status !== 'expired' && (
        <div className="mx-4 my-3 md:mx-6 p-3 bg-amber-50 border border-amber-200 rounded-lg flex gap-2.5 items-start">
          <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900">
            <span className="font-semibold">Keep your payment method valid.</span>{' '}
            We charge your saved card or UPI once when this hosting renews. If that single charge fails, your service is suspended and you'll need to re-subscribe with a new payment method to restore it.
            {hostingStats.expires_at && (() => {
              // Cron fires up to CHARGE_LOOKAHEAD_DAYS=1 day before expiry
              // (see lib/services/payment/recurring-charge-service.ts:53).
              // "around" not "on" — the cron has a 24-hour window so a
              // precise timestamp would over-promise; the customer just
              // needs the day to know when to verify their card.
              const expiry = new Date(hostingStats.expires_at);
              if (Number.isNaN(expiry.getTime())) return null;
              const chargeDay = new Date(expiry);
              chargeDay.setDate(chargeDay.getDate() - 1);
              const formatted = chargeDay.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              });
              return (
                <div className="mt-1.5 pt-1.5 border-t border-amber-200/60">
                  <span className="font-medium">Auto-renewal charge:</span> around {formatted}.
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div className="px-4 py-4 md:px-6 md:py-3 bg-paper-2/60 border-t border-hairline flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs text-ink-3">
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
        {/* Auto-renewal is intentionally NOT shown to regular users: for
            mandate-billed plans it's always on (the saved Razorpay mandate
            renews automatically) and not something a customer toggles — to stop
            future billing they cancel the plan. The user-facing auto-renew
            toggle was removed on operator request. Enforcement still lives on
            the API (rejects autoRenew=false for subscription plans). */}
        <div className="flex items-center gap-4 mt-1 md:mt-0 pt-2 md:pt-0 border-t md:border-0 border-hairline/60">
          <div className="flex items-center gap-1">
            DA User: <span className="font-mono font-medium text-ink-2 truncate max-w-[150px] sm:max-w-[200px]">{hostingStats.username}</span>
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
            <div className="p-2 bg-indigo-soft rounded-xl">
              <Server className="h-5 w-5 text-amber-ink" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ink">My Hosting</h1>
              <p className="text-sm text-ink-3 mt-0.5">Manage your web hosting packages and servers</p>
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
          <div className="bg-white border border-hairline rounded-2xl shadow-sm py-16 px-6 text-center">
            <div className="w-14 h-14 bg-indigo-soft rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Server className="h-7 w-7 text-amber-ink" />
            </div>
            <h3 className="text-sm font-semibold text-ink mb-1.5">No Hosting Services</h3>
            <p className="text-sm text-ink-3 mb-5 max-w-sm mx-auto">You don't have any active hosting packages yet — pick a plan to get started.</p>
            <button
              onClick={() => router.push(buyHref('hosting'))}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber text-white text-sm font-semibold rounded-xl hover:brightness-90 transition-colors shadow-sm"
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

      {/* Renewals are ResellerOS's (owner decisions, 24-25 Sep 2026): this
          points at the customer's pending renewal bill; DMS takes no payment. */}
      <RenewViaResellerOs
        isOpen={isRenewalModalOpen}
        onClose={() => setIsRenewalModalOpen(false)}
        serviceName={selectedDomainName}
        serviceType="hosting"
      />

      <HostingUpgradeModal
        isOpen={isUpgradeModalOpen}
        onClose={() => setIsUpgradeModalOpen(false)}
        domainName={upgradeDomainName}
      />
    </UserLayout>
  );
}
