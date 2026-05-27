'use client';

import { useState } from 'react';
import { Globe, Search, ArrowRight, Loader2, Check, X, ShoppingCart } from 'lucide-react';
import { useCartStore } from '@/store/cartStore';
import toast from 'react-hot-toast';
import { apiClient } from '@/lib/api-client';

interface SearchResult {
  domainName: string;
  available: boolean;
  price?: number;
  currency?: string;
  registrationPeriod?: number;
  error?: string;
}

export default function DomainCrossSell() {
  const [domainQuery, setDomainQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const { addItem } = useCartStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domainQuery.trim()) return;

    setIsSearching(true);
    setResult(null);

    // Basic validation to check for a dot
    let searchTerm = domainQuery.trim();
    if (!searchTerm.includes('.')) {
      searchTerm += '.com'; // Default to .com if no TLD
    }

    const result = await apiClient.post<{ success?: boolean; results?: SearchResult[]; error?: string }>(
      '/api/v1/domains/search',
      { domain: searchTerm }
    );

    if (result.ok && result.data.success && result.data.results && result.data.results.length > 0) {
      // Find the exact match or the first available result
      const exactMatch =
        result.data.results.find((r: SearchResult) => r.domainName === searchTerm) || result.data.results[0];
      setResult(exactMatch);
    } else if (result.ok) {
      setResult({
        domainName: searchTerm,
        available: false,
        error: result.data.error || 'Domain not available',
      });
    } else {
      toast.error('Failed to search domain');
    }
    setIsSearching(false);
  };

  const handleAddToCart = () => {
    if (result && result.available && result.price) {
      addItem({
        domainName: result.domainName,
        price: result.price,
        currency: result.currency || 'INR',
        registrationPeriod: 12, // Default to 1 year
        itemType: 'domain'
      });
      toast.success(`${result.domainName} added to cart!`);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6">
      <div className="flex items-center space-x-3 mb-4">
        <div className="bg-purple-100 p-2 rounded-lg">
          <Globe className="h-5 w-5 text-purple-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Every website needs a domain</h3>
          <p className="text-sm text-gray-600">Get your domain right away and publish your website faster</p>
        </div>
      </div>

      <div className="space-y-4">
        <div 
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              void handleSearch(e as unknown as React.FormEvent);
            }
          }}
          className="relative"
        >
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              value={domainQuery}
              onChange={(e) => {
                setDomainQuery(e.target.value);
                setResult(null); // Clear result on typing
              }}
              className="block w-full pl-10 pr-24 py-3 border border-gray-300 rounded-lg leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm transition duration-150 ease-in-out"
              placeholder="Search domain (e.g. example.com)"
            />
            <div className="absolute inset-y-1 right-1">
              <button
                type="button"
                onClick={handleSearch}
                disabled={!domainQuery.trim() || isSearching}
                className="h-full px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 flex items-center gap-2"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    Search
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Search Result Display */}
        {result && (
          <div className={`p-4 rounded-lg border flex items-center justify-between ${result.available ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
            <div className="flex items-center gap-3">
              {result.available ? (
                <div className="bg-green-100 p-1.5 rounded-full">
                  <Check className="h-4 w-4 text-green-600" />
                </div>
              ) : (
                <div className="bg-red-100 p-1.5 rounded-full">
                  <X className="h-4 w-4 text-red-600" />
                </div>
              )}
              <div>
                <p className={`font-semibold ${result.available ? 'text-green-900' : 'text-red-900'}`}>{result.domainName}</p>
                {result.available ? (
                  <p className="text-sm text-green-700">Available - <span className="font-bold">₹{result.price}</span>/yr</p>
                ) : (
                  <p className="text-sm text-red-700">Domain is taken or unavailable</p>
                )}
              </div>
            </div>

            {result.available && (
              <button
                onClick={handleAddToCart}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-md shadow-sm transition-colors"
              >
                <ShoppingCart className="h-4 w-4" />
                Add
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
