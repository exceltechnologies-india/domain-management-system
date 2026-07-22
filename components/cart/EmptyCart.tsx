import { ShoppingCart, Globe, Shield, CreditCard, Clock, CheckCircle, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function EmptyCart() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 sm:py-20 lg:py-24 animate-fade-in">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary-500/20 blur-3xl rounded-full scale-150" />
        <div className="relative bg-gradient-to-br from-primary-50 to-indigo-100 rounded-3xl p-8 shadow-inner border border-white">
          <ShoppingCart className="h-12 w-12 sm:h-16 sm:w-16 text-primary-600 drop-shadow-sm" />
        </div>
        <div className="absolute -bottom-2 -right-2 bg-white rounded-full p-2 shadow-md">
          <CheckCircle className="h-5 w-5 text-green-500" />
        </div>
      </div>

      <h3 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-4 text-center">
        Your cart is empty
      </h3>
      <p className="text-gray-600 text-base sm:text-lg mb-10 max-w-md text-center px-4 leading-relaxed">
        No domains or hosting plans in your cart yet. Ready to start your online journey?
      </p>

      <div className="flex flex-col sm:flex-row items-center space-y-4 sm:space-y-0 sm:space-x-4">
        <Link
          href="/domains/search"
          className="group inline-flex items-center px-8 py-4 bg-gradient-to-r from-primary-600 to-indigo-600 hover:from-primary-700 hover:to-indigo-700 text-white font-bold rounded-xl transition-all duration-300 shadow-xl hover:shadow-2xl transform hover:-translate-y-1"
        >
          <Globe className="h-5 w-5 mr-3 group-hover:rotate-12 transition-transform duration-300" />
          Find My Domain
          <ArrowRight className="ml-2 h-5 w-5 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
        </Link>
        <Link
          href="/hosting"
          className="px-8 py-4 bg-white border-2 border-gray-100 text-gray-700 font-semibold rounded-xl hover:bg-gray-50 hover:border-gray-200 transition-all duration-200"
        >
          Browse Hosting
        </Link>
      </div>

      <div className="mt-12 flex items-center space-x-6 grayscale opacity-50">
        <Shield className="h-8 w-8" />
        <CreditCard className="h-8 w-8" />
        <Clock className="h-8 w-8" />
      </div>
    </div>
  );
}
