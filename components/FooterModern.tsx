import Link from 'next/link';
import Logo from './Logo';

// Social icons — minimal inline SVGs (lucide dropped brand marks).
const FacebookIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);
const TwitterIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
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
const YoutubeIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23 12s0-3.5-.45-5.17a2.9 2.9 0 0 0-2.04-2.05C18.84 4.33 12 4.33 12 4.33s-6.84 0-8.51.45A2.9 2.9 0 0 0 1.45 6.83C1 8.5 1 12 1 12s0 3.5.45 5.17a2.9 2.9 0 0 0 2.04 2.05c1.67.45 8.51.45 8.51.45s6.84 0 8.51-.45a2.9 2.9 0 0 0 2.04-2.05C23 15.5 23 12 23 12zM9.75 15.5v-7l6 3.5z" />
  </svg>
);

interface FooterProps {
  className?: string;
}

const SOCIALS = [
  { Icon: FacebookIcon, label: 'Facebook', href: '#' },
  { Icon: TwitterIcon, label: 'Twitter / X', href: '#' },
  { Icon: LinkedinIcon, label: 'LinkedIn', href: '#' },
  { Icon: InstagramIcon, label: 'Instagram', href: '#' },
  { Icon: YoutubeIcon, label: 'YouTube', href: '#' },
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
  return (
    <footer className={`bg-[#0f172a] text-white ${className}`}>
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-2 lg:grid-cols-12 gap-x-6 gap-y-5 mb-5">
          {/* Brand */}
          <div className="col-span-2 lg:col-span-2">
            <div className="flex items-center mb-1.5">
              <Logo size="md" showText={false} variant="dark" />
            </div>
            <p className="text-[10px] font-semibold tracking-wide text-gray-400 mb-1">Empowering Businesses Online</p>
            <p className="text-[11px] text-gray-400 leading-snug max-w-xs mb-2.5">
              Reliable, fast &amp; secure web hosting to help businesses grow online.
            </p>
            <div className="flex gap-1.5">
              {SOCIALS.map(({ Icon, label, href }) => (
                <a
                  key={label}
                  href={href}
                  aria-label={label}
                  className="h-7 w-7 flex items-center justify-center rounded-md bg-white/5 text-gray-400 hover:bg-violet-600 hover:text-white transition-colors"
                >
                  <Icon className="h-3 w-3" />
                </a>
              ))}
            </div>
          </div>

          {/* Link columns */}
          {COLUMNS.map((col) => (
            <div key={col.title} className="lg:col-span-2">
              <h3 className="text-[13px] font-bold text-white mb-2">{col.title}</h3>
              <ul className="space-y-1.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href} className="text-[13px] text-gray-400 hover:text-white transition-colors">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* We Accept */}
          <div className="col-span-2 lg:col-span-2">
            <h3 className="text-[13px] font-bold text-white mb-2">We Accept</h3>
            <div className="flex flex-wrap gap-1.5">
              {PAYMENTS.map((p) => (
                <span
                  key={p.label}
                  className={`bg-white rounded px-1.5 py-0.5 text-[10px] font-extrabold ${p.color}`}
                >
                  {p.label}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mt-2">GSTIN: 07ABDCA0298H1ZP</p>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/10 pt-4">
          <div className="flex flex-col md:flex-row justify-between items-center gap-2 text-center md:text-left">
            <p className="text-gray-500 text-xs">
              © {new Date().getFullYear()} Anutech Digital Private Limited. All rights reserved.
            </p>
            <div className="flex flex-wrap gap-3 md:gap-5 justify-center md:justify-end">
              <Link href="/privacy" className="text-gray-500 hover:text-white text-xs transition-colors">Privacy Policy</Link>
              <Link href="/terms-and-conditions" className="text-gray-500 hover:text-white text-xs transition-colors">Terms and Conditions</Link>
              <Link href="/data-deletion" className="text-gray-500 hover:text-white text-xs transition-colors">Data Deletion</Link>
              <Link href="/cancellation-refund" className="text-gray-500 hover:text-white text-xs transition-colors">Cancellation &amp; Refund</Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
