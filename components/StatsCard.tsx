'use client';

import { ReactNode } from 'react';
import { motion } from 'framer-motion';
import Card from './Card';

interface StatsCardProps {
  icon: ReactNode;
  value: string | number;
  label: string;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  className?: string;
  delay?: number;
}

export default function StatsCard({
  icon,
  value,
  label,
  trend,
  trendValue,
  className = '',
  delay = 0
}: StatsCardProps) {
  const trendClasses = {
    up: 'text-green-600',
    down: 'text-red-600',
    neutral: 'text-gray-600'
  };

  const trendIcons = {
    up: '↗',
    down: '↘',
    neutral: '→'
  };

  return (
    <Card className={`text-center ${className}`} delay={delay}>
      <motion.div
        className="bg-gray-100 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-3 group-hover:bg-primary-100 transition-colors duration-300"
        whileHover={{
          scale: 1.1,
          rotate: 10,
          transition: { duration: 0.2 }
        }}
      >
        <motion.span
          className="text-primary-600"
          whileHover={{
            scale: 1.2,
            transition: { duration: 0.2 }
          }}
        >
          {icon}
        </motion.span>
      </motion.div>

      <motion.div
        className="text-2xl font-bold text-gray-900 mb-1 group-hover:text-primary-700 transition-colors duration-300"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: delay + 0.1, duration: 0.3 }}
      >
        {value}
      </motion.div>

      <motion.div
        className="text-sm text-gray-600 mb-2 group-hover:text-gray-700 transition-colors duration-300"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: delay + 0.2, duration: 0.3 }}
      >
        {label}
      </motion.div>

      {trend && trendValue && (
        <motion.div
          className={`text-xs ${trendClasses[trend]} flex items-center justify-center gap-1`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: delay + 0.3, duration: 0.3 }}
        >
          <motion.span
            animate={trend === 'up' ? { y: [-2, 0, -2] } : trend === 'down' ? { y: [2, 0, 2] } : {}}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
          >
            {trendIcons[trend]}
          </motion.span>
          {trendValue}
        </motion.div>
      )}
    </Card>
  );
}
