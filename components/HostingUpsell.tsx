'use client';

import { useState } from 'react';
import { Server, CheckCircle, Sparkles, ArrowRight, Shield, Zap, Headphones } from 'lucide-react';
import { useCartStore } from '@/store/cartStore';
import type { CartItem } from '@/lib/types';
import toast from 'react-hot-toast';

import { HOSTING_PLANS } from '@/config/hosting-plans';
import { logger } from '@/lib/logger';

// Standard plan details for display
const standardPlan = {
  id: HOSTING_PLANS.standard.id,
  name: HOSTING_PLANS.standard.name,
  subtitle: HOSTING_PLANS.standard.description,
  price: HOSTING_PLANS.standard.price,
  originalPrice: HOSTING_PLANS.standard.price * 2,
  discount: '50%',
  period: 12, // 1 Year (12 Months)
  features: [
    ...HOSTING_PLANS.standard.features,
    "30-Day Money-Back Guarantee"
  ],
};

export default function HostingUpsell() {
  const { addItem, items } = useCartStore();
  const [isAdding, setIsAdding] = useState(false);

  const handleAddHosting = () => {
    setIsAdding(true);

    try {
      const planData = HOSTING_PLANS.standard;

      const existingHosting = items.find(
        item => item.itemType === 'hosting' && item.hostingPlan?.id === planData.id
      );

      if (existingHosting) {
        toast.error(`${planData.name} Hosting is already in your cart`);
        setIsAdding(false);
        return;
      }

      // Check for existing domain in cart to link
      const existingDomain = items.find(
        item => (!item.itemType || item.itemType === 'domain')
      );

      // Always generate a unique ID for hosting products to avoid collision with domain products
      const uniqueHostingId = `hosting-${planData.id}-${Date.now()}`;

      const hostingItem: CartItem = {
        domainName: uniqueHostingId,
        price: planData.price,
        currency: 'INR',
        registrationPeriod: 12, // Default to Yearly for best value
        itemType: 'hosting',
        billingCycle: 'yearly',
        hostingPlan: {
          id: planData.id,
          name: planData.name + ' Hosting',
          description: planData.description,
          price: planData.price,
          serverPackage: planData.serverPackage,
          features: [
          ...planData.features,
          "30-Day Money-Back Guarantee"
        ]
        }
      };

      // If there's an existing domain, link it
      if (existingDomain) {
        hostingItem.linkedDomain = existingDomain.domainName;
      }

      addItem(hostingItem);
      toast.success(`${planData.name} Hosting added to cart!`);
    } catch (error) {
      logger.error("Error adding hosting:", error);
      toast.error("Failed to add hosting. Please try again.");
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="bg-blue-50 p-2 rounded-lg">
            <Server className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-bold text-gray-900">Add {standardPlan.name}</h3>
            <p className="text-xs sm:text-sm text-gray-600 mt-1">Get your website online with our most popular plan. Fast & secure.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-100">
          <span className="text-2xl font-bold text-gray-900">₹{standardPlan.price}</span>
          <span className="text-sm text-gray-500 line-through">₹{standardPlan.originalPrice}</span>
          <span className="text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
            Save 50%
          </span>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start lg:items-center justify-between">
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 flex-1">
          {standardPlan.features.map((feature, idx) => (
            <div key={idx} className="flex items-center gap-2 text-sm text-gray-700">
              <CheckCircle className="h-4 w-4 text-blue-600 flex-shrink-0" />
              <span>{feature}</span>
            </div>
          ))}
        </div>

        <button
          onClick={handleAddHosting}
          disabled={isAdding}
          className="w-full lg:w-auto bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-6 rounded-lg transition-colors duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isAdding ? 'Adding...' : 'Add Hosting'}
          {!isAdding && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
