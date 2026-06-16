'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { Eye, EyeOff, Lock, Mail, User, CheckCircle, ShieldCheck } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import SocialLoginButtons from './SocialLoginButtons';
import toast from 'react-hot-toast';
import { showSuccessToast, showErrorToast, showAccountDeactivated } from '@/lib/toast';
import { safeLocalStorage } from '@/lib/storage';
import GoogleRecaptcha from './GoogleRecaptcha';
import AuthShell from './AuthShell';
import { logger } from '@/lib/logger';

interface LoginFormProps {
  className?: string;
}

export default function LoginForm({ className = '' }: LoginFormProps) {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    rememberMe: true,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activationMessage, setActivationMessage] = useState('');
  const [deactivatedMessage, setDeactivatedMessage] = useState('');
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);
  const [resetRecaptchaKey, setResetRecaptchaKey] = useState(0);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();

  // Load form data from localStorage on component mount (excluding password)
  useEffect(() => {
    const savedData = safeLocalStorage.getItem('loginFormData');
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        setFormData(prev => ({
          ...prev,
          email: parsedData.email || '',
          rememberMe: parsedData.rememberMe !== undefined ? parsedData.rememberMe : true,
          // Don't restore password for security
          password: '',
        }));
      } catch (error) {
        // Error parsing saved form data
      }
    }

    // Check for activation message
    const message = searchParams.get('message');
    if (message) {
      setActivationMessage(decodeURIComponent(message));
    }

    // Check for NextAuth error parameter (e.g., from social login failure)
    const error = searchParams.get('error');
    if (error === 'AccessDenied' || error === 'Callback') {
      // When NextAuth redirects after signIn callback returns false,
      // it adds ?error=AccessDenied to the URL
      // This could be due to account deactivation for social users
      const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';
      setDeactivatedMessage(`Your account has been deactivated. Please contact our support team at ${supportEmail} for assistance.`);

      // Clean up the URL by removing the error parameter
      // This prevents the message from showing again on page refresh
      const newSearchParams = new URLSearchParams(searchParams.toString());
      newSearchParams.delete('error');
      const newUrl = newSearchParams.toString()
        ? `${window.location.pathname}?${newSearchParams.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, [searchParams]);

  // Save form data to localStorage whenever it changes (excluding password)
  useEffect(() => {
    const dataToSave = {
      email: formData.email,
      rememberMe: formData.rememberMe,
      // Don't save password for security
    };
    safeLocalStorage.setItem('loginFormData', JSON.stringify(dataToSave));
  }, [formData.email, formData.rememberMe]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Check if reCAPTCHA is configured (only enforced in production)
      const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
      const isRecaptchaConfigured = process.env.NODE_ENV === 'production' &&
        recaptchaSiteKey && recaptchaSiteKey !== 'your-recaptcha-site-key';

      // Only require reCAPTCHA token if reCAPTCHA is configured
      if (isRecaptchaConfigured && !recaptchaToken) {
        showErrorToast('Please complete the security verification');
        setIsLoading(false);
        return;
      }

      // Store remember me preference BEFORE login
      if (formData.rememberMe) {
        safeLocalStorage.setItem('rememberMe', 'true');
        safeLocalStorage.setItem('savedEmail', formData.email);
      } else {
        safeLocalStorage.removeItem('rememberMe');
        safeLocalStorage.removeItem('savedEmail');
      }

      // Clear saved form data
      safeLocalStorage.removeItem('loginFormData');

      // Get return URL
      const urlParams = new URLSearchParams(window.location.search);
      const returnUrl = urlParams.get('returnUrl') || '/dashboard';
      // Keep only same-origin paths to prevent open redirect
      const safeReturnUrl = returnUrl.startsWith('/') ? returnUrl : '/dashboard';

      // Use NextAuth signIn with MANUAL redirect
      // This prevents the URL from being cluttered with error parameters
      const startTime = Date.now();
      const result = await signIn('credentials', {
        redirect: false, // Handle redirect manually
        email: formData.email,
        password: formData.password,
        recaptchaToken: recaptchaToken,
        totpCode: totpCode || undefined,
        callbackUrl: safeReturnUrl,
      });

      if (result?.error || !result?.ok) {
        logger.error('SignIn failed:', result?.error);
        // Handle specific error cases if needed, otherwise show generic error
        if (result?.error === 'TotpRequired') {
          // Password correct — reveal TOTP step without showing an error
          setTotpRequired(true);
          setIsLoading(false);
          return;
        } else if (result?.error === 'InvalidTotpCode') {
          showErrorToast('Invalid authenticator code. Please try again.');
          setTotpCode('');
          setIsLoading(false);
          return;
        } else if (result?.error === 'AccountNotActivated') {
          showErrorToast('Account not activated. Please check your email.');
          setTimeout(() => {
            router.push(`/activate?email=${encodeURIComponent(formData.email)}`);
          }, 1000);
        } else if (result?.error === 'AccountDeactivated' || result?.error === 'AccessDenied') {
          showAccountDeactivated(process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in');
        } else {
          if (result?.error === 'CredentialsSignin' || !result?.error) {
            showErrorToast('Invalid email or password');
          } else {
            showErrorToast(result.error);
          }
        }

        // Reset reCAPTCHA on failed login attempt
        setRecaptchaToken(null);
        setResetRecaptchaKey(prev => prev + 1);

        setIsLoading(false);
      } else {
        // Login successful
        showSuccessToast('Login successful! Redirecting...');
        
        // Use window.location.href for a full page reload.
        // This is critical because it ensures the session cookie is correctly 
        // sent to the server for the next request, preventing middleware 
        // redirection loops back to the login page.
        setTimeout(() => {
          window.location.href = safeReturnUrl;
        }, 100);
      }
    } catch (error: unknown) {
      // This catch block might not be hit if signIn doesn't throw on redirect: false
      // But keeping it for safety for other synchronous errors in the block
      logger.error("Login error:", error);
      showErrorToast('An unexpected error occurred. Please try again.');
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? checked : value,
    });
  };

  const returnUrlParam = searchParams.get('returnUrl');
  return (
    <AuthShell
      className={className}
      title="Sign in to your account"
      subtitle={
        <>
          New here?{' '}
          <Link
            href={`/register${returnUrlParam ? `?returnUrl=${encodeURIComponent(returnUrlParam)}` : ''}`}
            className="font-medium text-blue-600 hover:text-blue-500"
          >
            Create an account
          </Link>
        </>
      }
      panelEyebrow="Welcome back"
      panelTitle="Pick up where you left off"
    >
      <>
          {(searchParams.get('returnUrl') === '/cart' ||
            searchParams.get('returnUrl') === '/checkout') && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center">
                <ShieldCheck className="h-5 w-5 text-blue-600 mr-2 shrink-0" />
                <p className="text-blue-800 text-sm font-medium">Please sign in to complete your purchase</p>
              </div>
            </div>
          )}
          {activationMessage && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center">
                <CheckCircle className="h-5 w-5 text-green-600 mr-2" />
                <p className="text-green-800 text-sm font-medium">{activationMessage}</p>
              </div>
            </div>
          )}
          <div 
            className="space-y-6"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                void handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          >
            {deactivatedMessage && (
              <div className="mb-4">
                <p className="text-sm text-red-600 text-center">
                  Your account has been deactivated. Please contact our support team at{' '}
                  <a
                    href={`mailto:${process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in'}`}
                    className="text-red-600 hover:text-red-700 underline font-medium"
                  >
                    {process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in'}
                  </a>
                  {' '}for assistance.
                </p>
              </div>
            )}
            <Input
              label="Email address"
              name="email"
              type="email"
              placeholder="Enter your email address"
              value={formData.email}
              onChange={handleChange}
              required
              fullWidth
              autoComplete="email"
              icon={<Mail className="h-4 w-4 text-gray-400" />}
            />

            <div className="relative">
              <Input
                label="Password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                value={formData.password}
                onChange={handleChange}
                required
                fullWidth
                autoComplete="current-password"
                icon={<Lock className="h-4 w-4 text-gray-400" />}
                rightIcon={
                  <button
                    type="button"
                    className="text-gray-500 hover:text-gray-700 focus:outline-none"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                }
              />
            </div>

            {totpRequired && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
                <div className="flex items-center gap-2 text-blue-800">
                  <ShieldCheck className="h-5 w-5 shrink-0" />
                  <span className="text-sm font-medium">Two-factor authentication required</span>
                </div>
                <p className="text-xs text-blue-700">
                  Enter the 6-digit code from your authenticator app.
                </p>
                <Input
                  label="Authenticator code"
                  name="totpCode"
                  type="text"
                  inputMode="numeric"
                  placeholder="000 000"
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  maxLength={6}
                  fullWidth
                  autoComplete="one-time-code"
                />
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <input
                  id="rememberMe"
                  name="rememberMe"
                  type="checkbox"
                  checked={formData.rememberMe}
                  onChange={handleChange}
                  className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                />
                <label htmlFor="rememberMe" className="ml-2 block text-sm text-gray-900">
                  Remember me
                </label>
              </div>

              <div className="text-sm">
                <a href="/reset-password" className="font-medium text-primary-600 hover:text-primary-500">
                  Forgot your password?
                </a>
              </div>
            </div>

            {process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY &&
              process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY !== 'your-recaptcha-site-key' && (
                <GoogleRecaptcha
                  onSuccess={(token) => setRecaptchaToken(token)}
                  onError={() => setRecaptchaToken(null)}
                  onExpire={() => setRecaptchaToken(null)}
                  resetKey={resetRecaptchaKey}
                  className="flex justify-center"
                />
              )}

            <Button
              type="button"
              onClick={handleSubmit}
              loading={isLoading}
              fullWidth
              icon={<User className="h-4 w-4" />}
              disabled={!!(process.env.NODE_ENV === 'production' &&
                process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY &&
                process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY !== 'your-recaptcha-site-key' &&
                !recaptchaToken)}
            >
              {isLoading ? 'Signing in...' : 'Sign in'}
            </Button>

            <SocialLoginButtons
              onSuccess={() => {
                // Redirect to dashboard after successful social login
                setTimeout(() => {
                  const urlParams = new URLSearchParams(window.location.search);
                  const returnUrl = urlParams.get('returnUrl');
                  router.push(returnUrl || '/dashboard');
                }, 100);
              }}
              onError={(error) => {
                // Social login error
              }}
            />
          </div>
      </>
    </AuthShell>
  );
}
