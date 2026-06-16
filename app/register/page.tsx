'use client';

import { Suspense } from 'react';
import MultiStageRegisterForm from '@/components/MultiStageRegisterForm';

// Suspense boundary required: MultiStageRegisterForm calls useSearchParams()
// in its render body to thread the returnUrl through to the "Already have
// an account? Sign in" link. Without this boundary, Next.js renders with
// `searchParams` resolved to null during SSR but to the real values during
// client hydration — DOM differs, React throws hydration error #418.
// Same fix pattern as /login (see app/login/page.tsx).
export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <MultiStageRegisterForm />
    </Suspense>
  );
}
