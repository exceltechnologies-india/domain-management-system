'use client';

import { CheckCircle, Send, Zap } from 'lucide-react';
import { formatIndianCurrency } from '@/lib/dateUtils';
import type { UpgradeInfo, EligiblePlan } from './types';

interface Props {
  upgradeInfo: UpgradeInfo;
  selectedPlan: EligiblePlan;
  onBack: () => void;
  onRequest: () => void;
}

/**
 * Confirmation step for an upgrade REQUEST (owner decision, 25 Sep 2026):
 * the prorated figure is shown as an ESTIMATE; the price is the quote our
 * team sends. Pure presentation — parent owns onRequest.
 */
export default function ConfirmStep({
  upgradeInfo,
  selectedPlan,
  onBack,
  onRequest,
}: Props) {
  return (
    <div className="space-y-5">
      <div className="bg-indigo-soft/50 border border-indigo/30 rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="bg-indigo-soft p-2 rounded-lg">
            <Zap className="h-5 w-5 text-indigo-ink" />
          </div>
          <div>
            <p className="text-xs text-ink-3">Upgrading to</p>
            <p className="text-lg font-bold text-ink">{selectedPlan.name}</p>
          </div>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between text-ink-2">
            <span>From</span>
            <span className="font-medium">{upgradeInfo.currentPlan.name}</span>
          </div>
          <div className="flex justify-between text-ink-2">
            <span>Remaining days</span>
            <span className="font-medium">{upgradeInfo.remainingDays} days</span>
          </div>
          <div className="flex justify-between text-ink font-bold text-base border-t border-indigo/30 pt-2 mt-2">
            <span>Estimated charge</span>
            <span className="text-indigo-ink">{formatIndianCurrency(selectedPlan.chargeAmount)}</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-ink-3">
        This is an estimate for the days left on your plan, including GST. The amount you pay is the one on the
        quote our team sends you.
      </p>

      <div className="bg-paper-2 rounded-xl p-4 space-y-1.5">
        <div className="flex items-center text-xs text-ink-2">
          <CheckCircle className="h-3.5 w-3.5 mr-2 text-emerald" />
          Our team emails you a quote to pay
        </div>
        <div className="flex items-center text-xs text-ink-2">
          <CheckCircle className="h-3.5 w-3.5 mr-2 text-emerald" />
          Your plan changes once the quote is paid — nothing is charged now
        </div>
      </div>

      <div className="flex gap-3 pt-1">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-3 text-ink-2 font-semibold bg-paper-2 hover:bg-hairline/50 rounded-xl transition-all"
        >
          Back
        </button>
        <button
          onClick={onRequest}
          className="flex-[2] px-6 py-3 bg-primary-600 hover:bg-primary-700 text-paper font-bold rounded-xl shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
        >
          <Send className="h-4 w-4" />
          Request upgrade
        </button>
      </div>
    </div>
  );
}
