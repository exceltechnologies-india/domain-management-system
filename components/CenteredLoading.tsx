'use client';

import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

interface CenteredLoadingProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fullScreen?: boolean;
  showMessage?: boolean;
}

/**
 * Perfectly centered loading component for consistent UI/UX across the app
 * Always centers content both horizontally and vertically on any screen size
 */
export default function CenteredLoading({
  message = 'Loading...',
  size = 'md',
  fullScreen = true,
  showMessage = true,
}: CenteredLoadingProps) {
  const sizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-10 w-10',
    lg: 'h-14 w-14',
    xl: 'h-20 w-20',
  };

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
    xl: 'text-lg',
  };

  const content = (
    <div className="flex flex-col items-center justify-center gap-4">
      {/* Spinning loader with pulsing effect */}
      <div className="relative">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className={sizeClasses[size]}
        >
          <Loader2 className="h-full w-full text-blue-600" />
        </motion.div>

        {/* Pulsing ring effect for better visibility */}
        <motion.div
          className="absolute inset-0 border-2 border-blue-200 rounded-full"
          animate={{
            scale: [1, 1.3, 1],
            opacity: [0.5, 0, 0.5],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      </div>

      {/* Optional message */}
      {showMessage && (
        <motion.p
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className={`text-gray-600 font-medium ${textSizeClasses[size]}`}
        >
          {message}
          <motion.span
            animate={{ opacity: [1, 0, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            ...
          </motion.span>
        </motion.p>
      )}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gray-50 z-50">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
        >
          {content}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center w-full h-full min-h-[200px]">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
      >
        {content}
      </motion.div>
    </div>
  );
}

/**
 * Inline loader for use within content (buttons, cards, etc.)
 */
export function InlineLoader({
  size = 'sm',
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };

  return (
    <div className={`inline-flex items-center justify-center ${className}`}>
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
        className={sizeClasses[size]}
      >
        <Loader2 className="h-full w-full" />
      </motion.div>
    </div>
  );
}

