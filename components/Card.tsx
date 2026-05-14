'use client';

import { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  padding?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'elevated' | 'outlined';
  animate?: boolean;
  delay?: number;
}

export default function Card({
  children,
  className = '',
  hover = false,
  padding = 'md',
  variant = 'default',
  animate = true,
  delay = 0
}: CardProps) {
  const paddingClasses = {
    sm: 'p-4',
    md: 'p-6',
    lg: 'p-8'
  };

  const variantClasses = {
    default: 'bg-white border border-gray-200',
    elevated: 'bg-white shadow-lg',
    outlined: 'bg-white border-2 border-gray-200'
  };

  const hoverClass = hover ? 'hover:shadow-xl hover:shadow-gray-200/50 transition-all duration-300 hover:-translate-y-1' : '';

  const cardContent = (
    <div className={`rounded-lg ${variantClasses[variant]} ${paddingClasses[padding]} ${hoverClass} ${className} group`}>
      {children}
    </div>
  );

  if (animate) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.5,
          delay: delay,
          ease: "easeOut"
        }}
        whileHover={hover ? {
          scale: 1.02,
          transition: { duration: 0.2 }
        } : {}}
      >
        {cardContent}
      </motion.div>
    );
  }

  return cardContent;
}
