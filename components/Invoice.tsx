'use client';

import { useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { formatIndianDate } from '@/lib/dateUtils';

interface InvoiceProps {
  order: {
    _id: string;
    orderId: string;
    invoiceNumber?: string;
    amount: number;
    currency: string;
    status: string;
    domains: Array<{
      domainName: string;
      price: number;
      currency: string;
      registrationPeriod: number;
      status: string;
      error?: string;
    }>;
    successfulDomains: string[];
    createdAt: string;
    updatedAt: string;
    userId?: {
      firstName: string;
      lastName: string;
      email: string;
    };
  };
  isOpen: boolean;
  onClose: () => void;
}

export default function Invoice({ order, isOpen, onClose }: InvoiceProps) {
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);

  if (!isOpen) return null;

  // Use stored values from order if available, otherwise calculate
  const total = order.amount || order.domains
    .filter(d => d.status === 'registered')
    .reduce((total, domain) => total + (domain.price * domain.registrationPeriod), 0);

  const handleDownloadPDF = async () => {
    setIsGeneratingPDF(true);
    try {
      const invoiceElement = document.getElementById('invoice-content');
      if (!invoiceElement) return;

      const canvas = await html2canvas(invoiceElement, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');

      const imgWidth = 210;
      const pageHeight = 295;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;

      let position = 0;

      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft >= 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      const fileName = `Invoice-${order.invoiceNumber || order.orderId}.pdf`;
      pdf.save(fileName);
    } catch (error) {
      // Error generating PDF
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <FileText className="h-6 w-6 text-blue-600" />
            <h2 className="text-xl font-bold text-gray-900">
              Invoice {order.invoiceNumber || order.orderId}
            </h2>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={handleDownloadPDF}
              disabled={isGeneratingPDF}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg transition-colors duration-200"
            >
              <Download className="h-4 w-4" />
              <span>{isGeneratingPDF ? 'Generating...' : 'Download PDF'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 transition-colors duration-200"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>

        {/* Invoice Content */}
        <div className="p-6">
          <div id="invoice-content" className="bg-white">
            {/* Invoice Header */}
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-gray-900 mb-2">Anutech Digital Private Limited</h1>
              <p className="text-gray-600">Domain Management System</p>
              <p className="text-gray-600">Invoice #{order.invoiceNumber || order.orderId}</p>
            </div>

            {/* Invoice Details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-3">Bill To:</h3>
                <div className="text-gray-700">
                  {order.userId ? (
                    <>
                      <p className="font-medium">{order.userId.firstName} {order.userId.lastName}</p>
                      <p>{order.userId.email}</p>
                    </>
                  ) : (
                    <p className="text-gray-500 italic">Customer information not available</p>
                  )}
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-3">Invoice Details:</h3>
                <div className="text-gray-700 space-y-1">
                  <p><span className="font-medium">Order ID:</span> {order.orderId}</p>
                  <p><span className="font-medium">Invoice Date:</span> {formatIndianDate(order.createdAt)}</p>
                  <p><span className="font-medium">Status:</span>
                    <span className={`ml-2 px-2 py-1 rounded-full text-xs font-medium ${order.status === 'completed'
                      ? 'bg-green-100 text-green-800'
                      : order.status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                      }`}>
                      {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Domain Details Table */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Domain Details</h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse border border-gray-300">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="border border-gray-300 px-4 py-3 text-left font-semibold text-gray-900">Domain Name</th>
                      <th className="border border-gray-300 px-4 py-3 text-center font-semibold text-gray-900">Period</th>
                      <th className="border border-gray-300 px-4 py-3 text-center font-semibold text-gray-900">Qty</th>
                      <th className="border border-gray-300 px-4 py-3 text-right font-semibold text-gray-900">Unit Price</th>
                      <th className="border border-gray-300 px-4 py-3 text-right font-semibold text-gray-900">Total</th>
                      <th className="border border-gray-300 px-4 py-3 text-center font-semibold text-gray-900">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.domains.map((domain, index) => (
                      <tr key={index}>
                        <td className="border border-gray-300 px-4 py-3 font-mono text-gray-900">{domain.domainName}</td>
                        <td className="border border-gray-300 px-4 py-3 text-center text-gray-700">
                          {domain.registrationPeriod} year{domain.registrationPeriod !== 1 ? 's' : ''}
                        </td>
                        <td className="border border-gray-300 px-4 py-3 text-center text-gray-700">1</td>
                        <td className="border border-gray-300 px-4 py-3 text-right text-gray-700">₹{domain.price.toFixed(2)}</td>
                        <td className="border border-gray-300 px-4 py-3 text-right font-medium text-gray-900">
                          ₹{(domain.price * domain.registrationPeriod).toFixed(2)}
                        </td>
                        <td className="border border-gray-300 px-4 py-3 text-center">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${domain.status === 'registered'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                            }`}>
                            {domain.status === 'registered' ? 'Success' : 'Failed'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Summary with GST Breakdown */}
            <div className="flex justify-end mb-8">
              <div className="w-80">
                <div className="bg-gray-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Order Summary</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between text-gray-700">
                      <span>Subtotal:</span>
                      <span>₹{(total / 1.18).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-gray-700">
                      <span>GST (18%):</span>
                      <span>₹{(total - (total / 1.18)).toFixed(2)}</span>
                    </div>
                    <div className="border-t border-gray-300 pt-2">
                      <div className="flex justify-between text-lg font-semibold text-gray-900">
                        <span>Total (incl. GST):</span>
                        <span className="text-blue-600">₹{total.toFixed(2)} {order.currency}</span>
                      </div>
                      <p className="text-xs text-gray-500 text-right mt-1">*GST (18%) is included in the total amount</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Status Messages */}
            {order.successfulDomains.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                <p className="text-green-800 font-medium">
                  ✅ {order.successfulDomains.length} domain(s) registered successfully
                </p>
              </div>
            )}


            {/* Footer */}
            <div className="border-t border-gray-300 pt-6 mt-8">
              <div className="text-center text-gray-600">
                <p className="font-medium">Thank you for choosing Anutech Digital Private Limited!</p>
                <p className="text-sm mt-2">
                  For support, contact us at{' '}
                  <a href={`mailto:${process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in'}`} className="text-blue-600 hover:text-blue-700">
                    {process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in'}
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
