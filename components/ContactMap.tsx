'use client';

import { MapPin, Navigation, Loader2 } from 'lucide-react';
import { useState } from 'react';

interface ContactMapProps {
  className?: string;
}

export default function ContactMap({ className = '' }: ContactMapProps) {
  const [isMapLoading, setIsMapLoading] = useState(true);

  // Company coordinates for Rohini, Delhi (approximate location)
  const companyCoords = [28.7406, 77.0884]; // Latitude, Longitude for Rohini, Delhi
  const companyAddress = "B9-54, Rohini, Sector-5, Delhi, India";
  const encodedAddress = encodeURIComponent(companyAddress);

  return (
    <div className={`w-full ${className}`}>
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <div className="bg-blue-100 rounded-full p-3">
            <MapPin className="h-8 w-8 text-blue-600" />
          </div>
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-4">Find Us</h2>
        <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
          Visit our office in Delhi. We're located in the heart of Rohini, easily accessible by public transport.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-lg overflow-hidden border border-gray-200">
        {/* Map Container */}
        <div className="relative h-96 w-full">
          {/* Loading State */}
          {isMapLoading && (
            <div className="absolute inset-0 bg-gray-100 flex items-center justify-center z-10">
              <div className="text-center">
                <Loader2 className="h-8 w-8 text-blue-600 animate-spin mx-auto mb-3" />
                <p className="text-sm text-gray-600 font-medium">Loading map...</p>
              </div>
            </div>
          )}

          {/* OpenStreetMap Embed */}
          <iframe
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${companyCoords[1] - 0.01},${companyCoords[0] - 0.01},${companyCoords[1] + 0.01},${companyCoords[0] + 0.01}&layer=mapnik&marker=${companyCoords[0]},${companyCoords[1]}`}
            width="100%"
            height="100%"
            style={{ border: 0 }}
            allowFullScreen
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            title="Anutech Digital Private Limited Office Location"
            className="w-full h-full"
            onLoad={() => setIsMapLoading(false)}
          />

          {/* Map Overlay with Company Info */}
          <div className="absolute top-4 left-4 bg-white bg-opacity-95 backdrop-blur-sm rounded-lg p-4 shadow-lg max-w-xs">
            <div className="flex items-start space-x-3">
              <div className="bg-blue-100 rounded-full p-2 flex-shrink-0">
                <Navigation className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-sm">Anutech Digital Private Limited</h3>
                <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                  B9-54, Rohini, Sector-5<br />
                  Delhi, India
                </p>
                <a
                  href={`https://www.openstreetmap.org/directions?engine=osrm_car&route=${companyCoords[0]},${companyCoords[1]}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-xs text-blue-600 hover:text-blue-700 mt-2 font-medium"
                >
                  Get Directions →
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
