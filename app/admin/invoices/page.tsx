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
import { AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';
import AdminDataTable from '@/components/admin/AdminDataTable';
import InvoiceDiagnostics from '@/components/admin/InvoiceDiagnostics';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';

interface Invoice {
  invoice_id: string;
  invoice_number: string;
  // 'primary' = our GST engine; 'zoho' = a historical Zoho Books invoice from
  // before Zoho was removed (24 Sep 2026). Both PDFs are rendered by DMS
  // from the order via the orderId-keyed route.
  provider?: 'primary' | 'zoho';
  order_id?: string;
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
  // Real row count — the list is our own collection, so it always has one.
  const [total, setTotal] = useState<number | undefined>(undefined);
  const invoicesCache = useRef<Record<string, { data: Invoice[], hasMore: boolean, total?: number }>>({});
  const fetchingPages = useRef<Set<string>>(new Set());

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
      const userRole = session.user.role;
      // Check if admin
      if (userRole !== 'admin') {
        router.push('/dashboard');
        return;
      }
      setIsAuthLoading(false);
      void fetchInvoices(page, false, false);
      return;
    }

    // No NextAuth session → /login. Previous localStorage/token-cookie
    // fallback read values no auth route ever wrote — dead code.
    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email, page]);

  const cacheKey = (targetPage: number) => `page:${targetPage}`;

  const fetchInvoices = async (
    targetPage: number = page,
    isBackground: boolean = false,
    forceRefresh: boolean = false
  ) => {
    const key = cacheKey(targetPage);
    if (forceRefresh) {
      delete invoicesCache.current[key];
    }

    if (!isBackground && invoicesCache.current[key]) {
      setInvoices(invoicesCache.current[key].data);
      setHasMore(invoicesCache.current[key].hasMore);
      setTotal(invoicesCache.current[key].total);
      setIsDataLoading(false);
      prefetchAdjacent(targetPage, invoicesCache.current[key].hasMore);
      return;
    }

    if (fetchingPages.current.has(key)) return;

    try {
      if (!isBackground) setIsDataLoading(true);
      fetchingPages.current.add(key);

      const result = await apiClient.get<{ invoices?: Invoice[]; page_context?: { has_more_page?: boolean; total?: number } }>(
        `/api/v1/admin/invoices?page=${targetPage}&per_page=10`
      );

      if (result.ok) {
        const newInvoices = result.data.invoices || [];
        const hasMorePage = result.data.page_context?.has_more_page || false;
        const reportedTotal = result.data.page_context?.total;

        invoicesCache.current[key] = { data: newInvoices, hasMore: hasMorePage, total: reportedTotal };

        if (!isBackground) {
          setInvoices(newInvoices);
          setHasMore(hasMorePage);
          setTotal(reportedTotal);
          prefetchAdjacent(targetPage, hasMorePage);
        }
      } else if (!isBackground) {
        showErrorToast('Failed to fetch invoices');
      }
    } finally {
      fetchingPages.current.delete(key);
      if (!isBackground) setIsDataLoading(false);
    }
  };

  const prefetchAdjacent = (currentPage: number, currentHasMore: boolean) => {
    const next = cacheKey(currentPage + 1);
    const prev = cacheKey(currentPage - 1);
    if (currentHasMore && !invoicesCache.current[next] && !fetchingPages.current.has(next)) {
      void fetchInvoices(currentPage + 1, true, false);
    }
    if (currentPage > 1 && !invoicesCache.current[prev] && !fetchingPages.current.has(prev)) {
      void fetchInvoices(currentPage - 1, true, false);
    }
  };

  const handleDownload = async (row: Invoice) => {
    const orderId = row.order_id || '';
    const invoiceNumber = row.invoice_number;
    try {
      setDownloadingId(orderId);
      const response = await fetch(`/api/v1/admin/orders/${encodeURIComponent(orderId)}/invoice`);

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
        <span className="text-ink-3 font-medium">
          {index + 1}
        </span>
      )
    },
    {
      key: 'invoice_number',
      label: 'Invoice #',
      sortable: true,
      render: (value: string, row: Invoice) => (
        <div className="flex items-center gap-2 font-medium text-ink">
          <FileText className="h-4 w-4 text-amber-ink shrink-0" />
          <span>{value}</span>
          {row.provider === 'zoho' && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-paper-2 text-ink-3 border border-hairline"
              title="Issued by Zoho Books before it was removed (24 Sep 2026). The PDF shown here is re-rendered by DMS from the order as a proforma copy."
            >
              Historical
            </span>
          )}
        </div>
      )
    },
    {
      key: 'customer_name',
      label: 'Customer',
      sortable: true,
      render: (value: string, row: Invoice) => (
        <div className="flex flex-col">
          <span className="font-medium text-ink">{value}</span>
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
          v === 'sent' || v === 'open' ? { cls: 'bg-indigo-soft text-indigo-ink border-indigo/25', icon: Clock } :
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
      render: (_value: unknown, row: Invoice) => {
        const docId = row.order_id || '';
        const viewHref = `/admin/invoices/${encodeURIComponent(docId)}/view`;
        return (
          <div className="flex items-center space-x-3">
            <button
              onClick={() => router.push(viewHref)}
              disabled={!docId}
              className="text-amber-ink hover:brightness-90 disabled:text-ink-4 disabled:cursor-not-allowed"
              title="View Invoice"
            >
              <Eye className="h-4 w-4" />
            </button>
            <button
              onClick={() => handleDownload(row)}
              disabled={!docId || downloadingId === docId}
              className="text-amber-ink hover:brightness-90 disabled:text-ink-4 disabled:cursor-not-allowed"
              title="Download PDF"
            >
              <Download className="h-4 w-4" />
            </button>
          </div>
        );
      }
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
    return <AdminGenericPageSkeleton />;
  }

  return (
    <AdminLayout
      user={
        session?.user
          ? {
              firstName: session.user.name?.split(' ')[0] || '',
              lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
              role: session.user.role || 'admin',
            }
          : null
      }
      onLogout={performLogout}
    >
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-soft rounded-xl">
              <Receipt className="h-5 w-5 text-amber-ink" />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-bold text-ink">All Invoices</h1>
              <p className="text-sm text-ink-3 mt-0.5">Manage all invoices across the system</p>
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
              <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-indigo-soft rounded-xl">
                  <FileText className="h-4 w-4 text-indigo-ink" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Total on Page</p>
                  <p className="text-xl font-bold text-ink">{invoices.length}</p>
                </div>
              </div>
              <div className="bg-paper border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-green-50 rounded-xl">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Paid</p>
                  <p className="text-xl font-bold text-ink">{paid}</p>
                </div>
              </div>
              <div className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 ${due > 0 ? 'border-amber-200' : 'border-hairline'}`}>
                <div className={`p-2 rounded-xl ${due > 0 ? 'bg-amber-50' : 'bg-paper-2/60'}`}>
                  <IndianRupee className={`h-4 w-4 ${due > 0 ? 'text-amber-600' : 'text-ink-3'}`} />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Total Billed</p>
                  <p className="text-xl font-bold text-ink">₹{totalAmount.toLocaleString()}</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Diagnostics panel ── */}
        {/* Paid orders with no invoice, and invoice-number conflicts. */}
        <InvoiceDiagnostics />

        {/* ── Invoices card ── */}
        <div className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
          {/* Card header */}
          <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <FileText className="h-4 w-4 text-ink-3" />
              <h3 className="text-sm font-semibold text-ink">Billing History</h3>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 bg-paper border border-hairline px-2.5 py-1 rounded-full">
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
              totalItems={total}
              hasMore={hasMore}
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
