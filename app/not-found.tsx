'use client';

import { Home, ArrowLeft, FileX } from 'lucide-react';
import Link from 'next/link';
import Button from '@/components/Button';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />

      <div className="flex items-center justify-center min-h-[80vh] px-4 pt-24">
        <div className="text-center max-w-2xl mx-auto">
          {/* 404 Icon */}
          <div className="mb-8">
            <div className="bg-primary-100 rounded-full w-32 h-32 flex items-center justify-center mx-auto mb-6">
              <FileX className="h-16 w-16 text-primary-600" />
            </div>
            <h1 className="text-9xl font-bold text-primary-600 mb-4">404</h1>
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              Page Not Found
            </h2>
            <p className="text-xl text-gray-600 mb-8">
              Sorry, we couldn't find the page you're looking for.
              The page might have been moved, deleted, or doesn't exist.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
            <Link href="/">
              <Button variant="primary" size="lg" className="flex items-center gap-2">
                <Home className="h-5 w-5" />
                Go Home
              </Button>
            </Link>
            <Button
              variant="outline"
              size="lg"
              className="flex items-center gap-2"
              onClick={() => window.history.back()}
            >
              <ArrowLeft className="h-5 w-5" />
              Go Back
            </Button>
          </div>

        </div>
      </div>

      <Footer />
    </div>
  );
}
