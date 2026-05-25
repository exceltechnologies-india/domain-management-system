import { Mail, Phone, MapPin, Clock, MessageCircle } from 'lucide-react';
import Card from './Card';

interface ContactInfoProps {
  className?: string;
}

export default function ContactInfo({ className = '' }: ContactInfoProps) {
  return (
    <div className={`space-y-6 text-center lg:text-left ${className}`}>
      <div>
        <h3 className="text-2xl font-bold text-gray-900 mb-3">Get in touch</h3>
        <p className="text-gray-600 text-base leading-relaxed mb-6 max-w-2xl mx-auto lg:mx-0">
          Have questions about our domain management services? We're here to help! Reach out to us through any of the channels below, and our team will get back to you as soon as possible.
        </p>
      </div>

      <div className="space-y-4">
        <Card className="flex flex-col items-center sm:flex-row sm:items-start p-5 hover:shadow-lg transition-shadow duration-200 text-center sm:text-left">
          <div className="bg-blue-100 rounded-full p-3 mb-4 sm:mb-0 sm:mr-4 flex-shrink-0">
            <Phone className="h-6 w-6 text-blue-600" />
          </div>
          <div className="flex-1">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Call Us</h4>
            <p className="text-gray-700 text-base font-medium mb-1">+91-777-888-9674</p>
            <div className="flex items-center justify-center sm:justify-start text-sm text-gray-500 mt-2">
              <Clock className="h-4 w-4 mr-1" />
              <span>10AM to 6PM (IST), Monday - Saturday</span>
            </div>
          </div>
        </Card>

        <Card className="flex flex-col items-center sm:flex-row sm:items-start p-5 hover:shadow-lg transition-shadow duration-200 text-center sm:text-left">
          <div className="bg-blue-100 rounded-full p-3 mb-4 sm:mb-0 sm:mr-4 flex-shrink-0">
            <Mail className="h-6 w-6 text-blue-600" />
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
          <div className="bg-blue-100 rounded-full p-3 mb-4 sm:mb-0 sm:mr-4 flex-shrink-0">
            <MapPin className="h-6 w-6 text-blue-600" />
          </div>
          <div className="flex-1">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Visit Us</h4>
            <p className="text-gray-700 text-base font-medium mb-1">B9-54, Rohini, Sector-5</p>
            <p className="text-sm text-gray-500">Delhi, India</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
