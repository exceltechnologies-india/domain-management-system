'use client';

import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import ClientOnly from '@/components/ClientOnly';
import { COMPANY_PHONE_DISPLAY } from '@/config/company';
import { motion } from 'framer-motion';
import { FileText, Calendar, Shield, AlertTriangle } from 'lucide-react';
import { formatIndianDate } from '@/lib/dateUtils';

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Navigation />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="pt-20 pb-16"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="text-center mb-12 flex flex-col items-center">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-primary-100 rounded-full mb-6">
              <FileText className="h-8 w-8 text-primary-600" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4 px-4">Terms and Conditions</h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Please read these terms and conditions carefully before using our services.
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
                  <Shield className="h-6 w-6 text-primary-600 mr-3" />
                  1. Introduction
                </h2>
                <p className="text-gray-700 leading-relaxed">
                  Welcome to Anutech Digital Private Limited. These Terms and Conditions ("Terms") govern your use of our domain management services, website, and related services (collectively, the "Service") operated by Anutech Digital Private Limited ("us", "we", or "our").
                </p>
              </section>

              {/* Acceptance of Terms */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">2. Acceptance of Terms</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  By accessing or using our Service, you agree to be bound by these Terms. If you disagree with any part of these terms, then you may not access the Service.
                </p>
                <div className="bg-blue-50 border-l-4 border-blue-400 p-4 rounded-r-lg">
                  <p className="text-blue-800 font-medium">
                    <AlertTriangle className="h-5 w-5 inline mr-2" />
                    Important: By using our services, you confirm that you have read, understood, and agree to be bound by these terms.
                  </p>
                </div>
              </section>

              {/* Service Description */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">3. Service Description</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  Anutech Digital Private Limited provides domain registration, web hosting, management, and related services through our platform. Our services include but are not limited to:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li>Domain name registration and renewal</li>
                  <li>Web hosting services (Shared, Premium, Business, Cloud)</li>
                  <li>SSL Certificates and security services</li>
                  <li>Domain management and DNS configuration</li>
                  <li>Customer support and technical assistance</li>
                  <li>Payment processing for domain services</li>
                </ul>
              </section>

              {/* User Responsibilities */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">4. User Responsibilities</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  As a user of our Service, you agree to:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li>Provide accurate and complete information when registering domains</li>
                  <li>Maintain the security of your account credentials</li>
                  <li>Use the Service in compliance with all applicable laws and regulations</li>
                  <li>Not use the Service for illegal, harmful, or unauthorized purposes</li>
                  <li>Respect intellectual property rights of others</li>
                  <li>Notify us immediately of any unauthorized use of your account</li>
                </ul>
              </section>

              {/* Hosting Specific Terms */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">5. Web Hosting Usage Policy</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  For our web hosting services, you agree to the following usage policies:
                </p>
                <div className="space-y-4">
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-2">5.1 Acceptable Use</h3>
                    <p className="text-gray-700">
                      You may not use our hosting services to store, distribute, or transmit any material that is unlawful, harmful, threatening, defamatory, obscene, or infringing. This includes but is not limited to malware, phishing sites, and copyrighted material without permission.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-2">5.2 Resource Usage</h3>
                    <p className="text-gray-700">
                      Users may not excessively consume server resources (CPU, RAM, Disk I/O) in a way that negatively impacts other users. We reserve the right to suspend accounts causing performance issues.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-2">5.3 Backups</h3>
                    <p className="text-gray-700">
                      While we provide automated backups for certain plans (Weekly for Single/Premium, Daily for Business/Cloud), you are solely responsible for maintaining your own off-site backups. We do not guarantee the completeness or integrity of our backups.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-2">5.4 Uptime Guarantee</h3>
                    <p className="text-gray-700">
                      We strive for a 99.9% network uptime. This guarantee excludes scheduled maintenance, force majeure events, and outages caused by user activity or third-party services.
                    </p>
                  </div>
                </div>
              </section>

              {/* Payment Terms */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">6. Payment Terms</h2>
                <p className="text-gray-700 leading-relaxed mb-4">
                  All payments for our services are processed through secure payment gateways. By making a payment, you agree to:
                </p>
                <ul className="list-disc list-inside text-gray-700 space-y-2 ml-4">
                  <li>Pay all applicable fees and charges as displayed at the time of purchase</li>
                  <li>Provide accurate billing information</li>
                  <li>Authorize us to charge your payment method for the services</li>
                  <li>Understand that all sales are final unless otherwise specified</li>
                </ul>
              </section>

              {/* Limitation of Liability */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">7. Limitation of Liability</h2>
                <p className="text-gray-700 leading-relaxed">
                  To the maximum extent permitted by law, Anutech Digital Private Limited shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your use of the Service.
                </p>
              </section>

              {/* Termination */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">8. Termination</h2>
                <p className="text-gray-700 leading-relaxed">
                  We may terminate or suspend your account and bar access to the Service immediately, without prior notice or liability, under our sole discretion, for any reason whatsoever and without limitation, including but not limited to a breach of the Terms.
                </p>
              </section>

              {/* Changes to Terms */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">9. Changes to Terms</h2>
                <p className="text-gray-700 leading-relaxed">
                  We reserve the right, at our sole discretion, to modify or replace these Terms at any time. If a revision is material, we will provide at least 30 days notice prior to any new terms taking effect.
                </p>
              </section>

              {/* Communications & Notifications */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">10. Communications &amp; Notifications</h2>
                <p className="text-gray-700 leading-relaxed">
                  By using the Service you agree to receive communications from us relating to your account. <strong>Certain emails are compulsory for security reasons and to maintain your services</strong> and cannot be opted out of while you hold an account with us; <strong>only marketing and other non-essential emails can be opted out</strong>. We divide these into two categories:
                </p>
                <ul className="list-disc list-inside text-gray-700 leading-relaxed mt-3 space-y-2">
                  <li>
                    <strong>Essential communications</strong> — account activation, password and security alerts, invoices and payment receipts, order and provisioning status, service-suspension notices, and other transactional or legally required messages. These are necessary to operate your account securely and <strong>cannot be turned off</strong> for as long as you hold an account with us.
                  </li>
                  <li>
                    <strong>Marketing &amp; non-essential notifications</strong> — product news, offers, and service reminders. You may unsubscribe from these at any time via the &quot;Receive marketing &amp; notification emails&quot; setting in your dashboard (<strong>Settings → Profile</strong>), the one-click unsubscribe link in any such email, or the WhatsApp opt-out. Unsubscribing from these does <strong>not</strong> stop essential communications above.
                  </li>
                </ul>
              </section>

              {/* Contact Information */}
              <section className="mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-4">11. Contact Information</h2>
                <p className="text-gray-700 leading-relaxed">
                  If you have any questions about these Terms and Conditions, please contact us at:
                </p>
                <div className="bg-gray-50 rounded-lg p-6 mt-4">
                  <p className="text-gray-700">
                    <strong>Anutech Digital Private Limited</strong><br />
                    Email: support@anutech.in<br />
                    Phone: {COMPANY_PHONE_DISPLAY}<br />
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
