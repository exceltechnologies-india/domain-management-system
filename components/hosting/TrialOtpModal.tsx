'use client';

import { useEffect, useState } from 'react';
import { Phone, Loader2, X, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';

interface TrialOtpModalProps {
  isOpen: boolean;
  defaultPhone?: string;
  onClose: () => void;
  onVerified: () => void;
}

/**
 * Phone-OTP step for the hosting free trial. Rendered when the eligibility
 * endpoint reports `otpRequired: true` (admin toggle `hosting_trial_otp_required`).
 *
 * Two states: enter phone → request OTP → enter 6-digit code → on success
 * we stash the signed token in sessionStorage and call onVerified so the
 * parent can resume the trial-claim flow.
 */
export default function TrialOtpModal({
  isOpen,
  defaultPhone,
  onClose,
  onVerified,
}: TrialOtpModalProps) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [cooldownEnd, setCooldownEnd] = useState(0);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setPhone(
        defaultPhone ? defaultPhone.replace(/\D/g, '').replace(/^91/, '').slice(-10) : ''
      );
      setCode('');
      setStage('phone');
      setCooldownEnd(0);
      setRemaining(0);
    }
  }, [isOpen, defaultPhone]);

  useEffect(() => {
    if (cooldownEnd <= Date.now()) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const r = Math.max(0, Math.ceil((cooldownEnd - Date.now()) / 1000));
      setRemaining(r);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [cooldownEnd]);

  const sendOtp = async () => {
    if (!/^\d{10}$/.test(phone)) {
      toast.error('Please enter a valid 10-digit Indian mobile number.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch('/api/v1/user/hosting/trial-otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send OTP');
      toast.success('OTP sent. Check your phone.');
      setStage('code');
      setCooldownEnd(Date.now() + 60_000);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not send OTP');
    } finally {
      setSending(false);
    }
  };

  const verifyOtp = async () => {
    if (!/^\d{6}$/.test(code)) {
      toast.error('Enter the 6-digit code.');
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch('/api/v1/user/hosting/trial-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || 'Verification failed');
      sessionStorage.setItem('trial-otp-token', data.token);
      toast.success('Phone verified!');
      onVerified();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-purple-50 rounded-xl">
              <ShieldCheck className="h-4 w-4 text-purple-600" />
            </div>
            <h3 className="text-sm font-semibold text-gray-900">
              Verify your phone to start the trial
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600">
            We&apos;ll send a 6-digit code to your mobile to confirm you&apos;re a real
            user before activating your free trial.
          </p>

          {stage === 'phone' && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  Mobile number
                </label>
                <div className="flex">
                  <span className="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-gray-200 bg-gray-50 text-sm text-gray-500">
                    +91
                  </span>
                  <div className="relative flex-1">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="tel"
                      maxLength={10}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      placeholder="10-digit mobile"
                      className="w-full pl-10 pr-3 py-2.5 text-sm rounded-r-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={sendOtp}
                disabled={sending || phone.length !== 10}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {sending ? 'Sending OTP…' : 'Send OTP'}
              </button>
            </>
          )}

          {stage === 'code' && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  6-digit OTP sent to +91 {phone}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full px-3 py-2.5 text-center tracking-[0.6em] font-mono text-lg rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>
              <button
                type="button"
                onClick={verifyOtp}
                disabled={verifying || code.length !== 6}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {verifying ? 'Verifying…' : 'Verify & Start Trial'}
              </button>
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setStage('phone');
                    setCode('');
                  }}
                  className="text-gray-500 hover:text-gray-900"
                >
                  Change number
                </button>
                <button
                  type="button"
                  onClick={sendOtp}
                  disabled={sending || remaining > 0}
                  className="text-purple-600 hover:text-purple-700 disabled:text-gray-400 disabled:cursor-not-allowed font-medium"
                >
                  {remaining > 0 ? `Resend in ${remaining}s` : 'Resend OTP'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
