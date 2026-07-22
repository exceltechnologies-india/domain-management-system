'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, Lock, Mail, MessageCircle, User, UserPlus } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import SocialLoginButtons from './SocialLoginButtons';
import toast from 'react-hot-toast';
import { apiClient } from '@/lib/api-client';
import { InputValidator } from '@/lib/validation';
import AuthShell from './AuthShell';

interface RegisterFormProps {
  className?: string;
}

export default function MultiStageRegisterForm({ className = '' }: RegisterFormProps) {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    whatsappNumber: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get('returnUrl') || '/dashboard';

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    }
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};

    const firstNameVal = InputValidator.validateName(formData.firstName, 'First name');
    if (!firstNameVal.isValid) next.firstName = firstNameVal.errors[0];

    const lastNameVal = InputValidator.validateName(formData.lastName, 'Last name');
    if (!lastNameVal.isValid) next.lastName = lastNameVal.errors[0];

    const emailVal = InputValidator.validateEmail(formData.email);
    if (!emailVal.isValid) next.email = emailVal.errors[0];

    // WhatsApp number is required at signup (renewal reminders + marketing;
    // also doubles as the contact number for domain purposes).
    const wa = formData.whatsappNumber.trim();
    if (!wa) next.whatsappNumber = 'WhatsApp number is required';
    else if (!/^\d{10}$/.test(wa)) next.whatsappNumber = 'Enter a 10-digit WhatsApp number';

    const pwVal = InputValidator.validatePasswordStrength(formData.password);
    if (!pwVal.isValid) next.password = pwVal.errors[0];

    if (!formData.confirmPassword) {
      next.confirmPassword = 'Please confirm your password';
    } else if (formData.password !== formData.confirmPassword) {
      next.confirmPassword = 'Passwords do not match';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setIsLoading(true);
    const result = await apiClient.post<{ requiresActivation?: boolean }>(
      '/api/v1/auth/register',
      {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        whatsappNumber: formData.whatsappNumber.trim(),
        password: formData.password,
      }
    );

    if (result.ok) {
      if (result.data.requiresActivation) {
        toast.success('Account created! Check your email to activate it.');
        router.push(
          `/login?message=${encodeURIComponent('Account created. Please check your email to activate your account.')}${returnUrl ? `&returnUrl=${encodeURIComponent(returnUrl)}` : ''}`
        );
      } else {
        toast.success('Account created successfully!');
        router.push(`/login${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''}`);
      }
    } else {
      // Map server-side field errors back onto the form if present.
      // The route returns Zod's `details` tree on the error body.
      const errBody = result.error.body as { details?: Record<string, unknown> } | undefined;
      if (errBody?.details) {
        const fieldErrors: Record<string, string> = {};
        const processErrors = (obj: Record<string, unknown>, prefix = '') => {
          Object.keys(obj).forEach((key) => {
            if (key === '_errors') {
              const errs = obj[key] as string[];
              if (errs.length > 0 && prefix) {
                fieldErrors[prefix.replace(/\.$/, '')] = errs[0];
              }
            } else {
              processErrors(obj[key] as Record<string, unknown>, `${prefix}${key}.`);
            }
          });
        };
        processErrors(errBody.details);
        setErrors(fieldErrors);
      }
      toast.error(result.error.message || 'Registration failed. Please try again.');
    }
    setIsLoading(false);
  };

  return (
    <AuthShell
      className={className}
      title="Create your account"
      subtitle={
        <>
          Already have one?{' '}
          <Link
            href={`/login${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''}`}
            className="font-medium text-primary-600 hover:text-primary-500"
          >
            Sign in
          </Link>
        </>
      }
      panelEyebrow="Get started"
      panelTitle="Your online identity, ready in minutes"
    >
      <>
          <SocialLoginButtons
            onSuccess={() => {
              setTimeout(() => { window.location.href = returnUrl || '/dashboard'; }, 100);
            }}
            onError={() => {}}
          />

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-white text-gray-500">or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="First name"
                name="firstName"
                placeholder="First name"
                value={formData.firstName}
                onChange={handleChange}
                required
                fullWidth
                icon={<User className="h-4 w-4 text-gray-400" />}
                error={errors.firstName}
              />
              <Input
                label="Last name"
                name="lastName"
                placeholder="Last name"
                value={formData.lastName}
                onChange={handleChange}
                required
                fullWidth
                icon={<User className="h-4 w-4 text-gray-400" />}
                error={errors.lastName}
              />
            </div>

            <Input
              label="Email address"
              name="email"
              type="email"
              placeholder="you@example.com"
              value={formData.email}
              onChange={handleChange}
              required
              fullWidth
              icon={<Mail className="h-4 w-4 text-gray-400" />}
              error={errors.email}
            />

            <Input
              label="WhatsApp number"
              name="whatsappNumber"
              type="tel"
              inputMode="numeric"
              placeholder="10-digit WhatsApp number"
              value={formData.whatsappNumber}
              onChange={(e) => {
                // digits only, max 10 — keeps the +91 10-digit contract clean
                const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                setFormData((prev) => ({ ...prev, whatsappNumber: digits }));
                if (errors.whatsappNumber) setErrors((prev) => { const n = { ...prev }; delete n.whatsappNumber; return n; });
              }}
              required
              fullWidth
              icon={<MessageCircle className="h-4 w-4 text-gray-400" />}
              helperText="We'll send renewal reminders here. Also used as your contact number for domains."
              error={errors.whatsappNumber}
            />

            <Input
              label="Password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Create a strong password"
              value={formData.password}
              onChange={handleChange}
              required
              fullWidth
              icon={<Lock className="h-4 w-4 text-gray-400" />}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
              helperText="Min. 8 characters with uppercase, lowercase, number, and special character"
              error={errors.password}
            />

            <Input
              label="Confirm password"
              name="confirmPassword"
              type={showConfirmPassword ? 'text' : 'password'}
              placeholder="Confirm your password"
              value={formData.confirmPassword}
              onChange={handleChange}
              required
              fullWidth
              icon={<Lock className="h-4 w-4 text-gray-400" />}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
              error={errors.confirmPassword}
            />

            <Button
              type="submit"
              disabled={isLoading}
              loading={isLoading}
              icon={<UserPlus className="h-4 w-4" />}
              className="w-full mt-2"
            >
              {isLoading ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-gray-500">
            You&apos;ll be prompted to add your billing address before checkout — required for domain registration.
          </p>
      </>
    </AuthShell>
  );
}
