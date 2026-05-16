'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { performLogout } from '@/lib/logout';
import {
  Search, Download, Eye, Calendar,
  CheckCircle, Clock, AlertTriangle, ExternalLink, FileText, RefreshCw, X, Receipt
} from 'lucide-react';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { useUser } from '@/hooks/useUser';
import { formatIndianDateTime } from '@/lib/dateUtils';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, OrdersPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { safeLocalStorage } from '@/lib/storage';

interface Order {
  _id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  domains: {
    domainName: string;
    price: number;
    currency: string;
    registrationPeriod: number;
    status: 'pending' | 'processing' | 'registered' | 'failed' | 'cancelled';
    itemType?: 'domain' | 'hosting';
    hostingPlan?: {
      name: string;
    };
    periodUnit?: string;
  }[];
  successfulDomains: string[];
  createdAt: string;
  updatedAt: string;
  invoiceNumber?: string;
}

export default function UserOrders() {
  const { user, isLoading: isAuthLoading } = useUser();
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  const {
    data: ordersData,
    isLoading: isLoadingOrders,
    isValidating,
    mutate,
  } = useSWR<{ orders: Order[] }>(
    user ? '/api/v1/orders' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const orders = ordersData?.orders ?? [];

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'cancelled':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4" />;
      case 'pending':
        return <Clock className="h-4 w-4" />;
      case 'failed':
        return <AlertTriangle className="h-4 w-4" />;
      case 'cancelled':
        return <AlertTriangle className="h-4 w-4" />;
      default:
        return <Receipt className="h-4 w-4" />;
    }
  };

  const formatRegistrationPeriod = (period: number, itemType?: 'domain' | 'hosting', hostingPlan?: any) => {
    const unit = (itemType === 'hosting' || hostingPlan ? 'month' : 'year');
    return `${period} ${unit}${period !== 1 ? 's' : ''} registration`;
  };

  const filteredOrders = orders.filter(order => {
    const matchesSearch =
      order.orderId?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (order.domains || []).some(domain => domain.domainName?.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesFilter = filterStatus === 'all' || order.status === filterStatus;
    return matchesSearch && matchesFilter;
  });

  const handleViewOrder = (order: Order) => {
    setSelectedOrder(order);
  };

  const handleDownloadInvoice = async (order: Order) => {
    if (!order._id) {
      toast.error('Order ID not available');
      return;
    }

    try {


      // Get token from localStorage (for credential login) or use session cookie (for NextAuth)
      let token = safeLocalStorage.getItem('token');
      const headers: HeadersInit = {};

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      toast.loading('Downloading invoice...', { id: 'download-invoice' });

      const response = await fetch(`/api/v1/orders/${order._id}/invoice`, {
        method: 'GET',
        headers,
        credentials: 'include', // Include cookies for NextAuth session
      });



      if (response.ok) {
        const blob = await response.blob();

        if (blob.size === 0) {
          toast.error('Invoice file is empty', { id: 'download-invoice' });
          return;
        }

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Invoice-${order.invoiceNumber || order.orderId}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        toast.success('Invoice downloaded successfully!', { id: 'download-invoice' });
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Failed to download invoice' }));

        toast.error(errorData.error || `Failed to download invoice (${response.status})`, { id: 'download-invoice' });
      }
    } catch (error) {
      toast.error(`Failed to download invoice: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: 'download-invoice' });
    }
  };

  if (!user || isAuthLoading) {
    return <DashboardLayoutSkeleton><OrdersPageSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout}>
        <div className="p-6">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900 mb-2">Order History</h1>
                <p className="text-gray-600">
                  View and manage your domain registration orders
                </p>
              </div>
              <div className="flex space-x-3">
                <RefreshButton onClick={() => mutate()} isLoading={isValidating} />
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="mb-6">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search orders or domains..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>
              <div className="sm:w-48">
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="all">All Status</option>
                  <option value="completed">Completed</option>
                  <option value="pending">Pending</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>
          </div>

          {/* Orders Table */}
          {isLoadingOrders ? (
            <OrdersPageSkeleton />
          ) : (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              {filteredOrders.length === 0 ? (
                <div className="text-center py-12">
                  <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No orders found</h3>
                  <p className="text-gray-500 mb-4">
                    {searchTerm || filterStatus !== 'all'
                      ? 'Try adjusting your search or filter criteria'
                      : 'You haven\'t placed any orders yet'
                    }
                  </p>
                  {!searchTerm && filterStatus === 'all' && (
                    <button
                      onClick={() => router.push('/')}
                      className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Search Domains
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Order
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Date
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Items
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Total
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {filteredOrders.map((order, index) => (
                        <motion.tr
                          key={order._id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.1 }}
                          className="hover:bg-gray-50"
                        >
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <Receipt className="h-5 w-5 text-gray-400 mr-3" />
                              <div>
                                <div className="text-sm font-medium text-gray-900">
                                  {order.orderId}
                                </div>
                                <div className="text-sm text-gray-500">
                                  {order.invoiceNumber || 'No invoice'}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {order.createdAt ? formatIndianDateTime(order.createdAt) : 'N/A'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>
                              {getStatusIcon(order.status)}
                              <span className="ml-1 capitalize">{order.status}</span>
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {(order.domains || []).length} domain{(order.domains || []).length !== 1 ? 's' : ''}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            ₹{(order.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                            <div className="flex space-x-3">
                              <button
                                onClick={() => handleViewOrder(order)}
                                className="p-2 text-blue-600 hover:text-blue-900 hover:bg-blue-50 rounded-lg transition-colors"
                                title="View Details"
                              >
                                <Eye className="h-5 w-5" />
                              </button>
                              <Link
                                href={`/dashboard/orders/${order.orderId}`}
                                className="p-2 text-purple-600 hover:text-purple-900 hover:bg-purple-50 rounded-lg transition-colors"
                                title="Track Order Status"
                              >
                                <ExternalLink className="h-5 w-5" />
                              </Link>
                              {order.invoiceNumber && (
                                <button
                                  onClick={() => handleDownloadInvoice(order)}
                                  className="p-2 text-green-600 hover:text-green-900 hover:bg-green-50 rounded-lg transition-colors"
                                  title="Download Invoice"
                                >
                                  <Download className="h-5 w-5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Order Details Modal */}
          {selectedOrder && selectedOrder.orderId && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">
                      Order Details - {selectedOrder.orderId}
                    </h3>
                    <button
                      onClick={() => setSelectedOrder(null)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <X className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm font-medium text-gray-600">Order Date</p>
                        <p className="text-sm text-gray-900">{selectedOrder.createdAt ? formatIndianDateTime(selectedOrder.createdAt) : 'N/A'}</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-600">Status</p>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(selectedOrder.status)}`}>
                          {getStatusIcon(selectedOrder.status)}
                          <span className="ml-1 capitalize">{selectedOrder.status}</span>
                        </span>
                      </div>
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-600 mb-2">Items</p>
                      <div className="space-y-2">
                        {(selectedOrder.domains || []).map((domain, index) => (
                          <div key={index} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                            <div>
                              <p className="font-medium text-gray-900">
                                {domain.domainName || 'Unknown Domain'}
                                {domain.hostingPlan?.name && (
                                  <span className="ml-2 text-xs font-normal text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                                    {domain.hostingPlan.name}
                                  </span>
                                )}
                              </p>
                              <p className="text-sm text-gray-500">
                                {formatRegistrationPeriod(domain.registrationPeriod || 1, domain.itemType, domain.hostingPlan)}
                              </p>
                            </div>
                            <p className="font-semibold text-gray-900">₹{((domain.price || 0) * (domain.registrationPeriod || 1)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="border-t pt-4">
                      <div className="space-y-2">
                        {/* Subtotal */}
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-gray-600">Subtotal</span>
                          <span className="text-sm text-gray-900">₹{((selectedOrder.amount || 0) / 1.18).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>

                        {/* GST (18%) */}
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-gray-600">GST (18%)</span>
                          <span className="text-sm text-gray-900">₹{((selectedOrder.amount || 0) - ((selectedOrder.amount || 0) / 1.18)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>

                        {/* Total */}
                        <div className="flex justify-between items-center border-t pt-2">
                          <span className="text-lg font-semibold text-gray-900">Total (incl. GST)</span>
                          <span className="text-lg font-bold text-blue-600">₹{(selectedOrder.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <p className="text-xs text-gray-500 text-right">*GST (18%) is included in the total amount</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
