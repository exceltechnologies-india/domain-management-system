'use client';

import { useState, useEffect } from 'react';
import { X, ArrowUp, CreditCard, AlertTriangle, CheckCircle, RefreshCw, ShieldCheck, Zap, Info } from 'lucide-react';
import { formatIndianCurrency } from '@/lib/dateUtils';
import { toast } from 'react-hot-toast';
import { safeLocalStorage, safeSessionStorage } from '@/lib/storage';
import { useRouter } from 'next/navigation';

interface EligiblePlan {
  planId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  features: string[];
  quota: number;
  bandwidth: number;
  chargeAmount: number;
  remainingDays: number;
}

interface UpgradeInfo {
  currentPlan: { planId: string; name: string; price: number };
  eligiblePlans: EligiblePlan[];
  remainingDays: number;
  hasSubscription: boolean;
  expiryDate: string;
}

interface HostingUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  domainName: string;
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

type ModalStep = 'loading' | 'select' | 'confirm' | 'paying' | 'verifying' | 'success' | 'error';

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

  useEffect(() => {
    if (isOpen) {
      setStep('loading');
      setSelectedPlan(null);
      setErrorMessage('');
      loadUpgradeInfo();
      loadRazorpayScript();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, domainName]);

  const loadRazorpayScript = () => {
    if (window.Razorpay) return;
    const script = document.createElement('script');
    // SRI not applied — see comment in HostingRenewalModal.tsx.
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
  };

  const loadUpgradeInfo = async () => {
    try {
      const token = safeLocalStorage.getItem('token');
      const response = await fetch(
        `/api/user/hosting/upgrade-info?domainName=${encodeURIComponent(domainName)}`,
        { headers: { Authorization: `Bearer ${token}` } }
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
      const token = safeLocalStorage.getItem('token');

      const orderRes = await fetch('/api/user/hosting/upgrade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ domainName, targetPlanId: selectedPlan.planId }),
      });

      const orderJson = await orderRes.json();
      if (!orderRes.ok) {
        throw new Error(orderJson.error || 'Failed to create upgrade order');
      }

      const { razorpayOrderId, amount, currency } = orderJson.data;

      const userRaw = safeLocalStorage.getItem('user');
      const userEmail = userRaw ? JSON.parse(userRaw).email : '';

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: amount * 100,
        currency,
        name: 'AnuTech Hosting',
        description: `Upgrade to ${selectedPlan.name} for ${domainName}`,
        order_id: razorpayOrderId,
        handler: async function (paymentResponse: any) {
          setStep('verifying');
          try {
            const verifyRes = await fetch('/api/payments/verify', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
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
          } catch (err: any) {
            setErrorMessage(err.message || 'Verification failed. Please contact support.');
            setStep('error');
          }
        },
        prefill: { email: userEmail },
        theme: { color: '#2563eb' },
        modal: {
          ondismiss: () => {
            // Return to confirm step so user can retry
            setStep('confirm');
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to initiate payment');
      setStep('error');
    }
  };

  if (!isOpen) return null;

  return (
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
          {/* Loading */}
          {step === 'loading' && (
            <div className="flex flex-col items-center justify-center py-12">
              <RefreshCw className="h-10 w-10 animate-spin text-blue-600 mb-4" />
              <p className="text-gray-600 font-medium">Loading upgrade options...</p>
            </div>
          )}

          {/* Verifying */}
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

          {/* Select Plan */}
          {step === 'select' && upgradeInfo && (
            <div className="space-y-5">
              {/* Current plan */}
              <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Current Plan</p>
                <div className="flex items-center justify-between">
                  <p className="text-base font-bold text-gray-900">{upgradeInfo.currentPlan.name}</p>
                  <p className="text-sm text-gray-600">{formatIndianCurrency(upgradeInfo.currentPlan.price)}<span className="text-xs text-gray-400">/mo</span></p>
                </div>
                <p className="text-xs text-gray-500 mt-1">{upgradeInfo.remainingDays} days remaining</p>
              </div>

              {/* Subscription warning */}
              {upgradeInfo.hasSubscription && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                  <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <p>Your current subscription will be cancelled. Future renewals must be done manually at the new plan rate.</p>
                </div>
              )}

              {/* Eligible plans */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Choose an upgrade plan</h3>
                <div className="space-y-3">
                  {upgradeInfo.eligiblePlans.map((plan) => (
                    <button
                      key={plan.planId}
                      onClick={() => handleSelectPlan(plan)}
                      className="w-full text-left p-4 rounded-xl border-2 border-gray-200 hover:border-blue-500 hover:bg-blue-50/30 transition-all group"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-bold text-gray-900 group-hover:text-blue-700">{plan.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{formatIndianCurrency(plan.price)}/mo after upgrade</p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg font-black text-blue-600">{formatIndianCurrency(plan.chargeAmount)}</p>
                          <p className="text-xs text-gray-400">prorated for {plan.remainingDays}d</p>
                        </div>
                      </div>
                      {plan.features.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {plan.features.slice(0, 3).map((f, i) => (
                            <span key={i} className="text-[10px] bg-gray-100 group-hover:bg-blue-100 text-gray-600 group-hover:text-blue-700 px-2 py-0.5 rounded-full">{f}</span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <button onClick={onClose} className="w-full px-4 py-2.5 text-gray-600 font-semibold bg-gray-100 hover:bg-gray-200 rounded-xl transition-all text-sm">
                Cancel
              </button>
            </div>
          )}

          {/* Confirm */}
          {step === 'confirm' && selectedPlan && upgradeInfo && (
            <div className="space-y-5">
              <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="bg-blue-100 p-2 rounded-lg">
                    <Zap className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Upgrading to</p>
                    <p className="text-lg font-bold text-gray-900">{selectedPlan.name}</p>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between text-gray-600">
                    <span>From</span>
                    <span className="font-medium">{upgradeInfo.currentPlan.name}</span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Remaining days</span>
                    <span className="font-medium">{upgradeInfo.remainingDays} days</span>
                  </div>
                  <div className="flex justify-between text-gray-900 font-bold text-base border-t border-blue-200 pt-2 mt-2">
                    <span>Prorated charge</span>
                    <span className="text-blue-700">{formatIndianCurrency(selectedPlan.chargeAmount)}</span>
                  </div>
                </div>
              </div>

              {upgradeInfo.hasSubscription && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <p>Your active subscription will be cancelled immediately. You will be billed manually for renewals.</p>
                </div>
              )}

              <div className="bg-gray-50 rounded-xl p-4 space-y-1.5">
                <div className="flex items-center text-xs text-gray-600">
                  <CheckCircle className="h-3.5 w-3.5 mr-2 text-green-500" />
                  Plan change applied instantly on server
                </div>
                <div className="flex items-center text-xs text-gray-600">
                  <CheckCircle className="h-3.5 w-3.5 mr-2 text-green-500" />
                  Billing continues at new plan rate on renewal
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => setStep('select')}
                  className="flex-1 px-4 py-3 text-gray-600 font-semibold bg-gray-100 hover:bg-gray-200 rounded-xl transition-all"
                >
                  Back
                </button>
                <button
                  onClick={handlePayment}
                  className="flex-[2] px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
                >
                  <CreditCard className="h-4 w-4" />
                  Pay {formatIndianCurrency(selectedPlan.chargeAmount)}
                </button>
              </div>
            </div>
          )}

          {/* Paying (Razorpay open) */}
          {step === 'paying' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <RefreshCw className="h-10 w-10 animate-spin text-blue-600 mb-4" />
              <h3 className="text-lg font-bold text-gray-900">Opening Payment Window</h3>
              <p className="text-gray-500 mt-2 text-sm">Complete the payment in the Razorpay window.</p>
            </div>
          )}

          {/* Error */}
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
                    loadUpgradeInfo();
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
  );
}
