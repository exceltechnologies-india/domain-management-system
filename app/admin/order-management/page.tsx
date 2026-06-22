'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Search, Filter, MoreVertical, Eye, Download, Archive, Trash2, RefreshCw, AlertTriangle, CheckCircle, Clock, XCircle, RotateCcw, ShoppingBag, Inbox } from 'lucide-react';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import AdminDataTable from '@/components/admin/AdminDataTable';
import ActionMenu from '@/components/admin/ActionMenu';
import Modal from '@/components/Modal';
import { formatIndianDate, formatIndianDateTime } from '@/lib/dateUtils';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';
import { apiClient } from '@/lib/api-client';

interface Order {
  _id: string;
  orderId: string;
  userId: {
    firstName: string;
    lastName: string;
    email: string;
  };
  amount: number;
  currency: string;
  status: string;
  paymentId: string;
  createdAt: string;
  domains: Array<{
    domainName: string;
    registrationPeriod: number;
    price: number;
    status: string;
    error?: string;
    hostingPlan?: {
      name: string;
    };
    periodUnit?: string;
    itemType?: string;
  }>;
  type: string;
  gst?: {
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
  };
  successfulDomains: string[];
  failedDomains: string[];
  isArchived?: boolean; // Legacy
  isDeleted?: boolean; // Actual DB field
}

interface User {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export default function AdminOrders() {
  const [user, setUser] = useState<User | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [archivedOrders, setArchivedOrders] = useState<Order[]>([]);
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');

  const [activePage, setActivePage] = useState(1);
  const [activeHasMore, setActiveHasMore] = useState(false);
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedHasMore, setArchivedHasMore] = useState(false);

  const activeCache = useRef<Record<number, { data: Order[], hasMore: boolean }>>({});
  const archivedCache = useRef<Record<number, { data: Order[], hasMore: boolean }>>({});

  const activeFetching = useRef<Set<number>>(new Set());
  const archivedFetching = useRef<Set<number>>(new Set());

  // Split loading states
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUnarchiveModalOpen, setIsUnarchiveModalOpen] = useState(false);
  const [orderToUnarchive, setOrderToUnarchive] = useState<Order | null>(null);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  const router = useRouter();
  const { data: session, status } = useSession();

  // Action Menu State
  const [menuData, setMenuData] = useState<{
    id: string;
    x: number;
    y: number;
    order: Order;
  } | null>(null);

  const handleTripleDotClick = (e: React.MouseEvent, o: Order) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuData({
      id: o._id,
      x: e.clientX,
      y: e.clientY,
      order: o
    });
  };

  const handleContextMenu = (e: React.MouseEvent, o: Order) => {
    e.preventDefault();
    setMenuData({
      id: o._id,
      x: e.clientX,
      y: e.clientY,
      order: o
    });
  };

  const closeMenu = () => setMenuData(null);

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Prefer NextAuth session (works for credentials login)
    if (session?.user) {
      const sessionUser = session.user;
      const userObj = {
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

      setUser(userObj as User);
      setIsAuthLoading(false);
      void fetchOrders('active', 1);
      return;
    }

    // No NextAuth session → /login. Previous localStorage/token-cookie
    // fallback read values no auth route ever wrote — dead code.
    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  useEffect(() => {
    if (!isAuthLoading && user) {
      const targetPage = activeTab === 'active' ? activePage : archivedPage;
      void fetchOrders(activeTab, targetPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const fetchOrders = async (
    tab: 'active' | 'archived' = activeTab,
    targetPage: number = tab === 'active' ? activePage : archivedPage,
    isBackground: boolean = false,
    forceRefresh: boolean = false
  ) => {
    const cache = tab === 'active' ? activeCache : archivedCache;
    const fetching = tab === 'active' ? activeFetching : archivedFetching;

    if (forceRefresh) {
      delete cache.current[targetPage];
    }

    if (!isBackground && cache.current[targetPage]) {
      const cachedData = cache.current[targetPage];
      if (tab === 'active') {
        setOrders(cachedData.data);
        setActiveHasMore(cachedData.hasMore);
      } else {
        setArchivedOrders(cachedData.data);
        setArchivedHasMore(cachedData.hasMore);
      }
      setIsDataLoading(false);
      prefetchAdjacent(tab, targetPage, cachedData.hasMore);
      return;
    }

    if (fetching.current.has(targetPage)) return;

    if (!isBackground) setIsDataLoading(true);
    fetching.current.add(targetPage);

    const archivedParam = tab === 'archived' ? 'true' : 'false';
    const result = await apiClient.get<{ orders?: Order[]; page_context?: { has_more_page?: boolean } }>(
      `/api/v1/admin/orders?page=${targetPage}&per_page=10&archived=${archivedParam}`
    );

    if (result.ok) {
      const newOrders = result.data.orders || [];
      const hasMorePage = result.data.page_context?.has_more_page || false;

      cache.current[targetPage] = { data: newOrders, hasMore: hasMorePage };

      if (!isBackground) {
        if (tab === 'active') {
          setOrders(newOrders);
          setActiveHasMore(hasMorePage);
        } else {
          setArchivedOrders(newOrders);
          setArchivedHasMore(hasMorePage);
        }
        prefetchAdjacent(tab, targetPage, hasMorePage);
      }
    }

    fetching.current.delete(targetPage);
    if (!isBackground) setIsDataLoading(false);
  };

  const prefetchAdjacent = (tab: 'active' | 'archived', currentPage: number, currentHasMore: boolean) => {
    const cache = tab === 'active' ? activeCache : archivedCache;
    const fetching = tab === 'active' ? activeFetching : archivedFetching;

    if (currentHasMore && !cache.current[currentPage + 1] && !fetching.current.has(currentPage + 1)) {
      void fetchOrders(tab, currentPage + 1, true);
    }
    if (currentPage > 1 && !cache.current[currentPage - 1] && !fetching.current.has(currentPage - 1)) {
      void fetchOrders(tab, currentPage - 1, true);
    }
  };

  const handleLogout = () => {
    void performLogout();
  };

  const handleViewOrder = (orderId: string) => {
    // Check both active and archived orders
    const orderToView = orders.find(o => o._id === orderId) ||
      archivedOrders.find(o => o._id === orderId);
    if (orderToView) {
      setSelectedOrder(orderToView);
      setIsModalOpen(true);
    }
  };

  const handleDeleteOrder = (order: Order) => {
    setOrderToDelete(order);
    setIsDeleteModalOpen(true);
  };

  const confirmDeleteOrder = async () => {
    if (!orderToDelete) return;

    setIsDeleting(true);
    const url = `/api/v1/admin/orders/${orderToDelete._id}${activeTab === 'archived' ? '?permanent=true' : ''}`;
    const result = await apiClient.delete(url);

    if (result.ok) {
      if (activeTab === 'active') {
        // Move from active to archived
        const archivedOrder = { ...orderToDelete, isArchived: true };
        setOrders(orders.filter(o => o._id !== orderToDelete._id));
        setArchivedOrders([archivedOrder, ...archivedOrders]);
        showSuccessToast('Order archived successfully');
      } else {
        // Permanently deleted
        setArchivedOrders(archivedOrders.filter(o => o._id !== orderToDelete._id));
        showSuccessToast('Order deleted permanently');
      }

      activeCache.current = {};
      archivedCache.current = {};

      setIsDeleteModalOpen(false);
      setOrderToDelete(null);
    } else {
      showErrorToast(result.error.status === 0 ? 'An error occurred while deleting the order' : result.error.message || 'Failed to delete order');
    }
    setIsDeleting(false);
  };

  const cancelDeleteOrder = () => {
    setIsDeleteModalOpen(false);
    setOrderToDelete(null);
  };

  const handleUnarchiveOrder = (order: Order) => {
    setOrderToUnarchive(order);
    setIsUnarchiveModalOpen(true);
  };

  const confirmUnarchiveOrder = async () => {
    if (!orderToUnarchive) return;

    setIsUnarchiving(true);
    const result = await apiClient.patch(`/api/v1/admin/orders/${orderToUnarchive._id}`, undefined);

    if (result.ok) {
      // Move from archived to active
      const activeOrder = { ...orderToUnarchive, isArchived: false };
      setArchivedOrders(archivedOrders.filter(o => o._id !== orderToUnarchive._id));
      setOrders([activeOrder, ...orders]);

      activeCache.current = {};
      archivedCache.current = {};

      setIsUnarchiveModalOpen(false);
      setOrderToUnarchive(null);
      showSuccessToast('Order un-archived successfully');
    } else {
      showErrorToast(result.error.status === 0 ? 'An error occurred while un-archiving the order' : result.error.message || 'Failed to un-archive order');
    }
    setIsUnarchiving(false);
  };

  const cancelUnarchiveOrder = () => {
    setIsUnarchiveModalOpen(false);
    setOrderToUnarchive(null);
  };

  const columns = [
    {
      key: 'orderId',
      label: 'Order ID',
      sortable: true,
      render: (value: string) => <span className="font-medium text-gray-900 text-xs sm:text-sm">{value}</span>
    },
    {
      key: 'customer',
      label: 'Customer',
      sortable: true,
      render: (_value: unknown, row: Order) => (
        <div>
          <div className="text-xs sm:text-sm font-medium text-gray-900">
            {row.userId ? `${row.userId.firstName} ${row.userId.lastName}` : 'Unknown'}
          </div>
          <div className="text-xs sm:text-sm text-gray-500 truncate max-w-[150px] sm:max-w-none">
            {row.userId ? row.userId.email : ''}
          </div>
        </div>
      )
    },
    {
      key: 'amount',
      label: 'Amount',
      sortable: true,
      render: (_value: unknown, row: Order) => (
        <span className="text-xs sm:text-sm font-medium text-gray-900">
          ₹{row.amount.toFixed(2)}
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (_value: unknown, row: Order) => (
        <span className={`px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full ${row.status === 'completed'
          ? 'bg-green-100 text-green-800'
          : row.status === 'pending'
            ? 'bg-yellow-100 text-yellow-800'
            : 'bg-red-100 text-red-800'
          }`}>
          {row.status}
        </span>
      )
    },
    {
      key: 'date',
      label: 'Date',
      sortable: true,
      render: (_value: unknown, row: Order) => (
        <span className="text-xs sm:text-sm text-gray-600">
          {formatIndianDate(new Date(row.createdAt))}
        </span>
      )
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_value: unknown, row: Order) => (
        <button
          onClick={(e) => handleTripleDotClick(e, row)}
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
        >
          <MoreVertical className="h-5 w-5" />
        </button>
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

  if (!user || isAuthLoading) {
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={handleLogout}>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <ShoppingBag className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Order Management</h1>
              <p className="text-sm text-gray-500 mt-0.5">Track and manage customer orders</p>
            </div>
          </div>
          <RefreshButton
            onClick={() => fetchOrders(activeTab, activeTab === 'active' ? activePage : archivedPage, false, true)}
            isLoading={isDataLoading}
          />
        </div>

        {/* ── Summary stat cards ── */}
        {!isDataLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => setActiveTab('active')}
              className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'active' ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300 hover:shadow-md'}`}
            >
              <div className="p-2 bg-blue-50 rounded-xl">
                <ShoppingBag className="h-4 w-4 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-500">Active Orders</p>
                <p className="text-xl font-bold text-gray-900">{orders.length}</p>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('archived')}
              className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'archived' ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300 hover:shadow-md'}`}
            >
              <div className="p-2 bg-gray-100 rounded-xl">
                <Archive className="h-4 w-4 text-gray-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-500">Archived</p>
                <p className="text-xl font-bold text-gray-900">{archivedOrders.length}</p>
              </div>
            </button>
          </div>
        )}

        {/* ── Orders card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header — segmented tabs */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <ShoppingBag className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">
                {activeTab === 'active' ? 'Active Orders' : 'Archived Orders'}
              </h3>
            </div>
            <div className="inline-flex bg-gray-100 rounded-xl p-1">
              {[
                { id: 'active',   label: 'Active',   count: orders.length },
                { id: 'archived', label: 'Archived', count: archivedOrders.length },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id as 'active' | 'archived')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    activeTab === t.id
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.label} <span className={`ml-1 ${activeTab === t.id ? 'text-blue-600' : 'text-gray-400'}`}>({t.count})</span>
                </button>
              ))}
            </div>
          </div>

          {/* Tab content */}
          <div className="p-4 sm:p-6">
            {isDataLoading ? (
              <AdminGenericPageSkeleton />
            ) : (
              <>
                {activeTab === 'active' ? (
                  <AdminDataTable
                    title=""
                    columns={columns}
                    data={orders}
                    searchable={true}
                    pagination={true}
                    pageSize={10}
                    totalItems={activeHasMore ? (activePage * 10) + 10 : activePage * 10}
                    currentPage={activePage}
                    onPageChange={(p) => { setActivePage(p); void fetchOrders('active', p); }}
                    onRowContextMenu={handleContextMenu}
                  />
                ) : (
                  <AdminDataTable
                    title=""
                    columns={columns}
                    data={archivedOrders}
                    searchable={true}
                    pagination={true}
                    pageSize={10}
                    totalItems={archivedHasMore ? (archivedPage * 10) + 10 : archivedPage * 10}
                    currentPage={archivedPage}
                    onPageChange={(p) => { setArchivedPage(p); void fetchOrders('archived', p); }}
                    onRowContextMenu={handleContextMenu}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Order Details Modal */}
        <Modal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          title="Order Details"
          size="lg"
        >
          {selectedOrder && (
            <div className="space-y-6">
              <p className="text-sm text-gray-500 border-b border-gray-100 pb-4">ID: {selectedOrder.orderId}</p>
              {/* Status & Payment Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-gray-50 p-4 rounded-lg space-y-3">
                  <div>
                    <label className="text-sm font-medium text-gray-500">Status</label>
                    <div className="mt-1">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${selectedOrder.status === 'completed'
                        ? 'bg-green-100 text-green-800'
                        : selectedOrder.status === 'pending'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                        }`}>
                        {selectedOrder.status === 'completed' && <CheckCircle className="w-3 h-3 mr-1" />}
                        {selectedOrder.status === 'pending' && <Clock className="w-3 h-3 mr-1" />}
                        {selectedOrder.status}
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Payment ID</label>
                    <p className="text-sm font-mono text-gray-900 mt-1">{selectedOrder.paymentId}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Date</label>
                    <p className="text-lg">{formatIndianDateTime(selectedOrder.createdAt)}</p>
                  </div>
                </div>

                {/* Amount Breakdown */}
                <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">Subtotal</span>
                    <span className="text-gray-900">₹{(selectedOrder.amount / 1.18).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">GST (18%)</span>
                    <span className="text-gray-900">₹{(selectedOrder.amount - (selectedOrder.amount / 1.18)).toFixed(2)}</span>
                  </div>
                  <div className="border-t pt-2 flex justify-between items-center">
                    <span className="font-semibold text-gray-900">Total (incl. GST)</span>
                    <span className="text-lg font-bold text-blue-600">₹{selectedOrder.amount.toFixed(2)} {selectedOrder.currency}</span>
                  </div>
                  <p className="text-xs text-gray-500 text-right">*GST (18%) is included in the total amount</p>
                </div>
              </div>

              {/* Domains */}
              <div className="border-t pt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Domains in this Order</h3>
                <div className="space-y-3">
                  {selectedOrder.domains.map((domain, index) => (
                    <div key={index} className="py-3 px-4 bg-gray-50 rounded-lg">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-0">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                          <div className="flex items-center space-x-2">
                            <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                                domain.status === 'registered' ? 'bg-green-500' :
                                domain.status === 'pending' ? 'bg-yellow-500' :
                                'bg-red-500'
                              }`}></div>
                            <span className="font-medium text-gray-900 break-all">
                              {domain.domainName}
                            </span>
                            {domain.status !== 'registered' && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase ${
                                domain.status === 'pending' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
                              }`}>
                                {domain.status}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center space-x-2 sm:ml-0">
                            {domain.hostingPlan?.name && (
                              <span className="text-xs font-normal text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full whitespace-nowrap">
                                {domain.hostingPlan.name}
                              </span>
                            )}
                            <span className="text-sm text-gray-500 whitespace-nowrap">
                              {domain.registrationPeriod} {(domain.hostingPlan ? 'month' : 'year')}{domain.registrationPeriod !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto mt-2 sm:mt-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-200">
                          <span className="font-medium text-gray-900">
                            ₹{(domain.price * domain.registrationPeriod).toFixed(2)}
                          </span>
                        </div>
                      </div>
                      {/*
                        Raw upstream provisioner error — admin-only diagnostic.
                        Surfaces what DirectAdmin / ResellerClub actually replied
                        (e.g. "License is limited to 2 accounts", "Domain already
                        registered", "Invalid package name"). Customers see the
                        friendly bookingStatus.message on /dashboard/orders/[id];
                        operators see the raw text here. Block layout (rather
                        than the old inline pill) so multi-line / long messages
                        are readable.
                      */}
                      {domain.status === 'failed' && domain.error && (
                        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600 mb-1">
                            Upstream provisioner error
                          </div>
                          <div className="text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                            {domain.error}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Summary */}
              {(() => {
                const reallySuccessfulDomains = selectedOrder.domains
                  .filter(d => d.status === 'registered' && d.itemType !== 'hosting')
                  .map(d => d.domainName);

                if (reallySuccessfulDomains.length === 0) return null;

                return (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Summary</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                        <div className="flex items-center space-x-2">
                          <CheckCircle className="h-5 w-5 text-green-600" />
                          <span className="font-medium text-green-800">Successfully Registered</span>
                        </div>
                        <p className="text-sm text-green-700 mt-1">
                          {reallySuccessfulDomains.join(', ')}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Modal>


        {/* Archive Confirmation Modal */}
        <Modal
          isOpen={isDeleteModalOpen}
          onClose={cancelDeleteOrder}
          title={activeTab === 'archived' ? 'Delete Order Permanently' : 'Archive Order'}
        >
          {orderToDelete && (
            <div className="space-y-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                </div>
                <div className="ml-3">
                  <p className="text-sm text-gray-500">
                    {activeTab === 'archived'
                      ? 'This action cannot be undone. All data will be permanently removed.'
                      : 'This will hide the order from the list but preserve all data'}
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <p className="text-gray-700 mb-2">
                  Are you sure you want to {activeTab === 'archived' ? 'permanently delete' : 'archive'} this order?
                </p>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">
                      Order ID: {orderToDelete.orderId}
                    </div>
                    <div className="text-gray-600">
                      Customer: {orderToDelete.userId ? `${orderToDelete.userId.firstName} ${orderToDelete.userId.lastName}` : 'Unknown'}
                    </div>
                    <div className="text-gray-600">
                      Amount: ₹{orderToDelete.amount.toFixed(2)} {orderToDelete.currency}
                    </div>
                    <div className="text-gray-600">
                      Status: {orderToDelete.status}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={cancelDeleteOrder}
                  disabled={isDeleting}
                  className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteOrder}
                  disabled={isDeleting}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
                >
                  {isDeleting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      {activeTab === 'archived' ? 'Deleting...' : 'Archiving...'}
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      {activeTab === 'archived' ? 'Delete Permanently' : 'Archive Order'}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </Modal>

        {/* Un-archive Confirmation Modal */}
        <Modal
          isOpen={isUnarchiveModalOpen}
          onClose={cancelUnarchiveOrder}
          title="Un-archive Order"
        >
          {orderToUnarchive && (
            <div className="space-y-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <RotateCcw className="h-6 w-6 text-green-600" />
                </div>
                <div className="ml-3">
                  <p className="text-sm text-gray-500">
                    Are you sure you want to un-archive this order? It will be restored to the active orders list.
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">
                      Order ID: {orderToUnarchive.orderId}
                    </div>
                    <div className="text-gray-600">
                      Customer: {orderToUnarchive.userId ? `${orderToUnarchive.userId.firstName} ${orderToUnarchive.userId.lastName}` : 'Unknown'}
                    </div>
                    <div className="text-gray-600">
                      Amount: ₹{orderToUnarchive.amount.toFixed(2)} {orderToUnarchive.currency}
                    </div>
                    <div className="text-gray-600">
                      Status: {orderToUnarchive.status}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={cancelUnarchiveOrder}
                  disabled={isUnarchiving}
                  className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmUnarchiveOrder}
                  disabled={isUnarchiving}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
                >
                  {isUnarchiving ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Un-archiving...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Un-archive Order
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </Modal>

        <ActionMenu
          isOpen={!!menuData}
          onClose={closeMenu}
          anchorPoint={{ x: menuData?.x || 0, y: menuData?.y || 0 }}
          items={menuData ? [
            {
              label: 'View Order Details',
              icon: Eye,
              onClick: () => handleViewOrder(menuData.order._id)
            },
            ...(activeTab === 'archived' ? [
              {
                label: 'Restore Order',
                icon: RotateCcw,
                onClick: () => handleUnarchiveOrder(menuData.order),
                variant: 'success' as const
              },
              {
                label: 'Delete Permanently',
                icon: Trash2,
                onClick: () => handleDeleteOrder(menuData.order),
                variant: 'danger' as const
              }
            ] : [
              {
                label: 'Archive Order',
                icon: Archive,
                onClick: () => handleDeleteOrder(menuData.order),
                variant: 'danger' as const
              }
            ])
          ] : []}
        />
      </div>
    </AdminLayout>
  );
}
