'use client';

import Link from 'next/link';
import Logo from './Logo';
import { useSiteVisibility } from './hooks/useSiteVisibility';

// Social icons — minimal inline SVGs (lucide dropped brand marks).
const FacebookIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);
const LinkedinIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" /><rect width="4" height="12" x="2" y="9" /><circle cx="4" cy="4" r="2" />
  </svg>
);
const InstagramIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);

interface FooterProps {
  className?: string;
}

// Only these three platforms are supported; URLs + visibility come from admin.
const SOCIAL_META = [
  { key: 'linkedin' as const, Icon: LinkedinIcon, label: 'LinkedIn' },
  { key: 'facebook' as const, Icon: FacebookIcon, label: 'Facebook' },
  { key: 'instagram' as const, Icon: InstagramIcon, label: 'Instagram' },
];

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Hosting',
    links: [
      { label: 'Web Hosting', href: '/hosting' },
      { label: 'Business Hosting', href: '/hosting' },
      { label: 'Reseller Hosting', href: '/hosting' },
      { label: 'VPS Hosting', href: '/hosting' },
    ],
  },
  {
    title: 'Domain',
    links: [
      { label: 'Domain Search', href: '/domains-home' },
      { label: 'Transfer Domain', href: '/domains-home' },
      { label: 'WHOIS Lookup', href: '/domains-home' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About Us', href: '/about' },
      { label: 'Why Choose Us', href: '/hosting' },
      { label: 'Blog', href: '#' },
      { label: 'Careers', href: '#' },
    ],
  },
  {
    title: 'Support',
    links: [
      { label: 'Help Center', href: '/contact' },
      { label: 'Contact Us', href: '/contact' },
      { label: 'Knowledge Base', href: '#' },
      { label: 'System Status', href: '#' },
    ],
  },
];

const PAYMENTS: { label: string; color: string }[] = [
  { label: 'VISA', color: 'text-[#1A1F71]' },
  { label: 'Mastercard', color: 'text-[#EB001B]' },
  { label: 'UPI', color: 'text-[#097939]' },
  { label: 'PayPal', color: 'text-[#003087]' },
];

export default function FooterModern({ className = '' }: FooterProps) {
  const { showGstin, social } = useSiteVisibility();
  return (
    <footer className={`bg-[#0f172a] text-white ${className}`}>
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-2 lg:grid-cols-12 gap-x-6 gap-y-8 mb-8">
          {/* Brand */}
          <div className="col-span-2 lg:col-span-2">
            <div className="flex items-center mb-2.5">
              <Logo size="lg" showText={false} variant="dark" />
            </div>
            <p className="text-[11px] font-semibold tracking-wide text-gray-400 mb-1.5">Empowering Businesses Online</p>
            <p className="text-xs text-gray-400 leading-relaxed max-w-xs mb-4">
              Reliable, fast &amp; secure web hosting to help businesses grow online.
            </p>
            <div className="flex gap-2">
              {SOCIAL_META.filter(({ key }) => social[key]?.enabled && social[key]?.url).map(({ key, Icon, label }) => (
                <a
                  key={key}
                  href={social[key].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 text-gray-400 hover:bg-violet-600 hover:text-white transition-colors"
                >
                  <Icon className="h-3.5 w-3.5" />
                </a>
              ))}
            </div>
          </div>

          {/* Link columns */}
          {COLUMNS.map((col) => (
            <div key={col.title} className="lg:col-span-2">
              <h3 className="text-sm font-bold text-white mb-3.5">{col.title}</h3>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href} className="text-sm text-gray-400 hover:text-white transition-colors">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* We Accept */}
          <div className="col-span-2 lg:col-span-2">
            <h3 className="text-sm font-bold text-white mb-3.5">We Accept</h3>
            <div className="flex flex-wrap gap-2">
              {PAYMENTS.map((p) => (
                <span
                  key={p.label}
                  className={`bg-white rounded px-2 py-1 text-[11px] font-extrabold ${p.color}`}
                >
                  {p.label}
                </span>
              ))}
            </div>
            {showGstin && <p className="text-xs text-gray-500 mt-3">GSTIN: 07ABDCA0298H1ZP</p>}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/10 pt-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-3 text-center md:text-left">
            <p className="text-gray-500 text-sm">
              © {new Date().getFullYear()} Anutech Digital Private Limited. All rights reserved.
            </p>
            <div className="flex flex-wrap gap-4 md:gap-6 justify-center md:justify-end">
              <Link href="/privacy" className="text-gray-500 hover:text-white text-sm transition-colors">Privacy Policy</Link>
              <Link href="/terms-and-conditions" className="text-gray-500 hover:text-white text-sm transition-colors">Terms and Conditions</Link>
              <Link href="/data-deletion" className="text-gray-500 hover:text-white text-sm transition-colors">Data Deletion</Link>
              <Link href="/cancellation-refund" className="text-gray-500 hover:text-white text-sm transition-colors">Cancellation &amp; Refund</Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
