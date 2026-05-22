'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  AlertTriangle,
  Clock,
  Loader2,
  Trash2,
  RefreshCw,
  ArrowLeft,
  XCircle,
  CheckCircle,
  CheckCircle2,
  Server,
  Mail,
  User as UserIcon,
  Inbox,
} from 'lucide-react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminPendingDomainsPageSkeleton, AdminTableRowsSkeleton } from '@/components/skeletons/PageSkeletons';
import Modal from '@/components/Modal';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { performLogout } from '@/lib/logout';
import { formatIndianDateTime } from '@/lib/dateUtils';
import toast from 'react-hot-toast';
import { logger } from '@/lib/logger';

interface User {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

interface PendingHostingItem {
  _id: string;
  userId: {
    _id: string;
    name: string;
    email: string;
  };
  domain: string;
  package: string;
  daUsername: string;
  error: string;
  status: string;
  createdAt: string;
}

export default function AdminPendingHostingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingItems, setPendingItems] = useState<PendingHostingItem[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);

  // State for actions
  const [isRetrying, setIsRetrying] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<PendingHostingItem | null>(null);

  const router = useRouter();
  const { data: session, status } = useSession();

  // Auth Check
  useEffect(() => {
    if (status === 'loading') return;

    if (session?.user) {
      const userObj = {
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        email: session.user.email || '',
        role: session.user.role || 'user',
      };

      if (userObj.role !== 'admin') {
        router.push('/dashboard');
        return;
      }

      setUser(userObj);
      setIsLoading(false);
      return;
    }

    router.push('/login');
  }, [router, session, status]);

  // Fetch Pending Data
  const fetchPendingData = async () => {
    try {
      setIsLoadingData(true);

      const res = await fetch('/api/v1/admin/hosting/pending', { credentials: 'include' });
      const data = await res.json();

      if (data.success) {
        setPendingItems(data.data);
      } else {
        toast.error('Failed to fetch pending hosting data');
      }
    } catch (error) {
      logger.error('Error fetching pending data:', error);
      toast.error('Error loading pending data');
    } finally {
      setIsLoadingData(false);
    }
  };

  useEffect(() => {
    if (user) {
      void fetchPendingData();
    }
  }, [user]);

  const handleRetry = async (id: string) => {
    try {
      setIsRetrying(id);

      const res = await fetch(`/api/v1/admin/hosting/pending/${id}/retry`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();

      if (data.success) {
        toast.success(data.message || 'Provisioning retried successfully');
        void fetchPendingData(); // Refresh list to remove the item
      } else {
        toast.error(data.message || 'Retry failed');
        // Refresh to show updated error
        void fetchPendingData();
      }
    } catch (error) {
      toast.error("An error occurred during retry");
    } finally {
      setIsRetrying(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDeleteItem) return;
    const id = pendingDeleteItem._id;
    try {
      setIsDeleting(id);

      const res = await fetch(`/api/v1/admin/hosting/pending/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        toast.success('Entry removed');
        setPendingItems(prev => prev.filter(item => item._id !== id));
        setPendingDeleteItem(null);
      } else {
        toast.error('Failed to delete entry');
      }
    } catch (error) {
      toast.error('Error deleting entry');
    } finally {
      setIsDeleting(null);
    }
  };

  if (isLoading || !user) {
    return (
      <AdminLayoutSkeleton>
        <AdminPendingDomainsPageSkeleton />
      </AdminLayoutSkeleton>
    );
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/admin/hosting')}
              className="p-2 hover:bg-gray-100 rounded-xl transition-colors text-gray-500 border border-gray-200 bg-white shadow-sm"
              title="Back to hosting"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="p-2 bg-amber-50 rounded-xl">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Pending Hosting Provisions</h1>
              <p className="text-sm text-gray-500 mt-0.5">Review and retry hosting accounts that failed to provision on DirectAdmin.</p>
            </div>
          </div>
          <RefreshButton onClick={fetchPendingData} isLoading={isLoadingData} />
        </div>

        {/* ── Pending list card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden min-h-[400px]">
          {/* Card header */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <Server className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">Failed Provisions</h3>
              <span className="inline-flex items-center text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
                {pendingItems.length}
              </span>
            </div>
          </div>

          {isLoadingData ? (
            <AdminTableRowsSkeleton rows={5} cols={5} />
          ) : pendingItems.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <div className="w-14 h-14 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="h-7 w-7 text-green-600" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1.5">All caught up</h3>
              <p className="text-sm text-gray-500 mb-5">No failed provisions pending.</p>
              <button
                onClick={() => router.push('/admin/hosting')}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Hosting Management
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/60 border-b border-gray-100">
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">User & Domain</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Package / DA User</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Error Details</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pendingItems.map((item) => (
                    <tr key={item._id} className="hover:bg-blue-50/30 transition-colors group">
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0 h-9 w-9 bg-amber-50 rounded-xl flex items-center justify-center">
                            <Server className="h-4 w-4 text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900">{item.domain}</p>
                            <p className="text-xs text-gray-500 truncate">
                              {item.userId?.email || 'Unknown user'}
                            </p>
                            {item.userId?.name && (
                              <p className="text-[11px] text-gray-400">{item.userId.name}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <p className="text-sm font-medium text-gray-900">{item.package}</p>
                        <p className="text-xs text-gray-400 font-mono mt-0.5">DA: {item.daUsername}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-start gap-2 max-w-md p-2 bg-red-50 border border-red-100 rounded-lg">
                          <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                          <span className="text-xs text-red-700 font-mono break-words leading-relaxed">{item.error}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                          <Clock className="h-3 w-3" />
                          {formatIndianDateTime(item.createdAt)}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleRetry(item._id)}
                            disabled={isRetrying === item._id || isDeleting === item._id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 transition-colors shadow-sm"
                          >
                            {isRetrying === item._id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                            Retry
                          </button>
                          <button
                            onClick={() => setPendingDeleteItem(item)}
                            disabled={isRetrying === item._id || isDeleting === item._id}
                            title="Remove entry"
                            className="inline-flex items-center justify-center w-7 h-7 text-red-500 hover:text-red-700 hover:bg-red-50 border border-gray-200 rounded-lg disabled:opacity-50 transition-colors"
                          >
                            {isDeleting === item._id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Remove-entry confirmation modal ── */}
      <Modal
        isOpen={!!pendingDeleteItem}
        onClose={() => !isDeleting && setPendingDeleteItem(null)}
        title="Remove Pending Entry?"
        size="md"
      >
        {pendingDeleteItem && (
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-3 p-3.5 bg-amber-50 border border-amber-200 rounded-xl">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-semibold mb-0.5">This won't delete the hosting account</p>
                <p className="text-xs">Only the pending-provision record is removed. The customer's payment record stays intact, and you can manually create the hosting account later.</p>
              </div>
            </div>

            <div className="space-y-2 p-4 bg-gray-50 border border-gray-100 rounded-xl">
              <div className="flex items-center gap-2 text-sm">
                <Server className="h-3.5 w-3.5 text-gray-400" />
                <span className="text-gray-500">Domain</span>
                <span className="font-mono font-semibold text-gray-900 ml-auto">{pendingDeleteItem.domain}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-3.5 w-3.5 text-gray-400" />
                <span className="text-gray-500">Customer</span>
                <span className="text-gray-900 ml-auto truncate">{pendingDeleteItem.userId?.email || 'Unknown'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <UserIcon className="h-3.5 w-3.5 text-gray-400" />
                <span className="text-gray-500">DA Username</span>
                <span className="font-mono text-gray-900 ml-auto">{pendingDeleteItem.daUsername}</span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setPendingDeleteItem(null)}
                disabled={!!isDeleting}
                className="px-4 py-2 text-sm font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={!!isDeleting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors disabled:opacity-50 shadow-sm"
              >
                {isDeleting === pendingDeleteItem._id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Remove Entry
              </button>
            </div>
          </div>
        )}
      </Modal>
    </AdminLayout>
  );
}
