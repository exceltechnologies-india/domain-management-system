'use client';

/*
 * /choose-password — the first sign-in after the one-time password in the "Your Customer
 * Portal is ready" email (Pawan, 7 Oct 2026). The middleware sends every dashboard/checkout
 * page here while the account is marked mustChangePassword; saving clears it, refreshes the
 * session and goes straight on to the dashboard — no second sign-in.
 */
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Lock, Eye, EyeOff, Check, Circle } from 'lucide-react';
import toast from 'react-hot-toast';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Card from '@/components/Card';
import Logo from '@/components/Logo';
import { apiClient } from '@/lib/api-client';

/** The same rules the server applies (InputValidator.validatePasswordStrength). */
const RULES: { label: string; ok: (p: string) => boolean }[] = [
  { label: 'At least 8 characters', ok: (p) => p.length >= 8 },
  { label: 'An uppercase letter', ok: (p) => /[A-Z]/.test(p) },
  { label: 'A lowercase letter', ok: (p) => /[a-z]/.test(p) },
  { label: 'A number', ok: (p) => /[0-9]/.test(p) },
  { label: 'A special character (e.g. ! @ # -)', ok: (p) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(p) },
];

function safeReturn(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/choose-password') ? raw : '/dashboard';
}

function ChoosePasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: session, status, update } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  if (status === 'unauthenticated') {
    router.replace('/login');
    return null;
  }

  const allOk = RULES.every((r) => r.ok(password));
  const matches = confirm.length > 0 && confirm === password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allOk) { toast.error('Your password does not meet all the rules yet — see the list below the box.'); return; }
    if (!matches) { toast.error('The two passwords do not match. Type the same password in both boxes.'); return; }
    setSaving(true);
    try {
      const res = await apiClient.post('/api/v1/user/choose-password', { newPassword: password });
      if (!res.ok) {
        toast.error(res.error.message || "We couldn't save your password. Please try again.");
        return;
      }
      await update(); // re-reads the account, so the one-time-password gate lifts at once
      toast.success('Password saved — welcome to your Customer Portal.');
      router.replace(safeReturn(params.get('returnUrl')) as never);
    } finally {
      setSaving(false);
    }
  };

  const first = (session?.user?.name ?? '').trim().split(/\s+/)[0];
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-2 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6"><Logo size="lg" /></div>
          <h1 className="text-3xl font-bold text-ink">Choose your password</h1>
          <p className="mt-2 text-sm text-ink-2">
            {first ? `Welcome, ${first}! ` : 'Welcome! '}You signed in with a one-time password. Choose your own to finish — you&apos;ll use it from now on.
          </p>
        </div>
        <Card>
          <form className="space-y-5" onSubmit={submit} noValidate>
            <Input
              label="New password"
              name="password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              fullWidth
              className="min-h-[44px]"
              icon={<Lock className="h-4 w-4 text-ink-4" />}
              rightIcon={
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}
                  className="text-ink-3 hover:text-ink-2 focus:outline-none inline-flex items-center justify-center min-w-[44px] min-h-[44px]">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
            />
            <ul className="space-y-1.5 text-sm" aria-label="Password rules">
              {RULES.map((r) => {
                const ok = r.ok(password);
                return (
                  <li key={r.label} className={`flex items-center gap-2 ${ok ? 'text-emerald-ink' : 'text-ink-3'}`}>
                    {ok ? <Check className="h-4 w-4" aria-hidden /> : <Circle className="h-3.5 w-3.5" aria-hidden />}
                    <span>{r.label}</span>
                    <span className="sr-only">{ok ? '— done' : '— not yet'}</span>
                  </li>
                );
              })}
            </ul>
            <Input
              label="Type it again"
              name="confirmPassword"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              fullWidth
              className="min-h-[44px]"
              icon={<Lock className="h-4 w-4 text-ink-4" />}
              error={confirm.length > 0 && !matches ? 'The two passwords do not match yet.' : undefined}
            />
            <Button type="submit" fullWidth loading={saving} disabled={saving}>
              Save password and continue
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

export default function ChoosePasswordPage() {
  return (
    <Suspense fallback={null}>
      <ChoosePasswordForm />
    </Suspense>
  );
}
