'use client';

import { useState, useCallback } from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { useCartStore } from '@/store/cartStore';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, CheckCircle2, XCircle, AlertCircle, ShoppingCart,
  Loader2, SquareCheckBig, Square, ChevronRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { apiClient } from '@/lib/api-client';

interface BulkResult {
  domainName: string;
  available: boolean;
  price: number;
  currency: string;
  registrationPeriod: number;
  pricingSource?: string;
  restricted?: boolean;
  error?: string;
}

const MAX_DOMAINS = 20;

function StatusBadge({ result }: { result: BulkResult }) {
  if (result.restricted) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-50 text-yellow-700 border border-yellow-200">
        <AlertCircle className="h-3.5 w-3.5" />
        Restricted
      </span>
    );
  }
  if (result.error) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 border border-gray-200">
        <AlertCircle className="h-3.5 w-3.5" />
        Error
      </span>
    );
  }
  if (result.available) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Available
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
      <XCircle className="h-3.5 w-3.5" />
      Taken
    </span>
  );
}

function BulkSearchContent() {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<BulkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { addItem, items: cartItems } = useCartStore();

  const lines = input
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);

  const validDomains = lines.filter((l) => l.includes('.'));
  const lineCount = lines.length;
  const overLimit = lineCount > MAX_DOMAINS;

  const inCart = useCallback(
    (domainName: string) => cartItems.some((i) => i.domainName === domainName),
    [cartItems]
  );

  const handleSearch = async () => {
    if (validDomains.length === 0) {
      toast.error('Enter at least one domain name (e.g. example.com)');
      return;
    }
    setLoading(true);
    setResults([]);
    setSelected(new Set());
    const result = await apiClient.post<{ results?: BulkResult[] }>(
      '/api/v1/domains/bulk-search',
      { domains: validDomains.slice(0, MAX_DOMAINS) }
    );
    if (!result.ok) {
      toast.error(
        result.error.status === 0 ? 'Network error. Please try again.' : result.error.message || 'Search failed. Please try again.'
      );
      setLoading(false);
      return;
    }
    const rows = result.data.results ?? [];
    setResults(rows);
    // Pre-select available, unrestricted domains
    const avail = new Set<string>(
      rows.filter((r) => r.available && !r.restricted && !r.error).map((r) => r.domainName)
    );
    setSelected(avail);
    setLoading(false);
  };

  const toggleSelect = (domainName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domainName)) next.delete(domainName);
      else next.add(domainName);
      return next;
    });
  };

  const availableResults = results.filter((r) => r.available && !r.restricted && !r.error);
  const allAvailableSelected =
    availableResults.length > 0 && availableResults.every((r) => selected.has(r.domainName));

  const toggleSelectAll = () => {
    if (allAvailableSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(availableResults.map((r) => r.domainName)));
    }
  };

  const handleAddSelected = () => {
    let added = 0;
    for (const result of results) {
      if (!selected.has(result.domainName) || !result.available) continue;
      if (inCart(result.domainName)) continue;
      const minPeriod = getMinRegistrationPeriod(result.domainName);
      addItem({
        domainName: result.domainName,
        price: result.price,
        currency: result.currency,
        registrationPeriod: Math.max(result.registrationPeriod, minPeriod),
        itemType: 'domain',
      });
      added++;
    }
    if (added > 0) toast.success(`${added} domain${added > 1 ? 's' : ''} added to cart`);
    else toast('Already in cart or none selected');
  };

  const selectedAddable = [...selected].filter((d) => {
    const r = results.find((x) => x.domainName === d);
    return r?.available && !inCart(d);
  }).length;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navigation user={null} />

      <main className="flex-grow pt-16 sm:pt-20 pb-12">
        {/* Header */}
        <div className="bg-white border-b border-gray-100 shadow-sm mb-8">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5">
            <nav className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
              <Link href="/" className="hover:text-blue-600 transition-colors">Home</Link>
              <ChevronRight className="h-3 w-3" />
              <Link href="/domains/search" className="hover:text-blue-600 transition-colors">Domain Search</Link>
              <ChevronRight className="h-3 w-3" />
              <span className="text-blue-600">Bulk Search</span>
            </nav>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Bulk Domain Search</h1>
            <p className="text-sm text-gray-500 mt-1">Check up to {MAX_DOMAINS} domains at once</p>
          </div>
        </div>

        <div className="max-w-4xl mx-auto px-4 sm:px-6 space-y-6">
          {/* Input */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <label className="block text-sm font-semibold text-gray-700">
              Enter domain names — one per line
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`example.com\nmystore.in\ncoolbrand.net`}
              rows={8}
              className="w-full font-mono text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none text-gray-800 placeholder-gray-400"
            />
            <div className="flex items-center justify-between">
              <span className={`text-xs font-medium ${overLimit ? 'text-red-600' : 'text-gray-400'}`}>
                {lineCount} / {MAX_DOMAINS} domains{overLimit ? ` — only the first ${MAX_DOMAINS} will be checked` : ''}
              </span>
              <button
                onClick={handleSearch}
                disabled={loading || validDomains.length === 0}
                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-bold rounded-xl transition-colors"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {loading ? 'Checking…' : 'Check Availability'}
              </button>
            </div>
          </div>

          {/* Results */}
          <AnimatePresence>
            {results.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden"
              >
                {/* Table header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={toggleSelectAll}
                      className="text-gray-400 hover:text-blue-600 transition-colors"
                      title={allAvailableSelected ? 'Deselect all' : 'Select all available'}
                    >
                      {allAvailableSelected
                        ? <SquareCheckBig className="h-5 w-5 text-blue-600" />
                        : <Square className="h-5 w-5" />}
                    </button>
                    <span className="text-sm font-semibold text-gray-700">
                      {results.length} result{results.length !== 1 ? 's' : ''}
                      {availableResults.length > 0 && (
                        <span className="ml-2 text-green-600">
                          — {availableResults.length} available
                        </span>
                      )}
                    </span>
                  </div>
                  {selectedAddable > 0 && (
                    <button
                      onClick={handleAddSelected}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-lg transition-colors"
                    >
                      <ShoppingCart className="h-4 w-4" />
                      Add {selectedAddable} to Cart
                    </button>
                  )}
                </div>

                {/* Rows */}
                <div className="divide-y divide-gray-100">
                  {results.map((result, i) => {
                    const isAvailable = result.available && !result.restricted && !result.error;
                    const alreadyInCart = inCart(result.domainName);
                    const isSelected = selected.has(result.domainName);

                    return (
                      <motion.div
                        key={result.domainName}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.03 }}
                        className={`flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition-colors ${isSelected && isAvailable ? 'bg-blue-50/40' : ''}`}
                      >
                        {/* Checkbox */}
                        <button
                          onClick={() => isAvailable && toggleSelect(result.domainName)}
                          className={`shrink-0 ${!isAvailable ? 'opacity-30 cursor-default' : 'text-gray-400 hover:text-blue-600 transition-colors'}`}
                          disabled={!isAvailable}
                        >
                          {isSelected && isAvailable
                            ? <SquareCheckBig className="h-5 w-5 text-blue-600" />
                            : <Square className="h-5 w-5" />}
                        </button>

                        {/* Domain name */}
                        <span className="flex-1 font-semibold text-gray-900 text-sm truncate">
                          {result.domainName}
                        </span>

                        {/* Status */}
                        <StatusBadge result={result} />

                        {/* Price */}
                        <span className="text-sm font-semibold text-gray-700 w-20 text-right shrink-0">
                          {isAvailable && result.price > 0
                            ? `₹${result.price.toLocaleString('en-IN')}/yr`
                            : '—'}
                        </span>

                        {/* Action */}
                        <div className="shrink-0 w-28 text-right">
                          {isAvailable ? (
                            alreadyInCart ? (
                              <span className="text-xs font-semibold text-green-600">In Cart ✓</span>
                            ) : (
                              <button
                                onClick={() => {
                                  const minPeriod = getMinRegistrationPeriod(result.domainName);
                                  addItem({
                                    domainName: result.domainName,
                                    price: result.price,
                                    currency: result.currency,
                                    registrationPeriod: Math.max(result.registrationPeriod, minPeriod),
                                    itemType: 'domain',
                                  });
                                  toast.success(`${result.domainName} added`);
                                }}
                                className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                              >
                                + Add to Cart
                              </button>
                            )
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <Footer />
    </div>
  );
}

export default function BulkSearchPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
      </div>
    }>
      <BulkSearchContent />
    </Suspense>
  );
}
