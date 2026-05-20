'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { formatIndianDate } from '@/lib/dateUtils';

interface LivePricingIndicatorProps {
  domainName: string;
  tld: string;
  onPriceUpdate?: (price: number, currency: string) => void;
}

export default function LivePricingIndicator({ domainName, tld, onPriceUpdate }: LivePricingIndicatorProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [livePrice, setLivePrice] = useState<{ price: number; currency: string } | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchLivePrice = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/domains/pricing?tlds=${tld}`);
      const data = await response.json();

      if (data.success && data.data[tld]) {
        const pricing = data.data[tld];
        const registrationPrice = pricing.customer?.addnewdomain?.["1"];

        if (registrationPrice) {
          const price = parseFloat(registrationPrice);
          const priceData = { price, currency: "INR" };

          setLivePrice(priceData);
          setLastUpdated(new Date());
          onPriceUpdate?.(price, "INR");
        }
      } else {
        setError("Live pricing not available");
      }
    } catch (err) {
      // Failed to fetch live pricing
      setError("Failed to fetch live pricing");
    } finally {
      setIsLoading(false);
    }
  }, [tld, onPriceUpdate]);

  useEffect(() => {
    void fetchLivePrice();
  }, [fetchLivePrice]);

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(price);
  };

  const formatLastUpdated = (date: Date) => {
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));

    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes === 1) return '1 minute ago';
    if (diffInMinutes < 60) return `${diffInMinutes} minutes ago`;

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours === 1) return '1 hour ago';
    if (diffInHours < 24) return `${diffInHours} hours ago`;

    return formatIndianDate(date);
  };

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <TrendingUp className="h-5 w-5 text-blue-600" />
          <h3 className="text-sm font-semibold text-blue-900">Live Pricing</h3>
          {livePrice && (
            <div className="flex items-center space-x-1">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span className="text-xs text-green-700">Live</span>
            </div>
          )}
        </div>

        <button
          onClick={fetchLivePrice}
          disabled={isLoading}
          className="flex items-center space-x-1 px-2 py-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="space-y-2">
        {isLoading && (
          <div className="flex items-center space-x-2 text-sm text-blue-700">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Fetching live pricing...</span>
          </div>
        )}

        {error && (
          <div className="flex items-center space-x-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}

        {livePrice && !isLoading && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700">Registration (1 year):</span>
              <span className="text-lg font-bold text-blue-900">
                {formatPrice(livePrice.price)}
              </span>
            </div>

            {lastUpdated && (
              <div className="flex items-center space-x-1 text-xs text-gray-500">
                <Clock className="h-3 w-3" />
                <span>Updated {formatLastUpdated(lastUpdated)}</span>
              </div>
            )}
          </div>
        )}

        <div className="text-xs text-gray-600">
          <p>Live pricing fetched from domain services</p>
          <p>Prices may vary based on current market rates</p>
        </div>
      </div>
    </div>
  );
}
