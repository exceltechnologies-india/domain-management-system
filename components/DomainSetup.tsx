'use client';

import { useState } from 'react';
import { Globe, Search, Loader2, Check, X, AlertTriangle, Link as LinkIcon, ArrowRight, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import type { CartItem } from '@/lib/types';

interface DomainSetupProps {
  hostingItem: CartItem;
  onUpdateDomain: (oldDomain: string, newDomain: string) => void;
  onAddDomainToCart: (domain: CartItem) => void;
}

interface SearchResult {
  domainName: string;
  available: boolean;
  price?: number;
  currency?: string;
  error?: string;
}

export default function DomainSetup({ hostingItem, onUpdateDomain, onAddDomainToCart }: DomainSetupProps) {
  const [activeTab, setActiveTab] = useState<'link' | 'buy'>('link');
  const [domainInput, setDomainInput] = useState('');
  const [inputError, setInputError] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  const validateDomain = (domain: string) => {
    // Basic validation: at least one dot, no spaces, valid chars
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
    return domainRegex.test(domain);
  };

  const handleLinkDomain = () => {
    if (!domainInput) {
      setInputError('Required');
      return;
    }
    if (!validateDomain(domainInput)) {
      setInputError('Invalid domain format');
      return;
    }

    setIsLinking(true);
    setTimeout(() => {
      onUpdateDomain(hostingItem.domainName, domainInput);
      setIsLinking(false);
      toast.success('Domain linked successfully');
    }, 500);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setSearchResult(null);

    let searchTerm = searchQuery.trim();
    if (!searchTerm.includes('.')) {
      searchTerm += '.com';
    }

    try {
      const response = await fetch('/api/v1/domains/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: searchTerm }),
      });

      const data = await response.json();

      if (response.ok && data.success && data.results && data.results.length > 0) {
        const exactMatch = data.results.find((r: SearchResult) => r.domainName === searchTerm) || data.results[0];
        setSearchResult(exactMatch);
      } else {
        setSearchResult({
          domainName: searchTerm,
          available: false,
          error: data.error || 'Domain not available'
        });
      }
    } catch (error) {
      toast.error('Failed to search domain');
    } finally {
      setIsSearching(false);
    }
  };

  const handleBuyAndLink = () => {
    if (searchResult && searchResult.available && searchResult.price) {
      const domainItem: CartItem = {
        domainName: searchResult.domainName,
        price: searchResult.price,
        currency: searchResult.currency || 'INR',
        registrationPeriod: 1, // Default 1 year
        itemType: 'domain',
      };

      onAddDomainToCart(domainItem);
      onUpdateDomain(hostingItem.domainName, searchResult.domainName);
      setIsSearching(false);
      setSearchResult(null);
      setSearchQuery('');
      toast.success('Domain added and linked!');
    }
  };

  const planName = hostingItem.hostingPlan?.name || 'Hosting Plan';

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_2px_8px_rgba(0,0,0,0.04)] overflow-hidden mb-8 transition-all duration-300 hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)]">
      <div className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6 mb-8">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl border border-indigo-100/50 shadow-sm flex-shrink-0">
              <Globe className="h-6 w-6 text-indigo-600" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-gray-900 tracking-tight">Connect a Domain</h3>
              <p className="text-gray-500 mt-1.5 text-sm leading-relaxed max-w-md">
                Your <span className="font-semibold text-gray-900">{planName}</span> subscription requires a domain name to work.
              </p>
            </div>
          </div>

          <div className="flex bg-gray-100/80 p-1.5 rounded-xl self-start md:self-center backdrop-blur-sm">
            <button
              onClick={() => setActiveTab('link')}
              className={`flex items-center gap-2 py-2.5 px-5 text-sm font-semibold rounded-[10px] transition-all duration-300 ${activeTab === 'link'
                ? 'bg-white text-gray-900 shadow-[0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-black/5 transform scale-[1.02]'
                : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200/50'
                }`}
            >
              <LinkIcon className={`h-4 w-4 ${activeTab === 'link' ? 'text-indigo-600' : 'text-gray-400'}`} />
              Link Existing
            </button>
            <button
              onClick={() => setActiveTab('buy')}
              className={`flex items-center gap-2 py-2.5 px-5 text-sm font-semibold rounded-[10px] transition-all duration-300 ${activeTab === 'buy'
                ? 'bg-white text-gray-900 shadow-[0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-black/5 transform scale-[1.02]'
                : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200/50'
                }`}
            >
              <Search className={`h-4 w-4 ${activeTab === 'buy' ? 'text-indigo-600' : 'text-gray-400'}`} />
              Buy New
            </button>
          </div>
        </div>

        <div className="max-w-3xl">
          {activeTab === 'link' ? (
            <div className="animate-in fade-in slide-in-from-left-4 duration-300">
              <label className="block text-sm font-semibold text-gray-700 mb-3 ml-1">
                Enter your existing domain name
              </label>
              <div className="flex items-start gap-3">
                <div className="flex-grow">
                  <div className="relative group">
                    <input
                      type="text"
                      value={domainInput}
                      onChange={(e) => {
                        setDomainInput(e.target.value);
                        setInputError('');
                      }}
                      placeholder="example.com"
                      className={`block w-full rounded-xl border-gray-200 bg-gray-50/50 shadow-sm focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 py-3.5 pl-4 transition-all duration-200 ${inputError ? 'border-red-300 ring-2 ring-red-100 focus:ring-red-100' : 'hover:border-gray-300'}`}
                      onKeyPress={(e) => e.key === 'Enter' && handleLinkDomain()}
                    />
                    {inputError && (
                      <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none animate-in fade-in zoom-in duration-200">
                        <AlertTriangle className="h-5 w-5 text-red-500" />
                      </div>
                    )}
                  </div>
                  {inputError && (
                    <p className="mt-2 text-sm text-red-600 font-medium ml-1">{inputError}</p>
                  )}
                </div>
                <button
                  onClick={handleLinkDomain}
                  disabled={isLinking}
                  className="flex-shrink-0 inline-flex items-center justify-center px-8 py-3.5 border border-transparent text-sm font-bold rounded-xl text-white bg-gray-900 hover:bg-black focus:outline-none focus:ring-4 focus:ring-gray-100 disabled:opacity-70 transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5"
                >
                  {isLinking ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      Link Domain
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </button>
              </div>

              <div className="mt-6 flex gap-4 p-5 bg-amber-50/60 rounded-xl border border-amber-100/50 text-amber-900">
                <div className="p-2 bg-amber-100 rounded-full h-fit flex-shrink-0">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                </div>
                <div className="text-sm">
                  <p className="font-bold text-amber-800">Important Next Step</p>
                  <p className="mt-1 text-amber-700/80 leading-relaxed">
                    After completing your purchase, you&apos;ll need to point your domain&apos;s nameservers to our hosting for your website to go live. We&apos;ll send you the instructions via email.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <label className="block text-sm font-semibold text-gray-700 mb-3 ml-1">
                Search for an available domain
              </label>
              <form onSubmit={handleSearch} className="relative mb-6">
                <div className="relative flex items-center group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Search className="h-5 w-5 text-gray-400 group-focus-within:text-indigo-500 transition-colors" />
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setSearchResult(null);
                    }}
                    className="block w-full rounded-xl border-gray-200 bg-gray-50/50 shadow-sm focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 py-3.5 pl-11 pr-40 transition-all duration-200 hover:border-gray-300"
                    placeholder="Find your perfect domain..."
                  />
                  <div className="absolute right-2">
                    <button
                      type="submit"
                      disabled={!searchQuery.trim() || isSearching}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-semibold rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-100 disabled:opacity-50 transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5"
                    >
                      {isSearching ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        'Check Availability'
                      )}
                    </button>
                  </div>
                </div>
              </form>

              {searchResult && (
                <div className={`p-5 rounded-2xl border transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${searchResult.available ? 'bg-emerald-50/50 border-emerald-100' : 'bg-rose-50/50 border-rose-100'}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      {searchResult.available ? (
                        <div className="bg-emerald-100 p-2.5 rounded-full flex-shrink-0 shadow-sm">
                          <Check className="h-5 w-5 text-emerald-600" />
                        </div>
                      ) : (
                        <div className="bg-rose-100 p-2.5 rounded-full flex-shrink-0 shadow-sm">
                          <X className="h-5 w-5 text-rose-600" />
                        </div>
                      )}
                      <div>
                        <p className={`text-lg font-bold tracking-tight ${searchResult.available ? 'text-emerald-900' : 'text-rose-900'}`}>{searchResult.domainName}</p>
                        {searchResult.available ? (
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
                              Available
                            </span>
                            <span className="text-sm text-emerald-700 font-medium">for <span className="text-emerald-900 font-bold">₹{searchResult.price}</span>/year</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-rose-100 text-rose-800">
                              Unavailable
                            </span>
                            <span className="text-sm text-rose-600">{searchResult.error || 'Domain is already taken'}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {searchResult.available && (
                      <button
                        onClick={handleBuyAndLink}
                        className="flex-shrink-0 flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl shadow-lg hover:shadow-xl transition-all transform hover:-translate-y-0.5 active:translate-y-0 focus:ring-4 focus:ring-emerald-100"
                      >
                        Add & Link
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
