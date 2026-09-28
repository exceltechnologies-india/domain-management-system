'use client';

import { Calendar } from 'lucide-react';

interface ExpiryBadgeProps {
  expiryDate: string | Date | null;
  onRenew?: () => void;
  className?: string;
}

type Tier = 'green' | 'yellow' | 'red';

function getTier(days: number): Tier {
  if (days > 60) return 'green';
  if (days > 14) return 'yellow';
  return 'red';
}

function getLabel(days: number, expiry: Date): string {
  if (days <= 0) return 'Expired';
  if (days > 60) {
    return `Expires ${expiry.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  if (days <= 14) return `Expires in ${days} day${days === 1 ? '' : 's'} — Renew Now`;
  return `Expires in ${days} days`;
}

const TIER_CLASSES: Record<Tier, string> = {
  green: 'bg-emerald-soft text-emerald-ink border-emerald/30',
  yellow: 'bg-amber-soft text-amber-ink border-amber/30',
  red: 'bg-rose-soft text-rose-ink border-rose/30',
};

export default function ExpiryBadge({ expiryDate, onRenew, className = '' }: ExpiryBadgeProps) {
  if (!expiryDate) return null;

  const expiry = new Date(expiryDate);
  if (isNaN(expiry.getTime())) return null;

  const days = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
  const tier = getTier(days);
  const label = getLabel(days, expiry);
  const shouldPulse = tier === 'red' && days > 0 && days <= 14;

  const baseClass = `inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${TIER_CLASSES[tier]} ${shouldPulse ? 'animate-pulse' : ''} ${className}`;

  if (onRenew) {
    return (
      <button type="button" onClick={onRenew} className={`${baseClass} cursor-pointer hover:opacity-80 transition-opacity`}>
        <Calendar className="h-3 w-3 flex-shrink-0" />
        {label}
      </button>
    );
  }

  return (
    <span className={baseClass}>
      <Calendar className="h-3 w-3 flex-shrink-0" />
      {label}
    </span>
  );
}
