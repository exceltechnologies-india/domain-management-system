'use client';

/**
 * TrialCountdownBanner — surfaces a live-updating "your trial ends in
 * X days Y hours" banner on /dashboard/hosting when a trial is within
 * 3 days of expiry.
 *
 * Why this exists (operator ask, 2026-07-02): the existing "Trial ends
 * <date>" pill in the hosting-card header is easy to miss. Trials
 * currently expire silently at day 15 — the customer's site suspends
 * and they only discover it via email (or worse, when their traffic
 * drops). This banner is a load-bearing UX nudge: prominent enough to
 * catch a scanning eye + one click to convert to paid.
 *
 * Threshold: shows within 3 days of expiryDate. Below 1 day it flips
 * to red + pulses. Auto-hides once expired (the "Pay Now to Restore"
 * button in the card header takes over at that point).
 *
 * Update cadence: every minute. Days-and-hours granularity is enough
 * — no need for second-by-second precision on a 3-day window, and a
 * 1s interval would churn the render tree unnecessarily.
 */

import { useEffect, useState } from 'react';
import { Clock, AlertCircle } from 'lucide-react';

interface TrialCountdownBannerProps {
  isTrial?: boolean;
  status?: string;
  expiryDate: string | Date | null;
  onConvert: () => void;
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

function formatRemaining(msUntil: number): { line1: string; line2: string } {
  if (msUntil <= 0) {
    return { line1: 'Your trial has ended', line2: 'Convert now to restore your hosting.' };
  }
  const days = Math.floor(msUntil / ONE_DAY_MS);
  const hours = Math.floor((msUntil % ONE_DAY_MS) / ONE_HOUR_MS);
  const minutes = Math.floor((msUntil % ONE_HOUR_MS) / ONE_MINUTE_MS);

  if (days >= 1) {
    return {
      line1: `Your free trial ends in ${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`,
      line2: 'Convert to a paid plan now to keep your hosting active — no downtime.',
    };
  }
  if (hours >= 1) {
    return {
      line1: `Your free trial ends in ${hours} hour${hours === 1 ? '' : 's'} ${minutes} min`,
      line2: 'Convert now — your hosting will be suspended when the timer hits zero.',
    };
  }
  return {
    line1: `Your free trial ends in ${minutes} minute${minutes === 1 ? '' : 's'}`,
    line2: 'Convert now — your hosting will be suspended when the timer hits zero.',
  };
}

export default function TrialCountdownBanner({
  isTrial,
  status,
  expiryDate,
  onConvert,
}: TrialCountdownBannerProps) {
  const [now, setNow] = useState(() => Date.now());

  // Re-tick every minute so days/hours/minutes stay accurate without
  // spamming the render loop. Second-level precision isn't useful over
  // a 3-day window.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ONE_MINUTE_MS);
    return () => clearInterval(id);
  }, []);

  if (!isTrial) return null;
  if (!expiryDate) return null;

  // Hide once expired — the header's "Pay Now to Restore" CTA covers
  // that state. Ditto for terminated/failed statuses (no path back).
  if (status === 'terminated' || status === 'failed') return null;

  const expiry = new Date(expiryDate);
  if (isNaN(expiry.getTime())) return null;

  const msUntil = expiry.getTime() - now;

  // Only show within the 3-day threshold. Above that, the small
  // "Trial ends <date>" pill in the header is enough.
  if (msUntil > THREE_DAYS_MS) return null;

  // If already expired, defer to the header's "expired" flow.
  if (msUntil <= 0) return null;

  const isCritical = msUntil <= ONE_DAY_MS;
  const { line1, line2 } = formatRemaining(msUntil);

  const containerClass = isCritical
    ? 'bg-red-50 border-red-300 text-red-900'
    : 'bg-amber-50 border-amber-300 text-amber-900';
  const iconClass = isCritical ? 'text-red-600' : 'text-amber-600';
  const buttonClass = isCritical
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : 'bg-amber-600 hover:bg-amber-700 text-white';

  return (
    <div
      role="alert"
      className={`px-4 sm:px-6 py-3 border-b flex flex-col sm:flex-row sm:items-center gap-3 ${containerClass}`}
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        {isCritical ? (
          <AlertCircle className={`h-5 w-5 flex-shrink-0 mt-0.5 ${iconClass}`} />
        ) : (
          <Clock className={`h-5 w-5 flex-shrink-0 mt-0.5 ${iconClass}`} />
        )}
        <div className="min-w-0">
          <div className="text-sm sm:text-base font-semibold">{line1}</div>
          <div className="text-xs sm:text-sm opacity-90 mt-0.5">{line2}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={onConvert}
        className={`flex-shrink-0 inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-semibold shadow-sm transition-colors ${buttonClass}`}
      >
        Convert to Paid Plan
      </button>
    </div>
  );
}
