'use client';

import LoginForm from '@/components/LoginForm';

export default function LoginPage() {
  // Simply show the login form
  // No need to check authentication here - let middleware and LoginForm handle it
  // This prevents redirect loops
  return <LoginForm />;
}