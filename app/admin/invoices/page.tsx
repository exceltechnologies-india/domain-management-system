'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  FileText,
  Calendar,
  Download,
  Currency,
  AlertCircle,
  RefreshCw,
  Search,
  Filter,
  Eye,
  Receipt,
  CheckCircle2,
  Clock,
  IndianRupee,
} from 'lucide-react';
import { formatIndianDateTime } from '@/lib/dateUtils';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';
import { safeLocalStorage } from '@/lib/storage';
import AdminDataTable from '@/components/admin/AdminDataTable';
import InvoiceDiagnostics from '@/components/admin/InvoiceDiagnostics';
import { logger } from '@/lib/logger';

interface Invoice {
  invoice_id: string;
  invoice_number: string;
  customer_name: string;
  email?: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
  currency_code: string;
  invoice_url?: string;
  created_time?: string;
}

export default function AdminInvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const invoicesCache = useRef<Record<number, { data: Invoice[], hasMore: boolean }>>({});
  const fetchingPages = useRef<Set<number>>(new Set());

  // Split loading states
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);

  const router = useRouter();
  const { data: session, status } = useSession();

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Prefer NextAuth session (works for credentials login)
    if (session?.user) {
      const userRole = (session.user as { role?: string }).role;
      // Check if admin
      if (userRole !== 'admin') {
        router.push('/dashboard');
        return;
      }
      setIsAuthLoading(false);
      void fetchInvoices(page);
      return;
    }

    // Fallback to localStorage (legacy support)
    const getCookieValue = (name: string) => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop()?.split(';').shift();
      return null;
    };

    const token = getCookieValue('token') || safeLocalStorage.getItem('token');
    const userData = safeLocalStorage.getItem('user');

    if (!token || !userData) {
      router.push('/login');
      return;
    }

    const userObj = JSON.parse(userData);
    if (userObj.role !== 'admin') {
      router.push('/dashboard');
      return;
    }

    setIsAuthLoading(false);
    void fetchInvoices(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email, page]);

  const fetchInvoices = async (targetPage: number = page, isBackground: boolean = false, forceRefresh: boolean = false) => {
    if (forceRefresh) {
      delete invoicesCache.current[targetPage];
    }

    if (!isBackground && invoicesCache.current[targetPage]) {
      setInvoices(invoicesCache.current[targetPage].data);
      setHasMore(invoicesCache.current[targetPage].hasMore);
      setIsDataLoading(false);
      prefetchAdjacent(targetPage, invoicesCache.current[targetPage].hasMore);
      return;
    }

    if (fetchingPages.current.has(targetPage)) return;

    try {
      if (!isBackground) setIsDataLoading(true);
      fetchingPages.current.add(targetPage);

      const response = await fetch(`/api/v1/admin/invoices?page=${targetPage}&per_page=10`);

      if (response.ok) {
        const data = await response.json();
        const newInvoices = data.invoices || [];
        const hasMorePage = data.page_context?.has_more_page || false;

        invoicesCache.current[targetPage] = { data: newInvoices, hasMore: hasMorePage };

        if (!isBackground) {
          setInvoices(newInvoices);
          setHasMore(hasMorePage);
          prefetchAdjacent(targetPage, hasMorePage);
        }
      } else if (!isBackground) {
        showErrorToast('Failed to fetch invoices');
      }
    } catch (error) {
      logger.error('Error fetching invoices:', error);
    } finally {
      fetchingPages.current.delete(targetPage);
      if (!isBackground) setIsDataLoading(false);
    }
  };

  const prefetchAdjacent = (currentPage: number, currentHasMore: boolean) => {
    if (currentHasMore && !invoicesCache.current[currentPage + 1] && !fetchingPages.current.has(currentPage + 1)) {
      void fetchInvoices(currentPage + 1, true);
    }
    if (currentPage > 1 && !invoicesCache.current[currentPage - 1] && !fetchingPages.current.has(currentPage - 1)) {
      void fetchInvoices(currentPage - 1, true);
    }
  };

  const handleDownload = async (invoiceId: string, invoiceNumber: string) => {
    try {
      setDownloadingId(invoiceId);
      const response = await fetch(`/api/v1/admin/invoices/${invoiceId}/pdf`);

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Invoice-${invoiceNumber}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showSuccessToast('Invoice downloaded successfully');
      } else {
        showErrorToast('Failed to download invoice');
      }

    } catch (error) {
      logger.error(error);
    } finally {
      setDownloadingId(null);
    }
  };

  const columns = [
    {
      key: 'serial_number',
      label: 'S.No.',
      sortable: false,
      render: (_value: unknown, _row: unknown, index: number) => (
        <span className="text-gray-500 font-medium">
          {index + 1}
        </span>
      )
    },
    {
      key: 'invoice_number',
      label: 'Invoice #',
      sortable: true,
      render: (value: string, row: Invoice) => (
        <div className="flex items-center font-medium text-gray-900">
          <FileText className="h-4 w-4 mr-2 text-blue-500" />
          {value}
        </div>
      )
    },
    {
      key: 'customer_name',
      label: 'Customer',
      sortable: true,
      render: (value: string, row: Invoice) => (
        <div className="flex flex-col">
          <span className="font-medium text-gray-900">{value}</span>
          {/* Email might not be directly on invoice object from list, depends on Zoho response */}
        </div>
      )
    },
    {
      key: 'date',
      label: 'Date',
      sortable: true,
      render: (value: string, row: Invoice) => (formatIndianDateTime(row.created_time || value))
    },
    {
      key: 'total',
      label: 'Amount',
      sortable: true,
      render: (value: number, row: Invoice) => (
        <span className="font-medium">{row.currency_code} {value}</span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (value: string) => {
        const v = (value || '').toLowerCase();
        const cfg =
          v === 'paid'    ? { cls: 'bg-green-50 text-green-700 border-green-200',   icon: CheckCircle2 } :
          v === 'overdue' ? { cls: 'bg-red-50 text-red-700 border-red-200',         icon: AlertCircle } :
          v === 'sent' || v === 'open' ? { cls: 'bg-blue-50 text-blue-700 border-blue-200', icon: Clock } :
                            { cls: 'bg-amber-50 text-amber-700 border-amber-200',   icon: FileText };
        const Icon = cfg.icon;
        return (
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${cfg.cls}`}>
            <Icon className="h-3 w-3" />
            <span className="capitalize">{v || 'unknown'}</span>
          </span>
        );
      }
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_value: unknown, row: Invoice) => (
        <div className="flex items-center space-x-3">
          <button
            onClick={() => router.push(`/admin/invoices/${row.invoice_id}/view`)}
            className="text-blue-600 hover:text-blue-900"
            title="View Invoice"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            onClick={() => handleDownload(row.invoice_id, row.invoice_number)}
            className="text-blue-600 hover:text-blue-900"
            title="Download PDF"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      )
    }
  ];

  /* Loading State */
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
    <AdminLayout
      user={
        session?.user
          ? {
              firstName: session.user.name?.split(' ')[0] || '',
              lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
              role: (session.user as { role?: string }).role || 'admin',
            }
          : null
      }
      onLogout={performLogout}
    >
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Receipt className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">All Invoices</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage all invoices across the system</p>
            </div>
          </div>
          <RefreshButton onClick={() => fetchInvoices(page, false, true)} isLoading={isDataLoading} />
        </div>

        {/* ── Summary stat cards ── */}
        {!isDataLoading && invoices.length > 0 && (() => {
          const paid = invoices.filter((i) => (i.status || '').toLowerCase() === 'paid').length;
          const due = invoices.filter((i) => {
            const s = (i.status || '').toLowerCase();
            return s === 'sent' || s === 'open' || s === 'overdue';
          }).length;
          const totalAmount = invoices.reduce((s, i) => s + (i.total || 0), 0);
          return (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-blue-50 rounded-xl">
                  <FileText className="h-4 w-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">Total on Page</p>
                  <p className="text-xl font-bold text-gray-900">{invoices.length}</p>
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-green-50 rounded-xl">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">Paid</p>
                  <p className="text-xl font-bold text-gray-900">{paid}</p>
                </div>
              </div>
              <div className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 ${due > 0 ? 'border-amber-200' : 'border-gray-200'}`}>
                <div className={`p-2 rounded-xl ${due > 0 ? 'bg-amber-50' : 'bg-gray-50'}`}>
                  <IndianRupee className={`h-4 w-4 ${due > 0 ? 'text-amber-600' : 'text-gray-500'}`} />
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">Total Billed</p>
                  <p className="text-xl font-bold text-gray-900">₹{totalAmount.toLocaleString()}</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Diagnostics panel ── */}
        <InvoiceDiagnostics />

        {/* ── Invoices card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <FileText className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">Billing History</h3>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
              {invoices.length} on this page
            </span>
          </div>
          <div className="p-4 sm:p-6">
            <AdminDataTable
              columns={columns}
              data={invoices}
              title=""
              searchable={true}
              pagination={true}
              isLoading={isDataLoading}
              totalItems={hasMore ? (page * 10) + 10 : page * 10}
              pageSize={10}
              currentPage={page}
              onPageChange={setPage}
            />
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
