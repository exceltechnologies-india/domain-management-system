/**
 * Admin TLD Pricing Page
 * 
 * This page provides administrators with a comprehensive view of TLD pricing,
 * including both customer and reseller pricing for comparison and margin analysis.
 * 
 * Features:
 * - Live pricing data from ResellerClub API
 * - Customer vs Reseller pricing comparison
 * - Margin calculation and display
 * - TLD categorization and filtering
 * - Data export functionality
 * - Real-time pricing updates
 * 
 * @author Anutech Digital Private Limited
 * @version 2.1.0
 * @since 2024
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { TrendingUp, RefreshCw, Search, Filter, Globe, Loader2, Tag, CheckCircle2, ArrowUp, ArrowDown } from 'lucide-react';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminPricingPageSkeleton, AdminTableRowsSkeleton } from '@/components/skeletons/PageSkeletons';
import AdminDataTable from '@/components/admin/AdminDataTable';
import { formatIndianCurrency, formatIndianNumber, formatIndianDateTime } from '@/lib/dateUtils';
import { performLogout } from '@/lib/logout';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';

/**
 * TLD Pricing Interface
 * 
 * Represents pricing data for a specific TLD, including both customer and reseller pricing
 * along with calculated margin information.
 */
interface TLDPricing {
  tld: string;
  customerPrice: number;
  resellerPrice: number;
  currency: string;
  category: string;
  description?: string;
  margin?: number; // Calculated margin percentage
}

/**
 * TLD Pricing API Response Interface
 * 
 * Represents the response structure from the TLD pricing API endpoint.
 */
interface TLDPricingResponse {
  success: boolean;
  tldPricing: TLDPricing[];
  totalCount: number;
  lastUpdated: string;
  pricingSource: string;
}

/**
 * Admin TLD Pricing Component
 * 
 * Main component for managing and displaying TLD pricing information.
 * Provides administrators with tools to analyze pricing, margins, and TLD performance.
 */
interface AdminUser {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export default function AdminTLDPricing() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [tldPricing, setTldPricing] = useState<TLDPricing[]>([]);

  // Split loading states for non-blocking UI
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);

  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [pricingSource, setPricingSource] = useState<string>('');
  const [isCached, setIsCached] = useState(false);
  const [cachedAt, setCachedAt] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('tld');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const [showOnlyWithMargin, setShowOnlyWithMargin] = useState<boolean>(false);
  const [isPurgingCache, setIsPurgingCache] = useState(false);
  const router = useRouter();
  const { data: session, status } = useSession();

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Prefer NextAuth session (works for credentials login)
    if (session?.user) {
      const sessionUser = session.user;
      const userObj: AdminUser = {
        _id: sessionUser.id || '',
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

      setUser(userObj);
      setIsAuthLoading(false); // Auth done, UI (shell) can load
      void loadTLDPricing();
      return;
    }

    // No NextAuth session → /login. Previous localStorage/token-cookie
    // fallback read values no auth route ever wrote — dead code.
    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  const loadTLDPricing = async () => {
    setIsDataLoading(true);
    const result = await apiClient.get<TLDPricingResponse & { cached?: boolean; cachedAt?: string }>(
      '/api/v1/admin/tld-pricing'
    );
    if (result.ok) {
      const data = result.data;
      setTldPricing(data.tldPricing || []);
      setLastUpdated(data.lastUpdated || '');
      setPricingSource(data.pricingSource || '');
      setIsCached(data.cached || false);
      setCachedAt(data.cachedAt || '');
    } else {
      logger.error('Failed to load TLD pricing:', result.error.message);
      setTldPricing([]);
    }
    setIsDataLoading(false);
  };

  const purgeCache = async () => {
    setIsPurgingCache(true);
    const result = await apiClient.delete('/api/v1/admin/tld-pricing/cache');
    if (result.ok) {
      logger.log('Cache purged successfully');
      // Reload pricing data (cache is already cleared, so will fetch fresh from API)
      await loadTLDPricing();
    } else {
      logger.error('Failed to purge cache');
    }
    setIsPurgingCache(false);
  };

  const handleLogout = () => {
    void performLogout();
  };


  // Filter TLD pricing based on search term, category, and other filters
  const filteredTLDPricing = tldPricing.filter(tld => {
    const matchesSearch = tld.tld.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tld.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || tld.category === selectedCategory;
    const matchesMargin = !showOnlyWithMargin || (tld.margin && tld.margin > 0);

    return matchesSearch && matchesCategory && matchesMargin;
  });

  // Get unique categories for filter
  const categories = ['all', ...Array.from(new Set(tldPricing.map(tld => tld.category)))];

  // Sort filtered TLD pricing
  const sortedTLDPricing = [...filteredTLDPricing].sort((a, b) => {
    let aValue: string | number, bValue: string | number;

    switch (sortBy) {
      case 'tld':
        aValue = a.tld.toLowerCase();
        bValue = b.tld.toLowerCase();
        break;
      case 'customerPrice':
        aValue = a.customerPrice;
        bValue = b.customerPrice;
        break;
      case 'resellerPrice':
        aValue = a.resellerPrice;
        bValue = b.resellerPrice;
        break;
      case 'margin':
        aValue = a.margin || 0;
        bValue = b.margin || 0;
        break;
      case 'category':
        aValue = a.category;
        bValue = b.category;
        break;
      default:
        aValue = a.tld.toLowerCase();
        bValue = b.tld.toLowerCase();
    }

    if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
    if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortOrder('asc');
    }
  };

  const getSortIcon = (key: string) => {
    if (sortBy !== key) return null;
    return sortOrder === 'asc' ? '↑' : '↓';
  };

  const columns = [
    {
      key: 'tld',
      label: 'TLD',
      sortable: true,
      render: (value: string) => (
        <div className="flex items-center">
          <Globe className="h-4 w-4 text-blue-500 mr-2" />
          <span className="font-mono font-semibold text-gray-900">{value}</span>
        </div>
      )
    },
    {
      key: 'customerPrice',
      label: 'Customer Price',
      sortable: true,
      render: (value: number, row: TLDPricing) => (
        <div className="flex items-center">
          <TrendingUp className="h-4 w-4 text-green-500 mr-1" />
          <span className="font-semibold text-gray-900">
            {formatIndianCurrency(value)}
          </span>
          <span className="text-sm text-gray-500 ml-1">{row.currency}</span>
        </div>
      )
    },
    {
      key: 'resellerPrice',
      label: 'Reseller Price',
      sortable: true,
      render: (value: number, row: TLDPricing) => (
        <div className="flex items-center">
          <TrendingUp className="h-4 w-4 text-blue-500 mr-1" />
          <span className="font-semibold text-gray-900">
            {formatIndianCurrency(value)}
          </span>
          <span className="text-sm text-gray-500 ml-1">{row.currency}</span>
        </div>
      )
    },
    {
      key: 'margin',
      label: 'Margin',
      sortable: true,
      render: (value: number, row: TLDPricing) => {
        const margin = row.customerPrice > 0 && row.resellerPrice > 0
          ? ((row.customerPrice - row.resellerPrice) / row.customerPrice * 100)
          : 0;
        return (
          <div className="flex items-center">
            <span className={`font-semibold ${margin > 0 ? 'text-green-600' : margin < 0 ? 'text-red-600' : 'text-gray-600'
              }`}>
              {margin > 0 ? '+' : ''}{margin.toFixed(1)}%
            </span>
          </div>
        );
      }
    },
    {
      key: 'category',
      label: 'Category',
      sortable: true,
      className: 'hidden sm:table-cell',
      render: (value: string) => (
        <span className={`px-2 py-1 text-xs font-medium rounded-full ${value === 'Generic' ? 'bg-blue-100 text-blue-800' :
          value === 'Country Code' ? 'bg-green-100 text-green-800' :
            value === 'New Generic' ? 'bg-purple-100 text-purple-800' :
              'bg-gray-100 text-gray-800'
          }`}>
          {value}
        </span>
      )
    },
    {
      key: 'description',
      label: 'Description',
      sortable: false,
      className: 'hidden md:table-cell',
      render: (value: string) => (
        <span className="text-sm text-gray-600">{value || 'N/A'}</span>
      )
    }
  ];

  // Animated Loading Component
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
    return <AdminLayoutSkeleton><AdminPricingPageSkeleton /></AdminLayoutSkeleton>;
  }

  // 2. Main Render (Shell is visible immediately)
  return (
    <AdminLayout user={user} onLogout={handleLogout}>
      {/* Loading Overlay for Manual Refresh - CACHE PURGE ONLY */}
      {isPurgingCache && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 max-w-md mx-4 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Fetching Latest Pricing Data
              </h3>
              <p className="text-sm text-gray-600 mb-1">
                {isCached ? 'Clearing cache and fetching fresh data from API...' : 'Fetching fresh data from ResellerClub API...'}
              </p>
              <p className="text-xs text-gray-500">
                This may take 5-10 seconds
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <Tag className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold text-gray-900">TLD Pricing</h1>
                {isCached && !isDataLoading && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
                    <CheckCircle2 className="h-3 w-3" />
                    Cached
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5">
                Live pricing from {pricingSource || 'Source'} · {tldPricing.length} TLDs available
                {lastUpdated && !isDataLoading && (
                  <span className="text-gray-400"> · Updated {formatIndianDateTime(lastUpdated)}</span>
                )}
              </p>
            </div>
          </div>
          <RefreshButton
            onClick={purgeCache}
            isLoading={isPurgingCache || isDataLoading}
            title="Refresh Pricing"
          />
        </div>

        {/* ── Fresh-data info banner ── */}
        {!isCached && !isDataLoading && !isPurgingCache && tldPricing.length > 0 && (
          <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-2xl">
            <CheckCircle2 className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-blue-900">Fresh Data Loaded</p>
              <p className="text-xs text-blue-700 mt-0.5">
                Data fetched from ResellerClub API. Future loads use cache — hit Refresh to pull live data again.
              </p>
            </div>
          </div>
        )}

        {/* ── Pricing card (filters + table in one) ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header with filters */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <Tag className="h-4 w-4 text-gray-500" />
                <h3 className="text-sm font-semibold text-gray-900">TLD Pricing</h3>
                <span className="inline-flex items-center text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
                  {sortedTLDPricing.length} of {tldPricing.length}
                </span>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnlyWithMargin}
                  onChange={(e) => setShowOnlyWithMargin(e.target.checked)}
                  className="h-3.5 w-3.5 text-green-600 focus:ring-green-500 border-gray-300 rounded"
                />
                <span className="text-xs font-medium text-gray-600">Only with margin</span>
              </label>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              {/* Search */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search TLDs or descriptions…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                />
              </div>

              {/* Category */}
              <div className="relative sm:w-44">
                <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="w-full pl-10 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-xl appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                >
                  {categories.map(category => (
                    <option key={category} value={category}>
                      {category === 'all' ? 'All Categories' : category}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sort + order toggle */}
              <div className="flex items-center gap-2">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-3 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                >
                  <option value="tld">Sort: TLD Name</option>
                  <option value="customerPrice">Sort: Customer Price</option>
                  <option value="resellerPrice">Sort: Reseller Price</option>
                  <option value="margin">Sort: Margin</option>
                  <option value="category">Sort: Category</option>
                </select>
                <button
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
                  className="inline-flex items-center justify-center w-9 h-9 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors text-gray-600"
                >
                  {sortOrder === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Table body */}
          {isDataLoading ? (
            <AdminTableRowsSkeleton rows={8} cols={6} />
          ) : (
            <div className="p-4 sm:p-6">
              <AdminDataTable
                title=""
                columns={columns}
                data={sortedTLDPricing}
                searchable={false}
                pagination={true}
                pageSize={20}
              />
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
