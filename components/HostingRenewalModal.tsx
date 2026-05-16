'use client';

import { useState, useEffect } from 'react';
import { X, Calendar, CreditCard, AlertTriangle, CheckCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatIndianDate, formatIndianCurrency } from '@/lib/dateUtils';
import { toast } from 'react-hot-toast';
import { safeLocalStorage, safeSessionStorage } from '@/lib/storage';
import { useRouter } from 'next/navigation';
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';

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
  // Razorpay checkout is loaded inside an isolated iframe (see
  // components/RazorpayCheckoutFrame.tsx) so this page can keep a strict CSP
  // without the eval-using checkout.js script.
  const razorpay = useRazorpayCheckout();

  useEffect(() => {
    if (isOpen) {
      loadRenewalInfo();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, domainName]);

  const loadRenewalInfo = async () => {
    setIsLoading(true);
    try {
      const token = safeLocalStorage.getItem('token');
      const response = await fetch(`/api/v1/user/hosting/renew-info?domainName=${encodeURIComponent(domainName)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
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
      const token = safeLocalStorage.getItem('token');
      
      // 1. Initiate renewal in backend to get Razorpay Order ID
      const response = await fetch('/api/v1/user/hosting/renew', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
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
          prefill: {
            email: safeLocalStorage.getItem('user')
              ? JSON.parse(safeLocalStorage.getItem('user')!).email
              : ''
          },
          theme: { color: '#2563eb' }
        });
      } catch (err: any) {
        // User dismissed the modal, or the iframe reported an error.
        if (err?.kind === 'dismissed') {
          setIsProcessing(false);
          return;
        }
        toast.error(err?.message || 'Payment was not completed');
        setIsProcessing(false);
        return;
      }

      // 3. Verify Payment
      setIsVerifying(true);
      try {
        const verifyRes = await fetch('/api/v1/payments/verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
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
    } catch (error: any) {
      toast.error(error.message || 'Failed to process renewal');
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
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200">
        {/* Header */}
        <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center">
              <RefreshCw className="h-5 w-5 mr-2 text-blue-600" />
              Service Renewal
            </h2>
            <p className="text-sm text-gray-500 mt-1">{domainName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-all"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <RefreshCw className="h-10 w-10 animate-spin text-blue-600 mb-4" />
              <p className="text-gray-600 font-medium">Loading renewal options...</p>
            </div>
          ) : isVerifying ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
               <div className="relative mb-6">
                <div className="h-20 w-20 rounded-full border-4 border-blue-50 border-t-blue-600 animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                    <ShieldCheck className="h-8 w-8 text-blue-600" />
                </div>
               </div>
               <h3 className="text-lg font-bold text-gray-900">Verifying Payment</h3>
               <p className="text-gray-500 mt-2">Please do not close this window while we activate your renewal.</p>
            </div>
          ) : renewalInfo ? (
            <div className="space-y-6">
              {/* Plan Info */}
              <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-4">
                <div className="flex justify-between items-start">
                    <div>
                        <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider">Current Plan</p>
                        <p className="text-lg font-bold text-gray-900 mt-0.5">{renewalInfo.planName}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Current Expiry</p>
                        <p className={`text-base font-bold mt-0.5 ${isExpiringSoon ? 'text-red-600' : 'text-gray-900'}`}>
                            {formatIndianDate(renewalInfo.currentExpiry)}
                        </p>
                        <p className="text-xs text-gray-500">({daysUntilExpiry} days left)</p>
                    </div>
                </div>
                {isExpiringSoon && (
                    <div className="mt-3 flex items-center text-xs text-red-600 bg-red-50 p-2 rounded-lg border border-red-100">
                        <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                        Urgent: Renewable now to prevent service interruption.
                    </div>
                )}
              </div>

              {/* Renewal Selection */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center">
                  <Calendar className="h-4 w-4 mr-2" />
                  Renewal Period
                </h3>
                <div className="grid grid-cols-1 gap-3">
                  <div className="relative p-4 rounded-xl border-2 border-blue-600 bg-blue-50/30 flex items-center justify-between cursor-default">
                    <div className="flex items-center">
                      <div className="h-5 w-5 rounded-full border-4 border-blue-600 mr-3 bg-white"></div>
                      <div>
                        <p className="font-bold text-gray-900">1 Year Extension</p>
                        <p className="text-xs text-gray-500">Add 12 months from current expiry</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-black text-gray-900">{formatIndianCurrency(renewalInfo.renewalPricing.price)}</p>
                      <p className="text-xs text-gray-500">+{renewalInfo.renewalPricing.currency}</p>
                    </div>
                  </div>
                </div>
                <p className="mt-4 text-[10px] text-gray-400 text-center uppercase tracking-widest font-bold">
                    * Monthly renewals are restricted to new customers only
                </p>
              </div>

              {/* Benefits */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                <div className="flex items-center text-xs text-gray-600">
                  <CheckCircle className="h-3.5 w-3.5 mr-2 text-green-500" />
                  Instant Activation & Un-suspension
                </div>
                <div className="flex items-center text-xs text-gray-600">
                  <CheckCircle className="h-3.5 w-3.5 mr-2 text-green-500" />
                  Tax Invoice generated in Zoho Books
                </div>
                <div className="flex items-center text-xs text-gray-600">
                    <CheckCircle className="h-3.5 w-3.5 mr-2 text-green-500" />
                    New Expiry: {formatIndianDate(new Date(new Date(renewalInfo.currentExpiry).setFullYear(new Date(renewalInfo.currentExpiry).getUTCFullYear() + 1)).toISOString())}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-3 text-gray-600 font-semibold bg-gray-100 hover:bg-gray-200 rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRenewal}
                  disabled={isProcessing}
                  className="flex-[2] px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
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
              <AlertTriangle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">Failed to load renewal options. Please try again.</p>
              <button 
                onClick={loadRenewalInfo}
                className="mt-4 text-blue-600 font-bold hover:underline"
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
