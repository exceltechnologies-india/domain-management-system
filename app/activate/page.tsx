'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle, XCircle, Loader2, Mail, RefreshCw } from 'lucide-react';
import Card from '@/components/Card';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import toast from 'react-hot-toast';
import { safeLocalStorage } from '@/lib/storage';
import { logger } from '@/lib/logger';

export default function ActivatePage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isActivating, setIsActivating] = useState(false);
  const [activationStatus, setActivationStatus] = useState<'success' | 'error' | 'expired' | 'invalid' | null>(null);
  const [message, setMessage] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const emailParam = searchParams.get('email');
  const messageParam = searchParams.get('message');

  useEffect(() => {
    if (token) {
      activateAccount(token);
    } else if (messageParam) {
      // User came from dashboard or login page with activation required
      const decodedMessage = decodeURIComponent(messageParam);
      setMessage(decodedMessage);

      if (decodedMessage.includes('Account not activated')) {
        // User came from dashboard - check if they're actually activated
        checkActivationStatus();
      } else {
        // User came from login page with activation required
        setActivationStatus('invalid');
        setMessage(decodedMessage);
        setIsLoading(false);
      }
    } else {
      setActivationStatus('invalid');
      setMessage('Invalid activation link. Please check your email and try again.');
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, emailParam, messageParam]);

  const checkActivationStatus = async () => {
    try {
      setIsLoading(true);

      // Get token from localStorage for API call
      const token = safeLocalStorage.getItem('token');

      if (!token) {
        // User not logged in, redirect to login immediately
        router.push('/login?message=Please log in to activate your account.');
        return;
      }

      // Make fresh API call to get current user status
      const response = await fetch('/api/auth/me', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok && data.user) {
        // Update localStorage with fresh data
        safeLocalStorage.setItem('user', JSON.stringify(data.user));

        if (data.user.isActivated) {
          // User is already activated, redirect to dashboard
          setActivationStatus('success');
          setMessage('Your account is already activated! Redirecting to dashboard...');
          setTimeout(() => {
            router.push('/dashboard');
          }, 2000);
        } else {
          // User is not activated, show activation required message
          setActivationStatus('invalid');
          setMessage('Your account is not activated. Please check your email for the activation link.');
        }
      } else {
        // API call failed, redirect to login
        router.push('/login?message=Please log in to activate your account.');
      }
    } catch (error) {
      logger.error('Check activation status error:', error);
      // If there's an error checking status, redirect to login
      router.push('/login?message=Unable to check activation status. Please log in.');
    } finally {
      setIsLoading(false);
    }
  };

  const activateAccount = async (activationToken: string) => {
    try {
      setIsActivating(true);
      const response = await fetch('/api/auth/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: activationToken }),
      });

      const data = await response.json();

      if (response.ok) {
        setActivationStatus('success');
        setMessage(data.message);
        setUserEmail(data.user?.email || '');

        // Store token and user data in localStorage for immediate login
        if (data.token && data.user) {
          safeLocalStorage.setItem('token', data.token);
          safeLocalStorage.setItem('user', JSON.stringify(data.user));

          // Store token in cookie for server-side access.
          // HttpOnly cannot be set here (client-side write); JS reads this cookie for
          // Authorization headers. SameSite=Lax blocks cross-site form submissions;
          // Secure ensures the cookie is only sent over HTTPS in production.
          const secure = window.location.protocol === 'https:' ? '; Secure' : '';
          document.cookie = `token=${data.token}; path=/; max-age=${24 * 60 * 60}; SameSite=Lax${secure}`;
        }

        // Redirect to dashboard after 2 seconds
        setTimeout(() => {
          router.push('/dashboard');
        }, 2000);
      } else {
        if (data.error === 'Token expired') {
          setActivationStatus('expired');
          setMessage('Your activation link has expired. Please request a new one.');
        } else if (data.error === 'Invalid token') {
          setActivationStatus('invalid');
          setMessage('Invalid activation link. Please check your email and try again.');
        } else {
          setActivationStatus('error');
          setMessage(data.error || 'Activation failed. Please try again.');
        }
      }
    } catch (error) {
      logger.error('Activation error:', error);
      setActivationStatus('error');
      setMessage('Network error. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
      setIsActivating(false);
    }
  };

  const resendActivationEmail = async () => {
    if (!userEmail) {
      toast.error('Email address not found. Please register again.');
      return;
    }

    try {
      setIsActivating(true);
      const response = await fetch('/api/auth/resend-activation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: userEmail }),
      });

      const data = await response.json();

      if (response.ok) {
        toast.success('Activation email sent! Please check your inbox.');
        setMessage('A new activation email has been sent to your email address.');
      } else {
        toast.error(data.error || 'Failed to send activation email.');
      }
    } catch (error) {
      logger.error('Resend activation error:', error);
      toast.error('Network error. Please try again.');
    } finally {
      setIsActivating(false);
    }
  };

  const getStatusIcon = () => {
    switch (activationStatus) {
      case 'success':
        return <CheckCircle className="h-16 w-16 text-green-500" />;
      case 'error':
      case 'invalid':
        return <XCircle className="h-16 w-16 text-red-500" />;
      case 'expired':
        return <XCircle className="h-16 w-16 text-orange-500" />;
      default:
        return <Loader2 className="h-16 w-16 text-blue-500 animate-spin" />;
    }
  };

  const getStatusColor = () => {
    switch (activationStatus) {
      case 'success':
        return 'text-green-600';
      case 'error':
      case 'invalid':
        return 'text-red-600';
      case 'expired':
        return 'text-orange-600';
      default:
        return 'text-blue-600';
    }
  };

  const getStatusTitle = () => {
    switch (activationStatus) {
      case 'success':
        return 'Account Activated Successfully!';
      case 'error':
        return 'Activation Failed';
      case 'invalid':
        return 'Invalid Activation Link';
      case 'expired':
        return 'Activation Link Expired';
      default:
        return 'Activating Account...';
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <h2 className="text-3xl font-bold text-gray-900">
            Account Activation
          </h2>
        </div>

        <Card className="p-8">
          <div className="text-center">
            <div className="flex justify-center mb-6">
              {getStatusIcon()}
            </div>

            <h3 className={`text-xl font-semibold mb-4 ${getStatusColor()}`}>
              {getStatusTitle()}
            </h3>

            <p className="text-gray-600 mb-6">
              {message}
            </p>

            {activationStatus === 'success' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <p className="text-green-800 text-sm">
                  You will be redirected to the login page in a few seconds...
                </p>
              </div>
            )}

            {activationStatus === 'expired' && (
              <div className="space-y-4">
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                  <p className="text-orange-800 text-sm">
                    Your activation link has expired. Please request a new one to activate your account.
                  </p>
                </div>

                <Button
                  onClick={resendActivationEmail}
                  disabled={isActivating}
                  className="w-full flex items-center justify-center gap-2"
                >
                  {isActivating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Mail className="h-4 w-4" />
                  )}
                  {isActivating ? 'Sending...' : 'Resend Activation Email'}
                </Button>
              </div>
            )}

            {activationStatus === 'invalid' && (
              <div className="space-y-4">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-800 text-sm">
                    The activation link is invalid or has already been used. Please check your email for the correct link.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={() => router.push('/register')}
                    variant="outline"
                    className="flex-1"
                  >
                    Register Again
                  </Button>
                  <Button
                    onClick={() => router.push('/login')}
                    className="flex-1"
                  >
                    Go to Login
                  </Button>
                </div>
              </div>
            )}

            {activationStatus === 'error' && (
              <div className="space-y-4">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-800 text-sm">
                    An error occurred during activation. Please try again or contact support.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={() => window.location.reload()}
                    variant="outline"
                    className="flex-1 flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Try Again
                  </Button>
                  <Button
                    onClick={() => router.push('/contact')}
                    className="flex-1"
                  >
                    Contact Support
                  </Button>
                </div>
              </div>
            )}

            {isLoading && (
              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-blue-800 text-sm">
                    Please wait while we activate your account...
                  </p>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
