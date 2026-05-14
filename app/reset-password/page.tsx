import { Suspense } from 'react';
import ResetPasswordContent from './ResetPasswordContent';

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ResetPasswordContent />
    </Suspense>
  );
}