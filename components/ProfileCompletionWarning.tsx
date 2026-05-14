"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AlertTriangle, X } from "lucide-react";
import { safeLocalStorage } from '@/lib/storage';

interface ProfileCompletionWarningProps {
  className?: string;
  /** After completing profile, user is redirected here. Defaults to staying on settings. */
  returnUrl?: string;
}

interface User {
  phone?: string;
  phoneCc?: string;
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    country?: string;
    zipcode?: string;
  };
  profileCompleted?: boolean;
}

interface MissingFields {
  phone: boolean;
  address: boolean;
}

function getMissingFields(userData: User): MissingFields {
  return {
    phone: !(userData.phone && userData.phone.trim() !== '' && userData.phoneCc && userData.phoneCc.trim() !== ''),
    address: !(userData.address?.line1 && userData.address.line1.trim() !== ''),
  };
}

function isProfileComplete(userData: User): boolean {
  if (userData.profileCompleted === true) return true;
  const missing = getMissingFields(userData);
  return !missing.phone && !missing.address;
}

export default function ProfileCompletionWarning({ className = "", returnUrl }: ProfileCompletionWarningProps) {
  const sessionResult = useSession();
  const session = sessionResult?.data;
  const router = useRouter();
  const [showWarning, setShowWarning] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [missingFields, setMissingFields] = useState<MissingFields>({ phone: false, address: false });

  useEffect(() => {
    const checkUserProfile = () => {
      let userData: User | null = null;
      const localUserData = safeLocalStorage.getItem('user');
      let local: User | null = null;
      if (localUserData) {
        try { local = JSON.parse(localUserData); } catch { }
      }

      if (session?.user) {
        userData = { ...(session.user as unknown as User), ...(local ?? {}) };
      } else if (local) {
        userData = local;
      }

      if (!userData) {
        setShowWarning(false);
        return;
      }

      if (!isProfileComplete(userData) && !isDismissed) {
        setMissingFields(getMissingFields(userData));
        setShowWarning(true);
      } else {
        setShowWarning(false);
      }
    };

    checkUserProfile();

    const handleStorageChange = (e: StorageEvent) => { if (e.key === 'user') checkUserProfile(); };
    const handleProfileUpdate = () => checkUserProfile();

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('profileUpdated', handleProfileUpdate);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('profileUpdated', handleProfileUpdate);
    };
  }, [session, isDismissed]);

  const handleCompleteProfile = () => {
    const url = returnUrl
      ? `/dashboard/settings?returnUrl=${encodeURIComponent(returnUrl)}`
      : '/dashboard/settings';
    router.push(url);
  };

  const handleDismiss = () => {
    setIsDismissed(true);
    setShowWarning(false);
  };

  if (!showWarning) return null;

  const missingList = [
    missingFields.phone && 'phone number',
    missingFields.address && 'address',
  ].filter(Boolean).join(' and ');

  return (
    <div className={`bg-amber-50 border border-amber-200 rounded-xl p-3 sm:p-4 mb-6 shadow-sm ${className}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-amber-900">
                Complete your profile to checkout
              </h3>
              {missingList && (
                <p className="mt-0.5 text-sm text-amber-800">
                  Your <strong>{missingList}</strong> {missingList.includes('and') ? 'are' : 'is'} missing — required for domain registration.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
              <button
                onClick={handleCompleteProfile}
                className="bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold transition-all shadow-sm hover:shadow active:scale-95 whitespace-nowrap"
              >
                Complete now →
              </button>
              <button
                onClick={handleDismiss}
                className="text-amber-400 hover:text-amber-600 p-1.5 hover:bg-amber-100 rounded-full transition-colors"
                title="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
