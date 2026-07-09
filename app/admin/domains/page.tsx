'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Globe,
  Search,
  RefreshCw,
  Clock,
  CheckCircle,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Loader2,
  Filter,
  MoreVertical,
  Eye,
  Settings,
  Network,
  Inbox,
  Trash2,
} from 'lucide-react';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton, AdminTableRowsSkeleton } from '@/components/skeletons/PageSkeletons';
import ActionMenu from '@/components/admin/ActionMenu';
import { performLogout } from '@/lib/logout';
import toast from 'react-hot-toast';
import { formatIndianDateTime } from '@/lib/dateUtils';
import { apiClient } from '@/lib/api-client';

interface Domain {
  id: string;
  name: string;
  customerName: string;
  customerEmail: string;
  status: string;
  expiresAt: string;
  dnsActivated: boolean;
  orderId: string;
}

export default function AdminDomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Pre-fill searchTerm from `?q=` so deep-links from other admin
  // surfaces (e.g. the Domains rows in the User Services modal in
  // /admin/user-management) land the operator on a pre-filtered list.
  // Falls back to '' when no `q` is present.
  const searchParams = useSearchParams();
  const [searchTerm, setSearchTerm] = useState(() => searchParams?.get('q') ?? '');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeDomainLoad, setActiveDomainLoad] = useState<string | null>(null);

  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const [user, setUser] = useState<{
    firstName: string;
    lastName: string;
    email: string;
    role: string;
  } | null>(null);

  // Action Menu State
  const [menuData, setMenuData] = useState<{
    id: string;
    x: number;
    y: number;
    domain: Domain;
  } | null>(null);

  const handleTripleDotClick = (e: React.MouseEvent, d: Domain) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuData({
      id: d.id,
      x: e.clientX,
      y: e.clientY,
      domain: d
    });
  };

  const handleContextMenu = (e: React.MouseEvent, d: Domain) => {
    e.preventDefault();
    setMenuData({
      id: d.id,
      x: e.clientX,
      y: e.clientY,
      domain: d
    });
  };

  const closeMenu = () => setMenuData(null);

  useEffect(() => {
    if (sessionStatus === 'loading') return;

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
      void fetchDomains();
      return;
    }

    router.push('/login');
  }, [router, session, sessionStatus]);

  const fetchDomains = async () => {
    setIsLoading(true);
    const result = await apiClient.get<{ success?: boolean; domains?: Domain[] }>('/api/v1/admin/domains');
    if (result.ok && result.data.success) {
      setDomains(result.data.domains || []);
    } else if (result.ok) {
      toast.error('Failed to fetch domains');
    } else {
      toast.error('Error loading data');
    }
    setIsLoading(false);
  };

  const filteredDomains = domains.filter(domain => {
    const matchesSearch = domain.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      domain.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      domain.customerEmail.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || domain.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'registered':
      case 'active':
        return 'bg-green-50 text-green-700 border-green-200';
      case 'expired':
        return 'bg-red-50 text-red-700 border-red-200';
      case 'pending':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      default:
        return 'bg-gray-100 text-gray-600 border-gray-200';
    }
  };

  const AnimatedLoading = () => {
    const [dots, setDots] = useState('');
    useEffect(() => {
      const interval = setInterval(() => {
        setDots(prev => (prev.length >= 3 ? '' : prev + '.'));
      }, 500);
      return () => clearInterval(interval);
    }, []);
    return <span className="inline-block w-6 text-left">{dots}</span>;
  };

  const handleSync = async (domain: Domain) => {
    toast.loading(`Syncing ${domain.name} with registrar...`, { id: `sync-${domain.id}` });
    const result = await apiClient.post<{ success?: boolean }>('/api/v1/admin/domains/sync', {
      domainName: domain.name,
    });

    if (result.ok) {
      if (result.data.success) {
        toast.success(`${domain.name} synced successfully`, { id: `sync-${domain.id}` });
        void fetchDomains(); // Refresh the list
      } else {
        toast.error('Sync failed', { id: `sync-${domain.id}` });
      }
    } else if (result.error.status === 0) {
      toast.error('Network error during sync', { id: `sync-${domain.id}` });
    } else {
      toast.error(result.error.message || 'Sync failed', { id: `sync-${domain.id}` });
    }
  };

  const handleRemoveFromPanel = async (domain: Domain) => {
    const ok = window.confirm(
      `Remove ${domain.name} from the panel?\n\nUse this ONLY for domains transferred out to another registrar account or legacy/test domains. It soft-deletes the domain (reversible for 90 days), hides it from the customer + this list, and does NOT touch billing/order records or the registrar.`
    );
    if (!ok) return;
    toast.loading(`Removing ${domain.name}…`, { id: `rm-${domain.id}` });
    const result = await apiClient.delete(`/api/v1/admin/domains?domainName=${encodeURIComponent(domain.name)}`);
    if (result.ok) {
      toast.success(`${domain.name} removed from panel`, { id: `rm-${domain.id}` });
      void fetchDomains();
    } else {
      toast.error(result.error.message || 'Failed to remove domain', { id: `rm-${domain.id}` });
    }
  };

  if (!user) {
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Globe className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Domain Management</h1>
              <p className="text-sm text-gray-500 mt-0.5">Monitor and manage all registered domains</p>
            </div>
          </div>
          <RefreshButton onClick={fetchDomains} isLoading={isLoading} />
        </div>

        {/* ── Domains list card (filters folded into header) ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden min-h-[400px]">
          {/* Card header: title + search + filter */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Globe className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">All Domains</h3>
              <span className="inline-flex items-center text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
                {filteredDomains.length}
              </span>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by domain, customer or email…"
                  className="w-full sm:w-72 pl-10 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Filter className="h-3.5 w-3.5 text-gray-400" />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="sm:w-40 px-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                >
                  <option value="all">All Statuses</option>
                  <option value="registered">Registered</option>
                  <option value="expired">Expired</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
            </div>
          </div>

          {isLoading ? (
            <AdminTableRowsSkeleton rows={6} cols={5} />
          ) : filteredDomains.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Inbox className="h-7 w-7 text-gray-400" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No domains found</h3>
              <p className="text-sm text-gray-500">Try adjusting your search or filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/60 border-b border-gray-100">
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Domain</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Expiry Date</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredDomains.map((domain) => {
                    const isExpired = domain.expiresAt && new Date(domain.expiresAt) < new Date();
                    const isMenuActive = menuData?.id === domain.id;
                    return (
                      <tr
                        key={domain.id}
                        className={`hover:bg-blue-50/30 transition-colors group/row ${isMenuActive ? 'bg-blue-50/60' : ''}`}
                        onContextMenu={(e) => handleContextMenu(e, domain)}
                      >
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className={`flex-shrink-0 h-9 w-9 rounded-xl flex items-center justify-center transition-colors ${isMenuActive ? 'bg-blue-100' : 'bg-blue-50 group-hover/row:bg-blue-100'}`}>
                              <Globe className="h-4 w-4 text-blue-600" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900">{domain.name}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                ID: <span className="font-mono">{domain.orderId}</span>
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <p className="text-sm font-medium text-gray-900">{domain.customerName}</p>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{domain.customerEmail}</p>
                        </td>
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5 flex-wrap">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusColor(domain.status)}`}>
                              {domain.status?.toLowerCase() === 'registered' || domain.status?.toLowerCase() === 'active'
                                ? <CheckCircle2 className="h-3 w-3" />
                                : domain.status?.toLowerCase() === 'expired'
                                  ? <AlertTriangle className="h-3 w-3" />
                                  : <Clock className="h-3 w-3" />}
                              <span className="capitalize">{domain.status}</span>
                            </span>
                            {domain.dnsActivated && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                <Network className="h-2.5 w-2.5" />
                                DNS
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className={`text-sm font-medium ${isExpired ? 'text-red-600' : 'text-gray-800'}`}>
                            {domain.expiresAt ? formatIndianDateTime(domain.expiresAt) : 'N/A'}
                          </div>
                          {isExpired && (
                            <div className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 mt-0.5">
                              <AlertTriangle className="h-3 w-3" />
                              EXPIRED
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3.5 whitespace-nowrap text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <a
                              href={`http://${domain.name}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open website"
                              className="inline-flex items-center justify-center w-7 h-7 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                            <button
                              onClick={() => router.push(`/admin/dns-management?domainId=${domain.id}`)}
                              title="Manage DNS"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
                            >
                              <Network className="h-3.5 w-3.5" />
                              <span className="hidden lg:inline">DNS</span>
                            </button>
                            <button
                              onClick={(e) => handleTripleDotClick(e, domain)}
                              title="More actions"
                              className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${isMenuActive ? 'text-blue-700 bg-blue-100' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <ActionMenu
          isOpen={!!menuData}
          onClose={closeMenu}
          anchorPoint={{ x: menuData?.x || 0, y: menuData?.y || 0 }}
          items={menuData ? [
            {
              label: 'View Website',
              icon: Globe,
              onClick: () => window.open(`http://${menuData.domain.name}`, '_blank')
            },
            {
              label: 'Sync with Registrar',
              icon: RefreshCw,
              onClick: () => handleSync(menuData.domain),
              variant: 'info' as const
            },
            {
              label: 'Manage DNS',
              icon: Settings,
              onClick: () => {
                setActiveDomainLoad(menuData.domain.id);
                router.push(`/admin/dns-management?domainId=${menuData.domain.id}`);
              },
              variant: 'info' as const
            },
            {
              label: 'View Order',
              icon: Eye,
              onClick: () => router.push(`/admin/order-management?search=${menuData.domain.orderId}`)
            },
            {
              label: 'Remove from panel',
              icon: Trash2,
              onClick: () => handleRemoveFromPanel(menuData.domain),
              variant: 'danger' as const
            }
          ] : []}
        />
      </div>
    </AdminLayout>
  );
}
