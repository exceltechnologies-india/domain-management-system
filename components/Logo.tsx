import Image from 'next/image';
import Link from 'next/link';

interface LogoProps {
  className?: string;
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
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
    sm: 'h-7 md:h-8 w-auto',
    md: 'h-10 md:h-11 w-auto',
    lg: 'h-12 md:h-14 w-auto',
    // xl — used in the nav, which now has a fixed bar height so this larger
    // mark centers within the bar without changing the navbar height.
    xl: 'h-12 md:h-16 w-auto'
  };

  const textSizeClasses = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-2xl',
    xl: 'text-2xl'
  };

  const logoElement = (
    <div className={`flex items-center ${className}`}>
      <Image
        // Single source of truth for the brand mark. On dark surfaces we
        // render the SAME logo turned pure-white via a CSS filter
        // (brightness(0) makes every pixel black, invert(1) flips it to
        // white) — a clean white silhouette on the dark login panel / footer,
        // no separate white asset to keep in sync.
        //
        // width/height are the asset's intrinsic dimensions (aspect ratio
        // only); the ACTUAL rendered size comes from the `h-* w-auto` classes
        // in sizeClasses. NOTE: do NOT re-add an inline `style` height/width —
        // inline styles override the Tailwind height classes and pin the logo
        // to the intrinsic size (that bug made every "bigger logo" change a
        // no-op).
        src="/black-logo.png"
        alt="Anutech Digital Private Limited"
        width={364}
        height={93}
        className={`${sizeClasses[size]} ${variant === 'dark' ? 'brightness-0 invert' : ''}`}
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
