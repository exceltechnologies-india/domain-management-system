'use client';

import { motion } from 'framer-motion';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'rectangular' | 'circular';
  width?: string | number;
  height?: string | number;
  animation?: 'pulse' | 'wave' | 'none';
}

export default function Skeleton({
  className = '',
  variant = 'rectangular',
  width,
  height,
  animation = 'wave'
}: SkeletonProps) {
  const baseClasses = 'bg-gray-200 rounded';

  const variantClasses = {
    text: 'h-4 rounded',
    rectangular: 'rounded-md',
    circular: 'rounded-full'
  };

  const animationClasses = {
    pulse: 'animate-pulse',
    wave: '',
    none: ''
  };

  const style = {
    width: width || (variant === 'circular' ? '40px' : '100%'),
    height: height || (variant === 'text' ? '16px' : variant === 'circular' ? '40px' : '200px')
  };

  if (animation === 'wave') {
    return (
      <div className={`relative overflow-hidden ${variantClasses[variant]} ${className}`} style={style}>
        <div className="absolute inset-0 bg-gray-200" />
        <motion.div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/60 to-transparent"
          animate={{ x: ['-100%', '100%'] }}
          transition={{
            duration: 1.5,
            repeat: Infinity,
            ease: 'easeInOut'
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`${baseClasses} ${variantClasses[variant]} ${animationClasses[animation]} ${className}`}
      style={style}
    />
  );
}

// Pre-built skeleton components
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          variant="text"
          width={i === lines - 1 ? '75%' : '100%'}
          className="h-4"
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`p-6 border border-gray-200 rounded-lg ${className}`}>
      <div className="flex items-center space-x-4 mb-4">
        <Skeleton variant="circular" width={40} height={40} />
        <div className="flex-1 space-y-2">
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="text" width="40%" />
        </div>
      </div>
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 4, className = '' }: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-3 ${className}`}>
      {/* Header */}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} variant="text" width="80%" />
        ))}
      </div>

      {/* Rows */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Skeleton
              key={colIndex}
              variant="text"
              width={colIndex === 0 ? '90%' : '70%'}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonList({ items = 5, className = '' }: { items?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`}>
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex items-center space-x-3 p-3 border border-gray-200 rounded-lg">
          <Skeleton variant="circular" width={32} height={32} />
          <div className="flex-1 space-y-2">
            <Skeleton variant="text" width="60%" />
            <Skeleton variant="text" width="40%" />
          </div>
        </div>
      ))}
    </div>
  );
}
