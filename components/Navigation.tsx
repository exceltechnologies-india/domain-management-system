'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ShoppingCart, User } from 'lucide-react';
import { useCartStore } from '@/store/cartStore';
import Logo from './Logo';

interface NavigationProps {
  variant?: 'default' | 'dashboard' | 'admin';
  user?: {
    firstName: string;
    lastName: string;
    role: string;
  } | null;
  onLogout?: () => void;
}

export default function Navigation({
  variant = 'default',
  user = null,
  onLogout
}: NavigationProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const pathname = usePathname();
  // Defensive against rare cases where useSession() returns undefined during
  // hydration races — destructuring undefined would otherwise crash into the
  // global error boundary.
  const sessionResult = useSession();
  const session = sessionResult?.data;
  const status = sessionResult?.status ?? 'loading';
  const { getItemCount } = useCartStore();
  const [cartCount, setCartCount] = useState(0);

  // Set mounted state
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Determine if user is logged in from NextAuth session
  const isLoggedIn = status === 'authenticated' && session?.user;

  // Get current user from NextAuth session
  const currentUser = isLoggedIn && session?.user
    ? {
      firstName: session.user.name?.split(' ')[0] || '',
      lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
      role: (session.user as { role?: string }).role || 'user'
    }
    : null;

  // Update cart count only on client side
  useEffect(() => {
    if (isMounted) {
      setCartCount(getItemCount());
    }
  }, [isMounted, getItemCount]);

  // Subscribe to cart changes
  useEffect(() => {
    if (isMounted) {
      const unsubscribe = useCartStore.subscribe((state) => {
        setCartCount(state.getItemCount());
      });
      return unsubscribe;
    }
  }, [isMounted]);

  const isActive = (path: string) => {
    if (path === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(path);
  };

  // Build the Login button's href so that a customer who clicks Login from
  // (e.g.) the cart page lands back on the cart after authenticating, instead
  // of the default /dashboard. Returns `/login` plainly when the current
  // pathname is one of: the homepage, an auth route the customer can't
  // possibly want to return to (login / register / activate / reset-password),
  // a public-marketing page that doesn't carry session state worth preserving,
  // or anything that doesn't look like a normal app path. The login form
  // already has an open-redirect guard, but we double-check here so the URL
  // bar reads cleanly when a customer is on /, /about, /privacy, etc.
  const buildLoginHref = (): string => {
    if (!pathname || pathname === '/') return '/login';
    const noReturnPrefixes = [
      '/login',
      '/register',
      '/activate',
      '/reset-password',
      '/forgot-password',
      '/403',
    ];
    if (noReturnPrefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
      return '/login';
    }
    // Same-origin safety net: pathname must start with a single forward
    // slash followed by a non-slash character. usePathname() should always
    // satisfy this, but the explicit check keeps the URL builder robust
    // against any future refactor.
    if (!/^\/[^/]/.test(pathname)) return '/login';
    return `/login?returnUrl=${encodeURIComponent(pathname)}`;
  };
  const loginHref = buildLoginHref();

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  if (variant === 'dashboard' || variant === 'admin') {
    return (
      <header className="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md shadow-lg border-b border-gray-200">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Fixed bar height (was py-4 + h-10/11 logo = 72/76px) so a larger
              logo doesn't grow the navbar or break the page's pt offset. */}
          <div className="flex justify-between items-center h-[72px] sm:h-[76px]">
            <Logo size="xl" href={variant === 'admin' ? '/admin' : '/dashboard'} />

            <div className="flex items-center space-x-4">
              <div className="hidden md:flex items-center space-x-6">
                {isMounted && (user ?? currentUser) && (
                  <>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${(user ?? currentUser)?.role === 'admin'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-blue-100 text-blue-800'
                      }`}>
                      {(user ?? currentUser)?.role?.toUpperCase()}
                    </span>
                  </>
                )}
              </div>

              {/* Cart Icon - always visible */}
              <Link
                href="/cart"
                className="relative p-2 text-gray-600 hover:text-primary-600 transition-colors duration-200"
                aria-label="Shopping Cart"
                title="Shopping Cart"
              >
                <ShoppingCart className="h-6 w-6" />
                {isMounted && cartCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-primary-600 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-medium">
                    {cartCount}
                  </span>
                )}
              </Link>

              {onLogout && (
                <button
                  onClick={onLogout}
                  className="btn btn-secondary hover:bg-gray-100 transition-colors duration-200"
                >
                  Logout
                </button>
              )}
            </div>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md shadow-lg border-b border-[var(--google-border-light)]">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Fixed bar height (was py-3/4 + h-10/11 logo = 64/76px) so a larger
            logo doesn't grow the navbar or break the page's pt offset. */}
        <div className="flex justify-between items-center h-16 sm:h-[76px]">
          <Logo size="xl" href="/" />

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-4 lg:space-x-6">
            <Link
              href="/"
              className={`font-medium transition-colors duration-200 relative group ${isActive('/')
                ? 'text-[var(--google-blue)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Home
              <span className={`absolute -bottom-1 left-0 h-0.5 transition-all duration-200 ${isActive('/') ? 'w-full' : 'w-0 group-hover:w-full'}`} style={{ backgroundColor: 'var(--google-blue)' }}></span>
            </Link>
            <Link
              href="/domains-home"
              className={`font-medium transition-colors duration-200 relative group ${isActive('/domains-home')
                ? 'text-[var(--google-blue)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Domains
              <span className={`absolute -bottom-1 left-0 h-0.5 transition-all duration-200 ${isActive('/domains-home') ? 'w-full' : 'w-0 group-hover:w-full'}`} style={{ backgroundColor: 'var(--google-blue)' }}></span>
            </Link>
            <Link
              href="/hosting"
              className={`font-medium transition-colors duration-200 relative group ${isActive('/hosting')
                ? 'text-[var(--google-blue)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Hosting
              <span className={`absolute -bottom-1 left-0 h-0.5 transition-all duration-200 ${isActive('/hosting') ? 'w-full' : 'w-0 group-hover:w-full'}`} style={{ backgroundColor: 'var(--google-blue)' }}></span>
            </Link>
            <Link
              href="/about"
              className={`font-medium transition-colors duration-200 relative group ${isActive('/about')
                ? 'text-[var(--google-blue)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              About Us
              <span className={`absolute -bottom-1 left-0 h-0.5 transition-all duration-200 ${isActive('/about') ? 'w-full' : 'w-0 group-hover:w-full'}`} style={{ backgroundColor: 'var(--google-blue)' }}></span>
            </Link>
            <Link
              href="/contact"
              className={`font-medium transition-colors duration-200 relative group ${isActive('/contact')
                ? 'text-[var(--google-blue)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Contact Us
              <span className={`absolute -bottom-1 left-0 h-0.5 transition-all duration-200 ${isActive('/contact') ? 'w-full' : 'w-0 group-hover:w-full'}`} style={{ backgroundColor: 'var(--google-blue)' }}></span>
            </Link>
          </nav>

          {/* Action Buttons */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            {/* Cart Icon - Hidden on mobile, shown in menu instead */}
            <Link
              href="/cart"
              className="hidden md:flex relative p-1.5 text-[var(--google-text-secondary)] hover:text-[var(--google-blue)] transition-colors duration-200"
              title="Shopping Cart"
            >
              <ShoppingCart className="h-6 w-6" />
              {isMounted && cartCount > 0 && (
                <span className="absolute -top-1 -right-1 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-medium" style={{ backgroundColor: 'var(--google-blue)' }}>
                  {cartCount}
                </span>
              )}
            </Link>

            {isLoggedIn ? (
              <Link
                href="/dashboard"
                className="flex items-center space-x-2 p-2 text-[var(--google-text-secondary)] hover:text-[var(--google-blue)] transition-colors duration-200 group"
                title="Go to Dashboard"
              >
                <User className="h-6 w-6" />
                <span className="hidden lg:block font-medium text-sm group-hover:text-[var(--google-blue)] transition-colors duration-200" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  Dashboard
                </span>
              </Link>
            ) : (
              <Link
                href={loginHref}
                className="px-4 py-2 rounded-lg font-medium text-white transition-all duration-200 shadow-sm hover:shadow-md"
                style={{
                  backgroundColor: 'var(--google-blue)',
                  borderColor: 'var(--google-blue)',
                  fontFamily: 'Google Sans, system-ui, sans-serif'
                }}
              >
                Login
              </Link>
            )}

            {/* Mobile menu button */}
            <button
              onClick={toggleMobileMenu}
              className="md:hidden p-2 rounded-lg text-[var(--google-text-secondary)] hover:text-[var(--google-text-primary)] hover:bg-[var(--google-bg-secondary)] transition-colors duration-200"
              aria-label="Toggle mobile menu"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={isMobileMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"}
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className={`md:hidden transition-all duration-300 ease-in-out ${isMobileMenuOpen
          ? 'max-h-[600px] opacity-100 pb-4'
          : 'max-h-0 opacity-0 overflow-hidden'
          }`}>
          <nav className="flex flex-col space-y-2 pt-4 border-t border-[var(--google-border-light)]">
            <Link
              href="/"
              onClick={closeMobileMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${isActive('/')
                ? 'text-[var(--google-blue)] bg-[var(--google-blue-light)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Home
            </Link>
            <Link
              href="/domains-home"
              onClick={closeMobileMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${isActive('/domains-home')
                ? 'text-[var(--google-blue)] bg-[var(--google-blue-light)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Domains
            </Link>
            <Link
              href="/hosting"
              onClick={closeMobileMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${isActive('/hosting')
                ? 'text-[var(--google-blue)] bg-[var(--google-blue-light)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Hosting
            </Link>
            <Link
              href="/about"
              onClick={closeMobileMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${isActive('/about')
                ? 'text-[var(--google-blue)] bg-[var(--google-blue-light)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              About Us
            </Link>
            <Link
              href="/contact"
              onClick={closeMobileMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${isActive('/contact')
                ? 'text-[var(--google-blue)] bg-[var(--google-blue-light)]'
                : 'text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)]'
                }`}
              style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
            >
              Contact Us
            </Link>
            <div className="flex flex-col space-y-2 pt-4 border-t border-[var(--google-border-light)]">
              {/* Cart in mobile menu */}
              <Link
                href="/cart"
                onClick={closeMobileMenu}
                className="flex items-center justify-between px-4 py-2 rounded-lg font-medium text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)] transition-colors duration-200"
                style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
              >
                <div className="flex items-center gap-2">
                  <ShoppingCart className="h-5 w-5" />
                  <span>Cart</span>
                </div>
                {isMounted && cartCount > 0 && (
                  <span className="text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-medium" style={{ backgroundColor: 'var(--google-blue)' }}>
                    {cartCount}
                  </span>
                )}
              </Link>
              {isLoggedIn ? (
                <Link
                  href="/dashboard"
                  onClick={closeMobileMenu}
                  className="flex items-center justify-center px-4 py-2 rounded-lg font-medium text-[var(--google-text-primary)] hover:text-[var(--google-blue)] hover:bg-[var(--google-bg-secondary)] transition-colors duration-200"
                  style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
                >
                  <User className="h-5 w-5 mr-2" />
                  <div className="flex flex-col items-start">
                    <span>Dashboard</span>
                    <span className="text-xs text-[var(--google-text-secondary)]">
                      {isMounted && currentUser ? `${currentUser.firstName} ${currentUser.lastName}` : ''}
                    </span>
                  </div>
                </Link>
              ) : (
                <Link
                  href={loginHref}
                  onClick={closeMobileMenu}
                  className="px-4 py-2 rounded-lg font-medium text-white transition-all duration-200 shadow-sm hover:shadow-md text-center"
                  style={{
                    backgroundColor: 'var(--google-blue)',
                    borderColor: 'var(--google-blue)',
                    fontFamily: 'Google Sans, system-ui, sans-serif'
                  }}
                >
                  Login
                </Link>
              )}
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
}
