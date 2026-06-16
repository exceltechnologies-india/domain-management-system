'use client';

import { Suspense } from 'react';
import LoginForm from '@/components/LoginForm';

// Suspense boundary is required: LoginForm calls useSearchParams() in its
// render body to conditionally show the "complete your purchase" notice
// and to thread the returnUrl through to the register link. Without this
// boundary, Next.js renders the LoginForm with `searchParams` resolved
// to null during SSR but to the real values during client hydration —
// the DOM differs and React throws hydration error #418.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
