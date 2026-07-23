'use client';

import { Mail, Phone, MapPin, Clock, MessageCircle } from 'lucide-react';
import Card from './Card';
import { COMPANY_PHONE_DISPLAY, COMPANY_PHONE_E164, COMPANY_SUPPORT_HOURS } from '@/config/company';
import { useSiteVisibility } from './hooks/useSiteVisibility';

interface ContactInfoProps {
  className?: string;
}

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

const SOCIAL_META = [
  { key: 'linkedin' as const, Icon: LinkedinIcon, label: 'LinkedIn' },
  { key: 'facebook' as const, Icon: FacebookIcon, label: 'Facebook' },
  { key: 'instagram' as const, Icon: InstagramIcon, label: 'Instagram' },
];

export default function ContactInfo({ className = '' }: ContactInfoProps) {
  const { showPhone, social } = useSiteVisibility();
  const activeSocials = SOCIAL_META.filter(({ key }) => social[key]?.enabled && social[key]?.url);
  return (
    <div className={`space-y-6 text-center lg:text-left ${className}`}>
      <div>
        <h3 className="text-2xl font-bold text-gray-900 mb-3">Get in touch</h3>
        <p className="text-gray-600 text-base leading-relaxed mb-6 max-w-2xl mx-auto lg:mx-0">
          Have questions about our domain management services? We're here to help! Reach out to us through any of the channels below, and our team will get back to you as soon as possible.
        </p>
      </div>

      <div className="space-y-4">
        {showPhone && (
        <Card className="flex flex-col items-center sm:flex-row sm:items-start p-5 hover:shadow-lg transition-shadow duration-200 text-center sm:text-left">
          <div className="bg-primary-100 rounded-full p-3 mb-4 sm:mb-0 sm:mr-4 flex-shrink-0">
            <Phone className="h-6 w-6 text-primary-600" />
          </div>
          <div className="flex-1">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Call Us</h4>
            <a href={`tel:${COMPANY_PHONE_E164}`} className="text-gray-700 text-base font-medium mb-1 hover:text-primary-600 transition-colors">{COMPANY_PHONE_DISPLAY}</a>
            <div className="flex items-center justify-center sm:justify-start text-sm text-gray-500 mt-2">
              <Clock className="h-4 w-4 mr-1" />
              <span>{COMPANY_SUPPORT_HOURS}</span>
            </div>
          </div>
        </Card>
        )}

        <Card className="flex flex-col items-center sm:flex-row sm:items-start p-5 hover:shadow-lg transition-shadow duration-200 text-center sm:text-left">
          <div className="bg-primary-100 rounded-full p-3 mb-4 sm:mb-0 sm:mr-4 flex-shrink-0">
            <Mail className="h-6 w-6 text-primary-600" />
          </div>
          <div className="flex-1">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Email Us</h4>
            <p className="text-gray-700 text-base font-medium mb-1">sales@anutech.in</p>
            <div className="flex items-center justify-center sm:justify-start text-sm text-gray-500 mt-2">
              <MessageCircle className="h-4 w-4 mr-1" />
              <span>We'll respond within 24 hours</span>
            </div>
          </div>
        </Card>

        <Card className="flex flex-col items-center sm:flex-row sm:items-start p-5 hover:shadow-lg transition-shadow duration-200 text-center sm:text-left">
          <div className="bg-primary-100 rounded-full p-3 mb-4 sm:mb-0 sm:mr-4 flex-shrink-0">
            <MapPin className="h-6 w-6 text-primary-600" />
          </div>
          <div className="flex-1">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Visit Us</h4>
            <p className="text-gray-700 text-base font-medium mb-1">B9-54, Rohini, Sector-5</p>
            <p className="text-sm text-gray-500">Delhi, India</p>
          </div>
        </Card>

        {activeSocials.length > 0 && (
          <Card className="p-5 text-center sm:text-left">
            <h4 className="text-lg font-semibold text-gray-900 mb-1">Follow Us</h4>
            <p className="text-sm text-gray-500 mb-4">Stay connected for updates, offers and news.</p>
            <div className="flex gap-3 justify-center sm:justify-start">
              {activeSocials.map(({ key, Icon, label }) => (
                <a
                  key={key}
                  href={social[key].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="h-11 w-11 flex items-center justify-center rounded-full bg-primary-50 text-primary-600 hover:bg-primary-600 hover:text-white transition-colors"
                >
                  <Icon className="h-5 w-5" />
                </a>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
