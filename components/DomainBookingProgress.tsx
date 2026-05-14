'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, Clock, AlertCircle, RefreshCw, Globe, User, CreditCard, Loader2 } from 'lucide-react';

interface BookingStatus {
  step: "payment_verified" | "customer_created" | "contact_created" | "domain_registering" | "domain_registered" | "domain_failed";
  message: string;
  timestamp: Date;
  progress: number;
}

interface DomainBookingProgressProps {
  orderId: string;
  domainName: string;
  onComplete?: () => void;
  autoRefresh?: boolean;
}

const stepIcons = {
  payment_verified: CreditCard,
  customer_created: User,
  contact_created: User,
  domain_registering: Globe,
  domain_registered: CheckCircle,
  domain_failed: AlertCircle,
};

const stepColors = {
  payment_verified: "text-blue-600",
  customer_created: "text-purple-600",
  contact_created: "text-purple-600",
  domain_registering: "text-orange-600",
  domain_registered: "text-green-600",
  domain_failed: "text-red-600",
};

export default function DomainBookingProgress({
  orderId,
  domainName,
  onComplete,
  autoRefresh = true,
}: DomainBookingProgressProps) {
  const [bookingStatus, setBookingStatus] = useState<BookingStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isComplete, setIsComplete] = useState(false);
  const [currentProgress, setCurrentProgress] = useState(0);

  const fetchBookingStatus = async () => {
    try {
      const response = await fetch(
        `/api/domains/booking-status?orderId=${orderId}&domainName=${domainName}`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.domains && data.domains.bookingStatus) {
          setBookingStatus(data.domains.bookingStatus);
          setCurrentProgress(data.domains.bookingStatus[data.domains.bookingStatus.length - 1]?.progress || 0);

          // Check if domain is fully registered
          const lastStep = data.domains.bookingStatus[data.domains.bookingStatus.length - 1];
          if (lastStep?.step === "domain_registered") {
            setIsComplete(true);
            onComplete?.();
          }
        }
      }
    } catch (error) {
      // Error fetching booking status
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBookingStatus();

    if (autoRefresh && !isComplete) {
      const interval = setInterval(fetchBookingStatus, 3000); // Refresh every 3 seconds
      return () => clearInterval(interval);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, domainName, autoRefresh, isComplete]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-600">Loading booking status...</span>
      </div>
    );
  }

  if (bookingStatus.length === 0) {
    return (
      <div className="text-center p-8 text-gray-500">
        <AlertCircle className="h-12 w-12 mx-auto mb-4 text-gray-400" />
        <p>No booking status information available</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Progress Bar */}
      <div className="bg-gray-200 rounded-full h-3 overflow-hidden">
        <motion.div
          className="bg-gradient-to-r from-blue-500 to-green-500 h-full rounded-full"
          initial={{ width: 0 }}
          animate={{ width: `${currentProgress}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>

      {/* Progress Percentage */}
      <div className="text-center">
        <span className="text-2xl font-bold text-gray-800">{currentProgress}%</span>
        <p className="text-sm text-gray-600 mt-1">Domain Registration Progress</p>
      </div>

      {/* Status Steps */}
      <div className="space-y-4">
        {bookingStatus.map((status, index) => {
          const Icon = stepIcons[status.step];
          const isCompleted = status.step === "domain_registered";
          const isFailed = status.step === "domain_failed";
          const isCurrent = index === bookingStatus.length - 1 && !isCompleted && !isFailed;

          return (
            <motion.div
              key={index}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              className={`flex items-start space-x-3 p-4 rounded-lg border ${isCompleted
                  ? 'bg-green-50 border-green-200'
                  : isFailed
                    ? 'bg-red-50 border-red-200'
                    : isCurrent
                      ? 'bg-blue-50 border-blue-200'
                      : 'bg-gray-50 border-gray-200'
                }`}
            >
              <div className={`flex-shrink-0 ${stepColors[status.step]}`}>
                {isCurrent ? (
                  <RefreshCw className="h-5 w-5 animate-spin" />
                ) : (
                  <Icon className="h-5 w-5" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${isCompleted ? 'text-green-800' :
                    isFailed ? 'text-red-800' :
                      isCurrent ? 'text-blue-800' : 'text-gray-800'
                  }`}>
                  {status.message}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(status.timestamp).toLocaleString()}
                </p>
              </div>

              {isCompleted && (
                <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0" />
              )}
              {isFailed && (
                <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Status Message */}
      {isComplete && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center p-6 bg-green-50 border border-green-200 rounded-lg"
        >
          <CheckCircle className="h-12 w-12 text-green-600 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-green-800 mb-2">
            Domain Registration Complete!
          </h3>
          <p className="text-green-700">
            Your domain <strong>{domainName}</strong> has been successfully registered and is now active.
          </p>
        </motion.div>
      )}

      {/* Refresh Button */}
      {!isComplete && (
        <div className="text-center">
          <button
            onClick={fetchBookingStatus}
            className="inline-flex items-center px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh Status
          </button>
        </div>
      )}
    </div>
  );
}
