'use client';

import { useState, useEffect, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowLeft, Download, FileText, Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import UserLayout from '@/components/user/UserLayout';
import { safeLocalStorage } from '@/lib/storage';
import { performLogout } from '@/lib/logout';
import { DashboardLayoutSkeleton, DetailPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { showSuccessToast, showErrorToast } from '@/lib/toast';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

export default function ViewInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: invoiceId } = use(params);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const router = useRouter();
  const { data: session, status } = useSession();

  // Auth Check
  useEffect(() => {
    if (status === 'loading') return;

    if (session?.user) {
      const sUser = session.user;
      const userObj = {
        id: sUser.id ?? '',
        email: session.user.email || '',
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        role: sUser.role || 'user',
      };
      setUser(userObj);
      setIsAuthLoading(false);
      return;
    }

    const token = safeLocalStorage.getItem('token');
    const userData = safeLocalStorage.getItem('user');

    if (!token || !userData) {
      router.push('/login');
      return;
    }

    try {
      setUser(JSON.parse(userData));
      setIsAuthLoading(false);
    } catch (e) {
      router.push('/login');
    }
  }, [router, session, status]);

  // Fetch PDF as blob URL — works in all browsers including Firefox
  // because blob URLs don't require re-authentication in the iframe context.
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const fetchPdf = async () => {
      setIsLoadingPdf(true);
      setPdfError(null);
      try {
        const res = await fetch(`/api/v1/user/invoices/${invoiceId}/pdf`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setPdfBlobUrl(url);
      } catch (err) {
        if (!cancelled) setPdfError('Failed to load PDF. Please try again or download it.');
      } finally {
        if (!cancelled) setIsLoadingPdf(false);
      }
    };

    void fetchPdf();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [user, invoiceId]);

  const handleDownload = async () => {
    try {
      setIsDownloading(true);
      // Re-use already-loaded blob if available
      if (pdfBlobUrl) {
        const a = document.createElement('a');
        a.href = pdfBlobUrl;
        a.download = `Invoice-${invoiceId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showSuccessToast('Invoice downloaded successfully');
        return;
      }
      // Fallback: fetch fresh
      const response = await fetch(`/api/v1/user/invoices/${invoiceId}/pdf`);
      if (!response.ok) { showErrorToast('Failed to download invoice'); return; }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Invoice-${invoiceId}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      showSuccessToast('Invoice downloaded successfully');
    } catch (error) {
      showErrorToast('Failed to download invoice');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleOpenNewTab = () => {
    if (pdfBlobUrl) window.open(pdfBlobUrl, '_blank');
  };

  const handleRetry = () => {
    setPdfBlobUrl(null);
    setPdfError(null);
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    // Re-trigger effect by bumping a counter would be cleaner, but simply
    // re-fetching here is fine since user is already set.
    setIsLoadingPdf(true);
    fetch(`/api/v1/user/invoices/${invoiceId}/pdf`)
      .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setPdfBlobUrl(url);
        setPdfError(null);
      })
      .catch(() => setPdfError('Failed to load PDF. Please try again or download it.'))
      .finally(() => setIsLoadingPdf(false));
  };

  if (isAuthLoading || !user) {
    return <DashboardLayoutSkeleton><DetailPageSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <UserLayout user={user} onLogout={performLogout} hideFloatingButtons={true}>
      <div className="p-4 sm:p-6 flex flex-col h-full md:h-[calc(100vh-64px)] gap-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.back()}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600 flex-shrink-0"
              title="Go Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
                <FileText className="h-5 w-5 text-blue-600 flex-shrink-0" />
                <span className="truncate">Invoice {invoiceId}</span>
              </h1>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {pdfBlobUrl && (
              <button
                onClick={handleOpenNewTab}
                className="flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2.5 rounded-lg font-medium transition-all flex-1 sm:flex-initial text-sm"
              >
                <ExternalLink className="h-4 w-4" />
                Open in Tab
              </button>
            )}
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-all shadow-sm hover:shadow-md active:scale-95 disabled:opacity-50 flex-1 sm:flex-initial text-sm"
            >
              {isDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Download
            </button>
          </div>
        </div>

        {/* Viewer */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden relative min-h-[60vh] sm:min-h-0">

          {isLoadingPdf && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-50">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
              <p className="text-sm text-gray-500 font-medium">Loading invoice…</p>
            </div>
          )}

          {pdfError && !isLoadingPdf && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center bg-gray-50">
              <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center">
                <FileText className="h-8 w-8 text-red-400" />
              </div>
              <p className="text-gray-600 text-sm max-w-xs">{pdfError}</p>
              <div className="flex gap-3">
                <button
                  onClick={handleRetry}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
                >
                  <Download className="h-4 w-4" />
                  Download
                </button>
              </div>
            </div>
          )}

          {pdfBlobUrl && !isLoadingPdf && (
            <iframe
              src={pdfBlobUrl}
              className="w-full h-full border-none"
              title={`Invoice ${invoiceId}`}
            />
          )}
        </div>
      </div>
    </UserLayout>
  );
}
