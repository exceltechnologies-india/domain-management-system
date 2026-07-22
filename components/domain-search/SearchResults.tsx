'use client';

import React, { useState } from 'react';
import {
  XCircle,
  Globe,
  Star,
  AlertTriangle,
  Loader2,
  ChevronRight,
  Sparkles,
  Zap,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { HeroResultCard, CompactResultCard } from './DomainCard';
import type { SearchResult } from './hooks/useDomainSearch';

interface SearchResultsProps {
  isSearching: boolean;
  isLoadingSuggestions: boolean;
  hasSearched: boolean;
  results: SearchResult[];
  suggestions: SearchResult[];
  error: string | null;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  onAddToCart: (result: SearchResult) => void;
  onShowRequirements: (domain: string) => void;
  onClearSearch: () => void;
  onLoadMore: () => void;
  onWatch?: (domainName: string) => void;
}

const SearchResults = React.memo(function SearchResults({
  isSearching,
  isLoadingSuggestions,
  hasSearched,
  results,
  suggestions,
  error,
  canLoadMore,
  isLoadingMore,
  onAddToCart,
  onShowRequirements,
  onClearSearch,
  onLoadMore,
  onWatch,
}: SearchResultsProps) {
  const [activeTab, setActiveTab] = useState('All');
  const categories = ['All', 'Popular', 'Tech', 'Business'];

  return (
    <AnimatePresence mode="wait">
      {(isSearching || hasSearched) && (
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="mt-4 bg-white/95 backdrop-blur-3xl rounded-[1.5rem] shadow-[0_30px_70px_rgba(0,0,0,0.15)] border border-white/40 overflow-hidden"
        >
          <div className="p-4 sm:p-6">
            {isSearching && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center py-20"
              >
                <div className="relative w-16 h-16 mb-6">
                  <div className="absolute inset-0 border-4 border-primary-100 rounded-full"></div>
                  <div className="absolute inset-0 border-4 border-t-primary-600 rounded-full animate-spin"></div>
                  <Globe className="absolute inset-0 m-auto h-8 w-8 text-primary-600 animate-pulse" />
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-1">Analyzing Availability</h3>
                <p className="text-sm text-gray-500 text-center">
                  Connecting to global registrars for real-time pricing...
                </p>
              </motion.div>
            )}

            {hasSearched && !isSearching && (
              <motion.div
                key="results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-8"
              >
                {/* Primary Results */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                    <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                      <Zap className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                      Exact Match Results
                    </h2>
                    <button
                      onClick={onClearSearch}
                      className="text-xs font-semibold text-gray-500 hover:text-gray-900 flex items-center gap-1 transition-colors"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Clear Search
                    </button>
                  </div>

                  {error && (
                    <div className="bg-red-50 border border-red-100 rounded-2xl p-6 text-red-700 flex items-center gap-4">
                      <AlertTriangle className="h-6 w-6 flex-shrink-0" />
                      <p className="font-medium">{error}</p>
                    </div>
                  )}

                  <div className="space-y-6">
                    {/* Only render the primary search result as a Hero Card */}
                    {results.length > 0 && (
                      <HeroResultCard
                        result={results[0]}
                        onAdd={() => onAddToCart(results[0])}
                        onShowRequirements={onShowRequirements}
                        onWatch={onWatch}
                      />
                    )}

                    {/* Render other prominent extensions in a more compact way */}
                    {results.length > 1 && (
                      <div className="pt-4 space-y-4">
                        <div className="flex items-center gap-2 px-2 pb-2">
                          <Star className="h-4 w-4 text-primary-500 fill-primary-500" />
                          <h3 className="text-sm font-bold text-gray-500 uppercase tracking-widest">
                            Other Popular Extensions
                          </h3>
                        </div>
                        <div className="grid grid-cols-1 gap-3">
                          {results.slice(1).map((result, index) => (
                            <CompactResultCard
                              key={`secondary-${index}`}
                              result={result}
                              onAdd={() => onAddToCart(result)}
                              onShowRequirements={onShowRequirements}
                              onWatch={onWatch}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Suggestions skeleton while loading in background */}
                {isLoadingSuggestions && suggestions.length === 0 && (
                  <div className="space-y-4 pt-4 border-t border-gray-100">
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 bg-gray-200 rounded-lg animate-pulse w-7 h-7" />
                      <div className="space-y-1.5">
                        <div className="h-4 w-36 bg-gray-200 rounded animate-pulse" />
                        <div className="h-3 w-48 bg-gray-100 rounded animate-pulse" />
                      </div>
                    </div>
                    <div className="space-y-3">
                      {[1, 2, 3, 4].map(i => (
                        <div key={i} className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-100 animate-pulse">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-gray-100 rounded-lg" />
                            <div className="space-y-1">
                              <div className="h-3.5 w-40 bg-gray-200 rounded" />
                              <div className="h-3 w-20 bg-gray-100 rounded" />
                            </div>
                          </div>
                          <div className="h-8 w-20 bg-gray-200 rounded-lg" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Suggestions Section */}
                {suggestions.length > 0 && (
                  <div className="space-y-6 pt-4 border-t border-gray-100">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-lg">
                          <Sparkles className="h-4 w-4 text-white" />
                        </div>
                        <div>
                          <h2 className="text-xl font-bold text-gray-900">More domain options</h2>
                          <p className="text-xs text-gray-500">Choose from brandable alternatives</p>
                        </div>
                      </div>

                      {/* Category Tabs */}
                      <div className="flex bg-gray-100 p-1 rounded-xl overflow-x-auto no-scrollbar max-w-full">
                        <div className="flex min-w-max gap-1">
                          {categories.map((cat) => (
                            <button
                              key={cat}
                              onClick={() => setActiveTab(cat)}
                              className={`px-4 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${
                                activeTab === cat
                                  ? 'bg-white text-primary-600 shadow-sm'
                                  : 'text-gray-500 hover:text-gray-900'
                              }`}
                            >
                              {cat}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      {suggestions
                        .filter((s) => activeTab === 'All' || s.category === activeTab)
                        .map((result, index) => (
                          <motion.div
                            key={index}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.05 * index }}
                          >
                            <CompactResultCard
                              result={result}
                              onAdd={() => onAddToCart(result)}
                              onShowRequirements={onShowRequirements}
                              onWatch={onWatch}
                            />
                          </motion.div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Load More Options */}
                {canLoadMore && (
                  <div className="text-center pt-8">
                    <button
                      onClick={onLoadMore}
                      disabled={isLoadingMore}
                      className="group relative px-6 py-3 sm:px-12 sm:py-5 bg-primary-600 hover:bg-primary-700 rounded-xl sm:rounded-2xl font-black text-white transition-all duration-300 shadow-xl hover:shadow-primary-500/40 active:scale-95 overflow-hidden"
                    >
                      <span className="relative z-10 flex items-center gap-2">
                        {isLoadingMore ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <ChevronRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                        )}
                        {isLoadingMore ? 'Loading More...' : 'Explore More Extensions'}
                      </span>
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

export default SearchResults;
