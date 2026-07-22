import { ReactNode } from 'react';

interface HeroSectionProps {
  children: ReactNode;
  className?: string;
  background?: 'gradient' | 'solid' | 'image';
  // 'brand' uses the Anutech logo's Azure gradient (#1E9BF0 → #1C64E0).
  // Additive — existing callers on other variants are unaffected; currently
  // opted into only by the homepage for the brand color-scheme preview.
  variant?: 'primary' | 'secondary' | 'dark' | 'brand';
  backgroundImage?: string;
  overlayOpacity?: number;
}

export default function HeroSection({
  children,
  className = '',
  background = 'gradient',
  variant = 'primary',
  backgroundImage,
  overlayOpacity = 0.6
}: HeroSectionProps) {
  const backgroundClasses = {
    gradient: variant === 'brand'
      ? 'bg-gradient-to-br from-primary-500 to-primary-800'
      : variant === 'primary'
      ? 'bg-gradient-to-r from-primary-600 to-primary-800'
      : variant === 'secondary'
        ? 'bg-gradient-to-r from-gray-600 to-gray-800'
        : 'bg-gradient-to-r from-gray-800 to-gray-900',
    solid: variant === 'brand'
      ? 'bg-primary-500'
      : variant === 'primary'
      ? 'bg-primary-600'
      : variant === 'secondary'
        ? 'bg-gray-600'
        : 'bg-gray-800',
    image: 'bg-cover bg-center bg-no-repeat'
  };

  const backgroundStyle = backgroundImage ? {
    backgroundImage: `url(${backgroundImage})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat'
  } : {};

  return (
    <section
      className={`${backgroundClasses[background]} text-white relative overflow-hidden pt-4 sm:pt-8 ${className}`}
      style={backgroundStyle}
    >
      {/* Blue overlay for better text readability */}
      <div
        className="absolute inset-0"
        style={{
          background: variant === 'brand'
            ? `linear-gradient(135deg, rgba(1, 128, 229, ${overlayOpacity}) 0%, rgba(1, 72, 157, ${overlayOpacity}) 100%)`
            : variant === 'primary'
            ? `linear-gradient(135deg, rgba(30, 64, 175, ${overlayOpacity}) 0%, rgba(29, 78, 216, ${overlayOpacity}) 100%)`
            : variant === 'secondary'
              ? `linear-gradient(135deg, rgba(75, 85, 99, ${overlayOpacity}) 0%, rgba(31, 41, 55, ${overlayOpacity}) 100%)`
              : `linear-gradient(135deg, rgba(31, 41, 55, ${overlayOpacity}) 0%, rgba(17, 24, 39, ${overlayOpacity}) 100%)`
        }}
      ></div>

      {/* Subtle pattern overlay for texture */}
      <div className="absolute inset-0 opacity-10" style={{
        backgroundImage: `radial-gradient(circle at 25% 25%, rgba(255, 255, 255, 0.1) 0%, transparent 50%),
                         radial-gradient(circle at 75% 75%, rgba(255, 255, 255, 0.05) 0%, transparent 50%)`
      }}></div>

      <div className="max-w-[120rem] mx-auto px-4 sm:px-6 lg:px-8 py-2 sm:py-6 lg:py-10 relative z-10">
        {children}
      </div>
    </section>
  );
}
