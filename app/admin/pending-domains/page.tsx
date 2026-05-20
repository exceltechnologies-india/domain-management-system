"use client";

import { useState, useEffect, Fragment } from "react";
import { useRouter } from "next/navigation";
import RefreshButton from '@/components/dashboard/RefreshButton';
import { useSession } from "next-auth/react";
import { toast } from "react-hot-toast";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  XCircle,
  RefreshCw,
  Eye,
  Search,
  AlertCircle,
  FileText,
  User,
  Package,
  Archive,
  Loader2,
  X,
  Wallet,
  Mail,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import { formatIndianDateTime } from '@/lib/dateUtils';
import AdminLayout from "@/components/admin/AdminLayout";
import { AdminLayoutSkeleton, AdminGenericPageSkeleton, AdminTableRowsSkeleton } from "@/components/skeletons/PageSkeletons";
import { performLogout } from "@/lib/logout";
import { safeLocalStorage } from "@/lib/storage";

interface PendingDomain {
  _id: string;
  domainName: string;
  price: number;
  currency: string;
  registrationPeriod: number;
  userId: {
    _id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    companyName: string;
  };
  orderId: string;
  customerId: number;
  contactId: number;
  nameServers?: string[];
  adminContactId?: number;
  techContactId?: number;
  billingContactId?: number;
  status: "pending" | "processing" | "completed" | "failed";
  reason: string;
  verificationAttempts: number;
  lastVerifiedAt?: string;
  registeredAt?: string;
  expiresAt?: string;
  resellerClubOrderId?: string;
  adminNotes?: string;
  isArchived?: boolean;
  source?: "pending_domain" | "order";
  createdAt: string;
  updatedAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

// Modal Component (Inline to avoid import issues if any, or just strictly typed)
const Modal = ({ isOpen, onClose, title, children }: ModalProps) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
          <h3 className="font-bold text-lg text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

export default function AdminPendingDomainsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  // Loosely-typed user blob — comes from either the JWT auth-check payload
  // (id/email/role/firstName/lastName/...) or the NextAuth session shape.
  // AdminLayout reads firstName/lastName/role; the gate above checks role.
  const [user, setUser] = useState<{
    firstName: string;
    lastName: string;
    role: string;
    id?: string;
    email?: string;
  } | null>(null);

  // Loading States
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);

  // Data States
  const [pendingDomains, setPendingDomains] = useState<PendingDomain[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1, limit: 20, total: 0, pages: 0
  });

  // Filters & UI States
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);

  // Balance / Account State
  const [rcAccount, setRcAccount] = useState<{
    name: string; accountStatus: string; billingMode: string;
    hasPrepaidWallet: boolean; available: number | null;
    unutilised: number | null; locked: number | null; totalReceipts: number;
  } | null>(null);
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Action States
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedDomainForDetails, setSelectedDomainForDetails] = useState<PendingDomain | null>(null);
  const [showRegisterConfirm, setShowRegisterConfirm] = useState(false);
  const [domainToRegister, setDomainToRegister] = useState<PendingDomain | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [domainToDelete, setDomainToDelete] = useState<PendingDomain | null>(null);

  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [domainToArchive, setDomainToArchive] = useState<PendingDomain | null>(null);

  const [showMarkResolvedConfirm, setShowMarkResolvedConfirm] = useState(false);
  const [domainToMarkResolved, setDomainToMarkResolved] = useState<PendingDomain | null>(null);

  const fetchBalance = async () => {
    try {
      setIsBalanceLoading(true);
      setBalanceError(null);
      const token = getAuthToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/v1/admin/resellerclub/balance', { headers, credentials: 'include' });
      const data = await res.json();
      if (res.ok && data.success) {
        setRcAccount(data.account);
      } else {
        setBalanceError(data.error || "Failed to fetch account details");
      }
    } catch {
      setBalanceError("Unable to fetch balance");
    } finally {
      setIsBalanceLoading(false);
    }
  };

  const getAuthToken = () => {
    const getCookieValue = (name: string) => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop()?.split(';').shift();
      return null;
    };
    return getCookieValue('token') || safeLocalStorage.getItem('token');
  };

  // Auth Effect
  useEffect(() => {
    const checkAuth = async () => {
      if (status === 'loading') return;

      try {
        const token = getAuthToken();
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch('/api/v1/auth/me', {
          method: 'GET',
          headers,
          credentials: 'include',
        });

        if (response.ok) {
          const data = await response.json();
          if (data.user?.role === 'admin') {
            setUser(data.user);
            setIsAuthLoading(false);
          } else {
            toast.error("Access denied. Admin privileges required.");
            setTimeout(() => router.push('/dashboard'), 2000);
          }
        } else {
          // Fallback to NextAuth session if API fails or returns 401 but we have session
          if (session?.user && session.user.role === 'admin') {
            const sUser = session.user;
            const [firstName = "", ...rest] = (sUser.name ?? "").split(" ");
            setUser({
              id: sUser.id,
              email: sUser.email ?? undefined,
              role: sUser.role ?? "admin",
              firstName,
              lastName: rest.join(" "),
            });
            setIsAuthLoading(false);
          } else {
            toast.error("Session expired. Please login again.");
            router.push('/login');
          }
        }
      } catch (error) {
        toast.error("Authentication failed");
        router.push('/login');
      }
    };
    void checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  // Fetch Balance on load
  useEffect(() => {
    if (!isAuthLoading && user) {
      void fetchBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoading, user]);

  // Fetch Data Effect
  useEffect(() => {
    if (!isAuthLoading && user) {
      void fetchPendingDomains();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoading, user, pagination.page, selectedStatus, searchTerm, activeTab]);

  const fetchPendingDomains = async () => {
    try {
      setIsDataLoading(true);
      const token = getAuthToken();
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
        ...(selectedStatus !== "all" && { status: selectedStatus }),
        ...(searchTerm && { search: searchTerm }),
        ...(activeTab === "archived" && { archived: "true" }),
      });

      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(`/api/v1/admin/pending-domains?${params}`, {
        headers,
        credentials: 'include'
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setPendingDomains(data.pendingDomains);
        setPagination(data.pagination);

        // Update counts
        if (activeTab === 'active') {
          setActiveCount(data.pagination?.total || 0);
        } else {
          setArchivedCount(data.pagination?.total || 0);
        }
      } else {
        toast.error(data.error || "Failed to fetch pending domains");
      }
    } catch (error) {
      toast.error("Unable to load pending domains.");
    } finally {
      setIsDataLoading(false);
    }
  };

  // Initial Count Fetch
  useEffect(() => {
    if (!isAuthLoading && user) {
      const fetchCounts = async () => {
        try {
          // Simplistic count fetch, similar to original
          // ... (omitted for brevity, can rely on main fetch for current tab count)
        } catch (e) { }
      };
      void fetchCounts();
    }
  }, [isAuthLoading, user]);

  /* Actions */
  const handleRegisterDomainClick = (domain: PendingDomain) => {
    setDomainToRegister(domain);
    setShowRegisterConfirm(true);
  };

  const handleRegisterDomain = async () => {
    if (!domainToRegister) return;
    try {
      setActionLoading(`register:${domainToRegister._id}`);
      setShowRegisterConfirm(false);
      const token = getAuthToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(`/api/v1/admin/pending-domains/${domainToRegister._id}/register`, {
        method: "POST",
        headers,
        credentials: 'include',
      });
      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(`Domain ${domainToRegister.domainName} registered successfully`);
        void fetchPendingDomains();
      } else {
        toast.error(data.message || "Failed to register domain");
      }
    } catch (error) {
      toast.error("Unable to register domain");
    } finally {
      setActionLoading(null);
      setDomainToRegister(null);
    }
  };

  const handleVerifyDomains = async (domainIds: string[]) => {
    try {
      setActionLoading("verify");
      const token = getAuthToken();
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch("/api/v1/admin/pending-domains/verify", {
        method: "POST",
        headers,
        credentials: 'include',
        body: JSON.stringify({ domainIds }),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(`Verified ${data.summary.total} domains`);
        void fetchPendingDomains();
      } else {
        toast.error(data.error || "Failed to verify domains");
      }
    } catch (error) {
      toast.error("Unable to verify domains");
    } finally {
      setActionLoading(null);
    }
  };

  const handleArchiveClick = (domain: PendingDomain) => {
    setDomainToArchive(domain);
    setShowArchiveConfirm(true);
  };

  const handleArchiveDomain = async () => {
    if (!domainToArchive) return;

    try {
      setActionLoading(`archive:${domainToArchive._id}`);
      setShowArchiveConfirm(false);
      const token = getAuthToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(`/api/v1/admin/pending-domains/${domainToArchive._id}`, {
        method: "DELETE",
        headers,
        credentials: 'include',
      });
      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Domain archived successfully");
        void fetchPendingDomains();
      } else {
        toast.error(data.error || "Failed to archive domain");
      }
    } catch (error) {
      toast.error("Unable to archive domain");
    } finally {
      setActionLoading(null);
      setDomainToArchive(null);
    }
  };

  const handleMarkResolvedClick = (domain: PendingDomain) => {
    setDomainToMarkResolved(domain);
    setShowMarkResolvedConfirm(true);
  };

  const handleMarkResolved = async () => {
    if (!domainToMarkResolved) return;
    try {
      setActionLoading(`resolve:${domainToMarkResolved._id}`);
      setShowMarkResolvedConfirm(false);
      const token = getAuthToken();
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const response = await fetch(`/api/v1/admin/pending-domains/${domainToMarkResolved._id}`, {
        method: "PUT",
        headers,
        credentials: "include",
        body: JSON.stringify({ status: "completed", reason: "Manually resolved by admin" }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success(`${domainToMarkResolved.domainName} marked as resolved`);
        void fetchPendingDomains();
      } else {
        toast.error(data.error || "Failed to mark as resolved");
      }
    } catch {
      toast.error("Unable to update domain status");
    } finally {
      setActionLoading(null);
      setDomainToMarkResolved(null);
    }
  };

  const handleRetryFailed = async (domain: PendingDomain) => {
    // Reset to pending first, then register
    try {
      setActionLoading(`retry:${domain._id}`);
      const token = getAuthToken();
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const resetRes = await fetch(`/api/v1/admin/pending-domains/${domain._id}`, {
        method: "PUT",
        headers,
        credentials: "include",
        body: JSON.stringify({ status: "pending", reason: "Retry initiated by admin" }),
      });
      if (!resetRes.ok) {
        toast.error("Failed to reset domain status for retry");
        return;
      }

      const registerRes = await fetch(`/api/v1/admin/pending-domains/${domain._id}/register`, {
        method: "POST",
        headers,
        credentials: "include",
      });
      const registerData = await registerRes.json();
      if (registerRes.ok && registerData.success) {
        toast.success(`${domain.domainName} registration retried successfully`);
      } else {
        toast.error(registerData.message || "Retry failed — check failure reason");
      }
      void fetchPendingDomains();
    } catch {
      toast.error("Retry failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteClick = (domain: PendingDomain) => {
    setDomainToDelete(domain);
    setShowDeleteConfirm(true);
  };

  const handleDeletePermanently = async () => {
    if (!domainToDelete) return;

    try {
      setActionLoading(`delete:${domainToDelete._id}`);
      setShowDeleteConfirm(false);
      const token = getAuthToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Call API with permanent=true query param
      const response = await fetch(`/api/v1/admin/pending-domains/${domainToDelete._id}?permanent=true`, {
        method: "DELETE",
        headers,
        credentials: 'include',
      });
      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Domain permanently deleted");
        void fetchPendingDomains();
      } else {
        toast.error(data.error || "Failed to delete domain");
      }
    } catch (error) {
      toast.error("Unable to delete domain");
    } finally {
      setActionLoading(null);
      setDomainToDelete(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pending": return <Clock className="h-4 w-4 text-yellow-500" />;
      case "processing": return <RefreshCw className="h-4 w-4 text-blue-500" />;
      case "completed": return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "failed": return <XCircle className="h-4 w-4 text-red-500" />;
      default: return <AlertCircle className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "pending": return "bg-yellow-100 text-yellow-800";
      case "processing": return "bg-blue-100 text-blue-800";
      case "completed": return "bg-green-100 text-green-800";
      case "failed": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  if (isAuthLoading) {
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-50 rounded-xl">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Pending Domains</h1>
              <p className="text-sm text-gray-500 mt-0.5">Domains that failed registration — retry or contact the customer.</p>
            </div>
          </div>
          <RefreshButton onClick={fetchPendingDomains} isLoading={isDataLoading} />
        </div>

        {/* ── ResellerClub Account banner ── */}
        {(() => {
          const isSuspended = rcAccount?.accountStatus === "Suspended";
          const lowBalance = rcAccount?.hasPrepaidWallet && rcAccount.available !== null && rcAccount.available < 500;
          const borderClass = isSuspended ? 'border-red-300' : lowBalance ? 'border-amber-300' : 'border-gray-200';
          const iconBg = isSuspended ? 'bg-red-50' : lowBalance ? 'bg-amber-50' : 'bg-green-50';
          const iconColor = isSuspended ? 'text-red-600' : lowBalance ? 'text-amber-600' : 'text-green-600';
          return (
            <div className={`bg-white border rounded-2xl shadow-sm px-5 py-4 ${borderClass}`}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2 rounded-xl ${iconBg}`}>
                    <Wallet className={`h-4 w-4 ${iconColor}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500">ResellerClub Account</p>
                    {isBalanceLoading ? (
                      <p className="text-sm text-gray-400 flex items-center gap-1 mt-0.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
                    ) : balanceError ? (
                      <p className="text-sm text-red-600 mt-0.5">{balanceError}</p>
                    ) : rcAccount ? (
                      <div className="flex items-center gap-2.5 flex-wrap mt-0.5">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${rcAccount.accountStatus === 'Active' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${rcAccount.accountStatus === 'Active' ? 'bg-green-500' : 'bg-red-500'}`} />
                          {rcAccount.accountStatus}
                        </span>
                        {rcAccount.hasPrepaidWallet && rcAccount.available !== null ? (
                          <>
                            <span className={`text-lg font-bold font-mono ${lowBalance ? 'text-amber-600' : 'text-green-700'}`}>
                              ₹{rcAccount.available.toFixed(2)}
                            </span>
                            <span className="text-xs text-gray-400">available</span>
                            {rcAccount.unutilised !== null && rcAccount.unutilised > 0 && (
                              <span className="text-xs text-gray-500">· ₹{rcAccount.unutilised.toFixed(2)} unutilised</span>
                            )}
                            {rcAccount.locked !== null && rcAccount.locked > 0 && (
                              <span className="text-xs text-gray-500">· ₹{rcAccount.locked.toFixed(2)} locked</span>
                            )}
                          </>
                        ) : (
                          <span className="text-sm text-gray-700 font-medium">
                            Credit Account <span className="text-xs font-normal text-gray-400">(no prepaid wallet)</span>
                          </span>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {isSuspended && (
                    <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-1.5 rounded-xl">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Suspended — registrations will fail
                    </div>
                  )}
                  {lowBalance && !isSuspended && (
                    <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold px-3 py-1.5 rounded-xl">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Low balance — registrations may fail
                    </div>
                  )}
                  <button
                    onClick={fetchBalance}
                    disabled={isBalanceLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isBalanceLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Pending domains card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header: tabs + filters */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="inline-flex bg-gray-100 rounded-xl p-1">
                {[
                  { id: 'active',   label: 'Active', icon: Package },
                  { id: 'archived', label: 'Archived', icon: Archive },
                ].map((t) => {
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setActiveTab(t.id as 'active' | 'archived')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                        activeTab === t.id
                          ? 'bg-white text-gray-900 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
              {selectedDomains.length > 0 && (
                <button
                  onClick={() => handleVerifyDomains(selectedDomains)}
                  disabled={actionLoading === "verify"}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {actionLoading === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Verify ({selectedDomains.length})
                </button>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search domains…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                />
              </div>
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="sm:w-44 px-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          </div>

          <div className="p-0 sm:p-0">
            {isDataLoading ? (
              <AdminTableRowsSkeleton rows={6} cols={6} />
            ) : pendingDomains.length === 0 ? (
              <div className="p-6 sm:p-12 text-center text-gray-500">
                <AlertTriangle className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                No {activeTab === 'active' ? 'pending' : 'archived'} domains found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left"><input type="checkbox" checked={selectedDomains.length === pendingDomains.length} onChange={(e) => setSelectedDomains(e.target.checked ? pendingDomains.map(d => d._id) : [])} className="rounded border-gray-300" /></th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Domain</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Failure Reason</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {pendingDomains.map((domain) => (
                      <tr key={domain._id} className="hover:bg-gray-50">
                        <td className="px-6 py-4"><input type="checkbox" checked={selectedDomains.includes(domain._id)} onChange={(e) => setSelectedDomains(e.target.checked ? [...selectedDomains, domain._id] : selectedDomains.filter(id => id !== domain._id))} className="rounded border-gray-300" /></td>
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">{domain.domainName}</div>
                          <div className="text-xs text-gray-500">Order: {domain.orderId}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">{domain.userId?.firstName} {domain.userId?.lastName}</div>
                          <div className="text-xs text-gray-500">{domain.userId?.email}</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeColor(domain.status)}`}>
                            {getStatusIcon(domain.status)}
                            <span className="ml-1 capitalize">{domain.status}</span>
                          </span>
                        </td>
                        <td className="px-6 py-4 max-w-[200px]">
                          {domain.reason ? (
                            <p className="text-xs text-red-700 truncate" title={domain.reason}>{domain.reason}</p>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">{domain.currency} {domain.price}</td>
                        <td className="px-6 py-4 text-sm text-gray-500">{formatIndianDateTime(domain.createdAt)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <div className="flex items-center gap-1 flex-wrap">
                            <button onClick={() => setSelectedDomainForDetails(domain)} className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="View Details"><Eye className="h-4 w-4" /></button>

                            {/* Contact User */}
                            {domain.userId?.email && (
                              <a
                                href={`mailto:${domain.userId.email}?subject=Regarding your domain registration: ${domain.domainName}&body=Hi ${domain.userId?.firstName || ''},`}
                                className="p-2 text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors"
                                title={`Email ${domain.userId.email}`}
                              >
                                <Mail className="h-4 w-4" />
                              </a>
                            )}

                            <div className="w-px h-5 bg-gray-200 mx-0.5" />

                            {/* Retry Provisioning — pending: Register; failed from pending_domain: Reset+Register */}
                            {domain.status === "pending" && domain.source === "pending_domain" && (
                              <button onClick={() => handleRegisterDomainClick(domain)} className="px-2.5 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs flex items-center gap-1.5 transition-colors font-medium" title="Retry Provisioning">
                                {actionLoading === `register:${domain._id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />} Register
                              </button>
                            )}
                            {domain.status === "failed" && domain.source === "pending_domain" && !domain.isArchived && (
                              <button onClick={() => handleRetryFailed(domain)} disabled={!!actionLoading} className="px-2.5 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs flex items-center gap-1.5 transition-colors font-medium disabled:opacity-50" title="Retry Provisioning">
                                {actionLoading === `retry:${domain._id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Retry
                              </button>
                            )}

                            {/* Mark Resolved */}
                            {(domain.status === "pending" || domain.status === "failed") && domain.source === "pending_domain" && !domain.isArchived && (
                              <button onClick={() => handleMarkResolvedClick(domain)} disabled={!!actionLoading} className="p-2 text-green-600 hover:bg-green-50 rounded-lg disabled:opacity-50 transition-colors" title="Mark as Resolved (manually registered)">
                                {actionLoading === `resolve:${domain._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                              </button>
                            )}

                            {/* Archive */}
                            {!domain.isArchived && activeTab === "active" && domain.source === "pending_domain" && (
                              <button onClick={() => handleArchiveClick(domain)} disabled={actionLoading === `archive:${domain._id}`} className="p-2 text-orange-500 hover:bg-orange-50 rounded-lg disabled:opacity-50 transition-colors" title="Archive Domain">
                                {actionLoading === `archive:${domain._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                              </button>
                            )}
                            {domain.isArchived && activeTab === "archived" && (
                              <button onClick={() => handleDeleteClick(domain)} disabled={actionLoading === `delete:${domain._id}`} className="p-2 text-red-500 hover:bg-red-50 rounded-lg disabled:opacity-50 transition-colors" title="Delete Permanently">
                                {actionLoading === `delete:${domain._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {pagination.pages > 1 && (
              <div className="p-4 border-t border-gray-200 flex justify-between items-center">
                <div className="text-sm text-gray-500">Page {pagination.page} of {pagination.pages}</div>
                <div className="flex gap-2">
                  <button onClick={() => setPagination({ ...pagination, page: pagination.page - 1 })} disabled={pagination.page === 1} className="px-4 py-2 border rounded-lg disabled:opacity-50 hover:bg-gray-50">Previous</button>
                  <button onClick={() => setPagination({ ...pagination, page: pagination.page + 1 })} disabled={pagination.page === pagination.pages} className="px-4 py-2 border rounded-lg disabled:opacity-50 hover:bg-gray-50">Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Details Slide-out */}
      {selectedDomainForDetails && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setSelectedDomainForDetails(null)}></div>
          <div className="relative w-full max-w-xl bg-white h-full shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-300">
            <div className="p-6 border-b flex justify-between items-center sticky top-0 bg-white z-10">
              <h2 className="text-xl font-bold">Domain Details</h2>
              <button onClick={() => setSelectedDomainForDetails(null)} className="p-2 hover:bg-gray-100 rounded-full"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-6 space-y-6">
              <div className="bg-gray-50 p-4 rounded-lg">
                <h3 className="text-lg font-bold">{selectedDomainForDetails.domainName}</h3>
                <p className="text-sm text-gray-500">Order: {selectedDomainForDetails.orderId}</p>
              </div>

              <div className="space-y-4">
                <h4 className="font-medium flex items-center gap-2"><User className="h-4 w-4 text-blue-600" /> Customer Info</h4>
                <div className="bg-white border rounded-lg p-4 text-sm space-y-2">
                  <div className="flex justify-between"><span className="text-gray-500">Name:</span> <span className="font-medium">{selectedDomainForDetails.userId?.firstName} {selectedDomainForDetails.userId?.lastName}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Email:</span> <span className="font-medium">{selectedDomainForDetails.userId?.email}</span></div>
                </div>
              </div>

              <div className="space-y-4">
                <h4 className="font-medium flex items-center gap-2"><FileText className="h-4 w-4 text-green-600" /> Technical Info</h4>
                <div className="bg-white border rounded-lg p-4 text-sm space-y-2">
                  <div className="flex justify-between"><span className="text-gray-500">Tech Contact ID:</span> <span className="font-medium">{selectedDomainForDetails.techContactId}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Admin Contact ID:</span> <span className="font-medium">{selectedDomainForDetails.adminContactId}</span></div>
                  {selectedDomainForDetails.nameServers && (
                    <div className="pt-2 border-t mt-2">
                      <span className="text-gray-500 block mb-1">Nameservers:</span>
                      {selectedDomainForDetails.nameServers.map(ns => <div key={ns} className="font-mono text-xs">{ns}</div>)}
                    </div>
                  )}
                </div>
              </div>

              {selectedDomainForDetails.reason && (
                <div className="bg-red-50 p-4 rounded-lg border border-red-100">
                  <h4 className="font-medium text-red-800 mb-1 flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Failure Reason</h4>
                  <p className="text-sm text-red-700">{selectedDomainForDetails.reason}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Register Confirm Modal */}
      {showRegisterConfirm && (
        <Modal isOpen={showRegisterConfirm} onClose={() => setShowRegisterConfirm(false)} title="Confirm Registration">
          <div className="p-6">
            <p className="mb-4">Are you sure you want to register <strong>{domainToRegister?.domainName}</strong>?</p>
            <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-200 text-sm text-yellow-800 mb-6">
              This will initiate the registration process with the registrar. Ensure ID: {domainToRegister?.orderId} details are correct.
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowRegisterConfirm(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleRegisterDomain} disabled={actionLoading === `register:${domainToRegister?._id}`} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 disabled:opacity-50">
                {actionLoading === `register:${domainToRegister?._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} Confirm & Register
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Archive Confirm Modal */}
      {showArchiveConfirm && (
        <Modal isOpen={showArchiveConfirm} onClose={() => setShowArchiveConfirm(false)} title="Confirm Archive">
          <div className="p-6">
            <p className="mb-4">Are you sure you want to archive <strong>{domainToArchive?.domainName}</strong>?</p>
            <p className="mb-6 text-sm text-gray-500">
              This will move the domain to the "Archived" tab and update its status to "Failed".
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowArchiveConfirm(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleArchiveDomain} disabled={actionLoading === `archive:${domainToArchive?._id}`} className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 flex items-center gap-2 disabled:opacity-50">
                {actionLoading === `archive:${domainToArchive?._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />} Confirm Archive
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Mark Resolved Confirm Modal */}
      {showMarkResolvedConfirm && (
        <Modal isOpen={showMarkResolvedConfirm} onClose={() => setShowMarkResolvedConfirm(false)} title="Mark as Resolved">
          <div className="p-6">
            <p className="mb-3">Mark <strong>{domainToMarkResolved?.domainName}</strong> as resolved?</p>
            <div className="bg-green-50 p-3 rounded-lg border border-green-200 text-sm text-green-800 mb-6">
              Use this only if you have manually registered the domain outside the system. This will update the order status to "registered" and close the pending record.
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowMarkResolvedConfirm(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleMarkResolved} disabled={actionLoading === `resolve:${domainToMarkResolved?._id}`} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 disabled:opacity-50">
                {actionLoading === `resolve:${domainToMarkResolved?._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Mark Resolved
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Confirm Modal */}
      {showDeleteConfirm && (
        <Modal isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} title="Confirm Permanent Deletion">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4 text-red-600 bg-red-50 p-3 rounded-lg border border-red-200">
              <AlertTriangle className="h-6 w-6 flex-shrink-0" />
              <p className="font-medium text-red-900">Warning: This action cannot be undone!</p>
            </div>
            <p className="mb-4 text-gray-600">
              Are you sure you want to <strong>PERMANENTLY DELETE</strong> the pending domain <strong>{domainToDelete?.domainName}</strong>?
            </p>
            <p className="mb-6 text-sm text-gray-500">
              This will remove the record from the pending domains database. The Order record will remain as 'failed' for history.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowDeleteConfirm(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-gray-700">Cancel</button>
              <button onClick={handleDeletePermanently} disabled={actionLoading === `delete:${domainToDelete?._id}`} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2 disabled:opacity-50">
                {actionLoading === `delete:${domainToDelete?._id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Delete Permanently
              </button>
            </div>
          </div>
        </Modal>
      )}
    </AdminLayout>
  );
}
