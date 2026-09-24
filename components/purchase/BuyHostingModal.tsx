'use client';

/**
 * Buy hosting from inside the customer panel.
 *
 * Replaces the `/hosting` marketing page for customers who are already signed
 * in (owner decision, 24 Sep 2026): the plan cards and the trial button, and
 * nothing else. The cart lines come from `lib/purchase/hosting-cart-item.ts`,
 * which is the old page's logic moved verbatim, so checkout sees no change.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Check } from 'lucide-react';
import Modal from '@/components/Modal';
import { useCartStore } from '@/store/cartStore';
import { HOSTING_PLANS, type HostingPlanConfig } from '@/config/hosting-plans';
import {
  buildHostingCartItem,
  buildTrialCartItem,
  displayRate,
  monthlyRate,
  type BillingCycle,
} from '@/lib/purchase/hosting-cart-item';
import { getDeviceFingerprint } from '@/lib/device-fingerprint';
import { apiClient } from '@/lib/api-client';
import { trackStartTrial } from '@/lib/journey';

interface BuyHostingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BuyHostingModal({ isOpen, onClose }: BuyHostingModalProps) {
  const router = useRouter();
  const { addItem, items: cartItems } = useCartStore();
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const [checkingTrial, setCheckingTrial] = useState(false);

  const choose = (plan: HostingPlanConfig) => {
    addItem(buildHostingCartItem(plan, cycle, cartItems));
    toast.success(`${plan.name} hosting added to cart`);
    router.push('/cart');
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
      addItem(buildTrialCartItem(plan));
      toast.success(`${plan.name} free trial added — ₹0 today, then billed yearly after 15 days.`);
      router.push('/cart');
    } finally {
      setCheckingTrial(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Buy hosting" size="xl">
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
          const rate = displayRate(plan, cycle);
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
                {inr(rate)}
                <span className="text-sm font-normal text-ink-3">/mo</span>
              </p>
              <p className="text-xs text-ink-3 mb-3">
                {cycle === 'yearly'
                  ? `Billed ${inr(rate * 12)} a year · ${inr(monthlyRate(plan))}/mo on monthly billing`
                  : 'Billed every month'}
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
                Add to cart
              </button>
              {cycle === 'yearly' && plan.id === 'starter' && (
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

      {/* No GST sentence here, deliberately. DMS's cart treats these figures
          as GST-INCLUSIVE (CartOrderSummary: subtotal = total / 1.18) while
          ResellerOS adds 18% on top of the same figure — ₹600 vs ₹708 for a
          Starter year. Which is right is an open owner question (ResellerOS
          Todos.md §0A); asserting either here would be guessing. */}
      <p className="mt-4 text-xs text-ink-3 text-center">
        Yearly plans carry a 30-day money-back guarantee.
      </p>
    </Modal>
  );
}
