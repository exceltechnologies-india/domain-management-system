'use client';

import { motion } from 'framer-motion';
import { Loader2, Globe, Receipt, ShoppingCart, Settings } from 'lucide-react';

interface LoadingSpinnerProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
  fullScreen?: boolean;
}

export function LoadingSpinner({ 
  message = 'Loading...', 
  size = 'md', 
  fullScreen = false 
}: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-8 w-8',
    lg: 'h-12 w-12'
  };

  const content = (
    <div className="flex flex-col items-center justify-center space-y-4">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
        className={sizeClasses[size]}
      >
        <Loader2 className="h-full w-full text-blue-600" />
      </motion.div>
      <p className="text-gray-600 text-sm font-medium">{message}</p>
    </div>
  );

  if (fullScreen) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        {content}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-12">
      {content}
    </div>
  );
}

interface PageLoadingProps {
  page?: string;
}

export function PageLoading({ page = 'content' }: PageLoadingProps) {
  const pageMessages = {
    domains: 'Loading your domains...',
    orders: 'Loading your orders...',
    cart: 'Loading your cart...',
    settings: 'Loading settings...',
    content: 'Loading...'
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="text-center"
      >
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="h-16 w-16 mx-auto mb-4"
        >
          <Loader2 className="h-full w-full text-blue-600" />
        </motion.div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          {pageMessages[page as keyof typeof pageMessages] || pageMessages.content}
        </h3>
        <p className="text-gray-500 text-sm">
          Please wait while we fetch your data
        </p>
      </motion.div>
    </div>
  );
}

interface DataLoadingProps {
  type?: 'table' | 'card' | 'list';
  count?: number;
}

export function DataLoading({ type = 'table', count = 3 }: DataLoadingProps) {
  const renderSkeleton = () => {
    switch (type) {
      case 'table':
        return (
          <div className="space-y-3">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i} className="flex space-x-4">
                <div className="h-4 bg-gray-200 rounded w-1/4 animate-pulse"></div>
                <div className="h-4 bg-gray-200 rounded w-1/3 animate-pulse"></div>
                <div className="h-4 bg-gray-200 rounded w-1/4 animate-pulse"></div>
                <div className="h-4 bg-gray-200 rounded w-1/6 animate-pulse"></div>
              </div>
            ))}
          </div>
        );
      
      case 'card':
        return (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-3/4 mb-3"></div>
                  <div className="h-3 bg-gray-200 rounded w-1/2 mb-2"></div>
                  <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                </div>
              </div>
            ))}
          </div>
        );
      
      case 'list':
        return (
          <div className="space-y-3">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div className="animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
                  <div className="h-3 bg-gray-200 rounded w-3/4"></div>
                </div>
              </div>
            ))}
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="p-6">
      {renderSkeleton()}
    </div>
  );
}
