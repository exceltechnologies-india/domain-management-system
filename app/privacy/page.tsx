'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import ClientOnly from '@/components/ClientOnly';
import { motion } from 'framer-motion';
import { Shield, Calendar, Lock, Eye, Database, Mail } from 'lucide-react';
import { formatIndianDate } from '@/lib/dateUtils';
import { safeLocalStorage } from '@/lib/storage';
import { logger } from '@/lib/logger';

interface User {
  firstName: string;
  lastName: string;
  role: string;
}

export default function PrivacyPage() {
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();

  useEffect(() => {
    const token = safeLocalStorage.getItem('token');
    const userData = safeLocalStorage.getItem('userData');

    if (token && userData) {
      try {
        const userObj = JSON.parse(userData);
        setUser(userObj);

        // Redirect admin users to admin dashboard
        if (userObj.role === 'admin') {
          router.push('/admin/dashboard');
          return;
        }
      } catch (error) {
        logger.error('Error parsing user data:', error);
      }
    }
  }, [router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Navigation user={user} />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="pt-20 pb-16"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="text-center mb-12 flex flex-col items-center">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-6">
              <Shield className="h-8 w-8 text-green-600" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4 px-4">Privacy Policy</h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Your privacy is important to us. This policy explains how we collect, use, and protect your information.
            </p>
            <div className="flex items-center justify-center mt-4 text-sm text-gray-500">
              <Calendar className="h-4 w-4 mr-2" />
              Last updated: {formatIndianDate(new Date())}
            </div>
          </div>

          {/* Content */}
          <div className="bg-white rounded-2xl shadow-lg p-8 md:p-12">
            <div className="prose prose-lg max-w-none">

              {/* Introduction */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <Lock className="h-6 w-6 text-green-600 mr-3" />
                  1. Information We Collect
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We collect information you provide directly to us, such as when you create an account, register a domain, or contact us for support.
                </p>
                <div className="bg-green-50 border-l-4 border-green-400 p-4 rounded-r-lg mb-4">
                  <h3 className="text-lg font-semibold text-green-800 mb-2">Personal Information</h3>
                  <ul className="list-disc list-inside text-green-700 space-y-1">
                    <li>Name and contact information (email, phone, address)</li>
                    <li>Account credentials and preferences</li>
                    <li>Payment and billing information</li>
                    <li>Domain registration details</li>
                    <li>Website content and database credentials (for hosting)</li>
                  </ul>
                </div>
                <div className="bg-blue-50 border-l-4 border-blue-400 p-4 rounded-r-lg">
                  <h3 className="text-lg font-semibold text-blue-800 mb-2">Usage Information</h3>
                  <ul className="list-disc list-inside text-blue-700 space-y-1">
                    <li>Website usage and interaction data</li>
                    <li>Device information and IP addresses</li>
                    <li>Cookies and similar tracking technologies</li>
                    <li>Log files and analytics data</li>
                    <li>Server access logs and error logs</li>
                  </ul>
                </div>
              </section>

              {/* How We Use Information */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <Eye className="h-6 w-6 text-green-600 mr-3" />
                  2. How We Use Your Information
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We use the information we collect to provide, maintain, and improve our services:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li>Process domain registrations, renewals, and hosting setups</li>
                  <li>Provide customer support and technical assistance</li>
                  <li>Send important service updates and notifications</li>
                  <li>Process payments and prevent fraud</li>
                  <li>Improve our website and services</li>
                  <li>Comply with legal obligations</li>
                </ul>
              </section>

              {/* Information Sharing */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">3. Information Sharing</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We do not sell, trade, or otherwise transfer your personal information to third parties without your consent, except in the following circumstances:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li><strong>Service Providers:</strong> We may share information with trusted third parties who assist us in operating our website and conducting our business</li>
                  <li><strong>Legal Requirements:</strong> We may disclose information when required by law or to protect our rights and safety</li>
                  <li><strong>Business Transfers:</strong> In the event of a merger or acquisition, your information may be transferred as part of the business assets</li>
                  <li><strong>Consent:</strong> We may share information with your explicit consent</li>
                </ul>
              </section>

              {/* Data Security */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <Database className="h-6 w-6 text-green-600 mr-3" />
                  4. Data Security
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We implement appropriate security measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction.
                </p>
                <div className="bg-gray-50 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-3">Security Measures Include:</h3>
                  <ul className="list-disc list-inside text-gray-700 space-y-2">
                    <li>SSL encryption for data transmission</li>
                    <li>Secure servers and databases with regular malware scanning</li>
                    <li>Regular security audits and updates</li>
                    <li>Access controls and authentication</li>
                    <li>Employee training on data protection</li>
                  </ul>
                </div>
              </section>

              {/* Cookies and Tracking */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">5. Cookies and Tracking Technologies</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We use cookies and similar technologies to enhance your experience on our website. You can control cookie settings through your browser preferences.
                </p>
                <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded-r-lg">
                  <p className="text-yellow-800">
                    <strong>Note:</strong> Disabling cookies may affect the functionality of our website and services.
                  </p>
                </div>
              </section>

              {/* Your Rights */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">6. Your Rights</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  You have certain rights regarding your personal information:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li><strong>Access:</strong> Request access to your personal information</li>
                  <li><strong>Correction:</strong> Request correction of inaccurate information</li>
                  <li><strong>Deletion:</strong> Request deletion of your personal information</li>
                  <li><strong>Portability:</strong> Request a copy of your data (including website files)</li>
                  <li><strong>Opt-out:</strong> Unsubscribe from marketing communications</li>
                </ul>
              </section>

              {/* Data Retention */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <Database className="h-6 w-6 text-green-600 mr-3" />
                  7. Data Retention
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We retain data only as long as required to fulfil the purpose for which it was collected, or as required by applicable law. The schedule below reflects the actual retention periods enforced by our systems.
                </p>
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">Data Category</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">Retention Period</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">Basis</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Account &amp; profile data</td>
                        <td className="px-4 py-3 text-gray-600">Duration of account + 30 days after verified deletion request</td>
                        <td className="px-4 py-3 text-gray-600">Contract performance</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Orders &amp; invoices</td>
                        <td className="px-4 py-3 text-gray-600">7 years from transaction date</td>
                        <td className="px-4 py-3 text-gray-600">Legal obligation (Indian IT Act / GST)</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Domain &amp; hosting records</td>
                        <td className="px-4 py-3 text-gray-600">1 year after service expiry, then purged</td>
                        <td className="px-4 py-3 text-gray-600">Legitimate interest (dispute resolution)</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Admin audit logs</td>
                        <td className="px-4 py-3 text-gray-600">90 days (automatic TTL expiry)</td>
                        <td className="px-4 py-3 text-gray-600">Security &amp; fraud prevention</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Authentication session tokens</td>
                        <td className="px-4 py-3 text-gray-600">30 minutes (auto-expired)</td>
                        <td className="px-4 py-3 text-gray-600">Security</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Server &amp; application logs</td>
                        <td className="px-4 py-3 text-gray-600">30 days, then rotated</td>
                        <td className="px-4 py-3 text-gray-600">Security &amp; debugging</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 text-gray-800">Payment gateway data</td>
                        <td className="px-4 py-3 text-gray-600">Held by Razorpay per their policy; our records 7 years</td>
                        <td className="px-4 py-3 text-gray-600">Legal obligation</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-gray-600 text-sm mt-4">
                  To request early deletion of your account data, visit our{' '}
                  <a href="/data-deletion" className="text-green-600 underline hover:text-green-700">Data Deletion page</a>{' '}
                  or email <strong>support@anutech.in</strong>. Financial and legal records cannot be deleted before their mandatory retention period expires.
                </p>
              </section>

              {/* Children's Privacy */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">8. Children's Privacy</h2>
                <p className="text-gray-700 leading-relaxed">
                  Our services are not intended for children under 13 years of age. We do not knowingly collect personal information from children under 13. If you are a parent or guardian and believe your child has provided us with personal information, please contact us.
                </p>
              </section>

              {/* Changes to Privacy Policy */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">9. Changes to This Privacy Policy</h2>
                <p className="text-gray-700 leading-relaxed">
                  We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last updated" date.
                </p>
              </section>

              {/* Contact Information */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <Mail className="h-6 w-6 text-green-600 mr-3" />
                  10. Contact Us
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  If you have any questions about this Privacy Policy or our data practices, please contact us:
                </p>
                <div className="bg-gray-50 rounded-lg p-6">
                  <p className="text-gray-700">
                    <strong>Anutech Digital Private Limited</strong><br />
                    Email: support@anutech.in<br />
                    Phone: +91-777-888-9674<br />
                    Address: B9-54, Rohini, Sector-5, Delhi, India
                  </p>
                </div>
              </section>

            </div>
          </div>
        </div>
      </motion.div>

      <Footer />
    </div>
  );
}
