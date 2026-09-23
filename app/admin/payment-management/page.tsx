'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { CreditCard, Search, Filter, MoreVertical, Eye, CheckCircle, XCircle, Clock, RotateCcw, RefreshCw, IndianRupee, CheckCircle2, AlertCircle } from 'lucide-react';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminPaymentsPageSkeleton } from '@/components/skeletons/PageSkeletons';
import AdminDataTable from '@/components/admin/AdminDataTable';
import { formatIndianDate, formatIndianTime, formatIndianDateTime, formatIndianCurrency } from '@/lib/dateUtils';
import { performLogout } from '@/lib/logout';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';

interface Payment {
  id: string;
  transactionId: string;
  amount: number;
  currency: string;
  status: 'completed' | 'pending' | 'failed' | 'refunded';
  paymentMethod: string;
  customerName: string;
  customerEmail: string;
  domainNames: string[];
  orderId?: string;
  invoiceNumber?: string;
  createdAt: string;
  processedAt?: string;
  refunded: boolean;
  refundAmount: number;
  refundStatus?: string;
  fee: number;
  tax: number;
  errorCode?: string;
  errorDescription?: string;
  notes: Record<string, unknown>;
}

interface AdminUser {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export default function AdminPayments() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  // Split loading states
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);

  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [razorpayMode, setRazorpayMode] = useState<'test' | 'live' | null>(null);
  const router = useRouter();
  const { data: session, status } = useSession();

  const pageSize = 5; // Show 5 items per page

  // Surface the active Razorpay mode so no one forgets prod is in TEST.
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await apiClient.get<{ mode?: 'test' | 'live' }>('/api/v1/admin/razorpay-mode');
      if (active && res.ok && (res.data.mode === 'test' || res.data.mode === 'live')) {
        setRazorpayMode(res.data.mode);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Prefer NextAuth session (works for credentials login)
    if (session?.user) {
      const sessionUser = session.user;
      const userObj: AdminUser = {
        _id: sessionUser.id || '',
        firstName: sessionUser.name?.split(' ')[0] || '',
        lastName: sessionUser.name?.split(' ').slice(1).join(' ') || '',
        email: sessionUser.email || '',
        role: sessionUser.role || 'user',
      };

      // Check if admin
      if (userObj.role !== 'admin') {
        router.push('/dashboard');
        return;
      }

      setUser(userObj);
      setIsAuthLoading(false);
      void loadPayments();
      return;
    }

    // No NextAuth session → /login. Previous localStorage/token-cookie
    // fallback read values no auth route ever wrote — dead code.
    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  const loadPayments = async (page: number = currentPage, search: string = searchTerm) => {
    setIsDataLoading(true);
    // Always fetch only the latest 5 transactions (no pagination)
    const result = await apiClient.get<{ payments?: Payment[]; total?: number }>(`/api/v1/admin/payments?limit=5&skip=0`);
    if (result.ok) {
      setPayments(result.data.payments || []);
      setTotalItems(result.data.total || 0);
    } else {
      logger.error('Failed to load payments:', result.error.message);
      setPayments([]);
      setTotalItems(0);
    }
    setIsDataLoading(false);
  };

  const handleLogout = () => {
    void performLogout();
  };

  const handleViewPayment = (paymentId: string) => {
    const payment = payments.find(p => p.id === paymentId);
    if (payment) {
      setSelectedPayment(payment);
      setIsModalOpen(true);
    }
  };

  const handleProcessPayment = (paymentId: string) => {
    // Process the payment
  };

  const handleRefundPayment = (paymentId: string) => {
    // Process refund
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    void loadPayments(page, searchTerm);
  };

  const handleSearch = (search: string) => {
    setSearchTerm(search);
    setCurrentPage(1); // Reset to first page when searching
    // Note: For now, we'll implement client-side search since the API doesn't support search
    // In a real implementation, you'd want to add search parameters to the API
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-green-500" />;
      case 'failed':
        return <XCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-red-500" />;
      case 'pending':
        return <Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-yellow-500" />;
      case 'refunded':
        return <RotateCcw className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-indigo" />;
      default:
        return null;
    }
  };

  const columns = [
    {
      key: 'transactionId',
      label: 'Transaction ID',
      sortable: true,
      render: (value: string, row: Payment) => (
        <div className="flex items-center space-x-1 sm:space-x-2">
          {getStatusIcon(row.status)}
          <span className="font-mono text-xs sm:text-sm text-ink truncate">{value}</span>
        </div>
      )
    },
    {
      key: 'customerName',
      label: 'Customer',
      sortable: true,
      render: (value: string, row: Payment) => (
        // When we can't resolve a name (guest / deleted / disposable-email
        // payment that lives only in Razorpay's history), show the email as the
        // identity + a muted "No linked account" note instead of a scary
        // "Unknown" that reads like a system error.
        value ? (
          <div className="min-w-0">
            <div className="text-xs sm:text-sm font-medium text-ink truncate">{value}</div>
            <div className="text-xs sm:text-sm text-ink-3 truncate">{row.customerEmail}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="text-xs sm:text-sm font-medium text-ink truncate">
              {row.customerEmail || '—'}
            </div>
            <div className="text-xs text-ink-4 italic truncate">No linked account</div>
          </div>
        )
      )
    },
    {
      key: 'amount',
      label: 'Amount',
      sortable: true,
      render: (value: number, row: Payment) => (
        <div className="text-xs sm:text-sm font-medium text-ink">
          {formatIndianCurrency(value)}
        </div>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (value: string) => {
        const v = (value || '').toLowerCase();
        const cfg =
          v === 'captured' || v === 'completed' ? { cls: 'bg-green-50 text-green-700 border-green-200', icon: CheckCircle2 } :
          v === 'failed'   ? { cls: 'bg-red-50 text-red-700 border-red-200', icon: XCircle } :
          v === 'pending'  ? { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock } :
          v === 'refunded' ? { cls: 'bg-indigo-soft text-indigo-ink border-indigo/25', icon: RotateCcw } :
                             { cls: 'bg-paper-2 text-ink-2 border-hairline', icon: AlertCircle };
        const Icon = cfg.icon;
        return (
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border capitalize ${cfg.cls}`}>
            <Icon className="h-3 w-3" />
            {v || 'unknown'}
          </span>
        );
      }
    },
    {
      key: 'paymentMethod',
      label: 'Method',
      sortable: true,
      render: (value: string) => (
        <span className="text-xs sm:text-sm text-ink">{value}</span>
      )
    },
    {
      key: 'domainNames',
      label: 'Domains',
      sortable: false,
      render: (value: string[], row: Payment) => (
        <div className="space-y-1">
          {value && value.length > 0 ? (
            value.map((domain, index) => (
              <span key={index} className="inline-block bg-indigo-soft text-indigo-ink text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 sm:py-1 rounded mr-1 mb-1">
                {domain}
              </span>
            ))
          ) : (
            <span className="text-xs sm:text-sm text-ink-4">No domains</span>
          )}
          {row.orderId && (
            <div className="text-[10px] sm:text-xs text-ink-3 mt-1">
              Order: {row.orderId}
            </div>
          )}
        </div>
      )
    },
    {
      key: 'createdAt',
      label: 'Date',
      sortable: true,
      render: (value: string) => (
        <div>
          <div className="text-xs sm:text-sm text-ink">{formatIndianDate(value)}</div>
          <div className="text-[10px] sm:text-xs text-ink-3">{formatIndianTime(value)}</div>
        </div>
      )
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_value: unknown, row: Payment) => (
        <div className="flex items-center space-x-1 sm:space-x-2">
          <button
            onClick={() => handleViewPayment(row.id)}
            className="p-1.5 sm:p-2 text-amber-ink hover:brightness-90 hover:bg-amber-soft rounded-lg transition-colors"
            title="View Payment Details"
          >
            <Eye className="h-4 w-4 sm:h-5 sm:w-5" />
          </button>
        </div>
      )
    }
  ];

  // Animated Loading Component
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

  if (!user || isAuthLoading) {
    return <AdminPaymentsPageSkeleton />;
  }

  return (
    <AdminLayout user={user} onLogout={handleLogout}>
      <div className="space-y-6">

        {/* ── Razorpay mode banner ── */}
        {razorpayMode === 'test' && (
          <div className="flex items-start gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold text-amber-900">Razorpay is in TEST mode — no real charges are being made.</p>
              <p className="text-amber-800 mt-0.5">Payments use test cards only. Switch to live with <code className="px-1 rounded bg-amber-100">bash scripts/switch-razorpay-mode.sh live</code> before taking real customers.</p>
            </div>
          </div>
        )}
        {razorpayMode === 'live' && (
          <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5">
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
            <p className="text-sm text-green-800"><span className="font-semibold">LIVE mode</span> — real payments are being processed.</p>
          </div>
        )}

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-soft rounded-xl">
              <CreditCard className="h-5 w-5 text-amber-ink" />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-bold text-ink">Payment Management</h1>
              <p className="text-sm text-ink-3 mt-0.5">
                Latest domain payments from Razorpay — most recent transactions including failed ones.
              </p>
            </div>
          </div>
          <RefreshButton
            onClick={() => loadPayments(currentPage, searchTerm)}
            isLoading={isDataLoading}
            title="Refresh Payments"
          />
        </div>

        {/* ── Summary stat cards ── */}
        {!isDataLoading && payments.length > 0 && (() => {
          const captured = payments.filter(p => ['captured', 'completed'].includes((p.status || '').toLowerCase())).length;
          const failed   = payments.filter(p => (p.status || '').toLowerCase() === 'failed').length;
          const refunded = payments.filter(p => (p.status || '').toLowerCase() === 'refunded').length;
          const totalCaptured = payments
            .filter(p => ['captured', 'completed'].includes((p.status || '').toLowerCase()))
            .reduce((s, p) => s + (p.amount || 0), 0);
          return (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-indigo-soft rounded-xl">
                  <CreditCard className="h-4 w-4 text-indigo-ink" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Transactions</p>
                  <p className="text-xl font-bold text-ink">{payments.length}</p>
                </div>
              </div>
              <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-green-50 rounded-xl">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Captured</p>
                  <p className="text-xl font-bold text-ink">{captured}</p>
                </div>
              </div>
              <div className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 ${failed > 0 ? 'border-red-200' : 'border-hairline'}`}>
                <div className={`p-2 rounded-xl ${failed > 0 ? 'bg-red-50' : 'bg-paper-2/60'}`}>
                  <XCircle className={`h-4 w-4 ${failed > 0 ? 'text-red-600' : 'text-ink-3'}`} />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Failed</p>
                  <p className="text-xl font-bold text-ink">{failed}</p>
                </div>
              </div>
              <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-emerald-50 rounded-xl">
                  <IndianRupee className="h-4 w-4 text-emerald-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Captured Total</p>
                  <p className="text-xl font-bold text-ink">₹{totalCaptured.toLocaleString()}</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Payments card ── */}
        <div className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
          {/* Card header with status filter */}
          <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <CreditCard className="h-4 w-4 text-ink-3" />
              <h3 className="text-sm font-semibold text-ink">Latest Payments</h3>
            </div>
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-ink-4" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-1.5 border border-hairline rounded-xl text-xs font-medium bg-paper text-ink-2 focus:outline-none focus:ring-2 focus:ring-amber focus:border-transparent transition-shadow"
              >
                <option value="all">All Payments</option>
                <option value="captured">Successful</option>
                <option value="failed">Failed</option>
                <option value="pending">Pending</option>
                <option value="refunded">Refunded</option>
              </select>
            </div>
          </div>
          <div className="p-4 sm:p-6">
            <AdminDataTable
              title=""
              columns={columns}
              data={statusFilter === 'all' ? payments : payments.filter(p => p.status === statusFilter)}
              searchable={false}
              pagination={false}
              pageSize={5}
              totalItems={statusFilter === 'all' ? payments.length : payments.filter(p => p.status === statusFilter).length}
              currentPage={1}
              onPageChange={handlePageChange}
              onSearch={handleSearch}
              isLoading={isDataLoading}
            />
          </div>
        </div>

        {/* Payment Details Modal */}
        {isModalOpen && selectedPayment && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
            onClick={() => setIsModalOpen(false)}
          >
            <div
              className="bg-paper rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-hairline">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-bold text-ink">Payment Details</h2>
                  <button
                    onClick={() => setIsModalOpen(false)}
                    className="text-ink-4 hover:text-ink-2"
                  >
                    <XCircle className="h-6 w-6" />
                  </button>
                </div>
              </div>

              <div className="p-6 space-y-6">
                {/* Payment Header */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-sm font-medium text-ink-3">Transaction ID</label>
                    <p className="text-lg font-mono">{selectedPayment.transactionId}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-ink-3">Status</label>
                    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${selectedPayment.status === 'completed'
                      ? 'bg-green-100 text-green-800'
                      : selectedPayment.status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : selectedPayment.status === 'pending'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-paper-2 text-ink'
                      }`}>
                      {selectedPayment.status.charAt(0).toUpperCase() + selectedPayment.status.slice(1)}
                    </span>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-ink-3 mb-2 block">Amount Breakdown</label>
                    <div className="bg-paper-2/60 p-3 rounded-lg space-y-1.5">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-ink-2">Subtotal:</span>
                        <span className="text-ink">₹{(selectedPayment.amount / 1.18).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-ink-2">GST (18%):</span>
                        <span className="text-ink">₹{(selectedPayment.amount - (selectedPayment.amount / 1.18)).toFixed(2)}</span>
                      </div>
                      <div className="border-t pt-1.5 flex justify-between items-center">
                        <span className="text-sm font-semibold text-ink">Total:</span>
                        <span className="text-base font-bold text-amber-ink">₹{selectedPayment.amount.toFixed(2)} {selectedPayment.currency}</span>
                      </div>
                      <p className="text-xs text-ink-3 text-right">*GST included</p>
                    </div>
                  </div>
                </div>

                {/* Customer Info */}
                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold text-ink mb-4">Customer Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium text-ink-3">Name</label>
                      <p className="text-lg">
                        {selectedPayment.customerName || (
                          <span className="text-ink-4 italic">No linked account</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-ink-3">Email</label>
                      <p className="text-lg">{selectedPayment.customerEmail}</p>
                    </div>
                  </div>
                </div>

                {/* Payment Details */}
                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold text-ink mb-4">Payment Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="text-sm font-medium text-ink-3">Payment Method</label>
                      <p className="text-lg">{selectedPayment.paymentMethod}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-ink-3">Created At</label>
                      <p className="text-lg">{formatIndianDateTime(selectedPayment.createdAt)}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-ink-3">Processed At</label>
                      <p className="text-lg">{selectedPayment.processedAt ? formatIndianDateTime(selectedPayment.processedAt) : 'Not processed'}</p>
                    </div>
                  </div>
                </div>

                {/* Order Information */}
                {(selectedPayment.orderId || selectedPayment.invoiceNumber) && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-ink mb-4">Order Information</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {selectedPayment.orderId && (
                        <div>
                          <label className="text-sm font-medium text-ink-3">Order ID</label>
                          <p className="text-lg font-mono">{selectedPayment.orderId}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Domains */}
                {selectedPayment.domainNames && selectedPayment.domainNames.length > 0 && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-ink mb-4">Domains in this Payment</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedPayment.domainNames.map((domain, index) => (
                        <span key={index} className="inline-block bg-indigo-soft text-indigo-ink text-sm px-3 py-1 rounded-full">
                          {domain}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Refund Information */}
                {selectedPayment.refunded && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-ink mb-4">Refund Information</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-ink-3">Refund Amount</label>
                        <p className="text-lg font-semibold text-red-600">₹{selectedPayment.refundAmount.toFixed(2)}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-ink-3">Refund Status</label>
                        <p className="text-lg">{selectedPayment.refundStatus || 'Processed'}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Error Information */}
                {selectedPayment.errorCode && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-ink mb-4">Error Information</h3>
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm font-medium text-red-700">Error Code</label>
                          <p className="text-lg font-mono text-red-800">{selectedPayment.errorCode}</p>
                        </div>
                        <div>
                          <label className="text-sm font-medium text-red-700">Error Description</label>
                          <p className="text-lg text-red-800">{selectedPayment.errorDescription}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Additional Details */}
                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold text-ink mb-4">Additional Details</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="text-sm font-medium text-ink-3">Fee</label>
                      <p className="text-lg">₹{selectedPayment.fee.toFixed(2)}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-ink-3">Tax</label>
                      <p className="text-lg">₹{selectedPayment.tax.toFixed(2)}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-ink-3">Net Amount</label>
                      <p className="text-lg font-semibold">₹{(selectedPayment.amount - selectedPayment.fee - selectedPayment.tax).toFixed(2)}</p>
                    </div>
                  </div>
                </div>

                {/* Notes */}
                {selectedPayment.notes && Object.keys(selectedPayment.notes).length > 0 && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-ink mb-4">Payment Notes</h3>
                    <div className="bg-paper-2/60 rounded-lg p-4">
                      <pre className="text-sm text-ink-2 whitespace-pre-wrap">
                        {JSON.stringify(selectedPayment.notes, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
