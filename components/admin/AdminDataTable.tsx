'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

// Rows are heterogeneous across the admin tables that consume this component
// (Order, Invoice, etc). The component is generic over the row type so each
// callsite keeps the precise shape of its render callbacks — internally the
// table reads `row[column.key]` via a structural cast.
export interface Column<T = unknown> {
  key: string;
  label: string;
  sortable?: boolean;
  className?: string; // Add optional className for custom responsive styling like hidden sm:table-cell
  // value: any — the column's per-row cell value can be of any concrete type
  // (string, number, nested object), so callers narrow it themselves inside
  // their render callback. Typing this as `unknown` would force every callsite
  // (5+ admin pages) to widen their existing `(value: string, …)` signatures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render?: (value: any, row: T, index: number) => React.ReactNode;
}

export interface AdminDataTableProps<T = unknown> {
  columns: Column<T>[];
  data: T[];
  title: string;
  searchable?: boolean;
  pagination?: boolean;
  pageSize?: number;
  // Server-side pagination props
  totalItems?: number;
  currentPage?: number;
  onPageChange?: (page: number) => void;
  onSearch?: (searchTerm: string) => void;
  isLoading?: boolean;
  onRowContextMenu?: (e: React.MouseEvent, row: T) => void;
}

export default function AdminDataTable<T>({
  columns,
  data,
  title,
  searchable = true,
  pagination = true,
  pageSize = 10,
  totalItems,
  currentPage: externalCurrentPage,
  onPageChange,
  onSearch,
  isLoading = false,
  onRowContextMenu
}: AdminDataTableProps<T>) {
  const [searchTerm, setSearchTerm] = useState('');
  const [internalCurrentPage, setInternalCurrentPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Reset page to 1 when data changes (e.g., after filtering)
  useEffect(() => {
    setInternalCurrentPage(1);
  }, [data]);

  // Use external pagination if provided, otherwise use internal
  const isServerSidePagination = totalItems !== undefined && onPageChange !== undefined;
  const currentPage = isServerSidePagination ? (externalCurrentPage || 1) : internalCurrentPage;
  const totalPages = isServerSidePagination
    ? Math.ceil((totalItems || 0) / pageSize)
    : Math.ceil(data.length / pageSize);

  // For server-side pagination, use data as-is. For client-side, filter and sort
  const displayData = isServerSidePagination
    ? data
    : (() => {
      const filteredData = data.filter(row =>
        Object.values(row as Record<string, unknown>).some(value =>
          String(value).toLowerCase().includes(searchTerm.toLowerCase())
        )
      );

      const sortedData = sortColumn
        ? [...filteredData].sort((a, b) => {
          const aVal = (a as Record<string, unknown>)[sortColumn] as string | number | undefined;
          const bVal = (b as Record<string, unknown>)[sortColumn] as string | number | undefined;
          if (aVal === bVal) return 0;
          if (aVal === undefined) return 1;
          if (bVal === undefined) return -1;
          if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
          if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
          return 0;
        })
        : filteredData;

      const startIndex = (currentPage - 1) * pageSize;
      return pagination
        ? sortedData.slice(startIndex, startIndex + pageSize)
        : sortedData;
    })();

  const startIndex = (currentPage - 1) * pageSize;

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const handlePageChange = (page: number) => {
    if (isServerSidePagination && onPageChange) {
      onPageChange(page);
    } else {
      setInternalCurrentPage(page);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    if (isServerSidePagination && onSearch) {
      onSearch(value);
    }
  };


  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-gray-200">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          <h3 className="text-base sm:text-lg font-semibold text-gray-900">{title}</h3>
        </div>
      </div>

      {/* Search */}
      {searchable && (
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-gray-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 sm:pl-10 pr-3 sm:pr-4 py-2 text-xs sm:text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-blue-300 focus:border-transparent"
            />
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`px-2 sm:px-4 md:px-6 py-2 sm:py-3 text-left text-[10px] sm:text-xs font-medium text-gray-500 uppercase tracking-wider ${column.key === 'createdAt' ? 'hidden sm:table-cell' : ''
                    } ${column.key === 'status' || column.key === 'role' ? 'hidden md:table-cell' : ''
                    } ${column.key === 'amount' || column.key === 'domains' || column.key === 'orderId' || column.key === 'transactionId' ? 'hidden sm:table-cell' : ''
                    } ${column.sortable ? 'cursor-pointer hover:bg-gray-100' : ''
                    } ${column.className || ''}`}
                  onClick={column.sortable ? () => handleSort(column.key) : undefined}
                >
                  <div className="flex items-center">
                    {column.label}
                    {column.sortable && sortColumn === column.key && (
                      <span className="ml-1">
                        {sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <tr>
                <td colSpan={columns.length} className="px-2 sm:px-6 py-4 sm:py-8 text-center">
                  <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-5 w-5 sm:h-6 sm:w-6 border-b-2 border-blue-600"></div>
                    <span className="ml-2 text-xs sm:text-sm text-gray-500">Loading...</span>
                  </div>
                </td>
              </tr>
            ) : displayData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-2 sm:px-6 py-4 sm:py-8 text-center text-xs sm:text-sm text-gray-500">
                  No data available
                </td>
              </tr>
            ) : (
              displayData.map((row, index) => (
                <tr 
                  key={index} 
                  className={`hover:bg-gray-50 group/row ${onRowContextMenu ? 'cursor-context-menu' : ''}`}
                  onContextMenu={(e) => onRowContextMenu?.(e, row)}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-2 sm:px-4 md:px-6 py-2 sm:py-3 md:py-4 whitespace-nowrap text-xs sm:text-sm text-gray-900 ${column.key === 'createdAt' ? 'hidden sm:table-cell' : ''
                        } ${column.key === 'status' || column.key === 'role' ? 'hidden md:table-cell' : ''
                        } ${column.key === 'amount' || column.key === 'domains' || column.key === 'orderId' || column.key === 'transactionId' ? 'hidden sm:table-cell' : ''
                        } ${column.className || ''}`}
                    >
                      {column.render
                        ? column.render((row as Record<string, unknown>)[column.key], row, startIndex + index)
                        : ((row as Record<string, unknown>)[column.key] as React.ReactNode)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-t border-gray-200">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
            <div className="text-xs sm:text-sm text-gray-700 text-center sm:text-left">
              {isServerSidePagination ? (
                `Showing ${startIndex + 1} to ${Math.min(startIndex + pageSize, totalItems || 0)} of ${totalItems || 0} results`
              ) : (
                `Showing ${startIndex + 1} to ${Math.min(startIndex + pageSize, data.length)} of ${data.length} results`
              )}
            </div>
            <div className="flex items-center justify-center sm:justify-start space-x-1 sm:space-x-2 mx-auto sm:mx-0">
              <button
                onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1 || isLoading}
                className="p-1.5 sm:p-2 text-gray-400 hover:text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg hover:bg-gray-100 transition-colors relative z-10"
                type="button"
              >
                <ChevronLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              </button>

              {/* Page numbers */}
              {totalPages > 1 ? (
                <div className="flex items-center space-x-0.5 sm:space-x-1">
                  {(() => {
                    const pages = [];

                    if (totalPages <= 7) {
                      // Show all pages if 7 or fewer
                      for (let i = 1; i <= totalPages; i++) {
                        pages.push(i);
                      }
                    } else {
                      // Smart pagination for more than 7 pages
                      if (currentPage <= 4) {
                        // Show first 5 pages + ellipsis + last page
                        for (let i = 1; i <= 5; i++) {
                          pages.push(i);
                        }
                        pages.push('...');
                        pages.push(totalPages);
                      } else if (currentPage >= totalPages - 3) {
                        // Show first page + ellipsis + last 5 pages
                        pages.push(1);
                        pages.push('...');
                        for (let i = totalPages - 4; i <= totalPages; i++) {
                          pages.push(i);
                        }
                      } else {
                        // Show first page + ellipsis + current-1, current, current+1 + ellipsis + last page
                        pages.push(1);
                        pages.push('...');
                        for (let i = currentPage - 1; i <= currentPage + 1; i++) {
                          pages.push(i);
                        }
                        pages.push('...');
                        pages.push(totalPages);
                      }
                    }

                    return pages.map((page, index) => {
                      if (page === '...') {
                        return (
                          <span key={`ellipsis-${index}`} className="px-1 sm:px-2 text-xs sm:text-sm text-gray-500">
                            ...
                          </span>
                        );
                      }

                      return (
                        <button
                          key={page}
                          onClick={() => handlePageChange(page as number)}
                          disabled={isLoading}
                          className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded-lg transition-colors relative z-10 ${currentPage === page
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-700 hover:bg-gray-100'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                          type="button"
                        >
                          {page}
                        </button>
                      );
                    });
                  })()}
                </div>
              ) : (
                <span className="text-xs sm:text-sm text-gray-700 px-1 sm:px-2">
                  Page {currentPage} of {totalPages}
                </span>
              )}

              <button
                onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages || isLoading}
                className="p-1.5 sm:p-2 text-gray-400 hover:text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg hover:bg-gray-100 transition-colors relative z-10"
                type="button"
              >
                <ChevronRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
