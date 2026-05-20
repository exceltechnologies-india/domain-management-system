'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, ArrowLeft } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import Card from './Card';
import Logo from './Logo';
import toast from 'react-hot-toast';
import GoogleRecaptcha from './GoogleRecaptcha';

const RESEND_COOLDOWN_SECONDS = 60;

interface ForgotPasswordFormProps {
  className?: string;
  /** When true, render copy framed as a first-time password setup
   * (used after guest checkout) rather than a recovery flow. */
  isSetup?: boolean;
  /** Pre-fill the email field — used in guest-conversion flow. */
  prefilledEmail?: string;
}

export default function ForgotPasswordForm({ className = '', isSetup = false, prefilledEmail = '' }: ForgotPasswordFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(prefilledEmail);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);
  const [cooldownEnd, setCooldownEnd] = useState<number>(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);

  useEffect(() => {
    if (cooldownEnd <= Date.now()) {
      setRemainingSeconds(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownEnd - Date.now()) / 1000));
      setRemainingSeconds(remaining);
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [cooldownEnd]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(''); // Clear previous errors

    try {
      // Check if reCAPTCHA is configured
      const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
      const isRecaptchaConfigured = recaptchaSiteKey && recaptchaSiteKey !== 'your-recaptcha-site-key';
      
      // Only require reCAPTCHA token if reCAPTCHA is configured
      if (isRecaptchaConfigured && !recaptchaToken) {
        setError('Please complete the security verification');
        toast.error('Please complete the security verification');
        setIsLoading(false);
        return;
      }

      const response = await fetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, recaptchaToken: recaptchaToken }),
      });

      const data = await response.json();

      if (response.ok) {
        setIsSubmitted(true);
        setCooldownEnd(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
        toast.success(isSetup ? 'Setup link sent — check your email!' : 'Password reset email sent!');
      } else {
        // Set error state and show toast
        const errorMessage = data.message || data.error || 'Failed to send reset email';
        setError(errorMessage);
        toast.error(errorMessage);
      }
    } catch (error) {
      const errorMessage = 'An error occurred. Please try again.';
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  if (isSubmitted) {
    return (
      <div className={`min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 ${className}`}>
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <Logo size="lg" />
            </div>
            <h2 className="text-3xl font-bold text-gray-900">
              Check your email
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              {isSetup
                ? <>We&apos;ve sent a setup link to {email}</>
                : <>We&apos;ve sent a password reset link to {email}</>}
            </p>
          </div>

          <Card>
            <div className="text-center">
              <div className="bg-green-100 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                <Mail className="h-8 w-8 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Email Sent Successfully!
              </h3>
              <p className="text-gray-600 mb-6">
                {isSetup
                  ? <>Please check your email and click the link to set up your account password. The link will expire in 1 hour.</>
                  : <>Please check your email and click the link to reset your password. The link will expire in 1 hour.</>}
              </p>
              <div className="space-y-3">
                <Button
                  onClick={() => {
                    if (remainingSeconds > 0) return;
                    setIsSubmitted(false);
                  }}
                  variant="outline"
                  fullWidth
                  disabled={remainingSeconds > 0}
                >
                  {remainingSeconds > 0
                    ? `Send Another Email (${remainingSeconds}s)`
                    : 'Send Another Email'}
                </Button>
                {remainingSeconds > 0 && (
                  <p className="text-xs text-gray-500 text-center -mt-1">
                    Please wait before requesting another email.
                  </p>
                )}
                <Button
                  onClick={() => router.push('/login')}
                  variant="ghost"
                  fullWidth
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back to Login
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 ${className}`}>
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <h2 className="text-3xl font-bold text-gray-900">
            {isSetup ? 'Set up your password' : 'Forgot your password?'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {isSetup
              ? <>Confirm your email and we&apos;ll send you a link to choose a password and activate your account.</>
              : <>Enter your email address and we&apos;ll send you a link to reset your password.</>}
          </p>
        </div>

        <Card>
          <div 
            className="space-y-6"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          >
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <Mail className="h-5 w-5 text-red-400" />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                </div>
              </div>
            )}

            <Input
              label="Email address"
              name="email"
              type="email"
              placeholder="Enter your email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              fullWidth
              autoComplete="email"
              icon={<Mail className="h-4 w-4 text-gray-400" />}
              helperText={isSetup ? "We'll send a password setup link to this email" : "We'll send a password reset link to this email"}
            />

            {process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY && 
             process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY !== 'your-recaptcha-site-key' && (
              <GoogleRecaptcha
                onSuccess={(token) => setRecaptchaToken(token)}
                onError={() => setRecaptchaToken(null)}
                onExpire={() => setRecaptchaToken(null)}
                className="flex justify-center"
              />
            )}

            <Button
              type="button"
              onClick={handleSubmit}
              loading={isLoading}
              fullWidth
              icon={<Mail className="h-4 w-4" />}
              disabled={!!(process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY && 
                       process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY !== 'your-recaptcha-site-key' && 
                       !recaptchaToken)}
            >
              {isLoading ? 'Sending...' : (isSetup ? 'Send Setup Link' : 'Send Reset Link')}
            </Button>

            <div className="text-center">
              <a
                href="/login"
                className="text-sm font-medium text-primary-600 hover:text-primary-500 inline-flex items-center"
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back to Login
              </a>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
