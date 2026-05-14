'use client';

import { useSearchParams } from 'next/navigation';
import ForgotPasswordForm from '@/components/ForgotPasswordForm';
import ResetPasswordForm from '@/components/ResetPasswordForm';

export default function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  // First-time password setup mode — used by guest-checkout success page
  // to route the user through "Set Password" copy instead of "Reset Password".
  const isSetup = searchParams.get('setup') === '1';
  const prefilledEmail = searchParams.get('email') ?? '';

  if (token) {
    return <ResetPasswordForm token={token} isSetup={isSetup} />;
  }

  return <ForgotPasswordForm isSetup={isSetup} prefilledEmail={prefilledEmail} />;
}
