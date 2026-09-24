'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, Download, AlertCircle, Eye, CheckCircle2,
  Clock, Inbox, IndianRupee, Receipt,
} from 'lucide-react';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { apiClient } from '@/lib/api-client';
import { useUser } from '@/hooks/useUser';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import UserLayout from '@/components/user/UserLayout';
import { performLogout } from '@/lib/logout';
import { DashboardLayoutSkeleton, InvoicesPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { formatIndianDate, formatIndianDateTime } from '@/lib/dateUtils';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { logger } from '@/lib/logger';

interface Invoice {
  invoice_id: string;
  invoice_number: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
  currency_code: string;
  invoice_url?: string;
  created_time?: string;
  /** Paid, but the invoice attempt failed — offer the retry pill. */
  invoice_failed?: boolean;
  order_id?: string;
}

export default function InvoicesPage() {
  const { user, isLoading: isAuthLoading } = useUser();
  const router = useRouter();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const {
    data: invoicesData,
    isLoading: isLoadingInvoices,
    isValidating,
    mutate,
  } = useSWR<{ invoices: Invoice[] }>(
    user ? '/api/v1/user/invoices' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const invoices = invoicesData?.invoices ?? [];

  // While any paid invoice is still being generated in the background, poll
  // every 30s so the user sees it appear without having to refresh manually.
  const hasPendingInvoice = invoices.some((inv) => inv.invoice_failed);
  useEffect(() => {
    if (!hasPendingInvoice) return;
    const id = setInterval(() => { void mutate(); }, 30000);
    return () => clearInterval(id);
  }, [hasPendingInvoice, mutate]);

  const handleSyncNow = async () => {
    setIsSyncing(true);
    const result = await apiClient.post<{ recovered?: number; failed?: number; total?: number; results?: Array<{ error?: string }> }>('/api/v1/user/invoices/sync', undefined);
    if (!result.ok) {
      showErrorToast(result.error.message || 'Sync failed');
      setIsSyncing(false);
      return;
    }
    const data = result.data;
    if ((data.recovered ?? 0) > 0) {
      showSuccessToast(`Invoice${(data.recovered ?? 0) > 1 ? 's' : ''} ready — refreshing.`);
    } else if ((data.failed ?? 0) > 0) {
      const firstError = data.results?.find((r) => r.error)?.error;
      showErrorToast(firstError || 'Could not generate invoice — please contact support.');
    } else if (data.total === 0) {
      showSuccessToast('Nothing to sync.');
    } else {
      showSuccessToast('Sync requested — refreshing.');
    }
    await mutate();
    setIsSyncing(false);
  };

  const handleDownload = async (orderId: string, invoiceNumber: string) => {
    try {
      setDownloadingId(orderId);
      const response = await fetch(`/api/v1/orders/${orderId}/invoice`);

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
      logger.error('Error downloading invoice:', error);
      showErrorToast('Failed to download invoice');
    } finally {
      setDownloadingId(null);
    }
  };

  const getStatusCfg = (status: string): { cls: string; icon: React.ElementType } => {
    switch (status.toLowerCase()) {
      case 'paid':
        return { cls: 'bg-green-50 text-green-700 border-green-200', icon: CheckCircle2 };
      case 'sent':
      case 'open':
        return { cls: 'bg-indigo-soft text-amber-ink border-indigo/25', icon: Clock };
      case 'overdue':
        return { cls: 'bg-red-50 text-red-700 border-red-200', icon: AlertCircle };
      case 'void':
        return { cls: 'bg-paper-2 text-ink-3 border-hairline', icon: Inbox };
      case 'draft':
        return { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: FileText };
      default:
        return { cls: 'bg-paper-2 text-ink-2 border-hairline', icon: FileText };
    }
  };

  const formatDate = (dateString: string) => {
    return formatIndianDate(dateString);
  };

  const formatDateTime = (dateString: string) => {
    return formatIndianDateTime(dateString);
  };

  if (isAuthLoading || !user) {
    return <DashboardLayoutSkeleton><InvoicesPageSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <UserLayout user={user} onLogout={performLogout}>
      <div className="p-6 space-y-6">

        {/* ── Page header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-soft rounded-xl">
              <Receipt className="h-5 w-5 text-amber-ink" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ink">Invoices</h1>
              <p className="text-sm text-ink-3 mt-0.5">View and download your billing history</p>
            </div>
          </div>
          <RefreshButton onClick={() => mutate()} isLoading={isValidating} />
        </div>

        {/* ── Summary stats ── */}
        {!isLoadingInvoices && invoices.length > 0 && (() => {
          const paid = invoices.filter(i => i.status.toLowerCase() === 'paid').length;
          const due = invoices.filter(i => i.balance > 0).length;
          const totalDue = invoices.reduce((s, i) => s + (i.balance > 0 ? i.balance : 0), 0);
          return (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-indigo-soft rounded-xl">
                  <FileText className="h-4 w-4 text-amber-ink" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Total Invoices</p>
                  <p className="text-xl font-bold text-ink">{invoices.length}</p>
                </div>
              </div>
              <div className="bg-white border border-hairline rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-green-50 rounded-xl">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">Paid</p>
                  <p className="text-xl font-bold text-ink">{paid}</p>
                </div>
              </div>
              <div className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 ${due > 0 ? 'border-amber-200' : 'border-hairline'}`}>
                <div className={`p-2 rounded-xl ${due > 0 ? 'bg-amber-50' : 'bg-paper-2/60'}`}>
                  <IndianRupee className={`h-4 w-4 ${due > 0 ? 'text-amber-600' : 'text-ink-3'}`} />
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-3">{due > 0 ? 'Amount Due' : 'All Cleared'}</p>
                  <p className="text-xl font-bold text-ink">
                    {due > 0 ? `₹${totalDue.toLocaleString()}` : '—'}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Invoices card ── */}
        <div className="bg-white border border-hairline rounded-2xl shadow-sm overflow-hidden">
          {!isLoadingInvoices && invoices.length > 0 && (
            <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-ink-3" />
                <h3 className="text-sm font-semibold text-ink">Billing History</h3>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 bg-white border border-hairline px-2.5 py-1 rounded-full">
                {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          {isLoadingInvoices ? (
            <InvoicesPageSkeleton />
          ) : invoices.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <div className="w-14 h-14 bg-paper-2 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Inbox className="h-7 w-7 text-ink-4" />
              </div>
              <h3 className="text-sm font-semibold text-ink mb-1.5">No invoices found</h3>
              <p className="text-sm text-ink-3">You don't have any invoices yet — they'll appear here after your first purchase.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-paper-2/60 border-b border-hairline">
                    <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Invoice</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Date</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-ink-3 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {invoices.map((invoice) => {
                    const statusCfg = getStatusCfg(invoice.status);
                    const StatusIcon = statusCfg.icon;
                    // `invoice_id` is the order id, and is set only once an
                    // invoice has actually been issued.
                    const docId = invoice.invoice_id;
                    const hasDocument = Boolean(docId);
                    return (
                      <tr
                        key={docId || invoice.invoice_number}
                        className="hover:bg-indigo-soft/30 transition-colors group"
                      >
                        {/* Invoice number */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className="flex-shrink-0 h-9 w-9 bg-indigo-soft rounded-xl flex items-center justify-center">
                              <FileText className="h-4 w-4 text-amber-ink" />
                            </div>
                            <span className="text-sm font-mono font-semibold text-ink">{invoice.invoice_number}</span>
                          </div>
                        </td>
                        {/* Date */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="text-sm text-ink">{formatDateTime(invoice.created_time || invoice.date)}</div>
                          <div className="text-xs text-ink-4 mt-0.5">Due {formatDate(invoice.due_date)}</div>
                        </td>
                        {/* Amount */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="text-sm font-semibold text-ink font-mono">
                            {invoice.currency_code} {invoice.total.toLocaleString()}
                          </div>
                          {invoice.balance > 0 && (
                            <div className="text-xs text-red-600 font-medium mt-0.5 font-mono">
                              Balance: {invoice.currency_code} {invoice.balance.toLocaleString()}
                            </div>
                          )}
                        </td>
                        {/* Status */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusCfg.cls}`}>
                            <StatusIcon className="h-3 w-3" />
                            <span className="capitalize">{invoice.status}</span>
                          </span>
                        </td>
                        {/* Actions */}
                        <td className="px-5 py-3.5 whitespace-nowrap text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {hasDocument && (
                              <button
                                onClick={() =>
                                  router.push(
                                    `/dashboard/invoices/${docId}/view`
                                  )
                                }
                                className="p-2.5 text-ink-4 hover:text-amber-ink hover:bg-indigo-soft rounded-lg transition-colors"
                                title="View invoice"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                            )}
                            {hasDocument && (
                              <button
                                onClick={() => handleDownload(docId, invoice.invoice_number)}
                                disabled={downloadingId === docId}
                                className="p-2.5 text-ink-4 hover:text-amber-ink hover:bg-indigo-soft rounded-lg transition-colors disabled:opacity-50"
                                title="Download PDF"
                              >
                                {downloadingId === docId ? (
                                  <div className="animate-spin h-4 w-4 border-2 border-amber border-t-transparent rounded-full" />
                                ) : (
                                  <Download className="h-4 w-4" />
                                )}
                              </button>
                            )}
                            {/* Only a paid order whose invoice attempt FAILED
                                offers the retry pill. An issued invoice has a
                                document — "we're finalising your invoice"
                                there would be false. */}
                            {!hasDocument && invoice.invoice_failed && (
                              <button
                                type="button"
                                onClick={handleSyncNow}
                                disabled={isSyncing}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 hover:border-amber-300 px-2.5 py-1 rounded-full transition-colors disabled:opacity-60 disabled:cursor-wait"
                                title="Click to retry. Your payment is complete — we're finalising your invoice."
                              >
                                {isSyncing ? (
                                  <>
                                    <div className="animate-spin h-3 w-3 border-2 border-amber-600 border-t-transparent rounded-full" />
                                    Syncing…
                                  </>
                                ) : (
                                  <>
                                    <span className="relative flex h-1.5 w-1.5">
                                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                                    </span>
                                    Generating · Retry
                                  </>
                                )}
                              </button>
                            )}
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

        {/* ── Info banner ── */}
        <div className="flex items-start gap-3 p-4 bg-indigo-soft border border-indigo/25 rounded-2xl">
          <AlertCircle className="h-4 w-4 text-amber-ink mt-0.5 shrink-0" />
          <p className="text-sm text-indigo-ink">
            A GST invoice is issued automatically when your payment completes. If one shows “Generating”, press Retry — or check back in a few minutes and it will appear here.
          </p>
        </div>
      </div>
    </UserLayout>
  );
}
