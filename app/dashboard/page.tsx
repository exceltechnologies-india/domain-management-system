'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
import useSWR from 'swr';
import {
  Globe, ShoppingCart, TrendingUp, Clock, CheckCircle,
  AlertTriangle, Calendar, ArrowRight, Plus, RefreshCw, Server, FileText, HardDrive,
  LayoutDashboard, Sparkles, Settings as SettingsIcon, Inbox, Search,
} from 'lucide-react';
import RupeeIcon from '@/components/icons/RupeeIcon';
import { useCartStore } from '@/store/cartStore';
import { safeLocalStorage, safeSessionStorage } from '@/lib/storage';
import { performLogout } from '@/lib/logout';
import { logger } from '@/lib/logger';
import { fetcher } from '@/lib/fetcher';
import { useUser } from '@/hooks/useUser';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, DashboardHomeSkeleton } from '@/components/skeletons/PageSkeletons';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface DashboardStats {
  totalDomains: number;
  activeDomains: number;
  pendingDomains?: number;
  totalOrders: number;
  recentOrders: any[];
  recentDomains: any[];
  upcomingRenewals: any[];
  activeHostings?: any[];
}

interface ServiceStatus {
  hasDomains: boolean;
  hasHosting: boolean;
}


export default function UserDashboard() {
  const { user, isLoading: isAuthLoading } = useUser();
  const [isSyncing, setIsSyncing] = useState(false);
  const router = useRouter();
  const { items: cartItems } = useCartStore();
  const hasAutoSynced = useRef(false);

  const {
    data: dashboardData,
    isLoading: isLoadingDashboard,
    mutate: mutateDashboard,
  } = useSWR<{ stats: DashboardStats; serviceStatus: ServiceStatus }>(
    user ? '/api/user/dashboard' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const stats = dashboardData?.stats ?? null;
  const serviceStatus = dashboardData?.serviceStatus ?? { hasDomains: true, hasHosting: true };

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

    try {
      let token = safeLocalStorage.getItem('token');
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/domains/sync', {
        method: 'POST',
        headers,
        credentials: 'include'
      });

      // Try to parse response
      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        // Silent handling - malformed response
        if (!silent && loadingToast) {
          toast.error('Unexpected response from server', { id: loadingToast });
        }
        return;
      }

      if (response.ok && data.success) {
        if (!silent && loadingToast) {
          toast.success(
            `Successfully imported ${data.imported} domain(s)! ${data.skipped > 0 ? `Skipped ${data.skipped} existing domain(s).` : ''}`,
            { id: loadingToast }
          );
        } else if (silent && data.imported > 0) {
          // Show success for auto-sync only if domains were actually imported
          toast.success(
            `Automatically imported ${data.imported} domain(s)!`
          );
        }

        // Reload dashboard data to show newly synced domains
        await mutateDashboard();
      } else {
        // Handle specific error cases
        const errorMessage = data.message || data.error || 'Failed to sync domains';
        const errorCode = data.code;

        // Check if user doesn't have a domain provider account
        if (errorCode === 'NO_LINKED_ACCOUNT' || 
            errorMessage.includes('No ResellerClub customer') ||
            errorMessage.includes('not linked to a ResellerClub')) {
          // This is expected for new users - don't show error in silent mode
          if (!silent && loadingToast) {
            toast.error(
              'No domains found. Register your first domain to get started.',
              { id: loadingToast }
            );
          } else {
            // Just log in silent mode
            // console.log('User does not have any domains yet - this is normal for new users');
          }
        } else {
          // Other errors - show them
          if (!silent && loadingToast) {
            toast.error(errorMessage, { id: loadingToast });
          }
          // Log to server-side only, not browser console
        }
      }
    } catch (error) {
      // Silent handling - network or other errors
      // Check if it's a network error
      if (error instanceof TypeError && error.message.includes('fetch')) {
        if (!silent && loadingToast) {
          toast.error('Network error. Please check your connection.', { id: loadingToast });
        }
      } else {
        if (!silent && loadingToast) {
          toast.error('Failed to sync domains', { id: loadingToast });
        }
      }
    } finally {
      setIsSyncing(false);
      // Dismiss loading toast if it exists
      if (loadingToast) {
        toast.dismiss(loadingToast);
      }
    }
  };

  if (!user || isAuthLoading) {
    return <DashboardLayoutSkeleton><DashboardHomeSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <UserLayout
      user={user}
      onLogout={handleLogout}
    >
      <div className="p-6 space-y-6">

        {/* ── Welcome ── */}
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-50 rounded-xl">
            <LayoutDashboard className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Welcome back, {user?.firstName || 'User'}!
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">Here's an overview of your services.</p>
          </div>
        </div>

        {isLoadingDashboard ? (
          <DashboardHomeSkeleton />
        ) : (
          <>
            {/* ── Overview stat cards ── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Domains */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 bg-blue-50 rounded-xl">
                    <Globe className="h-5 w-5 text-blue-600" />
                  </div>
                  <span className="text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full">
                    Domains
                  </span>
                </div>
                <p className="text-3xl font-bold text-gray-900">{stats?.activeDomains || 0}</p>
                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-gray-500">Active Domains</p>
                    {stats?.pendingDomains && stats.pendingDomains > 0 && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
                        {stats.pendingDomains} Pending
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => router.push('/dashboard/domains')}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                  >
                    View
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </motion.div>

              {/* Hosting */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 bg-orange-50 rounded-xl">
                    <HardDrive className="h-5 w-5 text-orange-600" />
                  </div>
                  <span className="text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-200 px-2.5 py-0.5 rounded-full">
                    Hosting
                  </span>
                </div>
                <p className="text-3xl font-bold text-gray-900">{stats?.activeHostings?.length || 0}</p>
                <div className="flex items-center justify-between mt-2">
                  <p className="text-xs font-medium text-gray-500">Active Hosting</p>
                  <button
                    onClick={() => router.push('/dashboard/hosting')}
                    className="text-xs font-semibold text-orange-600 hover:text-orange-700 inline-flex items-center gap-1"
                  >
                    View
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </motion.div>

              {/* Renewals */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 bg-purple-50 rounded-xl">
                    <Clock className="h-5 w-5 text-purple-600" />
                  </div>
                  {stats?.upcomingRenewals && stats.upcomingRenewals.length > 0 ? (
                    <span className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 px-2.5 py-0.5 rounded-full">
                      Action needed
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 px-2.5 py-0.5 rounded-full">
                      Renewals
                    </span>
                  )}
                </div>
                <p className="text-3xl font-bold text-gray-900">{stats?.upcomingRenewals?.length || 0}</p>
                <p className="text-xs font-medium text-gray-500 mt-2">Upcoming (30 days)</p>

                {stats?.upcomingRenewals && stats.upcomingRenewals.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
                    {stats.upcomingRenewals.slice(0, 2).map((renewal: any, idx: number) => (
                      <div key={idx} className="flex items-center gap-2 min-w-0">
                        {renewal.type === 'Hosting'
                          ? <HardDrive className="h-3.5 w-3.5 text-orange-500 flex-shrink-0" />
                          : <Globe className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />}
                        <p className="text-xs text-gray-700 truncate flex-1"><span className="font-medium">{renewal.domain}</span> · {renewal.expiryDate}</p>
                      </div>
                    ))}
                    {stats.upcomingRenewals.length > 2 && (
                      <p className="text-[11px] text-gray-400">+ {stats.upcomingRenewals.length - 2} more</p>
                    )}
                  </div>
                )}
              </motion.div>
            </div>

            {/* ── Main grid ── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* Your Services */}
              <motion.div
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
                className="lg:col-span-2 bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden"
              >
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Server className="h-4 w-4 text-gray-500" />
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">Your Services</h3>
                      <p className="text-xs text-gray-500 mt-0.5">Recent domains and hosting</p>
                    </div>
                  </div>
                  <button
                    onClick={() => router.push('/dashboard/domains')}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700"
                  >
                    View All
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="divide-y divide-gray-50">
                  {stats?.recentDomains && stats.recentDomains.length > 0 ? (
                    stats.recentDomains.slice(0, 4).map((service, index) => {
                      const isHost = service.itemType === 'hosting';
                      const status = service.status;
                      const statusCfg = (status === 'active' || status === 'registered' || status === 'provisioned')
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : (status === 'pending' || status === 'processing')
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-gray-100 text-gray-500 border-gray-200';
                      return (
                        <div key={index} className="px-6 py-3.5 hover:bg-blue-50/30 transition-colors flex items-center justify-between group">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`flex-shrink-0 h-9 w-9 rounded-xl flex items-center justify-center ${isHost ? 'bg-orange-50' : 'bg-blue-50'}`}>
                              {isHost
                                ? <HardDrive className="h-4 w-4 text-orange-600" />
                                : <Globe className="h-4 w-4 text-blue-600" />}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900 truncate">{service.name}</p>
                              <p className="text-xs text-gray-400 mt-0.5 capitalize">
                                {service.itemType} · {service.registeredDate}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border capitalize ${statusCfg}`}>
                              {status}
                            </span>
                            {service.expiryDate !== 'N/A' && (
                              <p className="text-xs text-gray-400 mt-1">
                                Expires {service.expiryDate}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-12 px-6 text-center">
                      <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <Inbox className="h-7 w-7 text-gray-400" />
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No services yet</h3>
                      <p className="text-sm text-gray-500 mb-5">Get started by registering a domain.</p>
                      <button
                        onClick={() => router.push('/')}
                        className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
                      >
                        <Search className="h-4 w-4" />
                        Find a Domain
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>

              {/* Side column */}
              <motion.div
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.25 }}
                className="space-y-5"
              >
                {/* Need a new domain CTA */}
                <div className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-700 rounded-2xl p-6 text-white shadow-md">
                  <div className="absolute -top-6 -right-6 w-24 h-24 bg-white/10 rounded-full blur-xl" />
                  <div className="absolute -bottom-8 -left-4 w-20 h-20 bg-white/5 rounded-full blur-xl" />
                  <div className="relative">
                    <div className="inline-flex p-2 bg-white/20 backdrop-blur-sm rounded-xl mb-3">
                      <Sparkles className="h-4 w-4 text-white" />
                    </div>
                    <h3 className="font-bold text-lg mb-1">Need a new domain?</h3>
                    <p className="text-blue-100 text-sm mb-4">Search and register your perfect domain name.</p>
                    <button
                      onClick={() => router.push('/')}
                      className="w-full inline-flex items-center justify-center gap-2 bg-white text-blue-700 font-semibold text-sm py-2.5 rounded-xl hover:bg-blue-50 transition-colors shadow-sm"
                    >
                      <Search className="h-4 w-4" />
                      Search Domains
                    </button>
                  </div>
                </div>

                {/* Quick Management */}
                <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-gray-100 bg-gray-50/60">
                    <h3 className="text-sm font-semibold text-gray-900">Quick Management</h3>
                  </div>
                  <div className="p-2">
                    {[
                      { href: '/dashboard/hosting',  icon: HardDrive,    label: 'Manage Hosting',  cls: 'bg-orange-50 text-orange-600' },
                      { href: '/dashboard/invoices', icon: FileText,     label: 'Invoices',        cls: 'bg-indigo-50 text-indigo-600' },
                      { href: '/dashboard/settings', icon: SettingsIcon, label: 'Account Settings',cls: 'bg-purple-50 text-purple-600' },
                    ].map(({ href, icon: Icon, label, cls }) => (
                      <button
                        key={href}
                        onClick={() => router.push(href)}
                        className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left group"
                      >
                        <div className={`p-2 rounded-lg ${cls} group-hover:scale-110 transition-transform`}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <span className="text-sm font-semibold text-gray-700 flex-1">{label}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-gray-300 group-hover:text-blue-500 group-hover:translate-x-0.5 transition-all" />
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </div>
    </UserLayout>
  );
}