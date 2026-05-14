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
      <div className="absolute -inset-2 bg-blue-500/10 rounded-[2.5rem] blur-xl opacity-40 transition duration-1000"></div>
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            onSearch(e as unknown as React.FormEvent);
          }
        }}
        className={`relative transition-all duration-300 ${
          compact
            ? 'rounded-xl sm:rounded-2xl p-0.5 sm:p-1 gap-1.5'
            : 'rounded-2xl sm:rounded-[1.5rem] p-1 sm:p-1.5 gap-2'
        } flex flex-col md:flex-row items-stretch ${
          theme === 'dark'
            ? 'bg-white/10 backdrop-blur-2xl border border-white/20 shadow-[0_20px_50px_rgba(0,0,0,0.3)]'
            : 'bg-white border-2 border-blue-100 shadow-[0_20px_50px_rgba(0,0,0,0.08)]'
        }`}
      >
        <div
          className={`flex-1 relative flex items-center rounded-2xl transition-all duration-300 ${
            isSearching ? 'opacity-50 pointer-events-none' : ''
          } ${
            theme === 'dark'
              ? 'bg-white/10 border border-white/10 focus-within:bg-white/20 focus-within:border-blue-400 focus-within:shadow-[0_0_20px_rgba(96,165,250,0.3)]'
              : 'bg-gray-50 border-transparent focus-within:bg-white focus-within:border-blue-400 focus-within:shadow-[0_0_20px_rgba(96,165,250,0.2)]'
          }`}
        >
          <Search
            className={`absolute left-5 h-6 w-6 transition-colors duration-300 ${
              theme === 'dark' ? 'text-blue-100/70' : 'text-gray-400'
            }`}
          />
          <input
            type="text"
            value={searchTerm}
            onChange={onChange}
            placeholder="Find your online identity (e.g., mysite)"
            className={`w-full pl-12 sm:pl-14 pr-4 sm:pr-6 bg-transparent border-0 focus:ring-0 focus:outline-none font-medium transition-colors duration-300 ${
              compact ? 'py-2 sm:py-2.5 text-sm sm:text-base' : 'py-2.5 sm:py-3 text-sm sm:text-lg'
            } ${
              theme === 'dark'
                ? 'text-white placeholder-blue-100/40'
                : 'text-gray-900 placeholder-gray-400'
            }`}
            style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
            disabled={isSearching}
          />
        </div>
        <button
          type="button"
          onClick={() => onSearch()}
          disabled={isSearching || !searchTerm.trim()}
          className={`${
            compact ? 'px-5 py-2 sm:py-2.5 text-sm' : 'px-6 py-2.5 sm:py-3 text-base'
          } bg-blue-500 hover:bg-blue-400 text-white font-bold rounded-xl transition-all duration-300 flex items-center justify-center gap-2 shadow-lg hover:shadow-blue-500/30 disabled:opacity-50 active:scale-95`}
        >
          <AnimatePresence mode="wait">
            {isSearching ? (
              <motion.div
                key="searching"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-center gap-2"
              >
                <Loader2 className="h-6 w-6 animate-spin" />
                <span>Searching...</span>
              </motion.div>
            ) : (
              <motion.div
                key="search"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-center gap-2"
              >
                <Search className="h-6 w-6" />
                <span>Search</span>
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
