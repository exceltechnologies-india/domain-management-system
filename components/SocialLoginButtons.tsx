'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { FcGoogle } from 'react-icons/fc';
import { FaFacebook, FaGithub } from 'react-icons/fa6';

import toast from 'react-hot-toast';
import { showAccountDeactivated } from '@/lib/toast';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';
const FACEBOOK_ENABLED = !!process.env.NEXT_PUBLIC_FACEBOOK_ENABLED && process.env.NEXT_PUBLIC_FACEBOOK_ENABLED !== 'false';
const GITHUB_ENABLED = !!process.env.NEXT_PUBLIC_GITHUB_ENABLED && process.env.NEXT_PUBLIC_GITHUB_ENABLED !== 'false';

type SocialProvider = 'google' | 'facebook' | 'github';

interface SocialLoginButtonsProps {
  className?: string;
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

const PROVIDER_CONFIG: Record<SocialProvider, { label: string; icon: React.ReactNode; colorClass: string }> = {
  google: {
    label: 'Google',
    icon: <FcGoogle className="h-5 w-5 flex-shrink-0" />,
    colorClass: 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
  },
  facebook: {
    label: 'Facebook',
    icon: <FaFacebook className="h-5 w-5 flex-shrink-0 text-[#1877F2]" />,
    colorClass: 'border-[#1877F2]/30 bg-white text-gray-700 hover:bg-blue-50',
  },
  github: {
    label: 'GitHub',
    icon: <FaGithub className="h-5 w-5 flex-shrink-0 text-gray-800" />,
    colorClass: 'border-gray-400 bg-white text-gray-700 hover:bg-gray-100',
  },
};

export default function SocialLoginButtons({
  className = '',
  onSuccess,
  onError
}: SocialLoginButtonsProps) {
  const [isLoading, setIsLoading] = useState<SocialProvider | null>(null);

  const activeProviders: SocialProvider[] = [
    'google',
    ...(FACEBOOK_ENABLED ? ['facebook' as SocialProvider] : []),
    ...(GITHUB_ENABLED ? ['github' as SocialProvider] : []),
  ];

  /**
   * Resolve the post-login destination from `?returnUrl=…` on the
   * login page's URL. Honours the same open-redirect guard the
   * credentials-login flow uses (LoginForm.tsx:126): the value must
   * be a same-origin path that starts with `/[non-slash]`. Anything
   * else (absolute URL, protocol-relative `//evil.com`, `javascript:`,
   * etc.) falls back to /dashboard. SSR-safe via the `typeof window`
   * guard so this can be called from a useEffect or event handler.
   */
  const resolveReturnUrl = (): string => {
    if (typeof window === 'undefined') return '/dashboard';
    const raw = new URLSearchParams(window.location.search).get('returnUrl');
    if (raw && /^\/[^/]/.test(raw)) return raw;
    return '/dashboard';
  };

  const handleSocialLogin = async (provider: SocialProvider) => {
    try {
      setIsLoading(provider);

      const callbackUrl = resolveReturnUrl();
      const result = await signIn(provider, {
        redirect: false,
        callbackUrl,
      });

      if (result?.error) {
        if (result.error === 'AccessDenied' || result.error === 'Callback') {
          showAccountDeactivated(SUPPORT_EMAIL);
          onError?.('Account deactivated');
          return;
        }

        const errorMessage =
          result.error === 'OAuthSignin' ? 'Failed to sign in. Please try again.' :
          result.error === 'OAuthCallback' ? 'Authentication failed. Please try again.' :
          result.error === 'OAuthCreateAccount' ? 'Could not create account. Please try again.' :
          result.error === 'EmailCreateAccount' ? 'Could not create account with this email.' :
          result.error === 'OAuthAccountNotLinked' ? 'This email is already associated with a different account.' :
          result.error === 'Callback' ? 'Authentication callback failed.' :
          'An error occurred during sign in.';

        toast.error(errorMessage);
        onError?.(errorMessage);
      } else if (result?.ok) {
        toast.success('Successfully signed in! Redirecting...');
        setTimeout(() => {
          window.location.href = callbackUrl;
        }, 2000);
        onSuccess?.();
      }
    } catch {
      const errorMessage = 'An unexpected error occurred. Please try again.';
      toast.error(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsLoading(null);
    }
  };

  const colClass =
    activeProviders.length === 1 ? 'grid-cols-1' :
    activeProviders.length === 2 ? 'grid-cols-2' :
    'grid-cols-3';

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-300" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="px-2 bg-white text-gray-500">Or continue with</span>
        </div>
      </div>

      <div className={`grid ${colClass} gap-3`}>
        {activeProviders.map((provider) => {
          const { label, icon, colorClass } = PROVIDER_CONFIG[provider];
          const loading = isLoading === provider;
          return (
            <button
              key={provider}
              type="button"
              onClick={() => handleSocialLogin(provider)}
              disabled={isLoading !== null}
              className={`w-full inline-flex items-center justify-center gap-2 py-2.5 px-3 border rounded-md shadow-sm text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${colorClass}`}
              aria-label={`Sign in with ${label}`}
            >
              {loading ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500 flex-shrink-0" />
              ) : (
                icon
              )}
              <span className={activeProviders.length === 3 ? 'hidden sm:inline' : ''}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
