'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import ClientOnly from '@/components/ClientOnly';
import { motion } from 'framer-motion';
import { RotateCcw, Calendar, AlertCircle, CheckCircle, Clock, DollarSign } from 'lucide-react';
import { formatIndianDate } from '@/lib/dateUtils';
import { safeLocalStorage } from '@/lib/storage';

interface User {
  firstName: string;
  lastName: string;
  role: string;
}

export default function CancellationRefundPage() {
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();

  useEffect(() => {
    const token = safeLocalStorage.getItem('token');
    const userData = safeLocalStorage.getItem('user');

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
        // Error parsing user data
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
            <div className="inline-flex items-center justify-center w-16 h-16 bg-orange-100 rounded-full mb-6">
              <RotateCcw className="h-8 w-8 text-orange-600" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4 px-4">Cancellation & Refund Policy</h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Our policy on cancellations, refunds, and domain service modifications.
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
                  <AlertCircle className="h-6 w-6 text-orange-600 mr-3" />
                  1. Overview
                </h2>
                <p className="text-gray-700 leading-relaxed">
                  This Cancellation & Refund Policy outlines the terms and conditions for canceling services and requesting refunds from Anutech Digital Private Limited. Please read this policy carefully before making any purchases.
                </p>
                <div className="bg-orange-50 border-l-4 border-orange-400 p-4 rounded-r-lg mt-4">
                  <p className="text-orange-800 font-medium">
                    <AlertCircle className="h-5 w-5 inline mr-2" />
                    Important: Domain registrations are generally non-refundable due to their nature. Yearly hosting services come with a 30-day money-back guarantee.
                  </p>
                </div>
              </section>

              {/* Domain Registration Policy */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">2. Domain Registration Policy</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  Domain registrations are processed immediately upon payment and become active in the global domain system. Due to this immediate activation:
                </p>
                <div className="bg-red-50 border-l-4 border-red-400 p-4 rounded-r-lg mb-4">
                  <h3 className="text-lg font-semibold text-red-800 mb-2">Non-Refundable Services</h3>
                  <ul className="list-disc list-inside text-red-700 space-y-1">
                    <li>Domain name registrations</li>
                    <li>Domain renewals</li>
                    <li>Premium domain purchases</li>
                  </ul>
                </div>
                <div className="bg-green-50 border-l-4 border-green-400 p-4 rounded-r-lg">
                  <h3 className="text-lg font-semibold text-green-800 mb-2">Exceptions</h3>
                  <ul className="list-disc list-inside text-green-700 space-y-1">
                    <li>Technical errors on our part</li>
                    <li>Duplicate registrations due to system issues</li>
                    <li>Registrations that fail to activate within 24 hours</li>
                  </ul>
                </div>
              </section>

              {/* Hosting Refund Policy */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <CheckCircle className="h-6 w-6 text-green-600 mr-3" />
                  3. Hosting Refund Policy
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  We offer a <strong>30-Day Money-Back Guarantee</strong> on all our yearly shared and cloud hosting plans. Monthly hosting plans are not eligible for refunds.
                </p>
                <div className="bg-green-50 border-l-4 border-green-400 p-4 rounded-r-lg mb-4">
                  <h3 className="text-lg font-semibold text-green-800 mb-2">Terms:</h3>
                  <ul className="list-disc list-inside text-green-700 space-y-1">
                    <li>Full refund if cancelled within 30 days of initial purchase</li>
                    <li>Applicable to annual (yearly) and multi-year plans only</li>
                    <li>Monthly plans are non-refundable</li>
                    <li>Refunds do not include domain registration fees (if bundled)</li>
                  </ul>
                </div>
              </section>

              {/* Cancellation Policy */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <Clock className="h-6 w-6 text-orange-600 mr-3" />
                  4. Cancellation Policy
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  You may cancel certain services under specific conditions:
                </p>
                <div className="space-y-4">
                  <div className="bg-blue-50 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-blue-800 mb-3">Before Payment Processing</h3>
                    <p className="text-blue-700">
                      You may cancel your domain order at any time before payment is processed. No charges will be applied to your account.
                    </p>
                  </div>
                  <div className="bg-green-50 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-green-800 mb-3">Hosting Cancellation</h3>
                    <p className="text-green-700">
                      Hosting services can be cancelled at any time from your dashboard. For yearly plans, if cancelled within 30 days, you are eligible for a full refund. Monthly plans are non-refundable upon activation. After the initial period, cancellation will prevent future renewals.
                    </p>
                  </div>
                  <div className="bg-yellow-50 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-yellow-800 mb-3">Within 24 Hours of Registration</h3>
                    <p className="text-yellow-700">
                      If you contact us within 24 hours of domain registration and the domain has not been used, we may consider a refund on a case-by-case basis.
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-gray-800 mb-3">After 24 Hours</h3>
                    <p className="text-gray-700">
                      Domain registrations cannot be cancelled or refunded after 24 hours due to immediate activation in the global domain system.
                    </p>
                  </div>
                </div>
              </section>

              {/* Refund Process */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4 flex items-center">
                  <DollarSign className="h-6 w-6 text-orange-600 mr-3" />
                  5. Refund Process
                </h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  If you are eligible for a refund, follow these steps:
                </p>
                <div className="bg-gray-50 rounded-lg p-6">
                  <ol className="list-decimal list-inside text-gray-700 space-y-3">
                    <li><strong>Contact Support:</strong> Email us at support@anutech.in with your order details</li>
                    <li><strong>Provide Information:</strong> Include your order number, domain name, and reason for refund request</li>
                    <li><strong>Review Process:</strong> We will review your request within 2-3 business days</li>
                    <li><strong>Approval:</strong> If approved, refunds will be processed within 5-10 business days</li>
                    <li><strong>Payment Method:</strong> Refunds will be issued to the original payment method</li>
                  </ol>
                </div>
              </section>

              {/* Processing Times */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">6. Processing Times</h2>
                <div className="grid md:grid-cols-2 gap-6">
                  <div className="bg-green-50 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-green-800 mb-3 flex items-center">
                      <CheckCircle className="h-5 w-5 mr-2" />
                      Refund Processing
                    </h3>
                    <ul className="text-green-700 space-y-2">
                      <li>Credit Card: 5-10 business days</li>
                      <li>PayPal: 3-5 business days</li>
                      <li>Bank Transfer: 7-14 business days</li>
                    </ul>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-blue-800 mb-3 flex items-center">
                      <Clock className="h-5 w-5 mr-2" />
                      Request Review
                    </h3>
                    <ul className="text-blue-700 space-y-2">
                      <li>Initial Review: 2-3 business days</li>
                      <li>Complex Cases: 5-7 business days</li>
                      <li>Peak Periods: May take longer</li>
                    </ul>
                  </div>
                </div>
              </section>

              {/* Non-Refundable Items */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">7. Non-Refundable Items</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  The following items are generally non-refundable:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li>Domain registrations and renewals</li>
                  <li>Premium domain purchases</li>
                  <li>SSL certificates</li>
                  <li>Monthly hosting plans</li>
                  <li>Yearly hosting services (after 30 days)</li>
                  <li>Custom development services</li>
                  <li>Third-party services and add-ons</li>
                </ul>
              </section>

              {/* Chargeback Policy */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">8. Chargeback Policy</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  If you initiate a chargeback or dispute with your payment provider without first contacting our support team:
                </p>
                <div className="bg-red-50 border-l-4 border-red-400 p-4 rounded-r-lg">
                  <ul className="list-disc list-inside text-red-700 space-y-2">
                    <li>Your account may be suspended or terminated</li>
                    <li>We may not be able to provide future services</li>
                    <li>Domain names may be transferred back to us</li>
                    <li>Additional fees may apply for account reinstatement</li>
                  </ul>
                </div>
                <p className="text-gray-700 mt-4">
                  <strong>Important:</strong> Always contact our support team first before initiating any payment disputes.
                </p>
              </section>

              {/* Contact Information */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">9. Contact Information</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  For refund requests, cancellations, or questions about this policy, please contact us:
                </p>
                <div className="bg-gray-50 rounded-lg p-6">
                  <p className="text-gray-700">
                    <strong>Anutech Digital Private Limited Support</strong><br />
                    Email: support@anutech.in<br />
                    Phone: +91-777-888-9674<br />
                    Hours: Monday - Friday, 9:00 AM - 6:00 PM IST<br />
                    Address: B9-54, Rohini, Sector-5, Delhi, India
                  </p>
                </div>
              </section>

              {/* Policy Updates */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">10. Policy Updates</h2>
                <p className="text-gray-700 leading-relaxed">
                  We reserve the right to update this Cancellation & Refund Policy at any time. Changes will be posted on this page with an updated "Last modified" date. Continued use of our services after changes constitutes acceptance of the updated policy.
                </p>
              </section>

            </div>
          </div>
        </div>
      </motion.div>

      <Footer />
    </div>
  );
}
