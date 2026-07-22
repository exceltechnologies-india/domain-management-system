'use client';

import React from 'react';
import {
  CheckCircle2,
  XCircle,
  Globe,
  Star,
  AlertTriangle,
  ShoppingCart,
  Zap,
  Bell,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { requiresAdditionalDetails } from '@/lib/domainRequirements';
import { useDomainPricing } from './hooks/useDomainPricing';
import type { SearchResult } from './hooks/useDomainSearch';

// ─────────────────────────────────────────────
// Hero Result Card (GoDaddy/Hostinger Style)
// ─────────────────────────────────────────────

interface HeroResultCardProps {
  result: SearchResult;
  onAdd: () => void;
  onShowRequirements?: (domain: string) => void;
  onWatch?: (domainName: string) => void;
}

export function HeroResultCard({ result, onAdd, onShowRequirements, onWatch }: HeroResultCardProps) {
  const { formatPrice } = useDomainPricing();
  const isAvailable = result.available;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`relative overflow-hidden rounded-xl border transition-all duration-500 ${
        isAvailable
          ? 'border-green-200 bg-gradient-to-br from-white to-green-50/20 shadow-md'
          : 'border-gray-100 bg-white opacity-95'
      }`}
    >
      <div className="px-3 py-2.5 sm:px-5 sm:py-4">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5 sm:gap-4">
          <div className="flex-1 min-w-0 w-full">
            <div className="flex flex-wrap items-center gap-2 mb-1.5 sm:mb-3">
              <span
                className={`px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-bold tracking-widest uppercase shadow-sm ${
                  isAvailable ? 'bg-primary-600 text-white' : 'bg-red-500 text-white'
                }`}
              >
                {isAvailable ? 'EXACT MATCH' : 'TAKEN'}
              </span>
              {isAvailable && (
                <span className="bg-primary-50 text-primary-700 px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-bold tracking-widest uppercase flex items-center gap-1 border border-primary-100">
                  <Zap className="h-2.5 w-2.5 fill-current" />
                  BEST VALUE
                </span>
              )}
            </div>

            <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1 sm:mb-2 tracking-tight break-all">
              {result.domainName}
            </h3>

            {isAvailable ? (
              <div className="flex items-center gap-2">
                <div className="bg-green-100 p-1 rounded-full">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                </div>
                <p className="text-sm font-bold text-gray-700">Available to register</p>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="bg-red-100 p-1 rounded-full">
                  <XCircle className="h-3.5 w-3.5 text-red-600" />
                </div>
                <p className="text-sm font-bold text-gray-600">Already registered</p>
              </div>
            )}
          </div>

          <div
            className={`w-full md:w-auto flex flex-col items-center md:items-end gap-2 rounded-lg p-2 sm:p-3 transition-colors ${
              isAvailable
                ? 'bg-white/50 backdrop-blur border border-white/60'
                : 'bg-gray-50/50 border border-gray-100'
            }`}
          >
            {isAvailable && result.price ? (
              <>
                <div className="text-center md:text-right w-full sm:w-auto">
                  <div className="text-[9px] sm:text-[10px] text-gray-400 font-bold uppercase mb-0.5 tracking-widest line-through leading-none">
                    {formatPrice(result.price * 1.5, result.currency)}
                  </div>
                  <div className="flex items-baseline gap-1 justify-center md:justify-end">
                    <span className="text-2xl sm:text-4xl font-black text-gray-900 tracking-tight leading-none">
                      {formatPrice(result.price, result.currency)}
                    </span>
                    <span className="text-[10px] text-gray-500 font-bold uppercase">/1st yr</span>
                  </div>
                </div>
                <button
                  onClick={onAdd}
                  className="w-full md:w-auto px-6 py-2.5 sm:py-2 bg-primary-600 hover:bg-primary-700 text-white font-bold text-xs rounded-lg transition-all duration-300 shadow-sm hover:shadow-primary-500/20 active:scale-95 flex items-center justify-center gap-2 uppercase tracking-wider"
                >
                  <ShoppingCart className="h-3.5 w-3.5" />
                  MAKE IT YOURS
                </button>
              </>
            ) : (
              <div className="w-full text-center md:text-right space-y-2">
                <button
                  disabled
                  className="w-full md:w-auto px-6 py-1.5 sm:py-2 bg-gray-100 text-gray-400 font-bold text-[10px] sm:text-xs rounded-lg uppercase tracking-wider border border-gray-200 opacity-60"
                >
                  NOT AVAILABLE
                </button>
                {onWatch && (
                  <button
                    onClick={() => onWatch(result.domainName)}
                    title="We'll email you when this domain becomes available for registration"
                    className="w-full md:w-auto px-6 py-1.5 sm:py-2 bg-amber-50 hover:bg-amber-100 text-amber-700 font-bold text-[10px] sm:text-xs rounded-lg uppercase tracking-wider border border-amber-200 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Bell className="h-3 w-3" />
                    NOTIFY ME
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Background Decorative Element */}
      <div
        className={`absolute -bottom-12 -right-12 h-48 w-48 rounded-full blur-3xl opacity-10 pointer-events-none ${
          isAvailable ? 'bg-green-400' : 'bg-red-400'
        }`}
      ></div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// Compact Result Card for Suggestion List
// ─────────────────────────────────────────────

interface CompactResultCardProps {
  result: SearchResult;
  onAdd: () => void;
  onShowRequirements?: (domain: string) => void;
  onWatch?: (domainName: string) => void;
}

export function CompactResultCard({ result, onAdd, onShowRequirements, onWatch }: CompactResultCardProps) {
  const { formatPrice } = useDomainPricing();
  const savings = result.originalPrice
    ? Math.round(((result.originalPrice - (result.price ?? 0)) / result.originalPrice) * 100)
    : 0;
  const isAvailable = result.available;

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      className={`group bg-white hover:bg-gray-50/80 border transition-all duration-300 p-3 sm:py-2 sm:px-3 rounded-xl sm:rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-2 ${
        isAvailable ? 'border-gray-100 hover:border-primary-200' : 'border-gray-50 opacity-75'
      }`}
    >
      {/* Domain Info */}
      <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
        <div className="hidden sm:flex w-8 h-8 bg-primary-50 text-primary-600 rounded-md items-center justify-center flex-shrink-0 group-hover:bg-primary-600 group-hover:text-white transition-colors">
          <Globe className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-0.5">
            <h4 className="text-base sm:text-base font-bold text-gray-900 truncate tracking-tight">
              {result.domainName}
            </h4>
            {savings > 0 && (
              <span className="bg-red-50 text-red-600 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider border border-red-100">
                SAVE {savings}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <span
              className={`text-[9px] font-bold uppercase tracking-widest ${
                isAvailable ? 'text-primary-600' : 'text-red-500'
              }`}
            >
              {isAvailable ? 'Available' : 'Taken'}
            </span>
            {isAvailable && result.pricingSource === 'live' && (
              <span className="flex items-center gap-1 text-primary-500 text-[8px] font-bold uppercase tracking-widest bg-primary-50/50 px-1 rounded">
                <Zap className="h-2 w-2 fill-current" />
                Live Price
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Pricing and Action */}
      <div className="flex items-center justify-between sm:justify-end gap-4 border-t sm:border-t-0 pt-2.5 sm:pt-0 border-gray-50">
        <div className="text-left sm:text-right">
          {result.originalPrice && isAvailable && (
            <div className="text-[8px] sm:text-[10px] text-gray-400 line-through font-bold leading-none mb-0.5">
              {formatPrice(result.originalPrice, result.currency)}
            </div>
          )}
          <div className="flex items-baseline gap-0.5 sm:gap-1">
            {isAvailable && result.price ? (
              <>
                <span className="text-base sm:text-xl font-bold text-gray-900 leading-none">
                  {formatPrice(result.price, result.currency)}
                </span>
                <span className="text-[8px] sm:text-[9px] text-gray-400 font-bold uppercase">/yr</span>
              </>
            ) : (
              <span className="text-[9px] sm:text-[10px] font-bold text-gray-400 uppercase tracking-tight">
                Unavailable
              </span>
            )}
          </div>
        </div>

        {isAvailable && result.price ? (
          <button
            onClick={onAdd}
            className="px-4 sm:px-4 py-2 sm:py-1.5 font-bold text-[9px] sm:text-[10px] rounded-lg transition-all duration-300 active:scale-95 uppercase tracking-wider bg-primary-50 border border-primary-200 text-primary-600 hover:bg-primary-600 hover:text-white"
          >
            BUY NOW
          </button>
        ) : onWatch ? (
          <button
            onClick={() => onWatch(result.domainName)}
            className="px-4 sm:px-4 py-2 sm:py-1.5 font-bold text-[9px] sm:text-[10px] rounded-lg transition-all duration-300 active:scale-95 uppercase tracking-wider bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 flex items-center gap-1"
          >
            <Bell className="h-2.5 w-2.5" />
            WATCH
          </button>
        ) : (
          <button
            disabled
            className="px-4 sm:px-4 py-2 sm:py-1.5 font-bold text-[9px] sm:text-[10px] rounded-lg uppercase tracking-wider bg-gray-50 border border-gray-100 text-gray-400 cursor-not-allowed opacity-50"
          >
            N/A
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// Full Domain Result Card (legacy card, kept for completeness)
// ─────────────────────────────────────────────

interface DomainResultCardProps {
  result: SearchResult;
  onAdd: () => void;
  onShowRequirements?: (domain: string) => void;
  isPrimary?: boolean;
}

export function DomainResultCard({
  result,
  onAdd,
  onShowRequirements,
  isPrimary = false,
}: DomainResultCardProps) {
  const { formatPrice } = useDomainPricing();

  return (
    <motion.div
      whileHover={{ y: -6, boxShadow: '0 25px 30px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)' }}
      className={`relative group rounded-2xl sm:rounded-[1.5rem] border-2 transition-all duration-500 overflow-hidden ${
        isPrimary
          ? 'bg-gradient-to-br from-primary-50 to-indigo-50/50 border-primary-200/50'
          : 'bg-white border-gray-100 hover:border-primary-200'
      } ${!result.available ? 'opacity-80 grayscale-[0.5]' : ''}`}
    >
      <div className="p-6">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 sm:gap-6">
          <div className="flex items-center gap-3 sm:gap-5 w-full lg:w-auto">
            <div
              className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl flex-shrink-0 shadow-sm ${
                result.available ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
              }`}
            >
              {result.available ? (
                <Globe className="h-5 w-5 sm:h-7 sm:w-7" />
              ) : (
                <XCircle className="h-5 w-5 sm:h-7 sm:w-7" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 sm:gap-3 mb-1 min-w-0">
                <h4 className="text-lg sm:text-xl font-extrabold text-gray-900 truncate tracking-tight">
                  {result.domainName}
                </h4>
                {requiresAdditionalDetails(result.domainName) && (
                  <button
                    onClick={() => onShowRequirements?.(result.domainName)}
                    className="p-1 bg-amber-100 text-amber-600 rounded-lg hover:bg-amber-200 transition-colors flex-shrink-0"
                    title="Additional details required"
                  >
                    <AlertTriangle className="h-3 w-3 sm:h-4 sm:w-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`px-2 py-0.5 sm:px-3 sm:py-1 rounded-full text-[8px] sm:text-[10px] font-bold uppercase tracking-widest ${
                    result.available ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  }`}
                >
                  {result.available ? 'AVAILABLE' : 'TAKEN'}
                </span>
                {result.available && result.pricingSource === 'live' && (
                  <span className="flex items-center gap-1 bg-primary-100 text-primary-700 px-2 py-0.5 sm:px-3 sm:py-1 rounded-full text-[8px] sm:text-[10px] font-bold uppercase tracking-widest">
                    <Zap className="h-2 w-2 sm:h-3 sm:w-3 fill-current" />
                    LIVE PRICE
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-row lg:flex-col items-center lg:items-end justify-between lg:justify-center w-full lg:w-auto gap-4 sm:gap-6 lg:gap-2 border-t lg:border-t-0 border-gray-100 pt-4 lg:pt-0 mt-1 lg:mt-0">
            {result.available && result.price ? (
              <>
                <div className="text-left lg:text-right">
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl sm:text-2xl font-black text-gray-900 leading-none">
                      {formatPrice(result.price, result.currency)}
                    </span>
                    <span className="text-[9px] sm:text-[10px] text-gray-500 font-bold uppercase">/yr</span>
                  </div>
                </div>
                <button
                  onClick={onAdd}
                  className="px-4 py-2 sm:px-6 sm:py-2.5 bg-gray-900 hover:bg-primary-600 text-white font-black text-xs sm:text-sm rounded-lg sm:rounded-xl transition-all duration-300 flex items-center justify-center gap-2 sm:gap-2.5 shadow-md shadow-gray-200 hover:shadow-primary-500/20 group/btn active:scale-95 flex-1 sm:flex-none"
                >
                  <ShoppingCart className="h-3.5 w-3.5 sm:h-4 sm:w-4 group-hover/btn:scale-110 transition-transform" />
                  <span className="whitespace-nowrap">ADD TO CART</span>
                </button>
              </>
            ) : (
              <div className="px-5 py-2 bg-gray-100 text-gray-500 font-bold text-[10px] uppercase rounded-xl tracking-widest">
                {result.available ? 'Contact for pricing' : 'NOT AVAILABLE'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Subtle indicator for primary result */}
      {isPrimary && (
        <div className="absolute top-0 right-0 p-4 opacity-10">
          <Star className="h-12 w-12 text-primary-600 fill-primary-600" />
        </div>
      )}
    </motion.div>
  );
}
