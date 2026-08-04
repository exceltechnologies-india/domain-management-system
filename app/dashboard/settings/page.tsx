'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { safeLocalStorage } from '@/lib/storage';
import { performLogout } from '@/lib/logout';
import {
  User, Mail, Phone, MapPin, Shield, Key, Save,
  Eye, EyeOff, CreditCard, AlertCircle, Building, Navigation,
  ShieldCheck, ShieldOff, QrCode, KeyRound, Copy, CheckCircle, Download, MessageCircle,
  Receipt,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { INDIAN_STATES, normaliseIndianState } from '@/lib/constants';
import { InputValidator } from '@/lib/validation';
import { apiClient } from '@/lib/api-client';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, SettingsPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';

interface User {
  id?: string;
  email: string;
  firstName: string;
  lastName: string;
  role?: string;
  phone?: string;
  phoneCc?: string;
  whatsappNumber?: string;
  whatsappOptOut?: boolean;
  emailOptOut?: boolean;
  companyName?: string;
  gstNumber?: string;
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    country?: string;
    zipcode?: string;
  };
  profileCompleted?: boolean;
}

interface UserSettings {
  security: {};
}

type ActiveSection = 'profile' | 'billing' | 'security';

// ── Small reusable pieces ────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium text-gray-700 mb-1.5">
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode }) {
  const { icon, className = '', ...rest } = props;
  if (icon) {
    return (
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">{icon}</span>
        <input
          {...rest}
          className={`w-full pl-10 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow ${className}`}
        />
      </div>
    );
  }
  return (
    <input
      {...rest}
      className={`w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow ${className}`}
    />
  );
}

function SectionCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
    </div>
  );
}

function SaveRow({ isDirty, isSaving, onClick, label = 'Save Changes' }: {
  isDirty?: boolean; isSaving: boolean; onClick: () => void; label?: string;
}) {
  return (
    <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60 flex items-center justify-end gap-3">
      {isDirty && !isSaving && (
        <span className="text-xs font-medium text-amber-600">Unsaved changes</span>
      )}
      <button
        onClick={onClick}
        disabled={isSaving}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors shadow-sm"
      >
        {isSaving ? (
          <><div className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />Saving…</>
        ) : (
          <><Save className="h-4 w-4" />{label}</>
        )}
      </button>
    </div>
  );
}

// ── Phone field (country prefix + input) ────────────────────────────────────
function PhoneField({
  value, onChange, error, placeholder = 'Enter number',
}: { value: string; onChange: (v: string) => void; error?: string; placeholder?: string }) {
  return (
    <div>
      <div className="flex">
        <span className="flex items-center px-3 py-2.5 border border-r-0 border-gray-200 rounded-l-xl bg-gray-50 text-sm text-gray-600 font-medium whitespace-nowrap select-none">
          🇮🇳 +91
        </span>
        <input
          type="tel"
          inputMode="numeric"
          pattern="[0-9]{10}"
          maxLength={10}
          value={value}
          onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
          placeholder={placeholder}
          className={`flex-1 px-3 py-2.5 border rounded-r-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow ${error ? 'border-red-300' : 'border-gray-200'}`}
        />
      </div>
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function UserSettings() {
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [activeSection, setActiveSection] = useState<ActiveSection>('profile');
  const [passwordData, setPasswordData] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [phoneError, setPhoneError] = useState('');
  const [whatsappError, setWhatsappError] = useState('');
  const [hasExistingPassword, setHasExistingPassword] = useState(true);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);

  // 2FA state
  type TotpStep = 'status' | 'scan' | 'verify' | 'backup' | 'disable';
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [totpStep, setTotpStep] = useState<TotpStep>('status');
  const [totpQrUrl, setTotpQrUrl] = useState('');
  const [totpManualKey, setTotpManualKey] = useState('');
  const [totpShowManualKey, setTotpShowManualKey] = useState(false);
  const [totpVerifyCode, setTotpVerifyCode] = useState('');
  const [totpBackupCodes, setTotpBackupCodes] = useState<string[]>([]);
  const [totpDisableCode, setTotpDisableCode] = useState('');
  const [totpDisablePassword, setTotpDisablePassword] = useState('');
  const [totpShowDisablePassword, setTotpShowDisablePassword] = useState(false);
  const [totpIsLoading, setTotpIsLoading] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  // Per-section dirty flags for the Profile tab so each card's "Save Changes"
  // only lights up for ITS own edits (name vs contact), and a single save
  // spinner shows on the clicked card only — not both. (The whole user record
  // is still persisted in one call; the WhatsApp number is required by the
  // server, so we can't send an identity-only payload.)
  const [identityDirty, setIdentityDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  // Billing tab: Business Details (company/GST) + Address are also two
  // separate cards, each with its own Save — same per-section treatment.
  const [businessDirty, setBusinessDirty] = useState(false);
  const [addressDirty, setAddressDirty] = useState(false);
  const [savingSection, setSavingSection] = useState<'identity' | 'contact' | 'business' | 'address' | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  // After a successful profile save, bounce the customer back to the page
  // that sent them here (cart, checkout, etc.). Only same-origin paths are
  // honoured — anything else (absolute URL, // protocol-relative, javascript:,
  // etc.) falls back to the default /dashboard destination as an
  // open-redirect guard.
  const rawReturnUrl = searchParams?.get('returnUrl') ?? null;
  const postSaveDestination =
    rawReturnUrl && /^\/[^/]/.test(rawReturnUrl) ? rawReturnUrl : '/dashboard';
  const { data: session, status } = useSession();
  const isLoadingSettings = useRef(false);
  const hasLoadedOnce = useRef(false);
  const savedUserRef = useRef<string | null>(null);

  // ── Data loading ─────────────────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    if (isLoadingSettings.current) return;
    try {
      isLoadingSettings.current = true;
      setIsLoading(true);

      const settingsResult = await apiClient.get<UserSettings & { profile?: Record<string, string> }>('/api/v1/user/settings');
      if (settingsResult.ok) {
        const data = settingsResult.data;
        setSettings(data);
        if (data.profile) {
          const profile = data.profile;
          setUser(prev => prev ? {
            ...prev,
            firstName: profile.firstName || prev.firstName,
            lastName: profile.lastName || prev.lastName,
            email: profile.email || prev.email,
            phone: profile.phone || prev.phone,
            phoneCc: profile.phoneCc || prev.phoneCc || '+91',
            whatsappNumber: profile.whatsappNumber ?? prev.whatsappNumber ?? '',
            // profile is loosely typed (Record<string,string>) though the
            // server sends a real boolean — String()===  'true' coerces
            // both a JSON boolean true and a "true" string safely.
            whatsappOptOut: String(profile.whatsappOptOut) === 'true',
            emailOptOut: String(profile.emailOptOut) === 'true',
            companyName: profile.company || prev.companyName,
            gstNumber: profile.gstNumber || prev.gstNumber || '',
            address: {
              line1: profile.address || prev.address?.line1 || '',
              city: profile.city || prev.address?.city || '',
              state: profile.state || prev.address?.state || '',
              country: profile.country || prev.address?.country || 'IN',
              zipcode: profile.zipCode || prev.address?.zipcode || '',
            },
          } : null);
        }
      } else {
        setSettings({ security: {} });
      }

      const meResult = await apiClient.get<{ user?: Record<string, unknown> & { id?: string; password?: boolean; provider?: string; profileCompleted?: boolean } }>('/api/v1/auth/me');
      if (meResult.ok && meResult.data.user) {
        const meUser = meResult.data.user;
        setHasExistingPassword(meUser.password === true);
        setUser(prev => ({ ...prev, ...meUser, id: meUser.id || prev?.id } as User));
        try {
          const existing = safeLocalStorage.getItem('user');
          if (existing) {
            const parsed = JSON.parse(existing);
            safeLocalStorage.setItem('user', JSON.stringify({ ...parsed, provider: meUser.provider, profileCompleted: meUser.profileCompleted }));
          }
        } catch {}
      }
    } catch { toast.error('Failed to load settings'); }
    finally { setIsLoading(false); isLoadingSettings.current = false; hasLoadedOnce.current = true; }
  }, []);

  useEffect(() => {
    if (status === 'loading' || hasLoadedOnce.current) return;
    if (session?.user) {
      const sessionUser = session.user;
      setUser({ id: sessionUser.id || '', email: sessionUser.email || '', firstName: sessionUser.name?.split(' ')[0] || '', lastName: sessionUser.name?.split(' ').slice(1).join(' ') || '', role: sessionUser.role || 'user' });
      void loadSettings(); return;
    }
    router.push('/login');
  }, [router, session, status, loadSettings]);

  useEffect(() => {
    if (!isLoading && user && savedUserRef.current === null) savedUserRef.current = JSON.stringify(user);
  }, [isLoading, user]);

  useEffect(() => {
    if (savedUserRef.current === null) return;
    setIsDirty(JSON.stringify(user) !== savedUserRef.current || !!passwordData.newPassword || !!passwordData.currentPassword);
    // Per-section dirty: compare only each card's own fields against the
    // last-saved snapshot so Personal Information and Contact Numbers light up
    // (and clear) independently.
    try {
      const saved = JSON.parse(savedUserRef.current);
      setIdentityDirty(
        !!user && ((user.firstName || '') !== (saved.firstName || '') || (user.lastName || '') !== (saved.lastName || '')),
      );
      setContactDirty(
        !!user && (
          (user.whatsappNumber || '') !== (saved.whatsappNumber || '') ||
          (user.phone || '') !== (saved.phone || '') ||
          user.whatsappOptOut !== saved.whatsappOptOut ||
          user.emailOptOut !== saved.emailOptOut
        ),
      );
      setBusinessDirty(
        !!user && ((user.companyName || '') !== (saved.companyName || '') || (user.gstNumber || '') !== (saved.gstNumber || '')),
      );
      const a = user?.address || {};
      const sa = saved.address || {};
      setAddressDirty(
        !!user && (
          (a.line1 || '') !== (sa.line1 || '') ||
          (a.city || '') !== (sa.city || '') ||
          (a.state || '') !== (sa.state || '') ||
          (a.zipcode || '') !== (sa.zipcode || '')
        ),
      );
    } catch { /* snapshot not parseable yet — leave section flags as-is */ }
  }, [user, passwordData]);

  useEffect(() => {
    if (!isDirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [isDirty]);

  useEffect(() => {
    if (activeSection !== 'security' || totpEnabled !== null) return;
    void (async () => {
      const result = await apiClient.get<{ totpEnabled?: boolean }>('/api/v1/auth/totp/setup');
      setTotpEnabled(result.ok ? (result.data.totpEnabled ?? false) : false);
    })();
  }, [activeSection, totpEnabled]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleTotpStartSetup = async () => {
    setTotpIsLoading(true);
    const result = await apiClient.post<{ qrCodeDataUrl?: string; manualKey?: string }>('/api/v1/auth/totp/setup', undefined);
    if (result.ok) {
      setTotpQrUrl(result.data.qrCodeDataUrl ?? '');
      setTotpManualKey(result.data.manualKey ?? '');
      setTotpStep('scan');
    } else {
      toast.error(result.error.message || 'Setup failed');
    }
    setTotpIsLoading(false);
  };

  const handleTotpConfirm = async () => {
    if (totpVerifyCode.length !== 6) { toast.error('Enter the 6-digit code from your authenticator app'); return; }
    setTotpIsLoading(true);
    const result = await apiClient.post<{ backupCodes?: string[] }>('/api/v1/auth/totp/confirm', { code: totpVerifyCode });
    if (result.ok) {
      setTotpBackupCodes(result.data.backupCodes ?? []);
      setTotpEnabled(true);
      setTotpStep('backup');
    } else {
      toast.error(result.error.message || 'Verification failed');
      setTotpVerifyCode('');
    }
    setTotpIsLoading(false);
  };

  const handleTotpDisable = async () => {
    if (!totpDisableCode || !totpDisablePassword) { toast.error('Both fields are required'); return; }
    setTotpIsLoading(true);
    const result = await apiClient.post('/api/v1/auth/totp/disable', { code: totpDisableCode, password: totpDisablePassword });
    if (result.ok) {
      setTotpEnabled(false); setTotpStep('status'); setTotpDisableCode(''); setTotpDisablePassword('');
      toast.success('Two-factor authentication disabled');
    } else {
      toast.error(result.error.message || 'Could not disable 2FA');
    }
    setTotpIsLoading(false);
  };

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Copied to clipboard'));

  const downloadBackupCodes = () => {
    const blob = new Blob([totpBackupCodes.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'anutech-2fa-backup-codes.txt'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleChangePassword = async () => {
    if (hasExistingPassword && !passwordData.currentPassword) { toast.error('Please enter your current password'); return; }
    if (!passwordData.newPassword) { toast.error('Please enter a new password'); return; }
    const v = InputValidator.validatePasswordStrength(passwordData.newPassword);
    if (!v.isValid) { toast.error(v.errors[0]); return; }
    if (hasExistingPassword && passwordData.currentPassword === passwordData.newPassword) { toast.error('New password must be different from your current password'); return; }
    if (passwordData.newPassword !== passwordData.confirmPassword) { toast.error('Passwords do not match'); return; }
    setIsSaving(true);
    const result = await apiClient.put('/api/v1/user/settings', { password: { currentPassword: hasExistingPassword ? passwordData.currentPassword : undefined, newPassword: passwordData.newPassword } });
    if (result.ok) {
      toast.success(hasExistingPassword ? 'Password changed successfully' : 'Password set successfully!');
      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' }); setHasExistingPassword(true);
    } else {
      toast.error(result.error.message || 'Failed to update password');
    }
    setIsSaving(false);
  };

  const handleUpdateProfile = async (updatedUser: Partial<User>, section: 'identity' | 'contact' | 'business' | 'address' | null = null) => {
    // WhatsApp number is REQUIRED (used for renewal reminders + marketing).
    // The phone number is optional — it auto-fills from WhatsApp (here and on
    // the server) so one number covers both.
    const wa = (updatedUser.whatsappNumber || '').trim();
    if (!wa || wa.length !== 10) {
      setWhatsappError(wa.length === 0 ? 'WhatsApp number is required' : 'Enter a 10-digit WhatsApp number');
      setActiveSection('profile');
      toast.error('Please add a valid 10-digit WhatsApp number');
      return;
    }
    setWhatsappError('');
    try {
      setIsSaving(true);
      setSavingSection(section);
      const profileData = { ...updatedUser, phoneCc: '+91', address: { ...updatedUser.address, country: 'IN' } };
      const result = await apiClient.put<{ user?: Record<string, unknown> & { profileCompleted?: boolean } }>('/api/v1/user/settings', { profile: profileData });
      if (result.ok) {
        const serverUser = result.data.user;
        const isComplete = serverUser?.profileCompleted ?? false;
        const updated = { ...user, ...profileData, ...(serverUser || {}), profileCompleted: isComplete, email: profileData.email || user?.email || '', firstName: profileData.firstName || user?.firstName || '', lastName: profileData.lastName || user?.lastName || '' };
        setUser(updated); savedUserRef.current = JSON.stringify(updated); setIsDirty(false);
        safeLocalStorage.setItem('user', JSON.stringify(updated));
        window.dispatchEvent(new CustomEvent('profileUpdated', { detail: { user: updated, isComplete } }));

        if (isComplete) {
          // Profile is complete — go to the returnUrl (cart, hosting flow,
          // wherever the customer was sent here from) or fall back to
          // /dashboard.
          const dest = postSaveDestination;
          toast.success(
            dest !== '/dashboard'
              ? 'Profile completed! Taking you back to your cart...'
              : 'Profile completed!'
          );
          setTimeout(() => router.push(dest), 1500);
        } else {
          // Profile still incomplete after this save — DON'T bounce to
          // /dashboard. Previous behaviour redirected to /dashboard, which
          // then re-prompted "Complete your profile" → landed back on
          // settings → user never saw which field was actually missing
          // (the senior reviewer's report on 2026-06-22). Instead, switch
          // to the section that contains the next missing field, surface
          // a targeted toast naming the gap, and let the customer fill
          // it in without leaving the page.
          const addr = (updated.address || {}) as { line1?: string; city?: string; state?: string; zipcode?: string };
          const missingAddress = !addr.line1?.trim() || !addr.city?.trim() || !addr.state?.trim() || !addr.zipcode?.trim();
          const missingPhone = !updated.phone?.trim();

          if (missingAddress) {
            setActiveSection('billing');
            toast.success('Saved. Please also add your billing address to complete your profile.');
          } else if (missingPhone) {
            // Stay on the profile tab; the contact-numbers section is here.
            toast.success('Saved. Please also add a phone number to complete your profile.');
          } else {
            // No specific known gap — just acknowledge the save.
            toast.success('Profile updated.');
          }
        }
      } else {
        toast.error(result.error.message || 'Failed to update profile');
      }
    } catch { toast.error('Failed to update profile'); }
    finally { setIsSaving(false); setSavingSection(null); }
  };

  const handleDetectLocation = () => {
    if (!navigator.geolocation) { toast.error('Geolocation is not supported by your browser'); return; }
    setIsDetectingLocation(true);
    const t = toast.loading('Detecting your location…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=en`, { headers: { 'Accept': 'application/json', 'User-Agent': 'Anutech Digital Private Limited' } });
          if (!res.ok) throw new Error();
          const data = await res.json();
          const addr = data.address;
          // Normalise the reverse-geocoded state against INDIAN_STATES so
          // "NCT of Delhi" / "Orissa" / etc. resolve to the dropdown's
          // canonical option. Empty string keeps the existing value
          // unchanged — never poisons the dropdown with a non-matching
          // raw string (was the bug on 2026-06-22).
          setUser(prev => prev ? { ...prev, address: { ...prev.address, line1: [addr.house_number, addr.road || addr.street, addr.neighbourhood].filter(Boolean).join(', ') || prev.address?.line1 || '', city: addr.city || addr.town || addr.village || prev.address?.city || '', state: normaliseIndianState(addr.state) || prev.address?.state || '', zipcode: addr.postcode || prev.address?.zipcode || '', country: 'IN' } } : null);
          toast.success('Location detected!', { id: t });
        } catch { toast.error('Could not get address from location', { id: t }); }
        finally { setIsDetectingLocation(false); }
      },
      (err) => {
        const msgs: Record<number, string> = { 1: 'Location permission denied', 2: 'Location unavailable', 3: 'Location request timed out' };
        toast.error(msgs[err.code] || 'Failed to detect location', { id: t });
        setIsDetectingLocation(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  if (!user) return <DashboardLayoutSkeleton><SettingsPageSkeleton /></DashboardLayoutSkeleton>;

  const initials = `${user.firstName?.charAt(0) || ''}${user.lastName?.charAt(0) || ''}`.toUpperCase();

  const navItems: { id: ActiveSection; label: string; icon: React.ElementType; description: string }[] = [
    { id: 'profile',  label: 'Profile',           icon: User,    description: 'Name, email & contact' },
    { id: 'billing',  label: 'Billing & Address',  icon: Receipt, description: 'Company, GST & address' },
    { id: 'security', label: 'Security',           icon: Shield,  description: 'Password & 2FA' },
  ];

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout} isLoading={isLoading}>
        <div className="p-6 space-y-6">

          {/* ── Page header ── */}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Account Settings</h1>
            <p className="text-sm text-gray-500 mt-1">Manage your profile, billing details and security</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">

            {/* ── Left nav ── */}
            <aside className="lg:col-span-1 space-y-1">
              {/* User card */}
              <div className="flex items-center gap-3 px-3 py-4 mb-3">
                <div className="h-11 w-11 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm shrink-0">
                  <span className="text-sm font-bold text-white">{initials || 'U'}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{user.firstName} {user.lastName}</p>
                  <p className="text-xs text-gray-400 truncate">{user.email}</p>
                </div>
              </div>

              {navItems.map(({ id, label, icon: Icon, description }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all ${
                    activeSection === id
                      ? 'bg-blue-50 border border-blue-200 text-blue-700 shadow-sm'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 border border-transparent'
                  }`}
                >
                  <div className={`p-1.5 rounded-lg ${activeSection === id ? 'bg-blue-100' : 'bg-gray-100'}`}>
                    <Icon className={`h-4 w-4 ${activeSection === id ? 'text-blue-600' : 'text-gray-500'}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium leading-none">{label}</p>
                    <p className={`text-xs mt-0.5 ${activeSection === id ? 'text-blue-500' : 'text-gray-400'}`}>{description}</p>
                  </div>
                </button>
              ))}
            </aside>

            {/* ── Content ── */}
            <div className="lg:col-span-3 space-y-5">

              {/* ════ PROFILE ════ */}
              {activeSection === 'profile' && (
                <>
                  {/* Identity */}
                  <SectionCard>
                    <CardHeader title="Personal Information" description="How your name appears across the platform" />
                    <div className="p-6 space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>First Name</FieldLabel>
                          <Input value={user.firstName} onChange={e => setUser(p => p ? { ...p, firstName: e.target.value } : null)} placeholder="First name" />
                        </div>
                        <div>
                          <FieldLabel>Last Name</FieldLabel>
                          <Input value={user.lastName} onChange={e => setUser(p => p ? { ...p, lastName: e.target.value } : null)} placeholder="Last name" />
                        </div>
                      </div>

                      <div>
                        <FieldLabel>Email Address</FieldLabel>
                        <Input
                          icon={<Mail className="h-4 w-4" />}
                          type="email"
                          value={user.email}
                          disabled
                          className="bg-gray-50 text-gray-400 cursor-not-allowed"
                        />
                        <p className="text-xs text-gray-400 mt-1">Email address cannot be changed</p>
                      </div>
                    </div>
                    <SaveRow isDirty={identityDirty} isSaving={savingSection === 'identity'} onClick={() => handleUpdateProfile(user, 'identity')} />
                  </SectionCard>

                  {/* Contact */}
                  <SectionCard>
                    <CardHeader title="Contact Numbers" description="Used for order updates and renewal reminders" />
                    <div className="p-6 space-y-5">
                      {/* WhatsApp is the PRIMARY contact — shown first to
                          signal we prioritise it; phone follows below. */}
                      <div>
                        <FieldLabel>
                          WhatsApp Number <span className="text-red-500">*</span>{' '}
                          <span className="ml-1.5 text-xs font-normal text-green-600 bg-green-50 px-1.5 py-0.5 rounded-md">
                            Required · renewal reminders
                          </span>
                        </FieldLabel>
                        <PhoneField
                          value={user.whatsappNumber || ''}
                          error={whatsappError}
                          onChange={v => setUser(p => {
                            if (!p) return null;
                            setWhatsappError(v.length === 0 ? 'WhatsApp number is required' : v.length !== 10 ? 'Enter a 10-digit WhatsApp number' : '');
                            // Auto-fill the phone number from WhatsApp so a
                            // user only has to enter one number. Mirror while
                            // phone is empty OR still equals the WhatsApp value
                            // (i.e. it's been mirroring) — this keeps mirroring
                            // correct mid-typing. Once the user types a DIFFERENT
                            // phone number, we stop touching it (they want two
                            // distinct numbers). Server-side save enforces the
                            // same fallback as a safety net.
                            const wasMirroring = !p.phone || p.phone === p.whatsappNumber;
                            if (wasMirroring) {
                              setPhoneError(v.length > 0 && v.length !== 10 ? 'Enter 10-digit mobile number' : '');
                              return { ...p, whatsappNumber: v, phone: v };
                            }
                            return { ...p, whatsappNumber: v };
                          })}
                          placeholder="10-digit WhatsApp number"
                        />
                        <p className="text-xs text-gray-500 mt-1.5">Required. We use this for renewal reminders and account updates — and it doubles as your contact number for domain purposes.</p>
                        <p className="text-xs text-gray-400 mt-1.5">We&apos;ll send renewal reminders and updates here. You can turn off WhatsApp messages below if you prefer email only.</p>

                        {/* Phone — optional secondary contact, shown AFTER
                            WhatsApp so the UI signals WhatsApp is prioritised. */}
                        <div className="mt-5">
                          <FieldLabel>Phone Number <span className="font-normal text-gray-400">(optional)</span></FieldLabel>
                          <PhoneField
                            value={user.phone || ''}
                            onChange={v => {
                              setUser(p => p ? { ...p, phone: v } : null);
                              setPhoneError(v.length > 0 && v.length !== 10 ? 'Enter 10-digit mobile number' : '');
                            }}
                            error={phoneError}
                            placeholder="10-digit mobile number"
                          />
                          <div className="flex items-center gap-2 mt-2">
                            <input
                              type="checkbox"
                              id="phone-same-wa"
                              className="h-3.5 w-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                              checked={!!user.whatsappNumber && user.phone === user.whatsappNumber}
                              onChange={e => setUser(p => {
                                if (!p) return p;
                                if (!e.target.checked) {
                                  // Untick → let them enter a distinct phone number.
                                  setPhoneError('');
                                  return { ...p, phone: '' };
                                }
                                // Tick → make both numbers the same, in EITHER
                                // direction: copy whichever side is already filled
                                // into the other (WhatsApp wins when both are set,
                                // since it's the required/primary number). So a
                                // phone-only user fills WhatsApp, and a WhatsApp-only
                                // user fills Phone — one tick, no retyping.
                                const src = p.whatsappNumber || p.phone || '';
                                setWhatsappError(src.length === 0 ? 'WhatsApp number is required' : src.length !== 10 ? 'Enter a 10-digit WhatsApp number' : '');
                                setPhoneError(src.length > 0 && src.length !== 10 ? 'Enter 10-digit mobile number' : '');
                                return { ...p, whatsappNumber: src, phone: src };
                              })}
                            />
                            <label htmlFor="phone-same-wa" className="text-xs text-gray-500 cursor-pointer select-none">Same as WhatsApp number</label>
                          </div>
                        </div>

                        {/* WhatsApp opt-out — only meaningful once a number
                            is on file. Complements replying STOP on WhatsApp;
                            either flips the same server-side flag. */}
                        {!!user.whatsappNumber && (
                          <label className="flex items-start gap-2 mt-3 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 mt-0.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                              checked={user.whatsappOptOut !== true}
                              onChange={e => setUser(p => p ? { ...p, whatsappOptOut: !e.target.checked } : null)}
                            />
                            <span className="text-xs text-gray-600">
                              Receive notifications on WhatsApp
                              <span className="block text-gray-400">Uncheck to stop WhatsApp messages (you&apos;ll still get email). You can also reply STOP on WhatsApp anytime.</span>
                            </span>
                          </label>
                        )}

                        {/* Marketing / non-essential EMAIL opt-out. Always
                            shown (every user has an email). Core account,
                            billing, and security emails are NOT covered by this
                            flag and always send — stated explicitly so the
                            customer knows what they can and can't turn off. */}
                        <label className="flex items-start gap-2 mt-3 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            checked={user.emailOptOut !== true}
                            onChange={e => setUser(p => p ? { ...p, emailOptOut: !e.target.checked } : null)}
                          />
                          <span className="text-xs text-gray-600">
                            Receive marketing &amp; notification emails
                            <span className="block text-gray-400">Product news, offers, and service reminders. Uncheck to unsubscribe. Essential account, billing, and security emails are always sent and can&apos;t be turned off.</span>
                          </span>
                        </label>
                      </div>
                    </div>
                    <SaveRow isDirty={contactDirty} isSaving={savingSection === 'contact'} onClick={() => handleUpdateProfile(user, 'contact')} />
                  </SectionCard>
                </>
              )}

              {/* ════ BILLING & ADDRESS ════ */}
              {activeSection === 'billing' && (
                <>
                  <SectionCard>
                    <CardHeader title="Business Details" description="Used for domain registration and invoice generation" />
                    <div className="p-6 space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>Company Name <span className="text-gray-400 font-normal">(optional)</span></FieldLabel>
                          <Input
                            icon={<Building className="h-4 w-4" />}
                            value={user.companyName || ''}
                            onChange={e => setUser(p => p ? { ...p, companyName: e.target.value } : null)}
                            placeholder="Your company name"
                          />
                        </div>
                        <div>
                          <FieldLabel>GST Number <span className="text-gray-400 font-normal">(optional)</span></FieldLabel>
                          <Input
                            icon={<CreditCard className="h-4 w-4" />}
                            value={user.gstNumber || ''}
                            onChange={e => setUser(p => p ? { ...p, gstNumber: e.target.value.toUpperCase() } : null)}
                            placeholder="GSTIN (15 characters)"
                            maxLength={15}
                          />
                        </div>
                      </div>
                    </div>
                    <SaveRow isDirty={businessDirty} isSaving={savingSection === 'business'} onClick={() => handleUpdateProfile(user, 'business')} />
                  </SectionCard>

                  <SectionCard>
                    <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900">Address</h3>
                        <p className="text-xs text-gray-500 mt-0.5">Required for domain registrations</p>
                      </div>
                      <button
                        onClick={handleDetectLocation}
                        disabled={isDetectingLocation}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Navigation className={`h-3.5 w-3.5 ${isDetectingLocation ? 'animate-spin' : ''}`} />
                        {isDetectingLocation ? 'Detecting…' : 'Auto-detect'}
                      </button>
                    </div>
                    <div className="p-6 space-y-5">
                      <div>
                        <FieldLabel>Address Line 1</FieldLabel>
                        <div className="relative">
                          <MapPin className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                          <textarea
                            value={user.address?.line1 || ''}
                            onChange={e => setUser(p => p ? { ...p, address: { ...p.address, line1: e.target.value } } : null)}
                            rows={2}
                            placeholder="Street address, building, area"
                            className="w-full pl-10 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none transition-shadow"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>City</FieldLabel>
                          <Input value={user.address?.city || ''} onChange={e => setUser(p => p ? { ...p, address: { ...p.address, city: e.target.value } } : null)} placeholder="City" />
                        </div>
                        <div>
                          <FieldLabel>State</FieldLabel>
                          <select
                            value={user.address?.state || ''}
                            onChange={e => setUser(p => p ? { ...p, address: { ...p.address, state: e.target.value } } : null)}
                            className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white text-gray-900"
                          >
                            <option value="" disabled>Select state</option>
                            {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <FieldLabel>Country</FieldLabel>
                          <div className="w-full px-3 py-2.5 border border-gray-200 rounded-xl bg-gray-50 text-sm text-gray-500 select-none">
                            🇮🇳 India
                          </div>
                        </div>
                        <div>
                          <FieldLabel>PIN Code</FieldLabel>
                          <Input
                            value={user.address?.zipcode || ''}
                            onChange={e => setUser(p => p ? { ...p, address: { ...p.address, zipcode: e.target.value } } : null)}
                            placeholder="6-digit PIN code"
                            maxLength={6}
                          />
                        </div>
                      </div>
                    </div>
                    <SaveRow isDirty={addressDirty} isSaving={savingSection === 'address'} onClick={() => handleUpdateProfile(user, 'address')} />
                  </SectionCard>
                </>
              )}

              {/* ════ SECURITY ════ */}
              {activeSection === 'security' && settings && (
                <>
                  {/* Password card */}
                  <SectionCard>
                    <CardHeader
                      title={hasExistingPassword ? 'Change Password' : 'Set Password'}
                      description={hasExistingPassword ? 'Update your login password' : 'Add a password to enable email/password login'}
                    />
                    <div className="p-6 space-y-4">
                      {!hasExistingPassword && (
                        <div className="flex items-start gap-3 p-3.5 bg-blue-50 border border-blue-200 rounded-xl">
                          <AlertCircle className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                          <p className="text-sm text-blue-700">Set a password to enable email/password login alongside your social login.</p>
                        </div>
                      )}

                      {hasExistingPassword && (
                        <div>
                          <FieldLabel>Current Password</FieldLabel>
                          <div className="relative">
                            <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type={showPassword ? 'text' : 'password'}
                              value={passwordData.currentPassword}
                              onChange={e => setPasswordData(p => ({ ...p, currentPassword: e.target.value }))}
                              placeholder="Enter current password"
                              autoComplete="current-password"
                              className="w-full pl-10 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            />
                            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>New Password</FieldLabel>
                          <div className="relative">
                            <input
                              type={showNewPassword ? 'text' : 'password'}
                              value={passwordData.newPassword}
                              onChange={e => setPasswordData(p => ({ ...p, newPassword: e.target.value }))}
                              placeholder="Min 8 characters"
                              autoComplete="new-password"
                              className="w-full px-3 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            />
                            <button type="button" onClick={() => setShowNewPassword(!showNewPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                              {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div>
                          <FieldLabel>Confirm New Password</FieldLabel>
                          <div className="relative">
                            <input
                              type={showConfirmPassword ? 'text' : 'password'}
                              value={passwordData.confirmPassword}
                              onChange={e => setPasswordData(p => ({ ...p, confirmPassword: e.target.value }))}
                              placeholder="Repeat new password"
                              autoComplete="new-password"
                              className="w-full px-3 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            />
                            <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                              {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <SaveRow
                      isDirty={!!passwordData.newPassword || !!passwordData.currentPassword}
                      isSaving={isSaving}
                      onClick={handleChangePassword}
                      label={hasExistingPassword ? 'Change Password' : 'Set Password'}
                    />
                  </SectionCard>

                  {/* 2FA card */}
                  <SectionCard>
                    <CardHeader title="Two-Factor Authentication" description="Require an authenticator code at every login for extra security" />
                    <div className="p-6">

                      {/* Status */}
                      {totpStep === 'status' && (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`p-2.5 rounded-xl ${totpEnabled ? 'bg-green-100' : 'bg-gray-100'}`}>
                              {totpEnabled
                                ? <ShieldCheck className="h-5 w-5 text-green-600" />
                                : <ShieldOff className="h-5 w-5 text-gray-400" />}
                            </div>
                            <div>
                              <p className={`text-sm font-semibold ${totpEnabled ? 'text-green-700' : 'text-gray-700'}`}>
                                {totpEnabled === null ? 'Loading…' : totpEnabled ? '2FA Enabled' : '2FA Disabled'}
                              </p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {totpEnabled === null ? '' : totpEnabled
                                  ? 'Authenticator code required at every login'
                                  : 'Your account has no second factor — set it up below'}
                              </p>
                            </div>
                          </div>
                          <div>
                            {totpEnabled === null ? (
                              <div className="h-4 w-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                            ) : totpEnabled ? (
                              <button onClick={() => setTotpStep('disable')} className="text-sm font-medium text-red-600 hover:text-red-700 px-3 py-1.5 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                                Disable 2FA
                              </button>
                            ) : (
                              <button
                                onClick={handleTotpStartSetup}
                                disabled={totpIsLoading}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
                              >
                                {totpIsLoading ? <div className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <QrCode className="h-4 w-4" />}
                                Set up 2FA
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Scan QR */}
                      {totpStep === 'scan' && (
                        <div className="space-y-5">
                          <div className="flex items-center gap-2">
                            <span className="flex items-center justify-center h-5 w-5 rounded-full bg-blue-600 text-white text-xs font-bold shrink-0">1</span>
                            <p className="text-sm font-medium text-gray-900">Scan the QR code</p>
                          </div>
                          <p className="text-sm text-gray-500">Open your authenticator app (Google Authenticator, Authy, 1Password, etc.) and scan the code below.</p>
                          {totpQrUrl && (
                            <div className="flex justify-center py-2">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={totpQrUrl} alt="TOTP QR code" className="rounded-xl border-2 border-gray-200 p-2 shadow-sm" />
                            </div>
                          )}
                          <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-medium text-gray-500 flex items-center gap-1.5">
                                <KeyRound className="h-3.5 w-3.5" /> Manual entry key
                              </span>
                              <button onClick={() => setTotpShowManualKey(!totpShowManualKey)} className="text-xs text-gray-400 hover:text-gray-600">
                                {totpShowManualKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                            {totpShowManualKey ? (
                              <div className="flex items-center gap-2">
                                <code className="text-xs font-mono break-all text-gray-800 flex-1">{totpManualKey}</code>
                                <button onClick={() => copyToClipboard(totpManualKey)} className="shrink-0 text-gray-400 hover:text-gray-600"><Copy className="h-3.5 w-3.5" /></button>
                              </div>
                            ) : (
                              <p className="text-xs text-gray-400 italic">Hidden — click the eye icon to reveal</p>
                            )}
                          </div>
                          <button onClick={() => setTotpStep('verify')} className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
                            I've scanned the code →
                          </button>
                        </div>
                      )}

                      {/* Verify */}
                      {totpStep === 'verify' && (
                        <div className="space-y-5">
                          <div className="flex items-center gap-2">
                            <span className="flex items-center justify-center h-5 w-5 rounded-full bg-blue-600 text-white text-xs font-bold shrink-0">2</span>
                            <p className="text-sm font-medium text-gray-900">Enter the 6-digit code</p>
                          </div>
                          <p className="text-sm text-gray-500">Enter the code your authenticator app is showing right now.</p>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="000 000"
                            value={totpVerifyCode}
                            onChange={e => setTotpVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            maxLength={6}
                            className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-center text-3xl font-mono tracking-[0.5em] focus:outline-none focus:border-blue-500 transition-colors"
                            autoFocus
                          />
                          <div className="flex gap-3">
                            <button onClick={() => setTotpStep('scan')} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">← Back</button>
                            <button
                              onClick={handleTotpConfirm}
                              disabled={totpIsLoading || totpVerifyCode.length !== 6}
                              className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                              {totpIsLoading && <div className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                              Verify &amp; Enable
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Backup codes */}
                      {totpStep === 'backup' && (
                        <div className="space-y-5">
                          <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
                            <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                            <div>
                              <p className="text-sm font-semibold text-green-800">2FA enabled successfully</p>
                              <p className="text-xs text-green-600 mt-0.5">Save your backup codes — they won't be shown again.</p>
                            </div>
                          </div>
                          <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-3">
                            <p className="text-xs font-semibold text-amber-800">Each code can only be used once. Store them somewhere safe.</p>
                            <div className="grid grid-cols-2 gap-2">
                              {totpBackupCodes.map(code => (
                                <code key={code} className="text-xs font-mono bg-white border border-amber-200 rounded-lg px-3 py-2 text-center text-gray-800 shadow-sm">{code}</code>
                              ))}
                            </div>
                            <div className="flex items-center gap-4 pt-1">
                              <button onClick={() => copyToClipboard(totpBackupCodes.join('\n'))} className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900">
                                <Copy className="h-3.5 w-3.5" /> Copy all
                              </button>
                              <button onClick={downloadBackupCodes} className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900">
                                <Download className="h-3.5 w-3.5" /> Download .txt
                              </button>
                            </div>
                          </div>
                          <button onClick={() => setTotpStep('status')} className="w-full py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-xl hover:bg-gray-800 transition-colors">
                            Done
                          </button>
                        </div>
                      )}

                      {/* Disable */}
                      {totpStep === 'disable' && (
                        <div className="space-y-5">
                          <div className="flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl">
                            <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                            <p className="text-sm text-red-700">Enter your authenticator code and password to confirm disabling 2FA.</p>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <FieldLabel>Authenticator code</FieldLabel>
                              <input
                                type="text"
                                inputMode="numeric"
                                placeholder="000000"
                                value={totpDisableCode}
                                onChange={e => setTotpDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                maxLength={6}
                                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm font-mono tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-red-400"
                              />
                            </div>
                            <div>
                              <FieldLabel>Account password</FieldLabel>
                              <div className="relative">
                                <input
                                  type={totpShowDisablePassword ? 'text' : 'password'}
                                  placeholder="Your password"
                                  value={totpDisablePassword}
                                  onChange={e => setTotpDisablePassword(e.target.value)}
                                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-red-400"
                                />
                                <button type="button" onClick={() => setTotpShowDisablePassword(!totpShowDisablePassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                                  {totpShowDisablePassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </button>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <button onClick={() => setTotpStep('status')} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
                            <button
                              onClick={handleTotpDisable}
                              disabled={totpIsLoading}
                              className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 disabled:opacity-50 transition-colors"
                            >
                              {totpIsLoading && <div className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                              Disable 2FA
                            </button>
                          </div>
                        </div>
                      )}

                    </div>
                  </SectionCard>
                </>
              )}

            </div>
          </div>
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
