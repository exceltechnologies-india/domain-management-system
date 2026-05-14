'use client';
import { ReactNode } from 'react';
import { motion } from 'framer-motion';
import Card from './Card';

interface FeatureCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
  hover?: boolean;
  delay?: number;
}

export default function FeatureCard({
  icon,
  title,
  description,
  className = '',
  hover = true,
  delay = 0
}: FeatureCardProps) {
  return (
    <Card hover={hover} className={`text-center sm:text-left ${className}`} delay={delay}>
      <motion.div
        className="bg-primary-100 rounded-full w-10 h-10 sm:w-12 sm:h-12 flex items-center justify-center mx-auto sm:mx-0 mb-2 sm:mb-3 group-hover:bg-primary-200 transition-colors duration-300"
        whileHover={{
          scale: 1.1,
          rotate: 5,
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

      <motion.h4
        className="text-lg sm:text-xl font-semibold mb-2 group-hover:text-primary-700 transition-colors duration-300"
        style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: delay + 0.1, duration: 0.3 }}
      >
        {title}
      </motion.h4>

      <motion.p
        className="text-sm sm:text-base text-gray-600 group-hover:text-gray-700 transition-colors duration-300"
        style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: delay + 0.2, duration: 0.3 }}
      >
        {description}
      </motion.p>
    </Card>
  );
}
