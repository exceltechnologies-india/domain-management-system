'use client';

import { useEffect, useState } from 'react';
import { Wrench, RefreshCw, Clock, Shield } from 'lucide-react';
import Link from 'next/link';

interface MaintenanceStatus {
  enabled: boolean;
  message: string;
  scheduledEnd: string | null;
}

function Countdown({ endTime }: { endTime: string }) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const calc = () => {
      const diff = new Date(endTime).getTime() - Date.now();
      if (diff <= 0) { setTimeLeft(''); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [endTime]);

  if (!timeLeft) return null;
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-2 mb-6">
      <Clock className="h-4 w-4 flex-shrink-0" />
      <span>Estimated time remaining: <strong>{timeLeft}</strong></span>
    </div>
  );
}

export default function MaintenancePage() {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/v1/public/maintenance-status', { cache: 'no-store' });
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus({ enabled: true, message: '', scheduledEnd: null });
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch('/api/v1/public/maintenance-status', { cache: 'no-store' });
      const data = await res.json();
      setStatus(data);
      if (!data.enabled) {
        window.location.href = '/';
        return;
      }
    } catch {
      // keep showing maintenance
    }
    setIsRefreshing(false);
  };

  // Site is live — maintenance is off
  if (status && !status.enabled) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-100 p-8 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
            <Shield className="h-8 w-8 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Site is Operating Normally</h1>
          <p className="text-gray-500 text-sm mb-6">There is no scheduled maintenance right now.</p>
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
          >
            Go to Homepage
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-8 md:p-10 text-center">
          {/* Icon */}
          <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg">
            <Wrench className="h-10 w-10 text-white" />
          </div>

          {/* Heading */}
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3">
            We&apos;re Under Maintenance
          </h1>

          {/* Message */}
          <p className="text-gray-500 text-sm md:text-base leading-relaxed mb-6">
            {status?.message && status.message.trim()
              ? status.message
              : "We're performing scheduled maintenance to improve your experience. We'll be back online shortly."}
          </p>

          {/* Countdown */}
          {status?.scheduledEnd && (
            <Countdown endTime={status.scheduledEnd} />
          )}

          {/* Divider */}
          <div className="border-t border-gray-100 my-6" />

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Checking…' : 'Try Again'}
            </button>

            <a
              href="/admin"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-gray-100 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Shield className="h-4 w-4" />
              Admin Access
            </a>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400 mt-6">
          If you need urgent assistance, please contact{' '}
          <a href="mailto:support@anutech.in" className="underline hover:text-gray-600">
            support@anutech.in
          </a>
        </p>
      </div>
    </div>
  );
}
