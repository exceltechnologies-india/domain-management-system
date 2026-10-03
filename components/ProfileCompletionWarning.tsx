"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AlertTriangle, X } from "lucide-react";
import { safeLocalStorage } from '@/lib/storage';
import { apiClient } from '@/lib/api-client';

interface ProfileCompletionWarningProps {
  className?: string;
  /** After completing profile, user is redirected here. Defaults to staying on settings. */
  returnUrl?: string;
  /**
   * Show only to a customer who has at least one domain (Pawan, 3 Oct 2026: "hide the banner for
   * customers who have no domains; when they try to buy a domain, prompt them"). Phone and address
   * are needed only to register a domain, so a hosting-only customer is not nagged; buying a
   * domain asks for them at checkout instead. Used by the panel shell.
   */
  onlyWithDomains?: boolean;
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

export default function ProfileCompletionWarning({ className = "", returnUrl, onlyWithDomains = false }: ProfileCompletionWarningProps) {
  const sessionResult = useSession();
  const session = sessionResult?.data;
  const router = useRouter();
  const [showWarning, setShowWarning] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [missingFields, setMissingFields] = useState<MissingFields>({ phone: false, address: false });
  /* What the account REALLY holds (3 Oct 2026). The login session carries `profileCompleted` but
     not the phone or address, so for a buyer whose profile is not complete — e.g. one created
     from a ResellerOS order, which sends a mobile but no address for hosting — the banner said
     "phone number missing" while the number was saved. Asked once, only when needed. */
  const [server, setServer] = useState<User | null>(null);
  const needsServer = Boolean(session?.user) && (session?.user as { profileCompleted?: boolean } | undefined)?.profileCompleted !== true;

  /* null = not known yet. Asked once, and only when the banner might show. */
  const [hasDomains, setHasDomains] = useState<boolean | null>(null);
  useEffect(() => {
    if (!onlyWithDomains || !needsServer || hasDomains !== null) return;
    let cancelled = false;
    void apiClient.get<{ total?: number; domains?: unknown[] }>('/api/v1/user/domains?limit=1').then((res) => {
      if (cancelled) return;
      // Unknown (request failed) → stay quiet: the domain checkout still asks for the address.
      setHasDomains(res.ok ? (res.data.total ?? res.data.domains?.length ?? 0) > 0 : false);
    }).catch(() => { if (!cancelled) setHasDomains(false); });
    return () => { cancelled = true; };
  }, [onlyWithDomains, needsServer, hasDomains]);

  useEffect(() => {
    if (!needsServer || server) return;
    let cancelled = false;
    void apiClient.get<{ user?: User }>('/api/v1/auth/me').then((res) => {
      if (!cancelled && res.ok && res.data.user) {
        const u = res.data.user;
        setServer({ phone: u.phone, phoneCc: u.phoneCc, address: u.address, profileCompleted: u.profileCompleted });
      }
    }).catch(() => { /* keep what the session and the browser copy say */ });
    return () => { cancelled = true; };
  }, [needsServer, server]);

  useEffect(() => {
    const checkUserProfile = () => {
      let userData: User | null = null;
      const localUserData = safeLocalStorage.getItem('user');
      let local: User | null = null;
      if (localUserData) {
        try { local = JSON.parse(localUserData); } catch { }
      }

      if (session?.user) {
        // The saved account wins over the session and the browser copy.
        userData = { ...(session.user as unknown as User), ...(local ?? {}), ...(server ?? {}) };
      } else if (local) {
        userData = local;
      }

      if (!userData) {
        setShowWarning(false);
        return;
      }

      if (onlyWithDomains && hasDomains !== true) {
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
  }, [session, isDismissed, server, onlyWithDomains, hasDomains]);

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
    <div className={`bg-amber-soft border border-amber/30 rounded-xl p-3 sm:p-4 mb-6 shadow-sm ${className}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-amber-ink">
                Complete your profile to checkout
              </h3>
              {missingList && (
                <p className="mt-0.5 text-sm text-amber-ink">
                  Your <strong>{missingList}</strong> {missingList.includes('and') ? 'are' : 'is'} missing — required for domain registration.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
              <button
                onClick={handleCompleteProfile}
                className="bg-amber hover:bg-amber/90 text-paper px-3 py-1.5 rounded-lg text-sm font-semibold transition-all shadow-sm hover:shadow active:scale-95 whitespace-nowrap"
              >
                Complete now →
              </button>
              <button
                onClick={handleDismiss}
                className="text-amber hover:text-amber-ink p-1.5 hover:bg-amber/15 rounded-full transition-colors"
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
