'use client';

import { Globe, Trash2, CheckCircle, AlertTriangle, Server } from 'lucide-react';
import { CartItem } from '@/lib/types';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';

interface CartItemCardProps {
  item: CartItem;
  onRemove: (domainName: string, itemType?: string) => void;
  onPeriodChange: (
    domainName: string,
    period: number,
    itemType?: string,
    unit?: 'months' | 'minutes' | 'years' | 'days'
  ) => void;
}

export default function CartItemCard({ item, onRemove, onPeriodChange }: CartItemCardProps) {
  const minPeriod = getMinRegistrationPeriod(item.domainName);
  const tldLabel = item.domainName.split('.').pop()?.toUpperCase();
  const isHostingPlaceholder =
    item.itemType === 'hosting' &&
    item.domainName.startsWith('hosting-') &&
    !item.linkedDomain;

  const displayName =
    item.itemType === 'hosting' && item.hostingPlan
      ? item.hostingPlan.name
      : item.domainName;

  // Trial items use days as their unit + a distinct label so the cart
  // doesn't mis-render a 15-day free trial as a 15-month subscription
  // (the periodUnit field was being silently ignored — see the trial
  // CartItem construction in app/hosting/page.tsx → handleStartTrial).
  const periodLabel = item.isTrial
    ? `${item.registrationPeriod}-day free trial`
    : item.itemType === 'hosting' && item.registrationPeriod === 12
      ? '1 year subscription'
      : `${item.registrationPeriod} ${item.itemType === 'hosting' ? 'month(s)' : 'year(s)'} ${
          item.itemType === 'hosting' ? 'subscription' : 'registration'
        }`;

  const periodOptions = (() => {
    const start = item.itemType === 'hosting' ? 1 : minPeriod;
    return Array.from({ length: 11 - start }, (_, i) => start + i);
  })();

  const isBillingCycleLocked =
    item.itemType === 'hosting' &&
    (item.billingCycle === 'yearly' || item.billingCycle === 'monthly');

  const isHostingItem = item.itemType === 'hosting';

  return (
    <div className="p-4 sm:p-5 bg-white border border-gray-200 rounded-xl hover:border-primary-200 hover:shadow-sm transition-all duration-200">
      {/* Single responsive layout: stacked on mobile, side-by-side on lg */}
      <div className="flex flex-col lg:flex-row lg:items-start gap-4">

        {/* Left: icon + info + tags */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className={`p-2 rounded-lg flex-shrink-0 ${isHostingItem ? 'bg-purple-50' : 'bg-primary-50'}`}>
            {isHostingItem
              ? <Server className="h-4 w-4 lg:h-5 lg:w-5 text-purple-600" />
              : <Globe className="h-4 w-4 lg:h-5 lg:w-5 text-primary-600" />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base lg:text-lg font-medium text-gray-900 truncate">
              {displayName}
            </h3>
            <p className="text-xs lg:text-sm text-gray-600">{periodLabel}</p>
            {item.itemType === 'hosting' &&
              (item.linkedDomain || !item.domainName.startsWith('hosting-')) && (
                <p className="text-xs lg:text-sm font-medium text-primary-600 mt-1">
                  Domain: {item.linkedDomain || item.domainName}
                </p>
              )}
            <div className="flex flex-wrap gap-2 mt-2">
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-primary-50 text-primary-700 border border-primary-100">
                <CheckCircle className="h-3 w-3 mr-1" />
                Available
              </span>
              {isHostingPlaceholder && (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 animate-pulse">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Domain Required
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: period selector + price + remove */}
        <div className="flex items-end justify-between lg:items-center gap-4 sm:gap-6 border-t lg:border-t-0 pt-4 lg:pt-0 flex-shrink-0">
          {/* Period selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs sm:text-sm font-medium text-gray-700">
              Registration Period:
            </label>
            {item.isTrial ? (
              <div className="px-4 py-2 border border-gray-200 rounded-md text-sm bg-amber-50 text-amber-800 font-medium sm:min-w-[100px] text-center">
                {item.registrationPeriod} Days
              </div>
            ) : isBillingCycleLocked ? (
              <div className="px-4 py-2 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-700 font-medium sm:min-w-[100px] text-center">
                {item.billingCycle === 'yearly' ? '1 Year' : '1 Month'}
              </div>
            ) : (
              <select
                value={item.registrationPeriod}
                onChange={(e) =>
                  onPeriodChange(
                    item.domainName,
                    parseInt(e.target.value),
                    item.itemType,
                    'months'
                  )
                }
                className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
              >
                {periodOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} Year{n !== 1 ? 's' : ''}
                    {n === minPeriod && minPeriod > 1 ? ' (Minimum)' : ''}
                  </option>
                ))}
              </select>
            )}
            {minPeriod > 1 && item.itemType !== 'hosting' && (
              <p className="text-xs text-amber-600">
                .{tldLabel} requires min {minPeriod} year registration
              </p>
            )}
          </div>

          {/* Price */}
          <div className="text-right">
            <p className="text-xl font-bold text-gray-900">
              {item.isTrial ? '₹0.00' : `₹${(item.price * item.registrationPeriod).toFixed(2)}`}
            </p>
            <p className="text-sm text-gray-600">
              {item.isTrial ? (
                <>Free for {item.registrationPeriod} days</>
              ) : item.itemType === 'hosting' ? (
                <>
                  ₹{item.price}
                  {item.registrationPeriod === 12 ? '/mo (Annually)' : '/mo'}
                </>
              ) : item.registrationPeriod > 1 ? (
                <>
                  ₹{item.price} × {item.registrationPeriod} years
                </>
              ) : (
                <>₹{item.price} per year</>
              )}
            </p>
            {/* Domain: multi-year benefit ── rate-lock & expiry */}
            {(!item.itemType || item.itemType === 'domain') && item.registrationPeriod > 1 && (() => {
              const expiry = new Date();
              expiry.setFullYear(expiry.getFullYear() + item.registrationPeriod);
              const expiryLabel = expiry.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              });
              return (
                <div className="mt-1.5 flex flex-col items-end gap-0.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Price locked for {item.registrationPeriod} years
                  </span>
                  <p className="text-[11px] text-emerald-700">
                    No renewal needed until {expiryLabel}
                  </p>
                </div>
              );
            })()}
            {item.itemType === 'hosting' && item.registrationPeriod === 12 && (() => {
              // Annual hosting is half the monthly rate (₹125/mo vs ₹250/mo
              // billed monthly). Surface the concrete saving so the user
              // understands what "Annual Savings Applied" actually means.
              const monthlyEquivalentYearly = item.price * 2 * 12;
              const yearlyTotal = item.price * 12;
              const saved = monthlyEquivalentYearly - yearlyTotal;
              const percent = Math.round((saved / monthlyEquivalentYearly) * 100);
              return (
                <div className="mt-1.5 flex flex-col items-end gap-0.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-50 text-green-700 border border-green-200">
                    Save {percent}%
                  </span>
                  <p className="text-[11px] text-green-700">
                    ₹{saved.toFixed(0)} off vs monthly billing
                  </p>
                  <p className="text-[10px] text-gray-400 line-through">
                    ₹{monthlyEquivalentYearly.toFixed(0)} if paid monthly
                  </p>
                </div>
              );
            })()}
          </div>

          {/* Remove */}
          <button
            onClick={() => onRemove(item.domainName, item.itemType)}
            className="p-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
            title="Remove item"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
