'use client';

import { Mail, Trash2, Shield, CheckCircle, AlertCircle, Clock, FileText } from 'lucide-react';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { motion } from 'framer-motion';

export default function DataDeletionPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Navigation />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="container mx-auto px-4 py-24 max-w-4xl"
      >
        {/* Header */}
        <div className="text-center mb-12">
          <div className="flex justify-center mb-6">
            <div className="bg-red-100 rounded-full p-4">
              <Trash2 className="h-12 w-12 text-red-600" />
            </div>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Data Deletion Instructions
          </h1>
          <p className="text-xl text-gray-600">
            Your privacy and data rights matter to us
          </p>
        </div>

        {/* Main Content */}
        <div className="bg-white rounded-xl shadow-lg p-8 mb-8">
          <div className="prose max-w-none">
            {/* Introduction */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center">
                <Shield className="h-6 w-6 mr-2 text-primary-600" />
                Your Data Rights
              </h2>
              <p className="text-gray-700 leading-relaxed">
                At Anutech Digital Private Limited, we respect your right to privacy and control over your personal data.
                If you've used our domain management services through Facebook Login, you can request the
                deletion of all your personal data from our systems at any time.
              </p>
            </div>

            {/* What Data We Collect */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center">
                <FileText className="h-6 w-6 mr-2 text-primary-600" />
                What Data We Collect (via Facebook Login)
              </h2>
              <div className="bg-blue-50 border-l-4 border-blue-600 p-4 mb-4">
                <ul className="space-y-2 text-gray-700">
                  <li className="flex items-start">
                    <CheckCircle className="h-5 w-5 mr-2 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Basic Profile:</strong> Name, email address, profile picture</span>
                  </li>
                  <li className="flex items-start">
                    <CheckCircle className="h-5 w-5 mr-2 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Contact Information:</strong> Phone number (if provided via Facebook)</span>
                  </li>
                  <li className="flex items-start">
                    <CheckCircle className="h-5 w-5 mr-2 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Address:</strong> Location information (if provided via Facebook)</span>
                  </li>
                  <li className="flex items-start">
                    <CheckCircle className="h-5 w-5 mr-2 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Account Data:</strong> Login history, preferences, and settings</span>
                  </li>
                  <li className="flex items-start">
                    <CheckCircle className="h-5 w-5 mr-2 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Transaction History:</strong> Domain purchases, orders, and invoices</span>
                  </li>
                  <li className="flex items-start">
                    <CheckCircle className="h-5 w-5 mr-2 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Hosting Data:</strong> Website files, databases, and emails stored on servers</span>
                  </li>
                </ul>
              </div>
            </div>

            {/* How to Request Deletion */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center">
                <Trash2 className="h-6 w-6 mr-2 text-red-600" />
                How to Request Data Deletion
              </h2>
              <p className="text-gray-700 mb-4">
                To request deletion of your data, please contact our support team:
              </p>

              {/* Primary Contact Method */}
              <div className="bg-gradient-to-r from-primary-50 to-primary-100 rounded-lg p-6 mb-4 border-2 border-primary-300">
                <h3 className="text-xl font-semibold text-gray-900 mb-3 flex items-center">
                  <Mail className="h-6 w-6 mr-2 text-primary-600" />
                  Email Data Deletion Request
                </h3>
                <p className="text-gray-700 mb-4">
                  Send your data deletion request to our support team:
                </p>
                <div className="flex items-center space-x-3 bg-white p-4 rounded-lg border border-primary-200 shadow-sm mb-4">
                  <Mail className="h-6 w-6 text-primary-600 flex-shrink-0" />
                  <a
                    href="mailto:support@anutech.in?subject=Data Deletion Request&body=Please delete all my personal data associated with my account.%0D%0A%0D%0AEmail: [Your Email]%0D%0AFacebook/Google Account: [Your Social Login Email]%0D%0A%0D%0AThank you."
                    className="text-primary-600 hover:underline font-semibold text-lg"
                  >
                    support@anutech.in
                  </a>
                </div>
                <div className="bg-white rounded-lg p-4 border border-primary-200">
                  <p className="text-gray-700 font-medium mb-2">📧 Email Template:</p>
                  <div className="bg-gray-50 p-3 rounded text-sm text-gray-700 font-mono">
                    <p><strong>To:</strong> support@anutech.in</p>
                    <p><strong>Subject:</strong> Data Deletion Request</p>
                    <p className="mt-2"><strong>Body:</strong></p>
                    <p className="mt-1">Please delete all my personal data associated with my account.</p>
                    <p className="mt-2">Email: [Your Email Address]</p>
                    <p>Facebook/Google Account: [Your Social Login Email]</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center">
                <Clock className="h-6 w-6 mr-2 text-green-600" />
                Deletion Timeline
              </h2>
              <div className="space-y-4">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary-100 text-primary-600 font-bold">
                      1
                    </div>
                  </div>
                  <div className="ml-4">
                    <h4 className="font-semibold text-gray-900">Request Received</h4>
                    <p className="text-gray-600">
                      We acknowledge your data deletion request via email within 24 hours.
                    </p>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <div className="flex items-center justify-center h-8 w-8 rounded-full bg-green-100 text-green-600 font-bold">
                      2
                    </div>
                  </div>
                  <div className="ml-4">
                    <h4 className="font-semibold text-gray-900">Within 48 Hours (Active Systems)</h4>
                    <p className="text-gray-600">
                      Your data is removed from our active systems within 48 hours of receipt during business days (Monday-Friday).
                    </p>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <div className="flex items-center justify-center h-8 w-8 rounded-full bg-purple-100 text-purple-600 font-bold">
                      3
                    </div>
                  </div>
                  <div className="ml-4">
                    <h4 className="font-semibold text-gray-900">Within 30 Days (Complete Removal)</h4>
                    <p className="text-gray-600">
                      Data in backup and archive systems is permanently removed within 30 days following your deletion request.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* What Gets Deleted */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center">
                <AlertCircle className="h-6 w-6 mr-2 text-orange-600" />
                What Gets Deleted
              </h2>
              <div className="bg-orange-50 border-l-4 border-orange-600 p-4">
                <p className="text-gray-700 mb-3">
                  When you request data deletion, the following information will be permanently removed:
                </p>
                <ul className="space-y-2 text-gray-700">
                  <li className="flex items-start">
                    <Trash2 className="h-5 w-5 mr-2 text-orange-600 flex-shrink-0 mt-0.5" />
                    <span>Your account credentials and login information</span>
                  </li>
                  <li className="flex items-start">
                    <Trash2 className="h-5 w-5 mr-2 text-orange-600 flex-shrink-0 mt-0.5" />
                    <span>Personal profile information (name, email, phone, address)</span>
                  </li>
                  <li className="flex items-start">
                    <Trash2 className="h-5 w-5 mr-2 text-orange-600 flex-shrink-0 mt-0.5" />
                    <span>Order and transaction history</span>
                  </li>
                  <li className="flex items-start">
                    <Trash2 className="h-5 w-5 mr-2 text-orange-600 flex-shrink-0 mt-0.5" />
                    <span>Communication preferences and settings</span>
                  </li>
                  <li className="flex items-start">
                    <Trash2 className="h-5 w-5 mr-2 text-orange-600 flex-shrink-0 mt-0.5" />
                    <span>All website files, databases, and emails stored on our hosting servers</span>
                  </li>
                  <li className="flex items-start">
                    <Trash2 className="h-5 w-5 mr-2 text-orange-600 flex-shrink-0 mt-0.5" />
                    <span>All data obtained from Facebook (if applicable)</span>
                  </li>
                </ul>
              </div>
            </div>

            {/* Important Notes */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Important Notes</h2>
              <div className="space-y-4">
                <div className="bg-yellow-50 border-l-4 border-yellow-600 p-4">
                  <h4 className="font-semibold text-gray-900 mb-2">⚠️ Active Domain Registrations</h4>
                  <p className="text-gray-700">
                    If you have active domain registrations through our service, we recommend transferring
                    them to another registrar before requesting account deletion. Domain registration data
                    may be retained as required by ICANN regulations.
                  </p>
                </div>

                <div className="bg-purple-50 border-l-4 border-purple-600 p-4">
                  <h4 className="font-semibold text-gray-900 mb-2">💾 Hosting Backups</h4>
                  <p className="text-gray-700">
                    Please download all your website files and databases before requesting deletion.
                    While active data is removed within 48 hours, some data may remain in our
                    encrypted backup systems for up to 30 days before being automatically overwritten.
                  </p>
                </div>

                <div className="bg-blue-50 border-l-4 border-blue-600 p-4">
                  <h4 className="font-semibold text-gray-900 mb-2">📋 Legal Compliance</h4>
                  <p className="text-gray-700">
                    Some data may be retained for legal, tax, or regulatory compliance purposes as required
                    by Indian law (up to 7 years for financial records). This includes transaction records
                    and invoices.
                  </p>
                </div>

                <div className="bg-green-50 border-l-4 border-green-600 p-4">
                  <h4 className="font-semibold text-gray-900 mb-2">✅ Confirmation</h4>
                  <p className="text-gray-700">
                    You will receive a confirmation email once your data deletion request has been processed
                    successfully. If you don't receive confirmation within the specified timeline, please
                    contact our support team.
                  </p>
                </div>
              </div>
            </div>

            {/* Contact Information */}
            <div className="bg-gradient-to-r from-primary-50 to-purple-50 rounded-lg p-6 border border-primary-200">
              <h3 className="text-xl font-bold text-gray-900 mb-4">Need Help?</h3>
              <p className="text-gray-700 mb-4">
                If you have any questions about data deletion or need assistance with the process,
                our support team is here to help.
              </p>
              <div className="flex items-center bg-white p-4 rounded-lg border border-primary-200">
                <Mail className="h-6 w-6 text-primary-600 mr-3 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-gray-900 mb-1">Email Support</p>
                  <a
                    href="mailto:support@anutech.in?subject=Data Deletion Request"
                    className="text-primary-600 hover:underline font-semibold text-lg"
                  >
                    support@anutech.in
                  </a>
                  <p className="text-xs text-gray-500 mt-1">We respond within 24 hours</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Action Button */}
        <div className="max-w-xl mx-auto mb-8">
          <a
            href="mailto:support@anutech.in?subject=Data Deletion Request&body=Please delete all my personal data associated with my account.%0D%0A%0D%0AEmail: [Your Email]%0D%0AFacebook/Google Account: [Your Social Login Email]%0D%0A%0D%0AThank you."
            className="block bg-gradient-to-r from-primary-600 to-primary-700 text-white px-8 py-5 rounded-lg hover:from-primary-700 hover:to-primary-800 transition-all flex items-center justify-center font-semibold shadow-xl text-lg"
          >
            <Mail className="h-6 w-6 mr-3" />
            Send Data Deletion Request
          </a>
          <p className="text-center text-gray-600 text-sm mt-3">
            We'll respond within 24 hours and process your request within 48 hours
          </p>
        </div>

        {/* Related Links */}
        <div className="text-center text-gray-600">
          <p className="mb-2">Related Documents:</p>
          <div className="space-x-4">
            <a href="/privacy" className="text-primary-600 hover:underline">
              Privacy Policy
            </a>
            <span>•</span>
            <a href="/terms-and-conditions" className="text-primary-600 hover:underline">
              Terms & Conditions
            </a>
            <span>•</span>
            <a href="/contact" className="text-primary-600 hover:underline">
              Contact Us
            </a>
          </div>
        </div>
      </motion.div >

      <Footer />
    </div >
  );
}
