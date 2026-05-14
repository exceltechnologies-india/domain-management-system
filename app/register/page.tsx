'use client';

import MultiStageRegisterForm from '@/components/MultiStageRegisterForm';

export default function RegisterPage() {
  // No need to check authentication here - let middleware handle it
  // This prevents redirect loops encountered when stale cookies exist
  return <MultiStageRegisterForm />;
}