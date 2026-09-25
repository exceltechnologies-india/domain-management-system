'use client';

import { CreditCard, Shield, Receipt } from 'lucide-react';
import Link from 'next/link';

interface CartOrderSummaryProps {
  isLoggedIn: boolean;
  hasSession: boolean;
  profileCompleted: boolean | undefined;
  itemCount: number;
  totalPrice: number;
  onCheckout: () => void;
  onClearCart: () => void;
  returnUrl: string;
}

export default function CartOrderSummary({
  isLoggedIn,
  hasSession,
  profileCompleted,
  itemCount,
  totalPrice,
  onCheckout,
  onClearCart,
  returnUrl,
}: CartOrderSummaryProps) {
  const subtotal = totalPrice / 1.18;
  const gst = totalPrice - subtotal;

  const checkoutLabel = !isLoggedIn
    ? 'Login to Checkout'
    : profileCompleted === true
    ? 'Proceed to Checkout'
    : 'Complete Profile First';

  const checkoutBtnClass =
    isLoggedIn && profileCompleted !== true
      ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-lg hover:shadow-xl transform hover:scale-105'
      : 'bg-gradient-to-r from-primary-600 to-primary-700 hover:from-primary-700 hover:to-primary-800 text-white shadow-lg hover:shadow-xl transform hover:scale-105';

  // Guest checkout was removed on 25 Sep 2026 (owner decision): it took
  // payment on DMS's own Razorpay account. A visitor signs in or creates an
  // account; the cart itself is kept for them.

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 lg:sticky lg:top-24 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-900">Order Summary</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
          {itemCount} item{itemCount !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="p-5 sm:p-6">
        {/* Totals breakdown */}
        <div className="bg-gradient-to-br from-primary-50/60 to-indigo-50/40 rounded-xl p-4 border border-primary-100/60 mb-5">
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Subtotal</span>
              <span className="text-gray-900 font-medium font-mono">₹{subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">GST (18%)</span>
              <span className="text-gray-900 font-medium font-mono">₹{gst.toFixed(2)}</span>
            </div>
            <div className="border-t border-primary-200/60 pt-2.5 mt-2.5 flex justify-between items-baseline">
              <span className="text-gray-900 font-semibold text-base">Total</span>
              <span className="text-2xl sm:text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary-600 to-indigo-600 font-mono">
                ₹{totalPrice.toFixed(2)}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 text-right">
              *Includes 18% GST
            </p>
          </div>
        </div>

        <button
          onClick={onCheckout}
          className={`w-full font-semibold py-2.5 sm:py-3 px-4 rounded-xl transition-all duration-200 mb-3 flex items-center justify-center space-x-2 text-sm sm:text-base ${checkoutBtnClass}`}
        >
          <CreditCard className="h-4 w-4 sm:h-5 sm:w-5" />
          <span>{checkoutLabel}</span>
        </button>

        {!isLoggedIn && !hasSession && (
          <p className="text-center text-xs sm:text-sm text-gray-600 mb-3 px-2">
            New here?{' '}
            <Link
              href={`/register?returnUrl=${encodeURIComponent(returnUrl)}`}
              className="text-primary-600 hover:text-primary-700 font-medium underline underline-offset-4"
            >
              Create an account
            </Link>
          </p>
        )}

        <button
          onClick={onClearCart}
          className="w-full border border-red-200 text-red-600 hover:text-red-700 hover:border-red-300 hover:bg-red-50 font-medium py-2 px-4 rounded-xl transition-all duration-200 text-sm sm:text-base"
        >
          Clear Cart
        </button>

        <div className="mt-5 pt-4 border-t border-gray-100">
          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
            <Shield className="h-3.5 w-3.5 text-green-600" />
            <span>Secure 256-bit SSL encryption</span>
          </div>
        </div>
      </div>
    </div>
  );
}
