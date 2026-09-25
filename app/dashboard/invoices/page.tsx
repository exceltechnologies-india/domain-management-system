'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, Download, AlertCircle, Eye, CheckCircle2,
  Clock, Inbox, Receipt,
} from 'lucide-react';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { useUser } from '@/hooks/useUser';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import UserLayout from '@/components/user/UserLayout';
import { performLogout } from '@/lib/logout';
import { DashboardLayoutSkeleton, InvoicesPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { formatIndianDate, formatIndianDateTime } from '@/lib/dateUtils';
import RefreshButton from '@/components/dashboard/RefreshButton';
import ResellerOsBills from '@/components/billing/ResellerOsBills';
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
  order_id?: string;
}

export default function InvoicesPage() {
  const { user, isLoading: isAuthLoading } = useUser();
  const router = useRouter();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

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

  // Only orders that DMS actually invoiced (before 25 Sep 2026) are shown
  // here, as earlier invoices. An order with no DMS invoice is not an
  // invoice, and its bill (if any) is ResellerOS's, shown above.
  const invoices = (invoicesData?.invoices ?? []).filter((inv) => Boolean(inv.invoice_id));

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
              <p className="text-sm text-ink-3 mt-0.5">Your bills, orders and renewals</p>
            </div>
          </div>
          <RefreshButton onClick={() => mutate()} isLoading={isValidating} />
        </div>

        {/* ── ResellerOS's bills — every bill since 25 Sep 2026 ── */}
        <ResellerOsBills />

        {/* ── Earlier invoices issued by this panel (read-only history) ── */}
        {(isLoadingInvoices || invoices.length > 0) && (
        <div className="bg-white border border-hairline rounded-2xl shadow-sm overflow-hidden">
          {!isLoadingInvoices && invoices.length > 0 && (
            <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-ink-3" />
                <h3 className="text-sm font-semibold text-ink">Earlier invoices issued by this panel</h3>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 bg-white border border-hairline px-2.5 py-1 rounded-full">
                {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          {isLoadingInvoices ? (
            <InvoicesPageSkeleton />
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

        )}

        {/* ── Info banner ── */}
        <div className="flex items-start gap-3 p-4 bg-indigo-soft border border-indigo/25 rounded-2xl">
          <AlertCircle className="h-4 w-4 text-amber-ink mt-0.5 shrink-0" />
          <p className="text-sm text-indigo-ink">
            New bills are issued by our billing system and emailed to you. Invoices this panel issued before 25 September 2026 stay listed here to view and download.
          </p>
        </div>
      </div>
    </UserLayout>
  );
}
