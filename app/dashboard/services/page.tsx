'use client';

import useSWR from 'swr';
import { Package, Inbox, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { fetcher } from '@/lib/fetcher';
import { useUser } from '@/hooks/useUser';
import UserLayout from '@/components/user/UserLayout';
import { performLogout } from '@/lib/logout';
import { DashboardLayoutSkeleton, InvoicesPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { formatIndianDate } from '@/lib/dateUtils';
import RefreshButton from '@/components/dashboard/RefreshButton';

interface Service {
  id: string;
  product: string;
  plan: string;
  seats: number;
  status: string;
  renewalDate: string;
  amount: number;
  currency: string;
}

const STATUS_STYLES: Record<string, { className: string; icon: typeof CheckCircle2 }> = {
  active: { className: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  suspended: { className: 'bg-amber-100 text-amber-800', icon: Clock },
  expired: { className: 'bg-gray-100 text-gray-700', icon: XCircle },
  cancelled: { className: 'bg-gray-100 text-gray-700', icon: XCircle },
};

export default function ServicesPage() {
  const { user, isLoading: isAuthLoading } = useUser();

  const {
    data,
    isLoading: isLoadingServices,
    isValidating,
    mutate,
  } = useSWR<{ services: Service[] }>(
    user ? '/api/v1/user/services' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const services = data?.services ?? [];

  if (isAuthLoading || !user) {
    return <DashboardLayoutSkeleton><InvoicesPageSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <UserLayout user={user} onLogout={performLogout}>
      <div className="p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Package className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">My Services</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Other services on your account — domains and hosting have their own tabs
              </p>
            </div>
          </div>
          <RefreshButton onClick={() => mutate()} isLoading={isValidating} />
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {isLoadingServices ? (
            <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
          ) : services.length === 0 ? (
            <div className="p-10 text-center">
              <Inbox className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No other services on your account yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/60 text-left text-xs font-medium text-gray-500 uppercase">
                    <th className="px-6 py-3">Service</th>
                    <th className="px-6 py-3">Seats</th>
                    <th className="px-6 py-3">Renews</th>
                    <th className="px-6 py-3">Amount</th>
                    <th className="px-6 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {services.map((s) => {
                    const style = STATUS_STYLES[s.status] ?? STATUS_STYLES.expired;
                    const StatusIcon = style.icon;
                    return (
                      <tr key={s.id}>
                        <td className="px-6 py-4">
                          <p className="font-medium text-gray-900">{s.product}</p>
                          <p className="text-xs text-gray-500">{s.plan}</p>
                        </td>
                        <td className="px-6 py-4 text-gray-700">{s.seats}</td>
                        <td className="px-6 py-4 text-gray-700">{formatIndianDate(s.renewalDate)}</td>
                        <td className="px-6 py-4 text-gray-700">
                          ₹{s.amount.toLocaleString('en-IN')}/yr
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full ${style.className}`}>
                            <StatusIcon className="h-3 w-3" />
                            {s.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </UserLayout>
  );
}
