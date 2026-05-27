'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { safeLocalStorage } from '@/lib/storage';
import { isRestrictedTLD } from '@/lib/domainRequirements';
import { apiClient } from '@/lib/api-client';
import { TOP_TLDS } from '../data/tlds';

export interface SearchResult {
  domainName: string;
  available: boolean;
  price?: number;
  currency?: string;
  registrationPeriod?: number;
  pricingSource?: 'live' | 'fallback' | 'unavailable' | 'taken';
  category?: string;
  originalPrice?: number;
}

interface ValidationSuccess {
  isValid: true;
  baseDomain: string;
  suggestedTld: string | null;
}

interface ValidationFailure {
  isValid: false;
  warning: string;
}

type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateDomainInput(input: string): ValidationResult {
  const trimmed = input.replace(/\s+/g, '');

  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    if (parts.length >= 2 && parts[0].length > 0 && parts[parts.length - 1].length > 0) {
      return {
        isValid: true,
        baseDomain: parts[0],
        suggestedTld: parts.slice(1).join('.')
      };
    }
  }

  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/;
  const matches = domainRegex.test(trimmed);

  if (matches && trimmed.length >= 2) {
    return {
      isValid: true,
      baseDomain: trimmed,
      suggestedTld: null
    };
  }

  return {
    isValid: false,
    warning: 'Please enter a valid domain name (e.g., "example" or "example.com")'
  };
}

export function getSuggestedTlds(domain: string): string[] {
  const filteredSuggestions = TOP_TLDS.filter(tld => !isRestrictedTLD(tld));
  return filteredSuggestions.slice(0, 20);
}

interface UseDomainSearchOptions {
  redirectOnSearch?: boolean;
  autoSearch?: boolean;
  initialSearchTerm?: string;
}

export function useDomainSearch({
  redirectOnSearch = false,
  autoSearch = false,
  initialSearchTerm = '',
}: UseDomainSearchOptions) {
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostingExists, setHostingExists] = useState(false);
  const [baseDomain, setBaseDomain] = useState('');
  const [showTldSuggestions, setShowTldSuggestions] = useState(false);
  const [searchMode, setSearchMode] = useState<'single' | 'multiple'>('single');
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchedTlds, setSearchedTlds] = useState<string[]>([]);
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

  const searchGenRef = useRef(0); // incremented on each new search to discard stale callbacks
  const router = useRouter();

  // Load saved search state or trigger auto-search on component mount
  useEffect(() => {
    if (initialSearchTerm) {
      setSearchTerm(initialSearchTerm);
      if (autoSearch) {
        const timer = setTimeout(() => {
          void handleSearch(undefined, initialSearchTerm);
        }, 100);
        return () => clearTimeout(timer);
      }
    } else {
      const savedSearchState = safeLocalStorage.getItem('domainSearchState');
      if (savedSearchState) {
        try {
          const state = JSON.parse(savedSearchState);
          if (state.searchTerm) {
            setSearchTerm(state.searchTerm);
            setBaseDomain(state.baseDomain || '');
            setSearchMode(state.searchMode || 'single');
          }
        } catch (error) {
          // Failed to load saved search state
        }
      }
    }

    setIsSearching(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearchTerm, autoSearch]);

  // Save search state when it changes
  useEffect(() => {
    if (hasSearched) {
      const searchState = {
        searchTerm,
        baseDomain,
        searchMode
      };
      safeLocalStorage.setItem('domainSearchState', JSON.stringify(searchState));
    }
  }, [searchTerm, baseDomain, searchMode, hasSearched]);

  const handleSearch = async (e?: React.FormEvent, overrideTerm?: string) => {
    if (e) e.preventDefault();

    const termToUse = overrideTerm || searchTerm;
    const cleanedSearchTerm = termToUse.replace(/\s+/g, '');
    if (!cleanedSearchTerm) return;

    if (redirectOnSearch && !overrideTerm) {
      router.push(`/domains/search?q=${encodeURIComponent(cleanedSearchTerm)}`);
      return;
    }

    const validation = validateDomainInput(termToUse);

    if (!validation.isValid) {
      const errorMessage = ('warning' in validation ? validation.warning : 'Please enter a valid domain name') || 'Please enter a valid domain name';
      toast.error(errorMessage);
      return;
    }

    searchGenRef.current += 1;
    const thisGen = searchGenRef.current;

    setSearchedTlds([]);
    setCanLoadMore(false);
    setSuggestions([]);
    setBaseDomain(('baseDomain' in validation ? validation.baseDomain : '') || '');
    setIsSearching(true);
    setIsLoadingSuggestions(false);
    setHasSearched(true);
    setError(null);
    setHostingExists(false);

    const suggestedTld = 'suggestedTld' in validation ? validation.suggestedTld : null;
    const shouldSearchMultipleTlds = !suggestedTld;

    // Build the request body for both quick and full requests
    const quickBody = shouldSearchMultipleTlds
      ? { domain: ('baseDomain' in validation ? validation.baseDomain : '') || '', tlds: ['.com'], quick: true }
      : { domain: cleanedSearchTerm, quick: true };

    const fullBody = shouldSearchMultipleTlds
      ? { domain: ('baseDomain' in validation ? validation.baseDomain : '') || '', tlds: ['.com'] }
      : { domain: cleanedSearchTerm };

    if (shouldSearchMultipleTlds) {
      const domainBase = ('baseDomain' in validation ? validation.baseDomain : '') || '';
      setBaseDomain(domainBase);
      setSearchedTlds(['.com']);
      const allTlds = getSuggestedTlds(domainBase);
      setCanLoadMore(allTlds.length > 1);
    }

    // ── Phase 1: quick domain availability (no suggestions) ──────────────────
    const quickResult = await apiClient.post<{ success?: boolean; results?: SearchResult[]; error?: string; message?: string }>('/api/v1/domains/search', quickBody);

    if (thisGen !== searchGenRef.current) return; // Search was superseded

    if (quickResult.ok && quickResult.data.success) {
      setResults(quickResult.data.results || []);
      setError(null);
    } else if (quickResult.ok) {
      const data = quickResult.data;
      setResults([]);
      setSuggestions([]);
      if (data.error === 'restricted_tld' || data.error === 'all_tlds_restricted') {
        setError(data.message ?? null);
        toast.error(data.message ?? '', { duration: 8000, style: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' } });
      } else {
        setError(data.error || 'Failed to search domain. Please try again.');
        toast.error(data.error || 'Failed to search domain. Please try again.');
      }
      setIsSearching(false);
      return;
    } else {
      setResults([]);
      setSuggestions([]);
      setError('Network error. Please check your connection and try again.');
      toast.error('Network error. Please check your connection and try again.');
      setIsSearching(false);
      return;
    }

    // Results are ready — stop the main spinner so users see them immediately
    setIsSearching(false);
    setIsLoadingSuggestions(true);

    // ── Phase 2: suggestions + hosting check in background ───────────────────
    void (async () => {
      const result = await apiClient.post<{ success?: boolean; suggestions?: SearchResult[]; hostingExists?: boolean }>('/api/v1/domains/search', fullBody);
      if (thisGen !== searchGenRef.current) return;
      if (result.ok && result.data.success) {
        setSuggestions(result.data.suggestions || []);
        setHostingExists(result.data.hostingExists || false);
      }
      // suggestions are non-critical; keep showing results on failure
      setIsLoadingSuggestions(false);
    })();
  };

  const handleLoadMoreSuggestions = async () => {
    if (!baseDomain || isLoadingMore) return;

    setIsLoadingMore(true);

    const allTlds = getSuggestedTlds(baseDomain);
    const remainingTlds = allTlds.filter(tld => !searchedTlds.includes(tld));
    const tldsToSearch = remainingTlds.slice(0, 6);

    if (tldsToSearch.length === 0) {
      setCanLoadMore(false);
      toast('No more TLD suggestions available', { icon: 'ℹ️' });
      setIsLoadingMore(false);
      return;
    }

    const result = await apiClient.post<{ success?: boolean; results?: SearchResult[]; error?: string }>('/api/v1/domains/search', { domain: baseDomain, tlds: tldsToSearch });

    if (result.ok && result.data.success) {
      const data = result.data;
      setResults(prevResults => [...prevResults, ...(data.results || [])]);
      setSearchedTlds(prev => [...prev, ...tldsToSearch]);

      const newRemainingTlds = remainingTlds.slice(tldsToSearch.length);
      setCanLoadMore(newRemainingTlds.length > 0);

      toast.success(`Found ${data.results?.length || 0} more suggestions`);
    } else if (result.ok) {
      toast.error(result.data.error || 'Failed to load more suggestions');
    } else {
      toast.error(result.error.status === 0 ? 'Failed to load more suggestions. Please try again.' : result.error.message || 'Failed to load more suggestions');
    }
    setIsLoadingMore(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\s+/g, '');
    setSearchTerm(value);

    const validation = validateDomainInput(value);
    const suggestedTld = 'suggestedTld' in validation ? validation.suggestedTld : null;
    const domainBase = (('baseDomain' in validation ? validation.baseDomain : '') || '');

    if (validation.isValid && !suggestedTld) {
      setSearchMode('multiple');
      setShowTldSuggestions(true);
      setBaseDomain(domainBase);
      if (hasSearched) {
        setResults([]);
        setSuggestions([]);
        setHasSearched(false);
        setError(null);
      }
    } else if (suggestedTld) {
      setSearchMode('single');
      setShowTldSuggestions(false);
      setBaseDomain(domainBase);
    } else {
      setSearchMode('single');
      setShowTldSuggestions(false);
      setBaseDomain('');
    }
  };

  const clearSearch = () => {
    searchGenRef.current += 1; // invalidate any in-flight background suggestion fetch
    setSearchTerm('');
    setResults([]);
    setSuggestions([]);
    setHasSearched(false);
    setError(null);
    setBaseDomain('');
    setSearchedTlds([]);
    setCanLoadMore(false);
    setIsLoadingMore(false);
    setIsLoadingSuggestions(false);
    setShowTldSuggestions(false);
    setSearchMode('single');
  };

  return {
    searchTerm,
    isSearching,
    isLoadingSuggestions,
    results,
    hasSearched,
    error,
    hostingExists,
    baseDomain,
    showTldSuggestions,
    searchMode,
    isLoadingMore,
    searchedTlds,
    canLoadMore,
    suggestions,
    handleSearch,
    handleLoadMoreSuggestions,
    handleInputChange,
    clearSearch,
  };
}
