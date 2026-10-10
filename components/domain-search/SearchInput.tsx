'use client';

import React, { useRef, useState } from 'react';
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
  const inputRef = useRef<HTMLInputElement>(null);
  /* An empty press used to do nothing behind a faded-out button, which read as broken
     (9 Oct 2026). The button now stays live and asks for a name instead. */
  const [needName, setNeedName] = useState(false);
  const search = (e?: React.FormEvent) => {
    if (!searchTerm.trim()) {
      setNeedName(true);
      inputRef.current?.focus();
      return;
    }
    setNeedName(false);
    onSearch(e);
  };
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
            search(e as unknown as React.FormEvent);
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
              ? 'bg-paper/95 shadow-[0_10px_30px_rgba(0,0,0,0.18)] focus-within:bg-paper focus-within:shadow-[0_12px_40px_rgba(0,0,0,0.22)]'
              : 'bg-paper border border-hairline shadow-[0_10px_30px_rgba(0,0,0,0.06)] focus-within:border-amber/40 focus-within:shadow-[0_12px_40px_rgba(96,165,250,0.18)]'
          }`}
        >
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => {
              if (needName && e.target.value.trim()) setNeedName(false);
              onChange(e);
            }}
            aria-label="Domain name"
            aria-describedby={needName ? 'domain-search-need-name' : undefined}
            placeholder="Type a name, e.g. yourbusiness"
            className={`w-full px-4 sm:px-5 bg-transparent border-0 focus:ring-0 focus:outline-none font-medium text-ink placeholder-ink-4 ${
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
          onClick={() => search()}
          disabled={isSearching}
          aria-label="Search domains"
          className={`flex-shrink-0 bg-amber hover:brightness-95 text-paper font-bold rounded-xl sm:rounded-2xl ring-1 ring-paper/30 transition-all duration-300 flex items-center justify-center gap-1.5 sm:gap-2 shadow-sm hover:shadow-md disabled:opacity-60 disabled:saturate-50 active:scale-95 ${
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

      {needName && (
        <p id="domain-search-need-name" role="alert" className="mt-2 text-sm text-rose-ink">
          Type a name to search, for example yourbusiness.
        </p>
      )}

      {/* Prompt Message */}
      <AnimatePresence>
        {searchMode === 'multiple' && baseDomain && !hasSearched && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`${compact ? 'mt-3' : 'mt-6'} flex items-center justify-center gap-3 text-indigo-ink font-semibold`}
          >
            {/* The prompt sits OUTSIDE the white search card and directly on
                the page's blue hero background in both hosted usages
                (app/page.tsx + app/domains/search/page.tsx, both pass
                theme="light"). The previous theme="light" colors
                (text-indigo sparkle + text-ink-2 text) were meant for
                a white card backdrop and read as low-contrast on blue.
                Switched to high-contrast yellow icon + near-white text so
                the prompt is readable in both contexts. */}
            <Sparkles
              className="h-5 w-5 animate-pulse text-amber transition-colors duration-300"
            />
            {/* White on the blue hero; ink on a white surface (the panel's pop-up), where white was invisible. */}
            <span className={`text-sm sm:text-base transition-colors duration-300 ${theme === 'light' ? 'text-ink-2' : 'text-paper/90'}`}>
              We'll check .com, .net, .in and more for "{baseDomain}"
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
