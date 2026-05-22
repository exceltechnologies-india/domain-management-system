'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Calendar, CreditCard, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { formatIndianDate, formatIndianCurrency } from '@/lib/dateUtils';
import { toast } from 'react-hot-toast';

interface DomainRenewalModalProps {
  isOpen: boolean;
  onClose: () => void;
  domainName: string;
}

interface RenewalInfo {
  pricing: {
    price: number;
    currency: string;
    years: number;
    domain: string;
  };
  expiry: {
    domain: string;
    expirydate: string;
    expirydateinseconds: number;
  };
}

export default function DomainRenewalModal({
  isOpen,
  onClose,
  domainName
}: DomainRenewalModalProps) {
  const [renewalInfo, setRenewalInfo] = useState<RenewalInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedYears, setSelectedYears] = useState(1);
  const [expiryDate, setExpiryDate] = useState<string>('');

  const renewalYears = [1, 2, 3, 4, 5, 10];

  const loadRenewalInfo = useCallback(async () => {
    setIsLoading(true);
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/domains/renew?domainName=${encodeURIComponent(domainName)}&years=${selectedYears}`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setRenewalInfo(data);
        setExpiryDate(data.expiry?.expirydate || '');
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to load renewal information');
      }
    } catch (error) {
      // Error loading renewal info
      toast.error('Failed to load renewal information');
    } finally {
      setIsLoading(false);
    }
  }, [domainName, selectedYears]);

  useEffect(() => {
    if (isOpen) {
      void loadRenewalInfo();
    }
  }, [isOpen, loadRenewalInfo]);

  const handleRenewal = async () => {
    if (!renewalInfo) return;

    setIsProcessing(true);
    try {
      // Create a mock payment ID for testing
      const paymentId = `renew_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const response = await fetch('/api/v1/domains/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          domainName,
          years: selectedYears,
          paymentId,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(`Domain renewed successfully for ${selectedYears} year(s)!`);
        onClose();
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to renew domain');
      }
    } catch (error) {
      // Error renewing domain
      toast.error('Failed to renew domain');
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'Unknown';
    return formatIndianDate(dateString);
  };

  const getDaysUntilExpiry = (dateString: string) => {
    if (!dateString) return 0;
    const expiry = new Date(dateString);
    const now = new Date();
    const diffTime = expiry.getTime() - now.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const daysUntilExpiry = getDaysUntilExpiry(expiryDate);
  const isExpiringSoon = daysUntilExpiry <= 30;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Domain Renewal</h2>
            <p className="text-gray-600 mt-1">{domainName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-blue-600" />
              <span className="ml-2 text-gray-600">Loading renewal information...</span>
            </div>
          ) : renewalInfo ? (
            <div className="space-y-6">
              {/* Current Status */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                  <Calendar className="h-5 w-5 mr-2" />
                  Current Status
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Expiry Date</label>
                    <p className="text-lg font-semibold text-gray-900">
                      {formatDate(expiryDate)}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Days Until Expiry</label>
                    <p className={`text-lg font-semibold ${isExpiringSoon ? 'text-red-600' : 'text-gray-900'}`}>
                      {daysUntilExpiry} days
                      {isExpiringSoon && (
                        <AlertTriangle className="h-4 w-4 inline ml-1" />
                      )}
                    </p>
                  </div>
                </div>
                {isExpiringSoon && (
                  <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center">
                      <AlertTriangle className="h-5 w-5 text-red-600 mr-2" />
                      <p className="text-red-800 text-sm">
                        Your domain is expiring soon! Renew now to avoid service interruption.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Renewal Options */}
              <div className="bg-blue-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                  <CreditCard className="h-5 w-5 mr-2" />
                  Renewal Options
                </h3>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select Renewal Period
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {renewalYears.map((years) => (
                      <button
                        key={years}
                        onClick={() => setSelectedYears(years)}
                        className={`px-4 py-2 rounded-lg border transition-colors ${selectedYears === years
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-700 border-gray-300 hover:border-blue-300'
                          }`}
                      >
                        {years} {years === 1 ? 'Year' : 'Years'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Renewal Cost</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {formatIndianCurrency(renewalInfo.pricing.price)}
                      </p>
                      <p className="text-sm text-gray-500">
                        for {selectedYears} {selectedYears === 1 ? 'year' : 'years'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-600">New Expiry Date</p>
                      <p className="text-lg font-semibold text-gray-900">
                        {formatDate(new Date(Date.now() + selectedYears * 365 * 24 * 60 * 60 * 1000).toISOString())}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Renewal Benefits */}
              <div className="bg-green-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                  <CheckCircle className="h-5 w-5 mr-2 text-green-600" />
                  Renewal Benefits
                </h3>
                <ul className="space-y-2 text-sm text-gray-700">
                  <li className="flex items-center">
                    <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
                    Maintain your domain ownership
                  </li>
                  <li className="flex items-center">
                    <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
                    Keep your website and email services active
                  </li>
                  <li className="flex items-center">
                    <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
                    Protect your brand and online presence
                  </li>
                  <li className="flex items-center">
                    <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
                    Avoid domain expiration penalties
                  </li>
                </ul>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end space-x-4">
                <button
                  onClick={onClose}
                  className="px-6 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRenewal}
                  disabled={isProcessing}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center"
                >
                  {isProcessing ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <CreditCard className="h-4 w-4 mr-2" />
                      Renew Domain
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <AlertTriangle className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>Failed to load renewal information.</p>
              <button
                onClick={loadRenewalInfo}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
