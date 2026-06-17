'use client';

import { InputHTMLAttributes, forwardRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
  // Retained for API compatibility with existing callers; the entry-state
  // animations were removed because Framer Motion's SSR'd inline styles
  // diverged from the React-19 client-rendered styles during hydration
  // and threw React #418 on every login/register page load. The
  // error/helper-message AnimatePresence below is kept — those only
  // render conditionally after a validation failure, so they don't
  // participate in the initial server-vs-client comparison.
  animate?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  label,
  error,
  helperText,
  icon,
  rightIcon,
  fullWidth = false,
  className = '',
  autoComplete,
  type,
  name,
  placeholder,
  ...props
}, ref) => {
  const [isFocused, setIsFocused] = useState(false);

  const baseClasses = 'block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-50 disabled:text-gray-500 text-gray-900 transition-all duration-200';
  const errorClasses = error ? 'border-red-300 focus:ring-red-500 focus:border-red-500' : '';
  const iconClasses = icon ? 'pl-10' : '';
  const rightIconClasses = rightIcon ? 'pr-10' : '';
  const widthClasses = fullWidth ? 'w-full' : '';
  const focusClasses = isFocused ? 'ring-2 ring-primary-500/20 shadow-md' : '';

  const getAutocomplete = (): string | undefined => {
    if (autoComplete) {
      return autoComplete;
    }
    if (type === 'password') {
      if (name?.includes('confirm') || (name === 'password' && placeholder?.toLowerCase().includes('create'))) {
        return 'new-password';
      }
      return 'current-password';
    }
    if (type === 'email') {
      return 'email';
    }
    if (name === 'phone' || name === 'phoneCc') {
      return 'tel';
    }
    return undefined;
  };

  return (
    <div className={fullWidth ? 'w-full' : ''}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <span className={`transition-colors duration-200 ${isFocused ? 'text-primary-500 scale-110' : 'text-gray-400'}`}>
              {icon}
            </span>
          </div>
        )}

        <input
          ref={ref}
          type={type}
          name={name}
          placeholder={placeholder}
          className={`${baseClasses} ${errorClasses} ${iconClasses} ${rightIconClasses} ${widthClasses} ${focusClasses} ${className}`}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          autoComplete={getAutocomplete()}
          {...props}
        />

        {rightIcon && (
          <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
            {rightIcon}
          </div>
        )}
      </div>

      <AnimatePresence>
        {error && (
          <motion.p
            className="mt-1 text-sm text-red-600"
            initial={{ opacity: 0, y: -5, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -5, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            {error}
          </motion.p>
        )}
        {helperText && !error && (
          <motion.p
            className="mt-1 text-sm text-gray-500"
            initial={{ opacity: 0, y: -5, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -5, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            {helperText}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
});

Input.displayName = 'Input';

export default Input;
