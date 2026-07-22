'use client';

import { ReactNode, ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  // Retained for API compatibility. The framer-motion entry animations
  // (initial={opacity:0,…} on the icon + text spans) emitted inline
  // `style="opacity:0;…"` on the SSR output that diverged from the
  // React-19 client-rendered styles during hydration, throwing React
  // #418 on every login/register/contact page. The animations were
  // decorative 0.2-second fades — no real UX value, only hydration
  // risk. Hover/tap micro-interactions are now done via Tailwind's
  // hover:/active: utilities (defined in baseClasses + variantClasses).
  animate?: boolean;
}

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  icon,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const baseClasses = 'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden tracking-wide active:scale-[0.985] enabled:hover:scale-[1.015]';

  const variantClasses = {
    primary: 'bg-gradient-to-br from-primary-600 to-primary-700 text-white hover:from-primary-700 hover:to-primary-800 shadow-md hover:shadow-lg focus:ring-primary-500 border border-primary-700/50',
    secondary: 'bg-gray-700 text-white hover:bg-gray-800 shadow-md hover:shadow-lg focus:ring-gray-600 border border-gray-800/50',
    outline: 'border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-primary-500 hover:border-primary-400 shadow-sm hover:shadow-md',
    ghost: 'text-gray-600 hover:bg-gray-100 focus:ring-gray-400',
    danger: 'bg-gradient-to-br from-red-600 to-red-700 text-white hover:from-red-700 hover:to-red-800 shadow-md hover:shadow-lg focus:ring-red-500 border border-red-700/50'
  };

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-5 py-2.5 text-base',
    lg: 'px-8 py-3.5 text-lg'
  };

  const widthClass = fullWidth ? 'w-full' : '';
  const loadingClass = loading ? 'cursor-wait' : '';

  const finalClassName = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${widthClass} ${loadingClass} ${className} group`;

  return (
    <button
      className={finalClassName}
      disabled={disabled || loading}
      {...props}
    >
      <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
      <div className="relative z-10 flex items-center justify-center gap-2">
        {loading ? (
          <svg
            className="animate-spin h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : icon ? (
          <span className="flex items-center">{icon}</span>
        ) : null}

        <span>{children}</span>
      </div>
    </button>
  );
}
