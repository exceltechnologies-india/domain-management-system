'use client';

import React from 'react';
import { Search, Loader2, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface SearchInputProps {
  searchTerm: string;
  isSearching: boolean;
  searchMode: 'single' | 'multiple';
  baseDomain: string;
  hasSearched: boolean;
  theme?: 'light' | 'dark';
  compact?: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSearch: (e?: React.FormEvent) => void;
}

export default function SearchInput({
  searchTerm,
  isSearching,
  searchMode,
  baseDomain,
  hasSearched,
  theme = 'dark',
  compact = false,
  onChange,
  onSearch,
}: SearchInputProps) {
  return (
    <motion.div
      className={`relative mx-auto ${compact ? 'max-w-4xl' : 'max-w-5xl'}`}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      {/* Two-piece search: a white input pill + an attached solid-colour
          search button. Modelled on the registrar-style search bars (the
          input and button are visually distinct units sharing one row
          instead of nesting inside a wrapping card). */}
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            onSearch(e as unknown as React.FormEvent);
          }
        }}
        className="relative flex flex-row items-stretch gap-2 sm:gap-2.5"
      >
        {/* Input pill */}
        <div
          className={`flex-1 min-w-0 relative flex items-center rounded-xl sm:rounded-2xl transition-all duration-300 ${
            isSearching ? 'opacity-50 pointer-events-none' : ''
          } ${
            theme === 'dark'
              ? 'bg-white/95 shadow-[0_10px_30px_rgba(0,0,0,0.18)] focus-within:bg-white focus-within:shadow-[0_12px_40px_rgba(0,0,0,0.22)]'
              : 'bg-white border border-gray-200 shadow-[0_10px_30px_rgba(0,0,0,0.06)] focus-within:border-blue-400 focus-within:shadow-[0_12px_40px_rgba(96,165,250,0.18)]'
          }`}
        >
          <input
            type="text"
            value={searchTerm}
            onChange={onChange}
            placeholder="Register a domain name to start"
            className={`w-full px-4 sm:px-5 bg-transparent border-0 focus:ring-0 focus:outline-none font-medium text-gray-900 placeholder-gray-400 ${
              compact ? 'py-3 sm:py-3.5 text-sm sm:text-base' : 'py-3.5 sm:py-4 text-sm sm:text-lg'
            }`}
            style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
            disabled={isSearching}
          />
        </div>
        {/* Search button — solid blue square attached to the right. On
            mobile only the icon is shown so the button stays compact. */}
        <button
          type="button"
          onClick={() => onSearch()}
          disabled={isSearching || !searchTerm.trim()}
          aria-label="Search domains"
          className={`flex-shrink-0 bg-blue-500 hover:bg-blue-400 text-white font-bold rounded-xl sm:rounded-2xl transition-all duration-300 flex items-center justify-center gap-1.5 sm:gap-2 shadow-[0_10px_30px_rgba(0,0,0,0.18)] hover:shadow-[0_12px_40px_rgba(59,130,246,0.45)] disabled:opacity-50 active:scale-95 ${
            compact
              ? 'w-12 sm:w-auto sm:px-5 py-3 sm:py-3.5 text-sm'
              : 'w-14 sm:w-auto sm:px-6 py-3.5 sm:py-4 text-base'
          }`}
        >
          <AnimatePresence mode="wait">
            {isSearching ? (
              <motion.div
                key="searching"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-center gap-1.5 sm:gap-2"
              >
                <Loader2 className="h-5 w-5 sm:h-6 sm:w-6 animate-spin" />
                <span className="hidden sm:inline">Searching...</span>
              </motion.div>
            ) : (
              <motion.div
                key="search"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-center gap-1.5 sm:gap-2"
              >
                <Search className="h-5 w-5 sm:h-6 sm:w-6" />
                <span className="hidden sm:inline">Search</span>
              </motion.div>
            )}
          </AnimatePresence>
        </button>
      </div>

      {/* Prompt Message */}
      <AnimatePresence>
        {searchMode === 'multiple' && baseDomain && !hasSearched && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-6 flex items-center justify-center gap-3 text-blue-600 font-semibold"
          >
            <Sparkles
              className={`h-5 w-5 animate-pulse transition-colors duration-300 ${
                theme === 'dark' ? 'text-yellow-400' : 'text-blue-500'
              }`}
            />
            <span
              className={`text-sm sm:text-base transition-colors duration-300 ${
                theme === 'dark' ? 'text-blue-100/90' : 'text-gray-600'
              }`}
            >
              We'll check .com, .net, .in and more for "{baseDomain}"
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
