'use client';

import { useState, useEffect } from 'react';
import { X, ArrowUp, AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { safeSessionStorage } from '@/lib/storage';
import { useRouter } from 'next/navigation';
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';
import SelectPlanStep from './hosting-upgrade/SelectPlanStep';
import ConfirmStep from './hosting-upgrade/ConfirmStep';
import type {
  EligiblePlan,
  UpgradeInfo,
  ModalStep,
} from './hosting-upgrade/types';

interface HostingUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  domainName: string;
}

export default function HostingUpgradeModal({
  isOpen,
  onClose,
  domainName,
}: HostingUpgradeModalProps) {
  const [step, setStep] = useState<ModalStep>('loading');
  const [upgradeInfo, setUpgradeInfo] = useState<UpgradeInfo | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<EligiblePlan | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const router = useRouter();
  const { data: session } = useSession();
  // Razorpay checkout is loaded inside an isolated iframe (see
  // components/RazorpayCheckoutFrame.tsx) so this page can keep a strict CSP
  // without the eval-using checkout.js script.
  const razorpay = useRazorpayCheckout();

  useEffect(() => {
    if (isOpen) {
      setStep('loading');
      setSelectedPlan(null);
      setErrorMessage('');
      void loadUpgradeInfo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, domainName]);

  const loadUpgradeInfo = async () => {
    try {
      const response = await fetch(
        `/api/v1/user/hosting/upgrade-info?domainName=${encodeURIComponent(domainName)}`,
        { credentials: 'include' }
      );
      const json = await response.json();
      if (!response.ok) {
        setErrorMessage(json.error || 'Failed to load upgrade options');
        setStep('error');
        return;
      }
      const info: UpgradeInfo = json.data;
      setUpgradeInfo(info);
      if (info.eligiblePlans.length === 0) {
        setErrorMessage('You are already on the highest available plan.');
        setStep('error');
      } else {
        setStep('select');
      }
    } catch {
      setErrorMessage('Failed to load upgrade options. Please try again.');
      setStep('error');
    }
  };

  const handleSelectPlan = (plan: EligiblePlan) => {
    setSelectedPlan(plan);
    setStep('confirm');
  };

  const handlePayment = async () => {
    if (!selectedPlan || !upgradeInfo) return;
    setStep('paying');

    try {
      // 1. Create the Razorpay order via our backend.
      const orderRes = await fetch('/api/v1/user/hosting/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ domainName, targetPlanId: selectedPlan.planId }),
      });

      const orderJson = await orderRes.json();
      if (!orderRes.ok) {
        throw new Error(orderJson.error || 'Failed to create upgrade order');
      }

      const { razorpayOrderId, amount, currency } = orderJson.data;
      const userEmail = session?.user?.email || '';

      // 2. Open Razorpay Checkout inside the isolated iframe.
      let paymentResponse;
      try {
        paymentResponse = await razorpay.open({
          key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
          amount: amount * 100,
          currency,
          name: 'AnuTech Hosting',
          description: `Upgrade to ${selectedPlan.name} for ${domainName}`,
          order_id: razorpayOrderId,
          prefill: { email: userEmail },
          theme: { color: '#0177E1' },
        });
      } catch (err: unknown) {
        // The iframe-checkout helper throws a tagged `{ kind: 'dismissed' }`
        // when the user closes the modal — handle that as a soft cancel.
        const tagged = err as { kind?: string; message?: string };
        if (tagged?.kind === 'dismissed') {
          setStep('confirm');
          return;
        }
        setErrorMessage(tagged?.message || (err instanceof Error ? err.message : 'Payment was not completed'));
        setStep('error');
        return;
      }

      // 3. Verify Payment
      setStep('verifying');
      const verifyRes = await fetch('/api/v1/payments/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          razorpay_order_id: paymentResponse.razorpay_order_id,
          razorpay_payment_id: paymentResponse.razorpay_payment_id,
          razorpay_signature: paymentResponse.razorpay_signature,
          cartItems: [{
            itemType: 'hosting',
            domainName,
            price: amount,
            registrationPeriod: 1,
            periodUnit: 'months',
            currency: 'INR',
          }],
        }),
      });

      const verifyJson = await verifyRes.json();
      if (verifyRes.ok && verifyJson.success) {
        safeSessionStorage.setItem('paymentResult', JSON.stringify({
          status: 'success',
          message: `Your hosting has been upgraded to ${selectedPlan.name} successfully.`,
          orderId: verifyJson.orderId,
          timestamp: Date.now(),
        }));
        setStep('success');
        setTimeout(() => {
          onClose();
          router.push('/payment-success');
        }, 2500);
      } else {
        throw new Error(verifyJson.error || 'Payment verification failed');
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to initiate payment');
      setStep('error');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <razorpay.Frame />
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200">
          {/* Header */}
          <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
            <div>
              <h2 className="text-xl font-bold text-gray-900 flex items-center">
                <ArrowUp className="h-5 w-5 mr-2 text-blue-600" />
                Upgrade Hosting Plan
              </h2>
              <p className="text-sm text-gray-500 mt-1">{domainName}</p>
            </div>
            {step !== 'paying' && step !== 'verifying' && (
              <button
                onClick={onClose}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>

          {/* Content */}
          <div className="p-6">
            {step === 'loading' && (
              <div className="flex flex-col items-center justify-center py-12">
                <RefreshCw className="h-10 w-10 animate-spin text-blue-600 mb-4" />
                <p className="text-gray-600 font-medium">Loading upgrade options...</p>
              </div>
            )}

            {step === 'verifying' && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="relative mb-6">
                  <div className="h-20 w-20 rounded-full border-4 border-blue-50 border-t-blue-600 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <ShieldCheck className="h-8 w-8 text-blue-600" />
                  </div>
                </div>
                <h3 className="text-lg font-bold text-gray-900">Verifying Payment</h3>
                <p className="text-gray-500 mt-2">Upgrading your plan on the server. Please do not close this window.</p>
              </div>
            )}

            {step === 'select' && upgradeInfo && (
              <SelectPlanStep
                upgradeInfo={upgradeInfo}
                onSelectPlan={handleSelectPlan}
                onCancel={onClose}
              />
            )}

            {step === 'confirm' && selectedPlan && upgradeInfo && (
              <ConfirmStep
                upgradeInfo={upgradeInfo}
                selectedPlan={selectedPlan}
                onBack={() => setStep('select')}
                onPay={handlePayment}
              />
            )}

            {step === 'paying' && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <RefreshCw className="h-10 w-10 animate-spin text-blue-600 mb-4" />
                <h3 className="text-lg font-bold text-gray-900">Opening Payment Window</h3>
                <p className="text-gray-500 mt-2 text-sm">Complete the payment in the Razorpay window.</p>
              </div>
            )}

            {step === 'error' && (
              <div className="text-center py-8">
                <div className="bg-red-100 rounded-full h-14 w-14 flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="h-7 w-7 text-red-600" />
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">Something went wrong</h3>
                <p className="text-gray-500 text-sm mb-6">{errorMessage}</p>
                <div className="flex gap-3 justify-center">
                  <button onClick={onClose} className="px-4 py-2 text-gray-600 font-semibold bg-gray-100 hover:bg-gray-200 rounded-xl transition-all text-sm">
                    Close
                  </button>
                  <button
                    onClick={() => {
                      setStep('loading');
                      setErrorMessage('');
                      void loadUpgradeInfo();
                    }}
                    className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition-all text-sm"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
