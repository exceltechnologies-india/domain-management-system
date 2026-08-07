'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { formatIndianDate } from '@/lib/dateUtils';

interface BillingSubscription {
  id: string;
  product: string;
  plan: string;
  seats: number;
  status: string;
  renewal_date: string;
  amount: number;
  currency: string;
}

interface BillingInvoice {
  id: string;
  number: string;
  amount: number;
  currency: string;
  status: string;
  issue_date: string;
  pdf_url: string;
}

interface BillingSummary {
  linked: boolean;
  customer?: { billing_customer_id: string; name: string; email: string; status: string };
  subscriptions?: BillingSubscription[];
  invoices?: BillingInvoice[];
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  paid: 'bg-green-100 text-green-800',
  suspended: 'bg-yellow-100 text-yellow-800',
  unpaid: 'bg-yellow-100 text-yellow-800',
  overdue: 'bg-red-100 text-red-800',
  expired: 'bg-gray-100 text-gray-700',
  cancelled: 'bg-gray-100 text-gray-700',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700'
        }`}
    >
      {status}
    </span>
  );
}

export default function CustomerBillingPanel({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<BillingSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    apiClient
      .get<BillingSummary>(`/api/v1/admin/users/${userId}/billing`)
      .then((result) => {
        if (cancelled) return;
        setData(result.ok ? result.data : { linked: false });
      })
      .catch(() => {
        if (!cancelled) setData({ linked: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) {
    return (
      <div>
        <label className="text-sm font-medium text-gray-500">Billing (ResellerOS)</label>
        <p className="text-sm text-gray-400 mt-1">Loading…</p>
      </div>
    );
  }

  if (!data?.linked) {
    return (
      <div>
        <label className="text-sm font-medium text-gray-500">Billing (ResellerOS)</label>
        <p className="text-sm text-gray-400 mt-1">No linked Billing account found for this email.</p>
      </div>
    );
  }

  const subscriptions = data.subscriptions ?? [];
  const invoices = data.invoices ?? [];

  return (
    <div>
      <label className="text-sm font-medium text-gray-500">Billing (ResellerOS)</label>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-900">{data.customer?.billing_customer_id}</span>
        <StatusBadge status={data.customer?.status ?? 'inactive'} />
      </div>

      {subscriptions.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-gray-500 uppercase mb-1">Subscriptions</p>
          <div className="space-y-1">
            {subscriptions.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">{s.product} ({s.seats} seats)</span>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">₹{s.amount.toLocaleString('en-IN')}/{s.plan === 'annual' ? 'yr' : 'mo'}</span>
                  <StatusBadge status={s.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {invoices.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-gray-500 uppercase mb-1">Recent Invoices</p>
          <div className="space-y-1">
            {invoices.slice(0, 5).map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-sm">
                <a
                  href={inv.pdf_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {inv.number}
                </a>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">{formatIndianDate(inv.issue_date)}</span>
                  <span className="text-gray-500">₹{inv.amount.toLocaleString('en-IN')}</span>
                  <StatusBadge status={inv.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {subscriptions.length === 0 && invoices.length === 0 && (
        <p className="text-sm text-gray-400 mt-1">Linked, but no subscriptions or invoices yet.</p>
      )}
    </div>
  );
}
