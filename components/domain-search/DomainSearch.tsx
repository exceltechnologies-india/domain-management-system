'use client';

/**
 * Domain Search Component (Orchestrator)
 *
 * Composes SearchInput, SearchResults, DomainCard sub-components and the
 * useDomainSearch hook to provide a full domain-search experience.
 *
 * @author Anutech Digital Private Limited
 * @version 2.0.0
 * @since 2024
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCartStore } from '@/store/cartStore';
import { useRouter } from 'next/navigation';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { getDomainRequirements, requiresAdditionalDetails, isDomainSupported } from '@/lib/domainRequirements';
import DomainRequirementsModal from '@/components/DomainRequirementsModal';
import { Bell, LogIn, UserPlus, X } from 'lucide-react';

import { useDomainSearch } from './hooks/useDomainSearch';
import type { SearchResult } from './hooks/useDomainSearch';
import { apiClient } from '@/lib/api-client';
import SearchInput from './SearchInput';
import SearchResults from './SearchResults';

export interface DomainSearchProps {
  className?: string;
  redirectOnSearch?: boolean;
  autoSearch?: boolean;
  initialSearchTerm?: string;
  theme?: 'light' | 'dark';
  title?: React.ReactNode;
  subtitle?: string;
  showHeroText?: boolean;
  compact?: boolean;
}

export default function DomainSearch({
  className = '',
  redirectOnSearch = false,
  autoSearch = false,
  initialSearchTerm = '',
  theme = 'dark',
  title,
  subtitle,
  showHeroText = true,
  compact = false,
}: DomainSearchProps) {
  const [showRequirementsModal, setShowRequirementsModal] = React.useState(false);
  const [selectedDomainForRequirements, setSelectedDomainForRequirements] = React.useState('');
  const [watchSignInDomain, setWatchSignInDomain] = React.useState<string | null>(null);

  const { addItem } = useCartStore();
  const router = useRouter();

  const {
    searchTerm,
    isSearching,
    isLoadingSuggestions,
    results,
    hasSearched,
    error,
    baseDomain,
    searchMode,
    isLoadingMore,
    canLoadMore,
    suggestions,
    handleSearch,
    handleLoadMoreSuggestions,
    handleInputChange,
    clearSearch,
  } = useDomainSearch({ redirectOnSearch, autoSearch, initialSearchTerm });

  const handleAddToCart = (result: SearchResult) => {
    if (result.available && result.price) {
      if (requiresAdditionalDetails(result.domainName)) {
        setSelectedDomainForRequirements(result.domainName);
        setShowRequirementsModal(true);
        return;
      }

      if (!isDomainSupported(result.domainName)) {
        showErrorToast(`${result.domainName} requires additional verification. Please contact support.`);
        return;
      }

      const cartItem = {
        domainName: result.domainName,
        price: result.price,
        currency: result.currency || 'INR',
        registrationPeriod: result.registrationPeriod || 1,
        itemType: 'domain' as const,
      };
      addItem(cartItem);
      showSuccessToast(`${result.domainName} added to cart`);

      setTimeout(() => {
        router.push('/cart');
      }, 1000);
    } else {
      showErrorToast('Cannot add to cart - missing required data');
    }
  };

  const handleShowRequirements = (domain: string) => {
    setSelectedDomainForRequirements(domain);
    setShowRequirementsModal(true);
  };

  const handleWatch = async (domainName: string) => {
    const result = await apiClient.post("/api/v1/user/domains/watch", { domainName });
    if (result.ok) {
      showSuccessToast(`We'll email you when ${domainName} becomes available`);
      return;
    }
    // Branch on the normalised status — same codes the route returns.
    switch (result.error.status) {
      case 401:
        setWatchSignInDomain(domainName);
        return;
      case 409:
        showErrorToast(`Already watching ${domainName}`);
        return;
      case 400:
        showErrorToast(result.error.message ?? "Could not add watch");
        return;
      default:
        showErrorToast("Failed to watch domain — please try again");
    }
  };

  return (
    <div className={`w-full max-w-screen-2xl mx-auto px-4 py-1 sm:py-3 ${className}`}>
      {/* Hero Search Section */}
      {showHeroText && (
        <section className={`relative text-center ${compact ? 'mb-2 sm:mb-4' : 'mb-3 sm:mb-6'}`}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <h1
              className={`font-black mb-2 sm:mb-3 tracking-tighter transition-colors duration-300 ${
                compact ? 'text-xl sm:text-2xl md:text-3xl' : 'text-2xl sm:text-3xl md:text-4xl'
              } ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              {title || (
                <>
                  Your Perfect Domain{' '}
                  <span className={theme === 'dark' ? 'text-primary-400' : 'text-primary-600'}>Awaits</span>
                </>
              )}
            </h1>
            <p
              className={`max-w-2xl mx-auto font-medium leading-relaxed transition-colors duration-300 ${
                compact ? 'text-xs sm:text-sm mb-2 sm:mb-3' : 'text-sm sm:text-base mb-3 sm:mb-4'
              } ${theme === 'dark' ? 'text-primary-100/80' : 'text-gray-600'}`}
            >
              {subtitle ||
                'Secure your online identity with enterprise-grade domain registration and management tools.'}
            </p>
          </motion.div>
        </section>
      )}

      {/* Search Input */}
      <SearchInput
        searchTerm={searchTerm}
        isSearching={isSearching}
        searchMode={searchMode}
        baseDomain={baseDomain}
        hasSearched={hasSearched}
        theme={theme}
        compact={compact}
        onChange={handleInputChange}
        onSearch={handleSearch}
      />

      {/* Results Area */}
      <SearchResults
        isSearching={isSearching}
        isLoadingSuggestions={isLoadingSuggestions}
        hasSearched={hasSearched}
        results={results}
        suggestions={suggestions}
        error={error}
        canLoadMore={canLoadMore}
        isLoadingMore={isLoadingMore}
        onAddToCart={handleAddToCart}
        onShowRequirements={handleShowRequirements}
        onClearSearch={clearSearch}
        onLoadMore={handleLoadMoreSuggestions}
        onWatch={handleWatch}
      />

      {/* Watch Domain — Sign In Prompt */}
      <AnimatePresence>
        {watchSignInDomain && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => setWatchSignInDomain(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl border border-gray-100 w-full max-w-sm p-6 relative"
            >
              <button
                onClick={() => setWatchSignInDomain(null)}
                className="absolute top-4 right-4 p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>

              <div className="flex items-center justify-center w-12 h-12 bg-amber-100 rounded-xl mb-4 mx-auto">
                <Bell className="h-6 w-6 text-amber-600" />
              </div>

              <h2 className="text-lg font-bold text-gray-900 text-center mb-1">
                Get notified when it's free
              </h2>
              <p className="text-sm text-gray-500 text-center mb-1">
                <span className="font-semibold text-gray-700">{watchSignInDomain}</span> is currently taken.
              </p>
              <p className="text-sm text-gray-500 text-center mb-6">
                Sign in and we'll email you the moment it becomes available for registration.
              </p>

              <div className="space-y-2.5">
                <a
                  href={`/login?returnUrl=${encodeURIComponent(`/domains/search?q=${watchSignInDomain.split('.')[0]}`)}`}
                  className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-xl transition-colors"
                >
                  <LogIn className="h-4 w-4" />
                  Sign In
                </a>
                <a
                  href={`/register?returnUrl=${encodeURIComponent(`/domains/search?q=${watchSignInDomain.split('.')[0]}`)}`}
                  className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-xl transition-colors"
                >
                  <UserPlus className="h-4 w-4" />
                  Create Account
                </a>
              </div>

              <p className="text-xs text-gray-400 text-center mt-4">
                Free to sign up · No spam · Unsubscribe any time
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Domain Requirements Modal */}
      {showRequirementsModal && selectedDomainForRequirements && (
        <DomainRequirementsModal
          isOpen={showRequirementsModal}
          onClose={() => {
            setShowRequirementsModal(false);
            setSelectedDomainForRequirements('');
          }}
          domain={selectedDomainForRequirements.split('.')[0]}
          tld={`.${selectedDomainForRequirements.split('.').slice(1).join('.')}`}
          requirements={
            getDomainRequirements(
              `.${selectedDomainForRequirements.split('.').slice(1).join('.')}`
            ).requirements
          }
          restrictions={
            getDomainRequirements(
              `.${selectedDomainForRequirements.split('.').slice(1).join('.')}`
            ).restrictions
          }
          onSelectAlternative={() => {
            const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';
            window.open(`mailto:${supportEmail}?subject=Domain Registration Support`);
          }}
        />
      )}
    </div>
  );
}
