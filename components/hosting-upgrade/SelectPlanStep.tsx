'use client';

import { Info } from 'lucide-react';
import { formatIndianCurrency } from '@/lib/dateUtils';
import type { UpgradeInfo, EligiblePlan } from './types';

interface Props {
  upgradeInfo: UpgradeInfo;
  onSelectPlan: (plan: EligiblePlan) => void;
  onCancel: () => void;
}

/**
 * Plan-selection step. Shows the current plan summary, a warning if there's
 * an active subscription that will be cancelled, and a list of eligible
 * upgrade plans with their prorated charge.
 */
export default function SelectPlanStep({ upgradeInfo, onSelectPlan, onCancel }: Props) {
  return (
    <div className="space-y-5">
      {/* Current plan */}
      <div className="bg-paper-2 rounded-xl p-4 border border-hairline">
        <p className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-1">
          Current Plan
        </p>
        <div className="flex items-center justify-between">
          <p className="text-base font-bold text-ink">{upgradeInfo.currentPlan.name}</p>
          <p className="text-sm text-ink-2">
            {formatIndianCurrency(upgradeInfo.currentPlan.price)}
            <span className="text-xs text-ink-4">/mo</span>
          </p>
        </div>
        <p className="text-xs text-ink-3 mt-1">{upgradeInfo.remainingDays} days remaining</p>
      </div>

      {/* Subscription warning */}
      {upgradeInfo.hasSubscription && (
        <div className="flex items-start gap-2 bg-amber-soft border border-amber/30 rounded-xl p-3 text-xs text-amber-ink">
          <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <p>
            Your current subscription will be cancelled. Future renewals must be done manually at
            the new plan rate.
          </p>
        </div>
      )}

      {/* Eligible plans */}
      <div>
        <h3 className="text-sm font-semibold text-ink-2 mb-3">Choose an upgrade plan</h3>
        <div className="space-y-3">
          {upgradeInfo.eligiblePlans.map((plan) => (
            <button
              key={plan.planId}
              onClick={() => onSelectPlan(plan)}
              className="w-full text-left p-4 rounded-xl border-2 border-hairline hover:border-indigo hover:bg-indigo-soft/30 transition-all group"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-ink group-hover:text-indigo-ink">{plan.name}</p>
                  <p className="text-xs text-ink-3 mt-0.5">
                    {formatIndianCurrency(plan.price)}/mo after upgrade
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-black text-indigo-ink">
                    {formatIndianCurrency(plan.chargeAmount)}
                  </p>
                  <p className="text-xs text-ink-4">prorated for {plan.remainingDays}d</p>
                </div>
              </div>
              {plan.features.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {plan.features.slice(0, 3).map((f, i) => (
                    <span
                      key={i}
                      className="text-[10px] bg-paper-2 group-hover:bg-indigo/15 text-ink-2 group-hover:text-indigo-ink px-2 py-0.5 rounded-full"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={onCancel}
        className="w-full px-4 py-2.5 text-ink-2 font-semibold bg-paper-2 hover:bg-hairline/50 rounded-xl transition-all text-sm"
      >
        Cancel
      </button>
    </div>
  );
}
