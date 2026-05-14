import toast from "react-hot-toast";
import { signOut } from "next-auth/react";
import { useCallback } from "react";
import { safeLocalStorage, safeSessionStorage } from "@/lib/storage";
import { logger } from "@/lib/logger";

/**
 * Direct logout function that can be called without hooks
 */
export const performLogout = async () => {
  try {
    // Set logout flag to prevent AuthSync from re-syncing
    safeSessionStorage.setItem('isLoggingOut', 'true');

    // Sign out from NextAuth (handles social login sessions)
    try {
      await signOut({ redirect: false });
    } catch (signOutError) {
      logger.warn('NextAuth signOut failed, continuing with logout:', signOutError);
    }

    // Clear all localStorage and sessionStorage data
    safeLocalStorage.removeItem('token');
    safeLocalStorage.removeItem('user');
    safeLocalStorage.removeItem('rememberMe');
    safeLocalStorage.removeItem('savedEmail');
    safeSessionStorage.clear();

    // Clear all cookies by setting them to expire
    const cookiesToClear = [
      'token',
      'next-auth.session-token',
      'next-auth.callback-url',
      'next-auth.csrf-token',
      '__Secure-next-auth.session-token',
      '__Host-next-auth.csrf-token'
    ];

    cookiesToClear.forEach(cookieName => {
      document.cookie = `${cookieName}=; path=/; max-age=0; SameSite=Lax`;
      document.cookie = `${cookieName}=; path=/; max-age=0; SameSite=Lax; domain=${window.location.hostname}`;
    });

    // Show success message
    toast.success('Logged out successfully');

    // Direct redirect to login
    setTimeout(() => {
      window.location.replace('/login');
    }, 500);

  } catch (error) {
    // Clear the flag even on error
    safeSessionStorage.removeItem('isLoggingOut');
    
    // Fallback: clear everything and redirect
    try {
      await signOut({ redirect: false });
    } catch (e) {
      // Silent fallback
    }
    safeLocalStorage.clear();
    document.cookie.split(";").forEach(function (c) {
      document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
    toast.success('Logged out successfully');
    setTimeout(() => {
      window.location.replace('/login');
    }, 500);
  }
};

/**
 * Simple logout utility - same process for all users
 */
export const useLogout = () => {
  // Use the performLogout function wrapped in useCallback for stability
  const logout = useCallback(() => performLogout(), []);

  return logout;
};

/**
 * Simple logout function - SAME process for ALL users (social + credential)
 */
export const logoutUser = async () => {
  try {
    // Set logout flag to prevent AuthSync from re-syncing
    safeSessionStorage.setItem('isLoggingOut', 'true');

    // Sign out from NextAuth (handles social login sessions)
    await signOut({ redirect: false });

    // Clear all localStorage and sessionStorage data
    safeLocalStorage.removeItem('token');
    safeLocalStorage.removeItem('user');
    safeLocalStorage.removeItem('rememberMe');
    safeLocalStorage.removeItem('savedEmail');
    safeSessionStorage.clear();

    // Clear all cookies
    const cookiesToClear = [
      'token',
      'next-auth.session-token',
      'next-auth.callback-url',
      'next-auth.csrf-token',
      '__Secure-next-auth.session-token',
      '__Host-next-auth.csrf-token'
    ];

    cookiesToClear.forEach(cookieName => {
      document.cookie = `${cookieName}=; path=/; max-age=0; SameSite=Lax`;
      document.cookie = `${cookieName}=; path=/; max-age=0; SameSite=Lax; domain=${window.location.hostname}`;
    });

    // Show success message
    toast.success('Logged out successfully');

    // Direct redirect to login
    window.location.replace('/login');

  } catch (error) {
    // Clear the flag even on error
    safeSessionStorage.removeItem('isLoggingOut');
    
    // Fallback: clear everything and redirect
    try {
      await signOut({ redirect: false });
    } catch (e) {
      // Silent fallback
    }
    safeLocalStorage.clear();
    document.cookie.split(";").forEach(function (c) {
      document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
    toast.success('Logged out successfully');
    setTimeout(() => {
      window.location.replace('/login');
    }, 500);
  }
};