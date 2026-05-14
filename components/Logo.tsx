import Image from 'next/image';
import Link from 'next/link';

interface LogoProps {
  className?: string;
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
  href?: string;
  variant?: 'light' | 'dark';
}

export default function Logo({
  className = '',
  showText = false,
  size = 'md',
  href = '/',
  variant = 'light'
}: LogoProps) {
  const sizeClasses = {
    sm: 'h-5 md:h-6 w-auto',
    md: 'h-6 md:h-7 w-auto',
    lg: 'h-7 md:h-8 w-auto'
  };

  const textSizeClasses = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-2xl'
  };

  const logoElement = (
    <div className={`flex items-center ${className}`}>
      <Image
        src={variant === 'dark' ? '/logo-white.png' : '/black-logo.png'}
        alt="Anutech Digital Private Limited"
        width={size === 'sm' ? 80 : size === 'md' ? 100 : 120}
        height={size === 'sm' ? 20 : size === 'md' ? 24 : 28}
        className={sizeClasses[size]}
        style={{ width: 'auto', height: 'auto' }}
        priority
      />
      {showText && (
        <span className={`ml-2 font-bold ${variant === 'dark' ? 'text-white' : 'text-gray-900'} ${textSizeClasses[size]}`}>
          Anutech Digital Private Limited
        </span>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href}>
        {logoElement}
      </Link>
    );
  }

  return logoElement;
}
