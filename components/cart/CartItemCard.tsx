'use client';

import { Globe, Trash2, CheckCircle, AlertTriangle, Server } from 'lucide-react';
import { CartItem } from '@/lib/types';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';
import { domainLineTotal, domainYearsOf, pricedDomainTermOptions } from '@/lib/reselleros/domain-terms';
import { useHostingPrices } from '@/hooks/useHostingPrices';
import { planPrice } from '@/lib/pricing/hosting-price';

interface CartItemCardProps {
  item: CartItem;
  onRemove: (domainName: string, itemType?: string) => void;
  onPeriodChange: (
    domainName: string,
    period: number,
    itemType?: string,
    unit?: 'months' | 'minutes' | 'years' | 'days'
  ) => void;
  /** What ResellerOS charges for this domain per term, before GST; null/absent while unknown. */
  termTotals?: Record<string, number> | null;
  /** A yearly hosting plan is in the cart, so ResellerOS makes this domain's first year free. */
  bundled?: boolean;
}

export default function CartItemCard({ item, onRemove, onPeriodChange, termTotals, bundled = false }: CartItemCardProps) {
  const hostingPrices = useHostingPrices();
  /* What 12 months of this plan cost billed monthly, GST included — ResellerOS's real monthly
     price, for the "Save N%" badge. It used to assume monthly = 2 × the yearly rate, which is
     only true for some plans (Plus: ₹5,300 shown, ₹5,292 real). Null while unknown → no badge. */
  const monthlyForAYear = (() => {
    if (item.itemType !== 'hosting' || hostingPrices.state !== 'ok') return null;
    const plan = planPrice(hostingPrices.table, item.hostingPlan?.id ?? item.hostingPlan?.name);
    return plan ? Math.round(plan.monthly.inclGst * 12 * 100) / 100 : null;
  })();
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
    // A domain: only the terms ResellerOS sells (1, 2, 3, 5 years — lib/reselleros/domain-terms.ts).
    if (item.itemType !== 'hosting') {
      // Narrowed to the terms ResellerOS has a price for, keeping the chosen one so the box never
      // shows a term the customer did not pick.
      const options = pricedDomainTermOptions(minPeriod, termTotals);
      const chosen = domainYearsOf(item);
      return options.includes(chosen) ? options : [...options, chosen].sort((a, b) => a - b);
    }
    const start = 1;
    return Array.from({ length: 11 - start }, (_, i) => start + i);
  })();

  const isBillingCycleLocked =
    item.itemType === 'hosting' &&
    (item.billingCycle === 'yearly' || item.billingCycle === 'monthly');

  const isHostingItem = item.itemType === 'hosting';

  return (
    <div className="p-4 sm:p-5 bg-paper border border-hairline rounded-xl hover:border-primary-200 hover:shadow-sm transition-all duration-200">
      {/* Single responsive layout: stacked on mobile, side-by-side on lg */}
      <div className="flex flex-col lg:flex-row lg:items-start gap-4">

        {/* Left: icon + info + tags */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className={`p-2 rounded-lg flex-shrink-0 ${isHostingItem ? 'bg-indigo-soft' : 'bg-primary-50'}`}>
            {isHostingItem
              ? <Server className="h-4 w-4 lg:h-5 lg:w-5 text-indigo-ink" />
              : <Globe className="h-4 w-4 lg:h-5 lg:w-5 text-primary-600" />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base lg:text-lg font-medium text-ink truncate">
              {displayName}
            </h3>
            <p className="text-xs lg:text-sm text-ink-2">{periodLabel}</p>
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
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-rose-soft text-rose-ink animate-pulse">
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
            {/* The period control is conditional (static div for trial/locked,
                select otherwise) — use a span so the label isn't tied to a
                sometimes-absent control. */}
            <span className="text-xs sm:text-sm font-medium text-ink-2">
              Registration Period:
            </span>
            {item.isTrial ? (
              <div className="px-4 py-2 border border-hairline rounded-md text-sm bg-amber-soft text-amber-ink font-medium sm:min-w-[100px] text-center">
                {item.registrationPeriod} Days
              </div>
            ) : isBillingCycleLocked ? (
              <div className="px-4 py-2 border border-hairline rounded-md text-sm bg-paper-2 text-ink-2 font-medium sm:min-w-[100px] text-center">
                {item.billingCycle === 'yearly' ? '1 Year' : '1 Month'}
              </div>
            ) : (
              <select
                value={item.itemType === 'hosting' ? item.registrationPeriod : domainYearsOf(item)}
                onChange={(e) =>
                  onPeriodChange(
                    item.domainName,
                    parseInt(e.target.value),
                    item.itemType,
                    // A domain's options are years; saving them as "months" made 3 years read as
                    // 3 months once the term was sent to ResellerOS (9 Oct 2026).
                    item.itemType === 'hosting' ? 'months' : 'years'
                  )
                }
                className="px-3 py-2 border border-hairline rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-paper"
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
              <p className="text-xs text-amber-ink">
                .{tldLabel} requires min {minPeriod} year registration
              </p>
            )}
          </div>

          {/* Price */}
          <div className="text-right">
            <p className="text-xl font-bold text-ink">
              {item.isTrial
                ? '₹0.00'
                : item.itemType === 'hosting'
                  ? `₹${(item.price * item.registrationPeriod).toFixed(2)}`
                  : `₹${domainLineTotal(item, termTotals, bundled).toFixed(2)}`}
            </p>
            <p className="text-sm text-ink-2">
              {item.isTrial ? (
                <>Free for {item.registrationPeriod} days</>
              ) : item.itemType === 'hosting' ? (
                <>
                  ₹{item.price}
                  {item.registrationPeriod === 12 ? '/mo (Annually)' : '/mo'}
                </>
              ) : (
                // ResellerOS's price for this term, plus 18% GST — what the payment window charges.
                <>
                  {domainYearsOf(item) > 1 ? `${domainYearsOf(item)} years` : '1 year'} · incl. 18% GST
                  {bundled && <span className="block text-emerald-ink">First year free with yearly hosting</span>}
                </>
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
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-soft text-emerald-ink border border-emerald/30">
                    Price locked for {item.registrationPeriod} years
                  </span>
                  <p className="text-[11px] text-emerald-ink">
                    No renewal needed until {expiryLabel}
                  </p>
                </div>
              );
            })()}
            {item.itemType === 'hosting' && item.registrationPeriod === 12 && monthlyForAYear !== null && (() => {
              // The concrete saving of paying yearly, against ResellerOS's real monthly price.
              const monthlyEquivalentYearly = monthlyForAYear;
              const yearlyTotal = item.price * 12;
              const saved = monthlyEquivalentYearly - yearlyTotal;
              if (saved <= 0) return null;
              const percent = Math.round((saved / monthlyEquivalentYearly) * 100);
              return (
                <div className="mt-1.5 flex flex-col items-end gap-0.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-soft text-emerald-ink border border-emerald/30">
                    Save {percent}%
                  </span>
                  <p className="text-[11px] text-emerald-ink">
                    ₹{saved.toFixed(0)} off vs monthly billing
                  </p>
                  <p className="text-[10px] text-ink-4 line-through">
                    ₹{monthlyEquivalentYearly.toFixed(0)} if paid monthly
                  </p>
                </div>
              );
            })()}
          </div>

          {/* Remove */}
          <button
            onClick={() => onRemove(item.domainName, item.itemType)}
            className="p-2 text-rose-ink hover:text-rose-ink hover:bg-rose/15 rounded-lg transition-colors flex-shrink-0"
            title="Remove item"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
