'use client';

import { useState, useEffect, useTransition, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Server,
  Search,
  MoreVertical,
  CheckCircle,
  AlertTriangle,
  Clock,
  Shield,
  Loader2,
  ExternalLink,
  Filter,
  Plus,
  X,
  Eye,
  Package,
  Link2Off,
  Edit,
  Wifi,
  Settings,
  RefreshCw,
  CheckCircle2,
  HardDrive,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import ActionMenu from '@/components/admin/ActionMenu';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton, AdminTableRowsSkeleton } from '@/components/skeletons/PageSkeletons';
import { performLogout } from '@/lib/logout';
import toast from 'react-hot-toast';
import { formatBytes } from '@/lib/format-utils';
import { getRelativeTime, formatIndianDateTime } from '@/lib/dateUtils';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';

interface User {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

interface HostingUsage {
  bandwidth: string;
  disk: string;
  bandwidthLimit: string;
  diskLimit: string;
}

interface HostingData {
  id: string;
  dbId?: string;
  user: { name: string; email: string };
  domain: string;
  status: string;
  serverIp: string;
  usage: HostingUsage;
  package: string;
  phpVersion?: string;

  expiryDate: string | null;
  createdDate: string | null;
  daUsername: string;
  isUnlinked?: boolean;
  linkedByEmail?: boolean;
  error?: string;
  // Recurring-payment metadata. Subscriptions-API path populates
  // `subscriptionId`; Tokens-API path populates `razorpayCustomerId`
  // + `razorpayTokenId`. `billingType` captures the high-level mode
  // ('subscription' | 'manual'); `isTrial` is set for active 15-day
  // free trials. Surfaced in the detail modal so an operator triaging
  // a stuck mandate can pivot to Razorpay dashboard via the IDs.
  subscriptionId?: string | null;
  razorpayCustomerId?: string | null;
  razorpayTokenId?: string | null;
  isTrial?: boolean;
  billingType?: string | null;
}

export default function AdminHostingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [hostingData, setHostingData] = useState<HostingData[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  // Filter rows by customer type: 'all' (default), 'trial' (isTrial=true only),
  // or 'paid' (isTrial=false only). Lets the operator slice the table to
  // "who's still on free trial" vs "who's actually paying" — common
  // operational ask especially in the first weeks of a launch.
  const [customerTypeFilter, setCustomerTypeFilter] = useState<'all' | 'trial' | 'paid'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  // Pagination transition state — marks page-change updates as a React
  // transition so we can show a "pending" overlay during reconciliation.
  // Without this, clicking Prev/Next has no visual feedback between the
  // click and the table re-render (10 rows of complex content take
  // 100-300ms to reconcile on slower machines); admin reads that gap as
  // "did my click register?" and may double-click. Fix gives the table
  // a brief opacity dip + disables the buttons while pending.
  const [isPaginating, startPaginationTransition] = useTransition();
  // Ref to the table container so we can scroll the new page's top into
  // view on page-change — otherwise the user lands at whatever scroll
  // position they had before clicking Next/Prev and may not realize the
  // page actually changed.
  const tableTopRef = useRef<HTMLDivElement | null>(null);
  // Guard against repeated fetches caused by session-reference churn.
  // Without this, NextAuth's `refetchOnWindowFocus: true` default makes
  // useSession() return a NEW session object reference every time the
  // window regains focus (even if the underlying session content is
  // identical). The auth-check useEffect's deps array includes
  // `session`, so each refocus re-fires the effect → fetchHostingData
  // runs again → two-pass flow restarts → table briefly drops to 10
  // rows → pagination disappears → admin sees a "loop". This ref makes
  // the data fetch run exactly once per page-mount; the operator hits
  // the Refresh button for explicit updates.
  const hasFetchedHostingsRef = useRef(false);
  const [daMode, setDaMode] = useState<string>('Live'); // Default to Live, update from API

  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);
  const [daError, setDaError] = useState<string | null>(null);

  // Provisioning Modal State
  interface HostingPackage {
    _id?: string;
    planId?: string;
    name: string;
    price?: number;
    serverPackage?: string;
    directAdminPackage?: string;
    description?: string;
  }
  interface PickerUser {
    id: string;
    name: string;
    email: string;
  }
  interface HostingDetails {
    daUsername?: string;
    username?: string;
    domain?: string;
    package?: string;
    status?: string;
    phpVersion?: string;
    php?: string;
    ip?: string;
    usage?: {
      bandwidth?: string;
      disk?: string;
      bandwidthLimit?: string;
      diskLimit?: string;
      subdomains?: { used: string; limit: string };
      ftp?: { used: string; limit: string };
      emails?: { used: string; limit: string };
      databases?: { used: string; limit: string };
    };
    user?: { name?: string; email?: string };
    expiryDate?: string;
    createdDate?: string;
    serverIp?: string;
    nameservers?: string[];
    features?: Record<string, boolean>;
    type?: string;
    created?: string;
    [k: string]: unknown;
  }
  const [showProvisionModal, setShowProvisionModal] = useState(false);
  const [availablePackages, setAvailablePackages] = useState<HostingPackage[]>([]);
  const [usersNoHosting, setUsersNoHosting] = useState<PickerUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [provisionDomain, setProvisionDomain] = useState('');
  const [selectedPackage, setSelectedPackage] = useState('');
  const [daUsername, setDaUsername] = useState('');
  const [validityPeriod, setValidityPeriod] = useState(12); // Default 12 months
  const [validityUnit, setValidityUnit] = useState<'months'>('months');
  const [provisionPrice, setProvisionPrice] = useState<number>(0);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [isLoadingProvisionDeps, setIsLoadingProvisionDeps] = useState(false);

  // Details Modal State
  const [selectedDetails, setSelectedDetails] = useState<HostingDetails | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  // Change Package Modal State
  const [showChangePackageModal, setShowChangePackageModal] = useState(false);
  const [changePackageUser, setChangePackageUser] = useState<{ username: string, currentPackage: string } | null>(null);
  const [newPackage, setNewPackage] = useState('');
  const [isChangingPackage, setIsChangingPackage] = useState(false);

  // Delete Modal State
  const [deleteModal, setDeleteModal] = useState({ show: false, username: '', domain: '', hostingId: '' });
  const [isDeleting, setIsDeleting] = useState(false);

  const router = useRouter();
  const { data: session, status } = useSession();
  const [mounted, setMounted] = useState(false);

  // Action Menu State
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [menuData, setMenuData] = useState<HostingData | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auth Check
  useEffect(() => {
    if (status === 'loading') return;

    if (session?.user) {
      const sessionUser = session.user;
      const userObj = {
        firstName: sessionUser.name?.split(' ')[0] || '',
        lastName: sessionUser.name?.split(' ').slice(1).join(' ') || '',
        email: sessionUser.email || '',
        role: sessionUser.role || 'user',
      };

      if (userObj.role !== 'admin') {
        router.push('/dashboard');
        return;
      }

      setUser(userObj);
      setIsAuthLoading(false);
      // Guard: fetch only once per page-mount. See `hasFetchedHostingsRef`
      // declaration for the full incident note (NextAuth refetchOnWindowFocus
      // session-reference churn would otherwise loop us through the two-pass
      // hostings fetch on every window focus, transiently dropping the table
      // back to 10 rows and making pagination flicker out).
      if (!hasFetchedHostingsRef.current) {
        hasFetchedHostingsRef.current = true;
        void fetchHostingData();
      }
      return;
    }

    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, session, status]);


  // Auto-calculate provision price
  useEffect(() => {
    if (selectedPackage) {
      const pkg = availablePackages.find(p => (p.directAdminPackage || p.name) === selectedPackage);
      if (pkg) {
        const totalPrice = Number(((pkg.price ?? 0) * validityPeriod).toFixed(2));
        setProvisionPrice(totalPrice);
      }
    }
  }, [selectedPackage, validityPeriod, availablePackages]);

  // Server Down State
  const [isServerDown, setIsServerDown] = useState(false);



  /**
   * Fetch hosting accounts via a two-pass lazy-load:
   *
   *   Pass 1 — `?firstPage=10` returns the first 10 accounts quickly so the
   *            table paints with real data immediately. `setIsDataLoading`
   *            clears here so the skeleton goes away after only N×config+N×usage
   *            DA round-trips (~1-2s typical), not all-31×... (~4-8s typical).
   *
   *   Pass 2 — backgrounds a no-param request (returns every account) and
   *            silently swaps state in when it lands. The user sees the table
   *            grow from 10 → 31 rows over a few seconds, no spinner.
   *
   * Skipped when there are <= 10 accounts on the server (pass 1's `total`
   * count matches the returned size, so no background fetch is needed).
   */
  const fetchHostingData = async () => {
    setIsDataLoading(true);
    setIsServerDown(false); // Reset

    // PASS 1 — fast first-page
    const firstResult = await apiClient.get<{
      success?: boolean;
      data?: HostingData[];
      daMode?: string;
      isDaConnected?: boolean;
      daError?: string;
      message?: string;
      error?: string;
      code?: string;
      pagination?: { returned?: number; total?: number; truncated?: boolean };
    }>(`/api/v1/admin/hosting/stats?firstPage=10&t=${Date.now()}`);

    if (!firstResult.ok) {
      setIsServerDown(true);
      if (firstResult.error.status === 503 || firstResult.error.code === 'DA_SERVER_DOWN' || firstResult.error.status === 0) {
        setDaError(firstResult.error.message || 'DirectAdmin server is unreachable');
      } else {
        setDaError(firstResult.error.message || 'Network error or system failure');
        toast.error('Error loading hosting data');
      }
      setHostingData([]);
      setIsDataLoading(false);
      return;
    }

    const firstData = firstResult.data;
    if (!firstData) {
      setIsServerDown(true);
      setDaError('Server returned an invalid response (non-JSON)');
      setHostingData([]);
      setIsDataLoading(false);
      return;
    }
    if (firstData.error === 'DA_SERVER_DOWN' || firstData.code === 'DA_SERVER_DOWN') {
      setIsServerDown(true);
      setDaError(firstData.message || 'DirectAdmin server is unreachable');
      setHostingData([]);
      setIsDataLoading(false);
      return;
    }

    if (firstData.success) {
      const incoming = firstData.data ?? [];
      const uniqueData = Array.from(new Map(incoming.map((item) => [item.id, item])).values());
      setHostingData(uniqueData);
      if (firstData.daMode) setDaMode(firstData.daMode);
      setIsServerDown(!firstData.isDaConnected);
      setDaError(firstData.daError || null);
    } else {
      toast.error('Failed to fetch hosting data');
      setDaError(firstData.message || 'Unknown API error');
      setIsDataLoading(false);
      return;
    }
    setIsDataLoading(false);

    // PASS 2 — background backfill IF there are more rows beyond the first 10
    if (firstData.pagination?.truncated) {
      // No loading state — silent fill-in. Errors here are swallowed so a
      // background failure doesn't disrupt the table the user is already
      // looking at; the first 10 rows remain valid.
      const fullResult = await apiClient.get<{
        success?: boolean;
        data?: HostingData[];
      }>(`/api/v1/admin/hosting/stats?t=${Date.now()}`);

      if (fullResult.ok && fullResult.data?.success && fullResult.data.data) {
        const fullData = Array.from(new Map(fullResult.data.data.map((item) => [item.id, item])).values());
        setHostingData(fullData);
      }
    }
  };

  const fetchProvisionDeps = async () => {
    setIsLoadingProvisionDeps(true);

    const [pkgResult, userResult] = await Promise.all([
      apiClient.get<{ success?: boolean; data?: HostingPackage[]; error?: string; code?: string }>('/api/v1/admin/hosting/packages'),
      apiClient.get<{ success?: boolean; data?: PickerUser[] }>('/api/v1/admin/users/no-hosting'),
    ]);

    // DirectAdmin unreachable — surfaced either as a 503/DA_SERVER_DOWN error or inside a 200 body
    const pkgDaDown =
      (!pkgResult.ok && (pkgResult.error.status === 503 || pkgResult.error.code === 'DA_SERVER_DOWN')) ||
      (pkgResult.ok && (pkgResult.data?.error === 'DA_SERVER_DOWN' || pkgResult.data?.code === 'DA_SERVER_DOWN'));
    if (pkgDaDown) {
      setShowProvisionModal(false);
      toast.error("DirectAdmin Server is unreachable. Cannot provision new accounts.");
      setIsServerDown(true); // Ensure banner is visible
      setIsLoadingProvisionDeps(false);
      return;
    }

    if (!pkgResult.ok) {
      logger.error('Error fetching provision deps:', pkgResult.error.message);
      toast.error('Failed to load packages or users');
      setShowProvisionModal(false);
      setIsLoadingProvisionDeps(false);
      return;
    }

    if (pkgResult.data?.success) setAvailablePackages(pkgResult.data.data ?? []);
    if (userResult.ok && userResult.data?.success) setUsersNoHosting(userResult.data.data ?? []);
    setIsLoadingProvisionDeps(false);
  };

  useEffect(() => {
    if (showProvisionModal) {
      void fetchProvisionDeps();
    }
  }, [showProvisionModal]);

  // Handle Hosting Provisioning
  const handleProvisionHosting = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProvisioning(true);

    const result = await apiClient.post<{ success?: boolean; message?: string }>('/api/v1/admin/hosting/provision', {
      userId: selectedUserId,
      domain: provisionDomain,
      packageName: selectedPackage,
      daUsername,
      validityPeriod,
      validityUnit,
      price: provisionPrice,
    });

    if (result.ok && result.data.success) {
      toast.success(`Hosting for ${provisionDomain} provisioned successfully!`);
      setShowProvisionModal(false);
      // Reset states
      setSelectedUserId('');
      setProvisionDomain('');
      setSelectedPackage('');
      setDaUsername('');
      setValidityPeriod(12); // Reset to default
      // Refresh hosting list
      void fetchHostingData();
    } else if (result.ok) {
      toast.error(result.data.message || 'Failed to provision hosting');
    } else {
      toast.error(result.error.status === 0 ? 'Something went wrong' : result.error.message || 'Failed to provision hosting');
    }
    setIsProvisioning(false);
  };

  /* State for Actions Menu */
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setActiveMenuId(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  const handleAction = async (action: 'suspend' | 'unsuspend' | 'delete', username: string, hostingId?: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    // For delete, show confirmation first
    if (action === 'delete') {
      const item = hostingData.find(i => (hostingId && i.dbId === hostingId) || i.daUsername === username);
      setDeleteModal({
        show: true,
        username: username,
        hostingId: hostingId || item?.dbId || '',
        domain: item?.domain || 'Unknown Domain'
      });
      setActiveMenuId(null);
      return;
    }

    // For suspend/unsuspend, call immediately
    await performHostingAction(action, username);
  };

  const performHostingAction = async (action: string, username: string, hostingId?: string) => {
    const toastId = toast.loading(`${action === 'delete' ? 'Terminating' : 'Performing ' + action}...`);
    if (action === 'delete') setIsDeleting(true);

    const result = await apiClient.post<{ success?: boolean; message?: string }>('/api/v1/admin/hosting/actions', { action, username, hostingId });
    toast.dismiss(toastId);

    if (result.ok && result.data.success) {
      const actionPastTense = action === 'delete' ? 'terminated' : action + 'ed';
      toast.success(`Account ${actionPastTense} successfully`);
      setDeleteModal({ show: false, username: '', domain: '', hostingId: '' });
      void fetchHostingData(); // Refresh list
    } else if (result.ok) {
      toast.error(result.data.message || `Failed to ${action} user`);
    } else {
      toast.error(result.error.status === 0 ? 'An error occurred' : result.error.message || `Failed to ${action} user`);
      logger.error(result.error.message);
    }
    setIsDeleting(false);
    setActiveMenuId(null);
  };

  const handleViewDetails = async (username: string) => {
    setIsLoadingDetails(true);
    setShowDetailsModal(true);
    setSelectedDetails(null); // Clear previous details
    setActiveMenuId(null);

    const result = await apiClient.get<{ success?: boolean; data?: HostingDetails; message?: string }>(
      `/api/v1/admin/hosting/details?username=${username}`
    );

    if (result.ok && result.data.success) {
      setSelectedDetails(result.data.data ?? null);
    } else if (result.ok) {
      toast.error(result.data.message || 'Failed to fetch details');
      setShowDetailsModal(false);
    } else {
      toast.error(result.error.status === 0 ? 'Error loading hosting details' : result.error.message || 'Failed to fetch details');
      setShowDetailsModal(false);
    }
    setIsLoadingDetails(false);
  };

  const handleChangePackageClick = (username: string, currentPackage: string) => {
    setChangePackageUser({ username, currentPackage });
    setNewPackage(currentPackage); // Default to current
    setShowChangePackageModal(true);
    setActiveMenuId(null);

    // Fetch packages if not already loaded
    if (availablePackages.length === 0) {
      void fetchProvisionDeps();
    }
  };

  const submitChangePackage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changePackageUser || !newPackage) return;

    setIsChangingPackage(true);
    const result = await apiClient.post<{ success?: boolean; message?: string }>('/api/v1/admin/hosting/change-package', {
      username: changePackageUser.username,
      newPackage: newPackage,
    });

    if (result.ok && result.data.success) {
      toast.success(`Package changed successfully to ${newPackage}`);
      setShowChangePackageModal(false);
      setChangePackageUser(null);
      setNewPackage('');
      void fetchHostingData(); // Refresh list
    } else if (result.ok) {
      toast.error(result.data.message || 'Failed to change package');
    } else {
      toast.error(result.error.status === 0 ? 'An error occurred while changing package' : result.error.message || 'Failed to change package');
      logger.error(result.error.message);
    }
    setIsChangingPackage(false);
  };

  const toggleMenu = (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // vital to stop the window click listener from closing it immediately
    setActiveMenuId(activeMenuId === id ? null : id);
  };

  const handleContextMenu = (e: React.MouseEvent, item: HostingData) => {
    e.preventDefault();
    setMenuAnchor({ x: e.clientX, y: e.clientY });
    setMenuData(item);
  };

  const handleTripleDotClick = (e: React.MouseEvent, item: HostingData) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuAnchor({ x: rect.left - 180, y: rect.bottom + 5 });
    setMenuData(item);
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'active':    return 'bg-green-50 text-green-700 border-green-200';
      case 'pending':   return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'suspended':
      case 'expired':
      case 'terminated':
      case 'failed':
      default:          return 'bg-red-50 text-red-700 border-red-200';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'active':  return <CheckCircle2 className="h-3 w-3" />;
      case 'pending': return <Clock className="h-3 w-3" />;
      case 'suspended':
      case 'expired':
      case 'terminated':
      case 'failed':
      default:        return <AlertTriangle className="h-3 w-3" />;
    }
  };

  const filteredData = hostingData.filter(item => {
    // Search filter — domain / name / email substring match
    const matchesSearch =
      item.domain.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.user.email.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;
    // Customer-type filter — drives the trial-vs-paid distinction the
    // operator can slice the table by.
    if (customerTypeFilter === 'trial') return item.isTrial === true;
    if (customerTypeFilter === 'paid') return item.isTrial !== true;
    return true;
  });

  // Trial / paid counts across the WHOLE dataset (not the filtered slice)
  // so the operator sees "12 of 47 are on trial" regardless of the
  // current filter view.
  const trialCount = hostingData.filter(item => item.isTrial === true).length;
  const paidCount = hostingData.filter(item => item.isTrial !== true).length;

  // Client-side pagination — the /api/v1/admin/hosting/stats endpoint
  // returns all accounts in one shot (acceptable for the current ~30-account
  // scale; server-side cursoring becomes worthwhile only past a few hundred).
  // Slicing in-memory means search + sort still operate on the full dataset.
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedData = filteredData.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  // Reset to page 1 whenever the filter shrinks the dataset below the
  // current page's offset — otherwise an empty table renders after typing
  // a narrow search.
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(1);
  }, [currentPage, totalPages]);

  const AnimatedLoading = () => {
    const [dots, setDots] = useState('');

    useEffect(() => {
      const interval = setInterval(() => {
        setDots(prev => {
          if (prev === '') return '.';
          if (prev === '.') return '..';
          if (prev === '..') return '...';
          return '';
        });
      }, 500);

      return () => clearInterval(interval);
    }, []);

    return <span className="inline-block w-6 text-left">{dots}</span>;
  };

  if (isAuthLoading) {
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Server className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold text-gray-900">Hosting Management</h1>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  daMode === 'Local' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                  daMode === 'Disconnected' ? 'bg-red-50 text-red-700 border-red-200' :
                  'bg-green-50 text-green-700 border-green-200'
                }`}>
                  {daMode === 'Local' || daMode === 'Disconnected'
                    ? <AlertTriangle className="h-3 w-3" />
                    : <CheckCircle2 className="h-3 w-3" />}
                  {daMode}
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-0.5">Monitor and manage client hosting packages</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 md:flex gap-2 w-full md:w-auto">
            <button
              onClick={() => router.push('/admin/hosting/pending')}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors shadow-sm"
              title="View failed provisions"
            >
              <Clock className="h-4 w-4" />
              Pending Queue
            </button>
            <button
              onClick={() => router.push('/admin/hosting/packages')}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-xl hover:bg-blue-100 transition-colors"
            >
              <Package className="h-4 w-4" />
              Packages
            </button>
            <button
              onClick={() => setShowProvisionModal(true)}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
            >
              <Plus className="h-4 w-4" />
              Create Hosting
            </button>
          </div>
        </div>

        {/* ── DirectAdmin server-issue banner ── */}
        {isServerDown && (
          <div className="bg-white border border-red-200 rounded-2xl shadow-sm p-5 flex items-start gap-3">
            <div className="p-2 bg-red-50 rounded-xl shrink-0">
              <AlertTriangle className="h-4 w-4 text-red-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-red-900">DirectAdmin Server Issue Detected</h3>
              <p className="text-sm text-red-700 mt-0.5">
                <strong>Error:</strong> {daError || 'We cannot connect to the hosting control panel. Live data and actions are limited.'}
              </p>
              <p className="text-xs text-red-500 mt-1.5">
                Check the server status, license validity, and firewall settings (Port 2222).
              </p>
            </div>
          </div>
        )}

        {/* ── Hosting list card (filters folded into header) ── */}
        <div
          ref={tableTopRef}
          className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden min-h-[400px] scroll-mt-20"
        >
          {/* Card header */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 flex-wrap">
              <HardDrive className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">All Hosting Accounts</h3>
              <span className="inline-flex items-center text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
                {filteredData.length}
              </span>
              {/* Trial / paid mix — visible at-a-glance regardless of the current filter */}
              <span className="inline-flex items-center text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full" title="Customers on a 15-day free trial">
                {trialCount} trial
              </span>
              <span className="inline-flex items-center text-[11px] font-medium text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full" title="Customers past the trial window — actively paying or post-trial">
                {paidCount} paid
              </span>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              {/* Customer-type filter — slices the table by trial vs paid.
                  See `customerTypeFilter` state declaration for rationale. */}
              <select
                value={customerTypeFilter}
                onChange={(e) => {
                  setCustomerTypeFilter(e.target.value as 'all' | 'trial' | 'paid');
                  setCurrentPage(1);
                }}
                className="text-sm bg-white border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                title="Filter by customer type"
              >
                <option value="all">All customers</option>
                <option value="trial">Trial only</option>
                <option value="paid">Paid only</option>
              </select>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by domain, user or email…"
                  className="w-full sm:w-80 pl-10 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                  value={searchTerm}
                  onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                />
              </div>
              <RefreshButton onClick={fetchHostingData} isLoading={isDataLoading} />
            </div>
          </div>
          {/* Content body wrapper for table/loading/empty states */}
          <div>
          {isDataLoading ? (
            <AdminTableRowsSkeleton rows={6} cols={6} />
          ) : filteredData.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              {customerTypeFilter === 'trial' && trialCount === 0
                ? "No trial customers right now."
                : customerTypeFilter === 'paid' && paidCount === 0
                  ? "No paid customers right now."
                  : customerTypeFilter !== 'all'
                    ? `No ${customerTypeFilter} customers match your search.`
                    : "No hosting accounts found on the server."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User & Domain</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Package / Server</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Dates</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Usage (GB)</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider sticky right-0 bg-gray-50 z-20 shadow-[-1px_0_0_rgba(0,0,0,0.1)]">Actions</th>
                  </tr>
                </thead>
                <tbody
                  className={`bg-white divide-y divide-gray-200 transition-opacity duration-150 ${
                    isPaginating ? 'opacity-60' : 'opacity-100'
                  }`}
                >
                  {pagedData.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-gray-50 group/row cursor-context-menu"
                      onContextMenu={(e) => handleContextMenu(e, item)}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className={`flex-shrink-0 h-10 w-10 rounded-full flex items-center justify-center font-bold ${item.isUnlinked ? 'bg-orange-100 text-orange-600' : 'bg-blue-100 text-blue-600'}`}>
                            {item.isUnlinked ? <Link2Off className="h-5 w-5" /> : item.user.name.charAt(0)}
                          </div>
                          <div className="ml-4">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{item.domain}</span>
                              <a
                                href={`http://${item.domain}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-400 hover:text-blue-600 transition-colors"
                                title="Open Website"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                              {item.isUnlinked && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700 border border-orange-200">
                                  UNLINKED
                                </span>
                              )}
                              {/* Trial vs paid pill — symmetric (always one
                                  visible). Amber TRIAL when isTrial=true;
                                  green PAID otherwise. Placed in the most
                                  prominent column so an admin scanning the
                                  list can answer "trial or paid?" in one
                                  glance. Mirrors the existing UNLINKED pill
                                  style. */}
                              {item.isTrial ? (
                                <span
                                  className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200"
                                  title="On a 15-day free trial — has not yet completed a paid renewal"
                                >
                                  TRIAL
                                </span>
                              ) : (
                                <span
                                  className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700 border border-green-200"
                                  title="Past the trial window — actively paying or post-trial"
                                >
                                  PAID
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-gray-500">{item.user.email}</div>
                            {item.status === 'error' ? (
                              <div className="text-xs text-red-500 font-mono mt-1 max-w-[200px] truncate" title={item.error}>
                                Err: {item.error}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-400">DA: {item.daUsername}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900 font-medium">{item.package}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded border border-gray-200">
                            PHP {item.phpVersion || 'Default'}
                          </span>
                          <span className="text-xs text-gray-400">IP: {item.serverIp}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-1.5">
                          {item.razorpayTokenId ? (
                            <span
                              className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded border border-purple-200 font-medium"
                              title="Tokens API — ₹2-charge-and-reverse mandate (Google/Netflix pattern). MIT charges are driven by the daily cron via /admin/recurring-charges."
                            >
                              TOKENS
                            </span>
                          ) : item.subscriptionId ? (
                            <span
                              className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200 font-medium"
                              title="Razorpay Subscriptions API — plan-based mandate. Renewals are driven by Razorpay webhooks."
                            >
                              SUBSCRIPTION
                            </span>
                          ) : (
                            <span
                              className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded border border-gray-200 font-medium"
                              title="Manual billing — no recurring mandate on file. Renewals require operator action."
                            >
                              MANUAL
                            </span>
                          )}
                          {/* TRIAL pill removed from this column — replaced
                              by the more prominent binary TRIAL/PAID pill
                              in the User & Domain column (column 1). One
                              source of truth per row. */}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <div className="text-xs text-gray-600 flex items-center gap-1">
                            <Clock className="h-3 w-3 text-gray-400" />
                            Created: <span className="font-medium cursor-help" title={getRelativeTime(item.createdDate)}>{formatIndianDateTime(item.createdDate)}</span>
                          </div>
                          <div className="text-xs text-gray-600 flex items-center gap-1">
                            <AlertTriangle className={`h-3 w-3 ${item.expiryDate && new Date(item.expiryDate) < new Date() ? 'text-red-500' : 'text-gray-400'}`} />
                            Expires: <span className={`font-medium cursor-help ${item.expiryDate && new Date(item.expiryDate) < new Date() ? 'text-red-600' : ''}`} title={getRelativeTime(item.expiryDate)}>{formatIndianDateTime(item.expiryDate)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${item.status === 'active' && item.expiryDate && new Date(item.expiryDate) < new Date()
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : getStatusColor(item.status)
                          }`}>
                          {item.status === 'active' && item.expiryDate && new Date(item.expiryDate) < new Date() ? (
                            <>
                              <AlertTriangle className="h-3 w-3" />
                              <span className="capitalize">Suspended</span>
                            </>
                          ) : (
                            <>
                              {getStatusIcon(item.status)}
                              <span className="capitalize">{item.status === 'terminated' || item.status === 'failed' ? 'suspended' : item.status}</span>
                            </>
                          )}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-2 w-40">
                          {/* Disk */}
                          <div className="flex flex-col gap-1">
                            <div className="flex justify-between text-xs text-gray-500">
                              <span>Disk: {formatBytes(item.usage?.disk, 'MB')} / {formatBytes(item.usage?.diskLimit, 'MB')}</span>
                            </div>
                            <div className="w-full bg-gray-200 h-1.5 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${item.status === 'error' ? 'bg-red-400' : 'bg-blue-600'}`}
                                style={{
                                  width: item.status === 'error'
                                    ? '100%'
                                    : `${Math.min(100, (parseFloat(item.usage?.disk || '0') / parseFloat(item.usage?.diskLimit || '1000')) * 100)}%`
                                }}
                              ></div>
                            </div>
                          </div>
                          {/* BW */}
                          <div className="flex flex-col gap-1">
                            <div className="flex justify-between text-xs text-gray-500">
                              <span>BW: {formatBytes(item.usage?.bandwidth, 'MB')} / {formatBytes(item.usage?.bandwidthLimit, 'MB')}</span>
                            </div>
                            <div className="w-full bg-gray-200 h-1.5 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${item.status === 'error' ? 'bg-red-400' : 'bg-green-600'}`}
                                style={{
                                  width: item.status === 'error'
                                    ? '100%'
                                    : `${Math.min(100, (parseFloat(item.usage?.bandwidth || '0') / parseFloat(item.usage?.bandwidthLimit || '10000')) * 100)}%`
                                }}
                              ></div>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-right text-sm font-medium sticky right-0 shadow-[-4px_0_8px_-2px_rgba(0,0,0,0.05)] border-l border-gray-100 transition-all ${menuData?.id === item.id ? 'z-[60] bg-blue-50' : 'z-10 bg-white group-hover/row:bg-gray-50'}`}>
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {/* Quick: View details */}
                          <button
                            onClick={() => handleViewDetails(item.daUsername)}
                            title="View details"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            <span className="hidden lg:inline">View</span>
                          </button>
                          {/* Quick: Suspend / Unsuspend */}
                          {item.status === 'suspended' ? (
                            <button
                              onClick={() => handleAction('unsuspend', item.daUsername)}
                              title="Unsuspend"
                              className="inline-flex items-center justify-center w-7 h-7 text-green-600 hover:text-green-700 hover:bg-green-50 rounded-lg transition-colors"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleAction('suspend', item.daUsername)}
                              title="Suspend"
                              className="inline-flex items-center justify-center w-7 h-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
                            >
                              <AlertTriangle className="h-4 w-4" />
                            </button>
                          )}
                          {/* More menu */}
                          <button
                            onClick={(e) => handleTripleDotClick(e, item)}
                            title="More actions"
                            className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${
                              menuData?.id === item.id
                                ? 'text-blue-700 bg-blue-100'
                                : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/*
                Pagination footer. Hidden when there's only one page (≤10
                accounts) so the existing single-page experience is
                unchanged for small datasets. The page counter shows the
                visible window (e.g. "11–20 of 31") plus prev / next
                controls. Page numbers themselves aren't rendered as
                buttons because the hosting list is unlikely to grow past
                a handful of pages and prev/next keeps the header
                uncluttered; can revisit if we ever hit 100+ accounts.
              */}
              {totalPages > 1 && (
                <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/40 flex items-center justify-between gap-3 text-xs">
                  <div className="text-gray-600">
                    Showing <span className="font-medium text-gray-900">{(safePage - 1) * PAGE_SIZE + 1}</span>
                    {" – "}
                    <span className="font-medium text-gray-900">{Math.min(safePage * PAGE_SIZE, filteredData.length)}</span>
                    {" of "}
                    <span className="font-medium text-gray-900">{filteredData.length}</span> account{filteredData.length === 1 ? '' : 's'}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        // Wrap the state update in a React transition so
                        // the table tbody picks up the `opacity-60` pending
                        // signal during reconciliation — gives the admin
                        // immediate visual feedback that the click
                        // registered. Then scroll the top of the table
                        // into view so the user lands on the new page's
                        // first row rather than at their previous scroll
                        // position.
                        startPaginationTransition(() => {
                          setCurrentPage((p) => Math.max(1, p - 1));
                        });
                        tableTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      disabled={safePage === 1 || isPaginating}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Previous
                    </button>
                    <span className="text-gray-500 px-1">
                      Page <span className="font-medium text-gray-900">{safePage}</span> of <span className="font-medium text-gray-900">{totalPages}</span>
                      {isPaginating && (
                        <span className="ml-1.5 inline-block animate-pulse text-blue-600" aria-label="Loading next page">…</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        startPaginationTransition(() => {
                          setCurrentPage((p) => Math.min(totalPages, p + 1));
                        });
                        tableTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      disabled={safePage === totalPages || isPaginating}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      aria-label="Next page"
                    >
                      Next
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        {/* Provision Modal */}
        {showProvisionModal && mounted && createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-200">
              <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-lg font-bold text-gray-900">Provision Hosting Account</h3>
                <button
                  onClick={() => setShowProvisionModal(false)}
                  className="text-gray-400 hover:text-gray-600 p-1 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {isLoadingProvisionDeps ? (
                <div className="p-12 text-center text-gray-500">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-600" />
                  Loading requirements...
                </div>
              ) : (
                <form onSubmit={handleProvisionHosting} className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Select User</label>
                    <select
                      required
                      value={selectedUserId}
                      onChange={(e) => {
                        const uid = e.target.value;
                        setSelectedUserId(uid);
                        // Auto-suggest DA username from email prefix
                        const selectedUser = usersNoHosting.find(u => u.id === uid);
                        if (selectedUser && !daUsername) {
                          const prefix = selectedUser.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
                          const random = Math.floor(Math.random() * 999);
                          setDaUsername(`u${prefix}${random}`);
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="">-- Choose User --</option>
                      {usersNoHosting.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.email})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Domain Name</label>
                    <input
                      type="text"
                      required
                      value={provisionDomain}
                      onChange={(e) => setProvisionDomain(e.target.value)}
                      placeholder="e.g., example.com"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Select Package</label>
                    <select
                      required
                      value={selectedPackage}
                      onChange={(e) => {
                        const pkgName = e.target.value;
                        setSelectedPackage(pkgName);
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="">-- Choose Package --</option>
                      {availablePackages.map((pkg: HostingPackage) => (
                        <option key={pkg._id || pkg.planId} value={pkg.directAdminPackage || pkg.name}>
                          {pkg.name || pkg.directAdminPackage}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Validity Period</label>
                      <select
                        required
                        value={`${validityPeriod}-${validityUnit || 'months'}`}
                        onChange={(e) => {
                          const [period] = e.target.value.split('-');
                          setValidityPeriod(Number(period));
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      >
                        <option value="1-months">1 Month</option>
                        <option value="12-months">12 Months (1 Year)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Price (INR)</label>
                      <input
                        type="number"
                        required
                        min="0"
                        step="any"
                        value={provisionPrice}
                        onChange={(e) => setProvisionPrice(Number(e.target.value))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1 flex justify-between items-center">
                      <span>DirectAdmin Username</span>
                      <button
                        type="button"
                        onClick={() => {
                          const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                          let result = 'u';
                          for (let i = 0; i < 7; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
                          setDaUsername(result);
                        }}
                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                      >
                        <RefreshCw className="h-3 w-3" /> Generate
                      </button>
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        required
                        value={daUsername}
                        onChange={(e) => setDaUsername(e.target.value)}
                        placeholder="e.g., da_user123"
                        pattern="^[a-zA-Z][a-zA-Z0-9]*$"
                        maxLength={10}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm pr-10"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                        <Shield className="h-4 w-4 text-gray-400" />
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">
                      Starts with letter, alphanumeric only, 3-10 chars.
                    </p>
                  </div>

                  <div className="pt-4 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setShowProvisionModal(false)}
                      className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isProvisioning || !selectedUserId || !availablePackages.length}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 flex justify-center items-center gap-2 transition-all shadow-sm shadow-blue-200"
                    >
                      {isProvisioning ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Provisioning...
                        </>
                      ) : (
                        'Activate Hosting'
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body
        )}

        {/* Change Package Modal */}
        {showChangePackageModal && changePackageUser && mounted && createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
              <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-lg font-bold text-gray-900">Change Hosting Package</h3>
                <button
                  onClick={() => setShowChangePackageModal(false)}
                  className="text-gray-400 hover:text-gray-600 p-1 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {isLoadingProvisionDeps ? (
                <div className="p-12 text-center text-gray-500">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-600" />
                  Loading requirements...
                </div>
              ) : (
                <form onSubmit={submitChangePackage} className="p-6 space-y-4">
                  <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 mb-4">
                    <p className="text-sm text-blue-800">
                      Changing package for user <strong>{changePackageUser.username}</strong>
                    </p>
                    <p className="text-xs text-blue-600 mt-1">
                      Current Package: {changePackageUser.currentPackage}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Select New Package</label>
                    <select
                      required
                      value={newPackage}
                      onChange={(e) => setNewPackage(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="">-- Choose Package --</option>
                      {availablePackages.map((pkg: HostingPackage) => (
                        <option key={pkg._id || pkg.planId} value={pkg.directAdminPackage || pkg.name}>
                          {pkg.name || pkg.directAdminPackage}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="pt-2 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setShowChangePackageModal(false)}
                      className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isChangingPackage || !newPackage || newPackage === changePackageUser.currentPackage}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 flex justify-center items-center gap-2 transition-all shadow-sm shadow-blue-200"
                    >
                      {isChangingPackage ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Updating...
                        </>
                      ) : (
                        'Update Package'
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body
        )}

        {/* Hosting Details Modal */}
        {showDetailsModal && mounted && createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
              {/* Modal Header */}
              <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                <div>
                  <h3 className="text-xl font-bold text-gray-900">Hosting Account Details</h3>
                  {selectedDetails && <p className="text-sm text-gray-500 font-mono">{selectedDetails.username} ({selectedDetails.domain})</p>}
                </div>
                <button onClick={() => setShowDetailsModal(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                  <X className="h-5 w-5 text-gray-500" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto p-6">
                {isLoadingDetails ? (
                  <div className="h-full flex flex-col items-center justify-center py-20">
                    <Loader2 className="h-10 w-10 animate-spin text-blue-600 mb-4" />
                    <p className="text-gray-500">Fetching live server data...</p>
                  </div>
                ) : !selectedDetails ? (
                  <div className="text-center py-20 text-red-500">
                    Failed to load data.
                  </div>
                ) : (
                  <div className="space-y-8">
                    {/* Row 1: Key Stats */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                        <div className="text-xs font-bold text-gray-400 uppercase mb-1">Status</div>
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${selectedDetails.status === 'active' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                          <span className="font-bold text-gray-900 capitalize">{selectedDetails.status}</span>
                        </div>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                        <div className="text-xs font-bold text-gray-400 uppercase mb-1">Package</div>
                        <div className="font-bold text-gray-900 truncate" title={selectedDetails.package}>{selectedDetails.package}</div>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                        <div className="text-xs font-bold text-gray-400 uppercase mb-1">Server IP</div>
                        <div className="font-bold text-gray-900">{selectedDetails.ip}</div>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                        <div className="text-xs font-bold text-gray-400 uppercase mb-1">PHP Version</div>
                        <div className="font-bold text-gray-900">{selectedDetails.php}</div>
                      </div>
                    </div>

                    {/* Recurring Payment / Mandate (Phase 2I admin-visibility addition).
                        Pulls from the row data (hostingData.find by daUsername) rather
                        than the live DA-side details, since this info lives on our
                        local Hosting record, not on DA. Rendered only when at least
                        one recurring-payment identifier is present — Subscriptions-API
                        customers see `subscriptionId`; Tokens-API customers see
                        `razorpayCustomerId` + `razorpayTokenId`; manual-billing
                        customers see neither, so the section stays hidden for them. */}
                    {(() => {
                      const row = hostingData.find((d) => d.daUsername === selectedDetails.username);
                      const hasMandate = row && (row.subscriptionId || row.razorpayTokenId || row.razorpayCustomerId);
                      if (!row || !hasMandate) return null;
                      const isTokens = !!row.razorpayTokenId;
                      const isSubs = !isTokens && !!row.subscriptionId;
                      return (
                        <div className="bg-amber-50 border border-amber-200 p-4 rounded-lg space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-amber-900">Recurring Payment</span>
                            <div className="flex gap-2">
                              {row.isTrial && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  15-day trial
                                </span>
                              )}
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                isTokens
                                  ? 'bg-purple-100 text-purple-800'
                                  : isSubs
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-gray-100 text-gray-800'
                              }`}>
                                {isTokens ? 'Tokens API (₹2-and-reverse)' : isSubs ? 'Subscriptions API' : 'Manual billing'}
                              </span>
                            </div>
                          </div>
                          {row.razorpayCustomerId && (
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-gray-600">Razorpay Customer ID</span>
                              <span className="text-sm font-mono text-gray-900">{row.razorpayCustomerId}</span>
                            </div>
                          )}
                          {row.razorpayTokenId && (
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-gray-600">Mandate Token ID</span>
                              <span className="text-sm font-mono text-gray-900">{row.razorpayTokenId}</span>
                            </div>
                          )}
                          {row.subscriptionId && (
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-gray-600">Razorpay Subscription ID</span>
                              <span className="text-sm font-mono text-gray-900">{row.subscriptionId}</span>
                            </div>
                          )}
                          {row.billingType && (
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-gray-600">Billing Type</span>
                              <span className="text-sm font-medium text-gray-900 capitalize">{row.billingType}</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Row 2: Resources Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                      {/* Databases */}
                      <div>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-gray-600 font-medium">Databases</span>
                          <span className="text-gray-900 font-bold">{selectedDetails.usage?.databases?.used ?? '0'} / {selectedDetails.usage?.databases?.limit ?? '0'}</span>
                        </div>
                        <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                          <div className="bg-blue-600 h-full" style={{ width: `${Math.min(100, (parseFloat(selectedDetails.usage?.databases?.used ?? '0') / parseFloat(selectedDetails.usage?.databases?.limit || '1')) * 100)}%` }}></div>
                        </div>
                      </div>
                      {/* Emails */}
                      <div>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-gray-600 font-medium">Email Accounts</span>
                          <span className="text-gray-900 font-bold">{selectedDetails.usage?.emails?.used ?? '0'} / {selectedDetails.usage?.emails?.limit ?? '0'}</span>
                        </div>
                        <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                          <div className="bg-green-500 h-full" style={{ width: `${selectedDetails.usage?.emails?.limit === 'Unlimited' ? 0 : Math.min(100, (parseFloat(selectedDetails.usage?.emails?.used ?? '0') / parseFloat(selectedDetails.usage?.emails?.limit || '1')) * 100)}%` }}></div>
                        </div>
                      </div>
                      {/* FTP */}
                      <div>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-gray-600 font-medium">FTP Accounts</span>
                          <span className="text-gray-900 font-bold">{selectedDetails.usage?.ftp?.used ?? '0'} / {selectedDetails.usage?.ftp?.limit ?? '0'}</span>
                        </div>
                        <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                          <div className="bg-yellow-500 h-full" style={{ width: `${Math.min(100, (parseFloat(selectedDetails.usage?.ftp?.used ?? '0') / parseFloat(selectedDetails.usage?.ftp?.limit || '1')) * 100)}%` }}></div>
                        </div>
                      </div>
                      {/* Subdomains */}
                      <div>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-gray-600 font-medium">Subdomains</span>
                          <span className="text-gray-900 font-bold">{selectedDetails.usage?.subdomains?.used ?? '0'} / {selectedDetails.usage?.subdomains?.limit ?? '0'}</span>
                        </div>
                        <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                          <div className="bg-purple-500 h-full" style={{ width: `${Math.min(100, (parseFloat(selectedDetails.usage?.subdomains?.used ?? '0') / parseFloat(selectedDetails.usage?.subdomains?.limit || '1')) * 100)}%` }}></div>
                        </div>
                      </div>
                    </div>

                    {/* Row 3: Nameservers & Features */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      {/* Nameservers */}
                      <div className="bg-blue-50/50 p-5 rounded-xl border border-blue-100">
                        <h4 className="text-sm font-bold text-blue-900 uppercase tracking-wider mb-4 flex items-center gap-2">
                          <Wifi className="h-4 w-4" /> Nameservers
                        </h4>
                        <div className="space-y-2">
                          {(selectedDetails.nameservers?.length ?? 0) > 0 ? selectedDetails.nameservers!.map((ns: string, i: number) => (
                            <div key={i} className="bg-white px-3 py-2 rounded-lg border border-blue-200 font-mono text-sm text-gray-700 flex justify-between items-center">
                              {ns}
                              <button onClick={() => { void navigator.clipboard.writeText(ns); toast.success('Copied!'); }} className="text-blue-500 hover:text-blue-700 p-1">
                                <ExternalLink className="h-3 w-3" />
                              </button>
                            </div>
                          )) : <p className="text-sm text-gray-500">No nameservers found</p>}
                        </div>
                      </div>

                      {/* Active Features */}
                      <div className="bg-gray-50 p-5 rounded-xl border border-gray-100">
                        <h4 className="text-sm font-bold text-gray-900 uppercase tracking-wider mb-4 flex items-center gap-2">
                          <Settings className="h-4 w-4" /> Features & Access
                        </h4>
                        <div className="grid grid-cols-2 gap-4">
                          {Object.entries(selectedDetails.features ?? {})
                            .filter(([key]) => key !== 'cgi')
                            .map(([key, value]) => (
                              <div key={key} className="flex items-center justify-between text-sm">
                                <span className="text-gray-500 capitalize">{key}</span>
                                {value ? (
                                  <span className="text-green-600 flex items-center gap-1 font-medium italic"><CheckCircle className="h-3 w-3" /> ON</span>
                                ) : (
                                  <span className="text-gray-400 font-medium">OFF</span>
                                )}
                              </div>
                            ))}
                        </div>
                      </div>
                    </div>

                    {/* Account Metadata */}
                    <div className="pt-4 border-t border-gray-100 flex justify-between text-xs text-gray-400 italic">
                      <div>Account Type: {selectedDetails.type}</div>
                      <div>Created On: {selectedDetails.created}</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end">
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className="px-6 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium shadow-sm"
                >
                  Close Details
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* Delete Confirmation Modal */}
        {deleteModal.show && mounted && createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden border border-red-100 animate-in zoom-in-95 duration-200">
              <div className="p-6 text-center">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Delete Account?</h3>
                <p className="text-gray-600 mb-6">
                  Are you sure you want to delete the hosting for <strong>{deleteModal.domain}</strong>?
                  This action is <span className="font-bold text-red-600">irreversible</span> and will delete all files, databases and emails.
                </p>

                <div className="flex gap-3">
                  <button
                    onClick={() => setDeleteModal({ show: false, username: '', domain: '', hostingId: '' })}
                    disabled={isDeleting}
                    className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => performHostingAction('delete', deleteModal.username, deleteModal.hostingId)}
                    disabled={isDeleting}
                    className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium disabled:opacity-50 flex justify-center items-center gap-2"
                  >
                    {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Yes, Delete
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* Global Action/Context Menu */}
        {menuData && (
          <ActionMenu
            isOpen={!!menuAnchor}
            anchorPoint={menuAnchor || { x: 0, y: 0 }}
            onClose={() => {
              setMenuAnchor(null);
              setMenuData(null);
            }}
            items={[
              ...(menuData.status !== 'suspended' ? [{
                label: 'Suspend Service',
                icon: AlertTriangle,
                onClick: () => handleAction('suspend', menuData.daUsername),
                variant: 'warning' as const
              }] : [{
                label: 'Unsuspend Service',
                icon: CheckCircle,
                onClick: () => handleAction('unsuspend', menuData.daUsername),
                variant: 'success' as const
              }]),
              {
                label: 'View Details',
                icon: Eye,
                onClick: () => handleViewDetails(menuData.daUsername),
                variant: 'info' as const
              },
              {
                label: 'Change Package',
                icon: Edit,
                onClick: () => handleChangePackageClick(menuData.daUsername, menuData.package),
                variant: 'default' as const
              },
              {
                label: 'Terminate Account',
                icon: X,
                onClick: () => handleAction('delete', menuData.daUsername, menuData.dbId),
                variant: 'danger' as const
              }
            ]}
          />
        )}
      </div>
    </AdminLayout>
  );
}
