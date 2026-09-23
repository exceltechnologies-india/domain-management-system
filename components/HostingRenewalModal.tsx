'use client';

import { useState, useEffect } from 'react';
import { X, Calendar, CreditCard, AlertTriangle, CheckCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatIndianDate, formatIndianCurrency } from '@/lib/dateUtils';
import { toast } from 'react-hot-toast';
import { useSession } from 'next-auth/react';
import { safeSessionStorage } from '@/lib/storage';
import { useRouter } from 'next/navigation';
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';
import { razorpayThemeColor } from '@/lib/theme-color';

interface HostingRenewalModalProps {
  isOpen: boolean;
  onClose: () => void;
  domainName: string;
}

interface RenewalInfo {
  domainName: string;
  currentStatus: string;
  currentExpiry: string;
  planName: string;
  renewalPricing: {
    price: number;
    currency: string;
    periodMonths: number;
    periodYears: number;
  };
}

export default function HostingRenewalModal({
  isOpen,
  onClose,
  domainName
}: HostingRenewalModalProps) {
  const [renewalInfo, setRenewalInfo] = useState<RenewalInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const router = useRouter();
  const { data: session } = useSession();
  // Razorpay checkout is loaded inside an isolated iframe (see
  // components/RazorpayCheckoutFrame.tsx) so this page can keep a strict CSP
  // without the eval-using checkout.js script.
  const razorpay = useRazorpayCheckout();

  useEffect(() => {
    if (isOpen) {
      void loadRenewalInfo();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, domainName]);

  const loadRenewalInfo = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/user/hosting/renew-info?domainName=${encodeURIComponent(domainName)}`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setRenewalInfo(data.data);
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to load renewal info');
        onClose();
      }
    } catch (error) {
      toast.error('Failed to load renewal info');
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  const handleRenewal = async () => {
    if (!renewalInfo) return;

    setIsProcessing(true);
    try {
      // 1. Initiate renewal in backend to get Razorpay Order ID
      const response = await fetch('/api/v1/user/hosting/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ domainName }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to initiate renewal');
      }

      const { data } = await response.json();

      // 2. Open Razorpay Checkout inside the isolated iframe.
      let paymentResponse;
      try {
        paymentResponse = await razorpay.open({
          key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
          amount: data.amount * 100, // Not strictly required if order_id is present, but good practice
          currency: data.currency,
          name: 'AnuTech Hosting',
          description: `Renewal for ${domainName} (1 Year)`,
          order_id: data.razorpayOrderId,
          prefill: { email: session?.user?.email || '' },
          theme: { color: razorpayThemeColor() }
        });
      } catch (err: unknown) {
        // User dismissed the modal, or the iframe reported an error.
        const tagged = err as { kind?: string; message?: string };
        if (tagged?.kind === 'dismissed') {
          setIsProcessing(false);
          return;
        }
        toast.error(tagged?.message || (err instanceof Error ? err.message : 'Payment was not completed'));
        setIsProcessing(false);
        return;
      }

      // 3. Verify Payment
      setIsVerifying(true);
      try {
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
                domainName: domainName,
                price: renewalInfo.renewalPricing.price / 12, // Monthly price for verification logic
                registrationPeriod: 12,
                periodUnit: 'months'
            }]
          }),
        });

        if (verifyRes.ok) {
          await verifyRes.json();
          toast.success('Hosting renewed successfully!');

          // Store result for success page if needed
          safeSessionStorage.setItem('paymentResult', JSON.stringify({
            status: 'success',
            message: 'Your hosting has been renewed successfully.',
            orderId: data.orderId,
            timestamp: Date.now()
          }));

          onClose();
          router.push('/payment-success');
        } else {
          const error = await verifyRes.json();
          toast.error(error.error || 'Payment verification failed');
        }
      } catch (err) {
        toast.error('Verification failed. Please contact support.');
      } finally {
        setIsVerifying(false);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to process renewal');
      setIsProcessing(false);
    }
  };

  const getDaysUntilExpiry = (dateString: string) => {
    if (!dateString) return 0;
    const expiry = new Date(dateString);
    const now = new Date();
    const diffTime = expiry.getTime() - now.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  if (!isOpen) return null;

  const daysUntilExpiry = renewalInfo ? getDaysUntilExpiry(renewalInfo.currentExpiry) : 0;
  const isExpiringSoon = daysUntilExpiry <= 30;

  return (
    <>
    <razorpay.Frame />
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
      <div className="bg-paper rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200">
        {/* Header */}
        <div className="p-6 border-b border-hairline flex items-center justify-between bg-paper-2/50">
          <div>
            <h2 className="text-xl font-bold text-ink flex items-center">
              <RefreshCw className="h-5 w-5 mr-2 text-indigo-ink" />
              Service Renewal
            </h2>
            <p className="text-sm text-ink-3 mt-1">{domainName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-ink-4 hover:text-ink-2 hover:bg-paper-2 rounded-full transition-all"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <RefreshCw className="h-10 w-10 animate-spin text-indigo-ink mb-4" />
              <p className="text-ink-2 font-medium">Loading renewal options...</p>
            </div>
          ) : isVerifying ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
               <div className="relative mb-6">
                <div className="h-20 w-20 rounded-full border-4 border-indigo-soft border-t-indigo animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                    <ShieldCheck className="h-8 w-8 text-indigo-ink" />
                </div>
               </div>
               <h3 className="text-lg font-bold text-ink">Verifying Payment</h3>
               <p className="text-ink-3 mt-2">Please do not close this window while we activate your renewal.</p>
            </div>
          ) : renewalInfo ? (
            <div className="space-y-6">
              {/* Plan Info */}
              <div className="bg-indigo-soft/50 border border-indigo-soft rounded-xl p-4">
                <div className="flex justify-between items-start">
                    <div>
                        <p className="text-xs font-semibold text-indigo-ink uppercase tracking-wider">Current Plan</p>
                        <p className="text-lg font-bold text-ink mt-0.5">{renewalInfo.planName}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Current Expiry</p>
                        <p className={`text-base font-bold mt-0.5 ${isExpiringSoon ? 'text-rose-ink' : 'text-ink'}`}>
                            {formatIndianDate(renewalInfo.currentExpiry)}
                        </p>
                        <p className="text-xs text-ink-3">({daysUntilExpiry} days left)</p>
                    </div>
                </div>
                {isExpiringSoon && (
                    <div className="mt-3 flex items-center text-xs text-rose-ink bg-rose-soft p-2 rounded-lg border border-rose-soft">
                        <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                        Urgent: Renewable now to prevent service interruption.
                    </div>
                )}
              </div>

              {/* Renewal Selection */}
              <div>
                <h3 className="text-sm font-semibold text-ink-2 mb-3 flex items-center">
                  <Calendar className="h-4 w-4 mr-2" />
                  Renewal Period
                </h3>
                <div className="grid grid-cols-1 gap-3">
                  <div className="relative p-4 rounded-xl border-2 border-indigo bg-indigo-soft/30 flex items-center justify-between cursor-default">
                    <div className="flex items-center">
                      <div className="h-5 w-5 rounded-full border-4 border-indigo mr-3 bg-paper"></div>
                      <div>
                        <p className="font-bold text-ink">1 Year Extension</p>
                        <p className="text-xs text-ink-3">Add 12 months from current expiry</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-black text-ink">{formatIndianCurrency(renewalInfo.renewalPricing.price)}</p>
                      <p className="text-xs text-ink-3">+{renewalInfo.renewalPricing.currency}</p>
                    </div>
                  </div>
                </div>
                <p className="mt-4 text-[10px] text-ink-4 text-center uppercase tracking-widest font-bold">
                    * Monthly renewals are restricted to new customers only
                </p>
              </div>

              {/* Benefits */}
              <div className="bg-paper-2 rounded-xl p-4 space-y-2">
                <div className="flex items-center text-xs text-ink-2">
                  <CheckCircle className="h-3.5 w-3.5 mr-2 text-emerald-ink" />
                  Instant Activation & Un-suspension
                </div>
                <div className="flex items-center text-xs text-ink-2">
                  <CheckCircle className="h-3.5 w-3.5 mr-2 text-emerald-ink" />
                  Tax Invoice generated in Zoho Books
                </div>
                <div className="flex items-center text-xs text-ink-2">
                    <CheckCircle className="h-3.5 w-3.5 mr-2 text-emerald-ink" />
                    New Expiry: {formatIndianDate(new Date(new Date(renewalInfo.currentExpiry).setFullYear(new Date(renewalInfo.currentExpiry).getUTCFullYear() + 1)).toISOString())}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-3 text-ink-2 font-semibold bg-paper-2 hover:bg-hairline rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRenewal}
                  disabled={isProcessing}
                  className="flex-[2] px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
                >
                  {isProcessing ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                      Initializing...
                    </>
                  ) : (
                    <>
                      <CreditCard className="h-4 w-4 mr-2" />
                      Pay & Renew Now
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <AlertTriangle className="h-12 w-12 text-ink-4 mx-auto mb-4" />
              <p className="text-ink-3">Failed to load renewal options. Please try again.</p>
              <button 
                onClick={loadRenewalInfo}
                className="mt-4 text-indigo-ink font-bold hover:underline"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
