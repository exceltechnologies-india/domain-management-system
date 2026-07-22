'use client';

import { Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  Headphones,
  ShieldAlert,
  Search,
  UserX
} from 'lucide-react';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import Link from 'next/link';

function ErrorContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const code = searchParams.get('code') || 'ERROR';
  const message = searchParams.get('message') || 'An unexpected error occurred during your hosting session.';

  const errorConfigs: Record<string, { icon: React.ReactNode; title: string; color: string }> = {
    ACCOUNT_SUSPENDED: {
      icon: <ShieldAlert className="h-16 w-16" />,
      title: "Account Suspended",
      color: "from-red-500 to-orange-600"
    },
    HOSTING_NOT_FOUND: {
      icon: <Search className="h-16 w-16" />,
      title: "Hosting Not Found",
      color: "from-primary-500 to-indigo-600"
    },
    OWNERSHIP_VERIFICATION_FAILED: {
      icon: <UserX className="h-16 w-16" />,
      title: "Access Denied",
      color: "from-purple-500 to-pink-600"
    },
    AUTH_REQUIRED: {
      icon: <AlertCircle className="h-16 w-16" />,
      title: "Session Expired",
      color: "from-amber-500 to-orange-600"
    },
    DEFAULT: {
      icon: <AlertCircle className="h-16 w-16" />,
      title: "Something Went Wrong",
      color: "from-gray-700 to-gray-900"
    }
  };

  const config = errorConfigs[code] || errorConfigs.DEFAULT;

  return (
    <div className="flex flex-col items-center justify-center text-center px-4 py-20 min-h-[70vh]">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", duration: 0.6 }}
        className={`bg-gradient-to-br ${config.color} p-6 rounded-3xl text-white shadow-2xl mb-8`}
      >
        {config.icon}
      </motion.div>

      <motion.h1
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="text-4xl md:text-5xl font-extrabold text-gray-900 mb-4 bg-gradient-to-r from-gray-900 via-gray-700 to-gray-900 bg-clip-text text-transparent"
      >
        {config.title}
      </motion.h1>

      <motion.p
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-lg text-gray-600 max-w-lg mb-12 leading-relaxed"
      >
        {message}
      </motion.p>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="flex flex-col sm:flex-row gap-4 w-full max-w-md justify-center"
      >
        <button
          onClick={() => router.push('/dashboard')}
          className="flex items-center justify-center gap-2 bg-[var(--google-blue)] text-white px-8 py-3 rounded-xl font-bold shadow-lg hover:shadow-xl hover:translate-y-[-2px] transition-all"
        >
          <ArrowLeft className="h-5 w-5" />
          Back to Dashboard
        </button>
        <Link
          href="/contact"
          className="flex items-center justify-center gap-2 bg-white border-2 border-gray-200 text-gray-700 px-8 py-3 rounded-xl font-bold hover:bg-gray-50 hover:border-gray-300 transition-all"
        >
          <Headphones className="h-5 w-5" />
          Support
        </Link>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
        className="mt-16 text-sm text-gray-400 font-medium"
      >
        Error Code: <span className="font-mono text-gray-500">{code}</span>
      </motion.div>
    </div>
  );
}

export default function HostingErrorPage() {
  return (
    <div className="min-h-screen bg-[var(--google-bg-secondary)] flex flex-col">
      <Navigation />

      <main className="flex-grow pt-20">
        <Suspense fallback={<div className="flex items-center justify-center min-h-[50vh]">Loading...</div>}>
          <ErrorContent />
        </Suspense>
      </main>

      <Footer />
    </div>
  );
}
