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
import AdminDataTable from '@/components/admin/AdminDataTable';
import InvoiceDiagnostics from '@/components/admin/InvoiceDiagnostics';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';

type InvoiceSource = 'zoho' | 'primary';

interface Invoice {
  invoice_id: string;
  invoice_number: string;
  // Which engine issued it. Tells us where the PDF lives: a 'primary' tax
  // invoice has no Zoho id and is served by the orderId-keyed route.
  provider?: InvoiceSource;
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
  const [source, setSource] = useState<InvoiceSource>('zoho');
  const [hasMore, setHasMore] = useState(false);
  // Real row count when the source reports one. The primary (our DB) source
  // always does; Zoho only sometimes. Undefined => the table renders an
  // honest cursor pager instead of inventing a total.
  const [total, setTotal] = useState<number | undefined>(undefined);
  // Cache + in-flight keys carry the source: the two tabs are separate
  // paginated lists, so page 1 of Zoho and page 1 of primary are different
  // rows and must not share a slot.
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
      void fetchInvoices(page, false, false, source);
      return;
    }

    // No NextAuth session → /login. Previous localStorage/token-cookie
    // fallback read values no auth route ever wrote — dead code.
    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email, page, source]);

  /** Cache/in-flight key. Tabs are independent lists, so the source is part of it. */
  const cacheKey = (targetPage: number, src: InvoiceSource) => `${src}:${targetPage}`;

  const fetchInvoices = async (
    targetPage: number = page,
    isBackground: boolean = false,
    forceRefresh: boolean = false,
    src: InvoiceSource = source
  ) => {
    const key = cacheKey(targetPage, src);
    if (forceRefresh) {
      delete invoicesCache.current[key];
    }

    if (!isBackground && invoicesCache.current[key]) {
      setInvoices(invoicesCache.current[key].data);
      setHasMore(invoicesCache.current[key].hasMore);
      setTotal(invoicesCache.current[key].total);
      setIsDataLoading(false);
      prefetchAdjacent(targetPage, invoicesCache.current[key].hasMore, src);
      return;
    }

    if (fetchingPages.current.has(key)) return;

    try {
      if (!isBackground) setIsDataLoading(true);
      fetchingPages.current.add(key);

      const result = await apiClient.get<{ invoices?: Invoice[]; page_context?: { has_more_page?: boolean; total?: number } }>(
        `/api/v1/admin/invoices?page=${targetPage}&per_page=10&source=${src}`
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
          prefetchAdjacent(targetPage, hasMorePage, src);
        }
      } else if (!isBackground) {
        showErrorToast('Failed to fetch invoices');
      }
    } finally {
      fetchingPages.current.delete(key);
      if (!isBackground) setIsDataLoading(false);
    }
  };

  const prefetchAdjacent = (currentPage: number, currentHasMore: boolean, src: InvoiceSource) => {
    const next = cacheKey(currentPage + 1, src);
    const prev = cacheKey(currentPage - 1, src);
    if (currentHasMore && !invoicesCache.current[next] && !fetchingPages.current.has(next)) {
      void fetchInvoices(currentPage + 1, true, false, src);
    }
    if (currentPage > 1 && !invoicesCache.current[prev] && !fetchingPages.current.has(prev)) {
      void fetchInvoices(currentPage - 1, true, false, src);
    }
  };

  const handleSourceChange = (next: InvoiceSource) => {
    if (next === source) return;
    setSource(next);
    // Both tabs start at page 1. Setting page also re-triggers the auth
    // effect's fetch when it isn't already 1, so guard against a double
    // fetch by only calling through when the page is unchanged.
    if (page === 1) {
      void fetchInvoices(1, false, false, next);
    } else {
      setPage(1);
    }
  };

  const handleDownload = async (row: Invoice) => {
    const invoiceId = row.invoice_id || row.order_id || '';
    const invoiceNumber = row.invoice_number;
    try {
      setDownloadingId(invoiceId);
      // A primary tax invoice has no Zoho id; its PDF is generated locally
      // and served by the orderId-keyed admin route.
      const url = row.provider === 'primary' && row.order_id
        ? `/api/v1/admin/orders/${encodeURIComponent(row.order_id)}/invoice`
        : `/api/v1/admin/invoices/${encodeURIComponent(invoiceId)}/pdf`;
      const response = await fetch(url);

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
        <div className="flex items-center gap-2 font-medium text-gray-900">
          <FileText className="h-4 w-4 text-blue-500 shrink-0" />
          <span>{value}</span>
          {row.provider === 'primary' && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200"
              title="Issued by our own GST engine — this number is the tax invoice of record and has no Zoho counterpart"
            >
              GST
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
      render: (_value: unknown, row: Invoice) => {
        const isPrimary = row.provider === 'primary';
        // Key actions off whichever id this row actually has: a Zoho invoice
        // has invoice_id, a primary one only ever has order_id.
        const docId = row.invoice_id || row.order_id || '';
        const viewHref = isPrimary
          ? `/admin/invoices/${encodeURIComponent(docId)}/view?src=order`
          : `/admin/invoices/${encodeURIComponent(docId)}/view`;
        return (
          <div className="flex items-center space-x-3">
            <button
              onClick={() => router.push(viewHref)}
              disabled={!docId}
              className="text-blue-600 hover:text-blue-900 disabled:text-gray-300 disabled:cursor-not-allowed"
              title="View Invoice"
            >
              <Eye className="h-4 w-4" />
            </button>
            <button
              onClick={() => handleDownload(row)}
              disabled={!docId || downloadingId === docId}
              className="text-blue-600 hover:text-blue-900 disabled:text-gray-300 disabled:cursor-not-allowed"
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
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
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
            <div className="p-2 bg-blue-50 rounded-xl">
              <Receipt className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">All Invoices</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage all invoices across the system</p>
            </div>
          </div>
          <RefreshButton onClick={() => fetchInvoices(page, false, true, source)} isLoading={isDataLoading} />
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
        {/* Zoho-only: the diagnostics panel finds orders whose ZOHO invoice
            never issued. Primary invoices have no zohoInvoiceId by design and
            are excluded from those queries, so the panel is meaningless (and
            misleading) on the GST tab. */}
        {source === 'zoho' && <InvoiceDiagnostics />}

        {/* ── Invoices card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <FileText className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">Billing History</h3>
            </div>
            {/* Source tabs. The two lists are paginated independently — Zoho
                paginates server-side, primary invoices live only in our DB —
                so they're shown side by side rather than merged into one list
                whose page numbers would silently repeat or skip rows. */}
            <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
              {([
                { id: 'zoho' as const,    label: 'Zoho Books' },
                { id: 'primary' as const, label: 'GST engine' },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSourceChange(tab.id)}
                  aria-pressed={source === tab.id}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                    source === tab.id
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
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
