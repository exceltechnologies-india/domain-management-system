'use client';

import Link from 'next/link';
import { Mail, Phone, MapPin, Globe, Shield, CreditCard, Database, Server, Wifi } from 'lucide-react';
import { useSiteVisibility } from './hooks/useSiteVisibility';

// Social icons removed from lucide-react v1 — use minimal inline SVGs
const FacebookIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);
const InstagramIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);
const LinkedinIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" /><rect width="4" height="12" x="2" y="9" /><circle cx="4" cy="4" r="2" />
  </svg>
);
import Logo from './Logo';

interface FooterProps {
  className?: string;
}

export default function FooterClassic({ className = '' }: FooterProps) {
  const { social } = useSiteVisibility();
  return (
    <footer className={`bg-gray-900 text-white ${className}`}>
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-8">
          {/* Company Info */}
          <div className="col-span-2 md:col-span-2 text-center md:text-left">
            <div className="flex items-center justify-center md:justify-start mb-4">
              <Logo size="xl" showText={false} variant="dark" />
            </div>
            <p className="text-gray-300 mb-6 max-w-md mx-auto md:mx-0">
              Anutech Digital Private Limited provides secure payments, professional DNS management, comprehensive domain solutions, and reliable web hosting services.
            </p>
            <div className="flex space-x-4 justify-center md:justify-start">
              <a href="#" className="text-gray-400 hover:text-white transition-colors">
                <Globe className="h-5 w-5" />
              </a>
              <a href="#" className="text-gray-400 hover:text-white transition-colors">
                <Shield className="h-5 w-5" />
              </a>
              <a href="#" className="text-gray-400 hover:text-white transition-colors">
                <CreditCard className="h-5 w-5" />
              </a>
            </div>
          </div>

          {/* Quick Links */}
          <div className="text-center md:text-left">
            <h3 className="text-lg font-semibold mb-4">Quick Links</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/" className="text-gray-300 hover:text-white transition-colors">
                  Home
                </Link>
              </li>
              <li>
                <Link href="/about" className="text-gray-300 hover:text-white transition-colors">
                  About Us
                </Link>
              </li>
              <li>
                <Link href="/contact" className="text-gray-300 hover:text-white transition-colors">
                  Contact Us
                </Link>
              </li>
              <li>
                <Link href="/login" className="text-gray-300 hover:text-white transition-colors">
                  Login
                </Link>
              </li>
              <li>
                <Link href="/register" className="text-gray-300 hover:text-white transition-colors">
                  Register
                </Link>
              </li>
            </ul>
          </div>

          {/* Services */}
          <div className="text-center md:text-left">
            <h3 className="text-lg font-semibold mb-4">Services</h3>
            <ul className="space-y-2">
              <li className="text-gray-300">Domain Registration</li>
              <li className="text-gray-300">DNS Management</li>
              <li className="text-gray-300">Backup</li>
              <li className="text-gray-300">SSL Certificates</li>
              <li>
                <Link href="/hosting" className="text-gray-300 hover:text-white transition-colors">
                  Web Hosting
                </Link>
              </li>
            </ul>
          </div>

          {/* Social Media */}
          <div className="text-center md:text-left">
            <h3 className="text-lg font-semibold mb-4">Follow Us</h3>
            <p className="text-gray-300 mb-4 text-sm">
              Stay connected with us on social media for updates and news.
            </p>
            <div className="flex flex-wrap gap-3 justify-center md:justify-start">
              {social.linkedin?.enabled && social.linkedin?.url && (
                <a href={social.linkedin.url} target="_blank" rel="noopener noreferrer" className="bg-gray-800 hover:bg-blue-700 text-white p-2 rounded-lg transition-colors duration-200" aria-label="LinkedIn">
                  <LinkedinIcon className="h-5 w-5" />
                </a>
              )}
              {social.facebook?.enabled && social.facebook?.url && (
                <a href={social.facebook.url} target="_blank" rel="noopener noreferrer" className="bg-gray-800 hover:bg-blue-600 text-white p-2 rounded-lg transition-colors duration-200" aria-label="Facebook">
                  <FacebookIcon className="h-5 w-5" />
                </a>
              )}
              {social.instagram?.enabled && social.instagram?.url && (
                <a href={social.instagram.url} target="_blank" rel="noopener noreferrer" className="bg-gray-800 hover:bg-pink-600 text-white p-2 rounded-lg transition-colors duration-200" aria-label="Instagram">
                  <InstagramIcon className="h-5 w-5" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center text-center md:text-left">
            <p className="text-gray-400 text-sm">
              © {new Date().getFullYear()} Anutech Digital Private Limited. All rights reserved.
            </p>
            <div className="flex flex-wrap gap-4 md:gap-6 mt-4 md:mt-0 justify-center md:justify-end">
              <Link href="/privacy" className="text-gray-400 hover:text-white text-sm transition-colors">
                Privacy Policy
              </Link>
              <Link href="/terms-and-conditions" className="text-gray-400 hover:text-white text-sm transition-colors">
                Terms and Conditions
              </Link>
              <Link href="/data-deletion" className="text-gray-400 hover:text-white text-sm transition-colors">
                Data Deletion
              </Link>
              <Link href="/cancellation-refund" className="text-gray-400 hover:text-white text-sm transition-colors">
                Cancellation & Refund
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
