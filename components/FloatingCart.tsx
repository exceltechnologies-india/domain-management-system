'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';
import { safeLocalStorage } from '@/lib/storage';
import { useCartStore } from '@/store/cartStore';

export default function FloatingCart() {
  const [isMounted, setIsMounted] = useState(false);
  const [cartCount, setCartCount] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const pathname = usePathname();
  const { getItemCount } = useCartStore();

  useEffect(() => {
    setIsMounted(true);

    // Check if user is admin
    const userData = safeLocalStorage.getItem('user');
    if (userData) {
      try {
        const userObj = JSON.parse(userData);
        setIsAdmin(userObj.role === 'admin');
      } catch (error) {
        // Error parsing user data
      }
    }
  }, []);

  // Update cart count
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

  // Don't render on server, if user is admin, if on admin routes, or on invoice view pages
  const isAdminRoute = pathname?.startsWith('/admin');
  const isInvoiceView = pathname?.includes('/dashboard/invoices/') && pathname?.includes('/view');

  if (!isMounted || isAdmin || isAdminRoute || isInvoiceView) {
    return null;
  }

  return (
    <Link
      href="/cart"
      className={`md:hidden fixed bottom-6 right-6 z-50 text-white rounded-full p-4 shadow-2xl hover:shadow-xl transition-all duration-300 transform hover:scale-110 active:scale-95 ${cartCount > 0 ? 'bg-green-600 hover:bg-green-700 animate-cart-flash' : 'bg-primary-600 hover:bg-primary-700'
        }`}
      style={{
        boxShadow: '0 10px 40px rgb(var(--primary-600) / 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1)',
      }}
      title="View Cart"
    >
      <ShoppingCart className="h-6 w-6" />
      {cartCount > 0 && (
        <span
          className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full h-6 w-6 flex items-center justify-center border-2 border-white animate-pulse"
          style={{
            fontFamily: 'Google Sans, system-ui, sans-serif',
            boxShadow: '0 2px 8px rgba(239, 68, 68, 0.4)',
          }}
        >
          {cartCount > 9 ? '9+' : cartCount}
        </span>
      )}
    </Link>
  );
}

