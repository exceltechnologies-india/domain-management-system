'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, ArrowLeft, CheckCircle, Eye, EyeOff } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import Card from './Card';
import Logo from './Logo';
import toast from 'react-hot-toast';
import GoogleRecaptcha from './GoogleRecaptcha';

interface ResetPasswordFormProps {
  token: string;
  className?: string;
  /** First-time password setup (guest → full account) — adjusts copy. */
  isSetup?: boolean;
}

export default function ResetPasswordForm({ token, className = '', isSetup = false }: ResetPasswordFormProps) {
  const router = useRouter();
  const [formData, setFormData] = useState({
    password: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.password !== formData.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    if (formData.password.length < 8) {
      toast.error('Password must be at least 8 characters long');
      return;
    }

    setIsLoading(true);

    try {
      // Check if reCAPTCHA is configured
      const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
      const isRecaptchaConfigured = recaptchaSiteKey && recaptchaSiteKey !== 'your-recaptcha-site-key';

      // Only require reCAPTCHA token if reCAPTCHA is configured
      if (isRecaptchaConfigured && !recaptchaToken) {
        toast.error('Please complete the security verification');
        setIsLoading(false);
        return;
      }

      const response = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token,
          password: formData.password,
          recaptchaToken: recaptchaToken,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setIsSuccess(true);
        toast.success(isSetup ? 'Password set — your account is ready!' : 'Password has been reset successfully');
        // Redirect to login after a short delay
        setTimeout(() => {
          router.push('/login');
        }, 3000);
      } else {
        toast.error(data.error || (isSetup ? 'Failed to set password' : 'Failed to reset password'));
      }
    } catch (error) {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  if (isSuccess) {
    return (
      <div className={`min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 ${className}`}>
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <Logo size="lg" />
            </div>
            <h2 className="text-3xl font-bold text-gray-900">
              {isSetup ? 'Account Activated' : 'Password Reset Complete'}
            </h2>
          </div>

          <Card>
            <div className="text-center">
              <div className="bg-green-100 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="h-8 w-8 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Success!
              </h3>
              <p className="text-gray-600 mb-6">
                {isSetup
                  ? <>Your password is set and your account is ready. You&apos;ll be redirected to the login page shortly.</>
                  : <>Your password has been successfully reset. You will be redirected to the login page shortly.</>}
              </p>
              <Button
                onClick={() => router.push('/login')}
                fullWidth
              >
                Go to Login
              </Button>
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
            {isSetup ? 'Set Your Password' : 'Set New Password'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {isSetup
              ? <>Choose a password to activate your account and access your dashboard.</>
              : <>Please enter your new password below.</>}
          </p>
        </div>

        <Card>
          <div 
            className="space-y-6"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                handleSubmit(e as any);
              }
            }}
          >
            <div className="relative">
              <Input
                label={isSetup ? "Password" : "New Password"}
                name="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter new password"
                value={formData.password}
                onChange={handleChange}
                required
                fullWidth
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
                helperText="Min. 8 characters with uppercase, lowercase, number, and special character"
              />
            </div>

            <div className="relative">
              <Input
                label="Confirm Password"
                name="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="Confirm new password"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
                fullWidth
                icon={<Lock className="h-4 w-4 text-gray-400" />}
                rightIcon={
                  <button
                    type="button"
                    className="text-gray-500 hover:text-gray-700 focus:outline-none"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                }
              />
            </div>

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
            >
              {isLoading
                ? (isSetup ? 'Setting…' : 'Resetting...')
                : (isSetup ? 'Set Password & Activate' : 'Reset Password')}
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
