'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, Download, ExternalLink, AlertCircle, Eye, CheckCircle2,
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
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';

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
  zoho_pending?: boolean;
}

export default function InvoicesPage() {
  const { user, isLoading: isAuthLoading } = useUser();
  const router = useRouter();
  const razorpay = useRazorpayCheckout();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
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
  const hasPendingInvoice = invoices.some((inv) => inv.zoho_pending);
  useEffect(() => {
    if (!hasPendingInvoice) return;
    const id = setInterval(() => { void mutate(); }, 30000);
    return () => clearInterval(id);
  }, [hasPendingInvoice, mutate]);

  const handlePayNow = async (invoice: Invoice) => {
    try {
      setIsProcessingPayment(true);
      const response = await fetch(`/api/v1/user/invoices/${invoice.invoice_id}/pay`, {
        method: 'POST',
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to initiate payment');

      let payment;
      try {
        payment = await razorpay.open({
          key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
          amount: data.amount * 100,
          currency: data.currency,
          name: "Anutech Digital",
          description: `Payment for Invoice ${data.invoiceNumber}`,
          order_id: data.razorpayOrderId,
          prefill: {
            email: user?.email,
            name: `${user?.firstName} ${user?.lastName}`
          },
          theme: { color: "#0177E1" }
        });
      } catch (err: unknown) {
        if ((err as { kind?: string })?.kind === 'dismissed') {
          setIsProcessingPayment(false);
          return;
        }
        throw err;
      }

      try {
        const verifyRes = await fetch('/api/v1/payments/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payment,
            orderId: data.orderId,
            cartItems: [{
              itemType: 'hosting',
              price: data.amount,
              currency: data.currency,
              domainName: 'Invoice Renewal'
            }]
          })
        });

        if (verifyRes.ok) {
          showSuccessToast('Payment successful! Services are being reactivated.');
          void mutate();
          router.push('/dashboard/hosting');
        } else {
          showErrorToast('Payment verified but service reactivation failed. Please contact support.');
        }
      } catch (err) {
        showErrorToast('Failed to verify payment');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showErrorToast(message);
    } finally {
      setIsProcessingPayment(false);
    }
  };

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

  const handleDownload = async (invoiceId: string, invoiceNumber: string) => {
    try {
      setDownloadingId(invoiceId);
      const response = await fetch(`/api/v1/user/invoices/${invoiceId}/pdf`);

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
        return { cls: 'bg-blue-50 text-blue-700 border-blue-200', icon: Clock };
      case 'overdue':
        return { cls: 'bg-red-50 text-red-700 border-red-200', icon: AlertCircle };
      case 'void':
        return { cls: 'bg-gray-100 text-gray-500 border-gray-200', icon: Inbox };
      case 'draft':
        return { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: FileText };
      default:
        return { cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: FileText };
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
      <razorpay.Frame />
      <div className="p-6 space-y-6">

        {/* ── Page header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Receipt className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
              <p className="text-sm text-gray-500 mt-0.5">View and download your billing history</p>
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
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className="p-2 bg-blue-50 rounded-xl">
                  <FileText className="h-4 w-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">Total Invoices</p>
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
                  <p className="text-xs font-medium text-gray-500">{due > 0 ? 'Amount Due' : 'All Cleared'}</p>
                  <p className="text-xl font-bold text-gray-900">
                    {due > 0 ? `₹${totalDue.toLocaleString()}` : '—'}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Invoices card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {!isLoadingInvoices && invoices.length > 0 && (
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-gray-500" />
                <h3 className="text-sm font-semibold text-gray-900">Billing History</h3>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
                {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          {isLoadingInvoices ? (
            <InvoicesPageSkeleton />
          ) : invoices.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Inbox className="h-7 w-7 text-gray-400" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No invoices found</h3>
              <p className="text-sm text-gray-500">You don't have any invoices yet — they'll appear here after your first purchase.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/60 border-b border-gray-100">
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Invoice</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Amount</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {invoices.map((invoice) => {
                    const statusCfg = getStatusCfg(invoice.status);
                    const StatusIcon = statusCfg.icon;
                    const canPay = invoice.invoice_id && invoice.balance > 0 &&
                      ['sent', 'open', 'overdue'].includes(invoice.status.toLowerCase());
                    return (
                      <tr key={invoice.invoice_id} className="hover:bg-blue-50/30 transition-colors group">
                        {/* Invoice number */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className="flex-shrink-0 h-9 w-9 bg-blue-50 rounded-xl flex items-center justify-center">
                              <FileText className="h-4 w-4 text-blue-600" />
                            </div>
                            <span className="text-sm font-mono font-semibold text-gray-900">{invoice.invoice_number}</span>
                          </div>
                        </td>
                        {/* Date */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="text-sm text-gray-800">{formatDateTime(invoice.created_time || invoice.date)}</div>
                          <div className="text-xs text-gray-400 mt-0.5">Due {formatDate(invoice.due_date)}</div>
                        </td>
                        {/* Amount */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="text-sm font-semibold text-gray-900 font-mono">
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
                            {canPay && (
                              <button
                                onClick={() => handlePayNow(invoice)}
                                disabled={downloadingId === invoice.invoice_id}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 shadow-sm"
                                title="Pay Now"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Pay Now
                              </button>
                            )}
                            {invoice.invoice_id && (
                              <button
                                onClick={() => router.push(`/dashboard/invoices/${invoice.invoice_id}/view`)}
                                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                title="View invoice"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                            )}
                            {invoice.invoice_id && (
                              <button
                                onClick={() => handleDownload(invoice.invoice_id, invoice.invoice_number)}
                                disabled={downloadingId === invoice.invoice_id}
                                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                                title="Download PDF"
                              >
                                {downloadingId === invoice.invoice_id ? (
                                  <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full" />
                                ) : (
                                  <Download className="h-4 w-4" />
                                )}
                              </button>
                            )}
                            {!invoice.invoice_id && (
                              <button
                                type="button"
                                onClick={handleSyncNow}
                                disabled={isSyncing}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 hover:border-amber-300 px-2.5 py-1 rounded-full transition-colors disabled:opacity-60 disabled:cursor-wait"
                                title="Click to retry. Your payment is complete — we're finalising the accounting invoice."
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

        {/* ── Sync info banner ── */}
        <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-2xl">
          <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
          <p className="text-sm text-blue-800">
            Invoices are synchronized from our accounting system. If you recently made a payment and don't see the invoice here yet, please check back in a few minutes.
          </p>
        </div>
      </div>
    </UserLayout>
  );
}
