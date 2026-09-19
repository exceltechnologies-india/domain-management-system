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
    default: 'bg-paper border border-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
    elevated: 'bg-paper border border-hairline shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
    outlined: 'bg-paper border border-hairline-strong'
  };

  const hoverClass = hover ? 'hover:border-hairline-strong hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-all duration-300 hover:-translate-y-0.5' : '';

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
