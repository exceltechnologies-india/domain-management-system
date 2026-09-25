'use client';

/**
 * Buy hosting from inside the customer panel.
 *
 * Replaces the `/hosting` marketing page for customers who are already signed
 * in (owner decision, 24 Sep 2026): the plan cards and the trial button, and
 * nothing else.
 *
 * A PAID plan no longer goes into DMS's cart (owner decision 30, 25 Sep 2026:
 * ResellerOS creates every Razorpay order). "Buy" opens PanelCheckout, which
 * asks ResellerOS for the order and opens Razorpay with ResellerOS's key; DMS
 * creates no order and issues no bill. The ₹0 free TRIAL still goes through
 * DMS's cart: ResellerOS's panel-order refuses trials, because DMS starts its
 * in-panel trial itself, and a trial takes no payment.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Check } from 'lucide-react';
import Modal from '@/components/Modal';
import PanelCheckout, { type PanelPurchaseChoice } from '@/components/purchase/PanelCheckout';
import { useCartStore } from '@/store/cartStore';
import { HOSTING_PLANS, type HostingPlanConfig } from '@/config/hosting-plans';
import {
  buildTrialCartItem,
  chargeFor,
  type BillingCycle,
} from '@/lib/purchase/hosting-cart-item';
import { isTrialPlan } from '@/lib/pricing/trial-plan';
import { getDeviceFingerprint } from '@/lib/device-fingerprint';
import { apiClient } from '@/lib/api-client';
import { trackStartTrial } from '@/lib/journey';

interface BuyHostingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** The plans ResellerOS's panel-order prices, or null for anything else. */
function sellablePlanId(id: string): 'starter' | 'standard' | 'plus' | null {
  return id === 'starter' || id === 'standard' || id === 'plus' ? id : null;
}

// Whole rupees: ResellerOS's hosting prices are whole-rupee figures.
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function BuyHostingModal({ isOpen, onClose }: BuyHostingModalProps) {
  const router = useRouter();
  const { addItem } = useCartStore();
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const [checkingTrial, setCheckingTrial] = useState(false);
  const [checkout, setCheckout] = useState<PanelPurchaseChoice | null>(null);

  const close = () => {
    setCheckout(null);
    onClose();
  };

  const choose = (plan: HostingPlanConfig) => {
    const planId = sellablePlanId(plan.id);
    if (!planId) {
      // ResellerOS sells these three; anything else has no price to charge.
      toast.error(`${plan.name} can't be bought online. Nothing was charged. Please contact support.`);
      return;
    }
    setCheckout({
      kind: 'hosting',
      planId,
      cycle,
      label: `${plan.name} hosting, ${cycle === 'yearly' ? '1 year' : '1 month'}`,
    });
  };

  const startTrial = async (plan: HostingPlanConfig) => {
    trackStartTrial();
    setCheckingTrial(true);
    try {
      const deviceFingerprint = await getDeviceFingerprint().catch(() => '');
      const result = await apiClient.post<{ eligible?: boolean; reason?: string }>(
        '/api/v1/user/hosting/trial-eligibility',
        { planId: plan.id, deviceFingerprint }
      );
      if (!result.ok) {
        toast.error('Could not check whether you can start a free trial. Please try again.');
        return;
      }
      if (!result.data.eligible) {
        toast.error(result.data.reason || 'You are not eligible for a free trial.');
        return;
      }
      addItem(buildTrialCartItem(plan, cycle));
      toast.success(`${plan.name} free trial added — ₹0 today, then billed ${cycle === 'monthly' ? 'monthly' : 'yearly'} after 15 days.`);
      router.push('/cart');
    } finally {
      setCheckingTrial(false);
    }
  };

  if (checkout) {
    return (
      <Modal isOpen={isOpen} onClose={close} title="Buy hosting" size="lg">
        <PanelCheckout choice={checkout} onBack={() => setCheckout(null)} onClose={close} />
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={close} title="Buy hosting" size="xl">
      <div className="flex justify-center mb-5">
        <div role="group" aria-label="Billing cycle" className="inline-flex rounded-lg border border-hairline bg-paper-2 p-1">
          {(['yearly', 'monthly'] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cycle === c}
              onClick={() => setCycle(c)}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                cycle === c ? 'bg-paper text-ink shadow-sm' : 'text-ink-3 hover:text-ink'
              }`}
            >
              {c === 'yearly' ? 'Yearly · save 50%' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Object.values(HOSTING_PLANS).map((plan) => {
          const charge = chargeFor(plan, cycle);
          const per = cycle === 'yearly' ? 'year' : 'month';
          return (
            <div
              key={plan.id}
              className={`flex flex-col rounded-xl border p-4 ${plan.isPopular ? 'border-amber' : 'border-hairline'}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="font-serif text-lg text-ink">{plan.name}</h4>
                {plan.isPopular && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-ink bg-amber-soft px-2 py-0.5 rounded-full">
                    Popular
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-3 mb-3">{plan.description}</p>
              <p className="text-2xl font-semibold text-ink">
                {inr(charge.exGst)}
                <span className="text-sm font-normal text-ink-3">/{per} + GST</span>
              </p>
              <p className="text-xs text-ink-3 mb-3">
                {`${inr(charge.inclGst)} a ${per} including 18% GST (${inr(charge.gst)})`}
              </p>
              <ul className="space-y-1 mb-4 flex-1">
                {plan.features.slice(0, 5).map((f) => (
                  <li key={f} className="flex items-start gap-1.5 text-xs text-ink-2">
                    <Check className="h-3.5 w-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => choose(plan)}
                className="w-full px-4 py-2 text-sm font-semibold text-paper bg-amber rounded-lg hover:brightness-90 transition-colors"
              >
                Buy {plan.name}
              </button>
              {/* Starter only, on monthly AND yearly (owner, 24 Sep 2026). The
                  server re-checks both: lib/pricing/trial-plan.ts. */}
              {isTrialPlan(plan.id) && (
                <button
                  type="button"
                  disabled={checkingTrial}
                  onClick={() => void startTrial(plan)}
                  className="mt-2 w-full px-4 py-2 text-sm font-medium text-ink-2 border border-hairline rounded-lg hover:bg-paper-2 disabled:opacity-50 transition-colors"
                >
                  {checkingTrial ? 'Checking…' : 'Start 15-day free trial'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Prices are ResellerOS's, GST added on top — owner decision,
          24 Sep 2026 ("ResellerOS is correct price one"). Figures come from
          lib/pricing/hosting-price.ts, the same function create-order uses
          to charge, so the dialog and the charge cannot disagree. */}
      <p className="mt-4 text-xs text-ink-3 text-center">
        Yearly plans carry a 30-day money-back guarantee.
      </p>
    </Modal>
  );
}
