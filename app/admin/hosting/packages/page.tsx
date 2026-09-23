'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Package,
  Loader2,
  HardDrive,
  Wifi,
  ArrowLeft,
  AlertTriangle,
  Eye,
  X,
  Settings
} from 'lucide-react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminHostingPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { performLogout } from '@/lib/logout';
import { apiClient } from '@/lib/api-client';
import toast from 'react-hot-toast';

interface User {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

interface HostingOnePackage {
  _id: string;
  planId: string;
  name: string;
  price: number;
  renewalPrice: number;
  quota: number; // MB
  bandwidth: number; // MB
  features: string[];
  directAdminPackage: string;
  isActive: boolean;
  details?: Record<string, unknown>;
  razorpayPlans?: {
    monthly?: string;
    yearly?: string;
  };
}

export default function AdminPackagesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [packages, setPackages] = useState<HostingOnePackage[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [selectedPkg, setSelectedPkg] = useState<HostingOnePackage | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingPkg, setEditingPkg] = useState<Partial<HostingOnePackage> | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const router = useRouter();
  const { data: session, status } = useSession();

  // ... (Auth Logic Remains Same)
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

  const [isServerDown, setIsServerDown] = useState(false);

  const fetchPackages = async () => {
    setIsLoadingData(true);
    setIsServerDown(false);
    const result = await apiClient.get<{ success?: boolean; data?: HostingOnePackage[]; message?: string; code?: string }>('/api/v1/admin/hosting/packages');
    if (!result.ok) {
      if (result.error.status === 503 || result.error.code === 'DA_SERVER_DOWN') {
        setIsServerDown(true);
        setPackages([]);
      } else {
        toast.error(result.error.status === 0 ? 'Error loading package data' : result.error.message || 'Failed to fetch packages');
      }
      setIsLoadingData(false);
      return;
    }
    if (result.data.code === 'DA_SERVER_DOWN') {
      setIsServerDown(true);
      setPackages([]);
    } else if (result.data.success) {
      setPackages(result.data.data || []);
    } else {
      toast.error(result.data.message || 'Failed to fetch packages');
    }
    setIsLoadingData(false);
  };

  useEffect(() => {
    if (user) void fetchPackages();
  }, [user]);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPkg?._id) return;

    setIsUpdating(true);
    const result = await apiClient.patch<{ success?: boolean; message?: string }>('/api/v1/admin/hosting/packages', {
      id: editingPkg._id,
      name: editingPkg.name,
      price: editingPkg.price,
      renewalPrice: editingPkg.renewalPrice,
    });
    if (result.ok && result.data.success) {
      toast.success('Package updated successfully');
      setIsEditModalOpen(false);
      void fetchPackages();
    } else if (result.ok) {
      toast.error(result.data.message || 'Update failed');
    } else {
      toast.error(result.error.status === 0 ? 'Error updating package' : result.error.message || 'Update failed');
    }
    setIsUpdating(false);
  };

  const formatUnit = (mb: number) => {
    if (mb === -1) return 'Unlimited';
    if (!mb) return '0 MB';
    if (mb >= 1024) return `${parseFloat((mb / 1024).toFixed(2))} GB`;
    return `${mb} MB`;
  };

  if (isLoading || !user) {
    return (
      <AdminHostingPageSkeleton />
    );
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">
        <div className="bg-paper rounded-xl shadow-sm border border-hairline p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <button onClick={() => router.push('/admin/hosting')} className='text-ink-4 hover:text-ink-2 transition-colors'>
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <h1 className="text-2xl font-serif font-bold text-ink">Hosting Packages</h1>
              </div>
              <p className="text-ink-2">Manage pricing and renewal settings for hosting plans</p>
            </div>
          </div>
        </div>

        {isServerDown && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-r-lg shadow-sm">
            <div className="flex items-center">
              <AlertTriangle className="h-5 w-5 text-red-500 mr-3" />
              <div>
                <p className="text-sm text-red-700 font-medium text-bold">DirectAdmin Server Offline</p>
                <p className="text-sm text-red-600">Plan details are using cached database values.</p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-paper rounded-xl shadow-sm border border-hairline overflow-hidden min-h-[400px]">
          {isLoadingData ? (
            <div className="px-6 py-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex gap-6 py-4 border-b border-hairline last:border-0 items-center">
                  <div className="skeleton h-4 rounded w-40" />
                  <div className="skeleton h-4 rounded w-20" />
                  <div className="skeleton h-4 rounded w-20" />
                  <div className="skeleton h-4 rounded w-32" />
                  <div className="skeleton h-4 rounded w-32" />
                  <div className="skeleton h-4 rounded w-16 ml-auto" />
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-hairline">
                <thead className="bg-paper-2/60">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-3 uppercase">Package Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-3 uppercase">Current Price</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-3 uppercase">Renewal Price</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-3 uppercase">Monthly Plan</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-3 uppercase">Yearly Plan</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-ink-3 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-paper divide-y divide-hairline text-sm">
                  {packages.map((pkg) => (
                    <tr key={pkg._id} className="hover:bg-paper-2">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <Package className="h-5 w-5 text-indigo-500 mr-3" />
                          <div>
                            <div className="font-medium text-ink">{pkg.name}</div>
                            <div className="text-xs text-ink-3 font-mono">{pkg.directAdminPackage}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap font-semibold">₹{pkg.price}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-amber-ink font-semibold">₹{pkg.renewalPrice || pkg.price}</td>
                      <td className="px-6 py-4 whitespace-nowrap font-mono text-xs">
                        {pkg.razorpayPlans?.monthly ? (
                          <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded border border-green-200">{pkg.razorpayPlans.monthly}</span>
                        ) : (
                          <span className="text-ink-4 italic">None</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap font-mono text-xs">
                        {pkg.razorpayPlans?.yearly ? (
                          <span className="bg-indigo-soft text-indigo-ink px-1.5 py-0.5 rounded border border-indigo/25">{pkg.razorpayPlans.yearly}</span>
                        ) : (
                          <span className="text-ink-4 italic">None</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right space-x-2">
                        <button
                          onClick={() => setSelectedPkg(pkg)}
                          className="bg-paper-2 text-ink-2 hover:bg-hairline p-2 rounded-lg transition-colors"
                          title="View Specs"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => {
                            setEditingPkg(pkg);
                            setIsEditModalOpen(true);
                          }}
                          className="bg-amber-soft text-amber-ink hover:brightness-95 p-2 rounded-lg transition-all"
                          title="Edit Pricing"
                        >
                          <Settings className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {isEditModalOpen && editingPkg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-paper rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 border-b border-hairline bg-paper-2/60 flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold text-ink">Edit Pricing</h3>
                <p className="text-xs text-ink-3">{editingPkg.directAdminPackage}</p>
              </div>
              <button onClick={() => setIsEditModalOpen(false)} className="text-ink-4 hover:text-ink-2">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleUpdate} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-ink-3 uppercase tracking-wider mb-1">Display Name</label>
                <input
                  type="text"
                  value={editingPkg.name || ''}
                  onChange={e => setEditingPkg({ ...editingPkg, name: e.target.value })}
                  className="w-full px-3 py-2 border border-hairline rounded-lg focus:ring-2 focus:ring-amber"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-ink-3 uppercase tracking-wider mb-1">Initial Price (₹)</label>
                  <input
                    type="number"
                    step="any"
                    value={editingPkg.price || 0}
                    onChange={e => setEditingPkg({ ...editingPkg, price: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-hairline rounded-lg focus:ring-2 focus:ring-amber"
                    required
                  />
                  <p className="text-[10px] text-ink-4 mt-1">One-time entry fee</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-3 uppercase tracking-wider mb-1">Renewal Price (₹)</label>
                  <input
                    type="number"
                    step="any"
                    value={editingPkg.renewalPrice || editingPkg.price || 0}
                    onChange={e => setEditingPkg({ ...editingPkg, renewalPrice: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-hairline rounded-lg focus:ring-2 focus:ring-amber"
                    required
                  />
                  <p className="text-[10px] text-amber-ink mt-1">Automated recurring fee</p>
                </div>
              </div>

              <div className="pt-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="flex-1 py-2 bg-paper-2 text-ink-2 rounded-lg hover:bg-hairline font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdating}
                  className="flex-1 py-2 bg-amber text-white rounded-lg hover:brightness-90 font-medium flex items-center justify-center gap-2"
                >
                  {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Details Modal */}
      {selectedPkg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-paper rounded-xl shadow-xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-hairline flex justify-between items-center bg-paper-2/60">
              <div>
                <h3 className="text-lg font-bold text-ink">Technical Specs</h3>
                <p className="text-sm text-ink-3">{selectedPkg.name}</p>
              </div>
              <button onClick={() => setSelectedPkg(null)} className="text-ink-4 hover:text-ink-2">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div className="bg-paper-2/60 p-4 rounded-lg border border-hairline">
                    <span className="text-[10px] uppercase font-bold text-ink-4 block tracking-widest mb-1">Storage</span>
                    <span className="text-sm font-mono">{formatUnit(selectedPkg.quota)}</span>
                  </div>
                  <div className="bg-paper-2/60 p-4 rounded-lg border border-hairline">
                    <span className="text-[10px] uppercase font-bold text-ink-4 block tracking-widest mb-1">Bandwidth</span>
                    <span className="text-sm font-mono">{formatUnit(selectedPkg.bandwidth)}</span>
                  </div>
                  {selectedPkg.details && Object.entries(selectedPkg.details).map(([key, value]) => {
                    if (typeof value === 'object' || key === 'feature_list' || key === 'quota' || key === 'bandwidth') return null;
                    return (
                      <div key={key} className="bg-paper-2/60 p-4 rounded-lg border border-hairline">
                        <span className="text-[10px] uppercase font-bold text-ink-4 block tracking-widest mb-1">{key.replace(/_/g, ' ')}</span>
                        <span className="text-sm font-mono truncate block" title={String(value)}>{String(value)}</span>
                      </div>
                    );
                  })}
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
