import { ShoppingCart, Globe, Server, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { buyHref } from '@/lib/purchase/buy-dialog';

export default function EmptyCart() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 sm:py-20 lg:py-24 animate-fade-in">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary-500/20 blur-3xl rounded-full scale-150" />
        <div className="relative bg-gradient-to-br from-primary-50 to-indigo-soft rounded-3xl p-8 shadow-inner border border-paper">
          <ShoppingCart className="h-12 w-12 sm:h-16 sm:w-16 text-primary-600 drop-shadow-sm" />
        </div>
      </div>

      <h1 className="text-2xl sm:text-3xl font-bold text-ink mb-4 text-center">
        Your cart is empty
      </h1>
      <p className="text-ink-2 text-base sm:text-lg mb-10 max-w-md text-center px-4 leading-relaxed">
        Find a domain or pick a hosting plan. You&apos;ll see each price, GST included, before you pay.
      </p>

      <div className="flex flex-col sm:flex-row items-center space-y-4 sm:space-y-0 sm:space-x-4">
        <Link
          href={buyHref('domain')}
          className="group inline-flex items-center px-8 py-4 bg-gradient-to-r from-primary-600 to-indigo-600 hover:from-primary-700 hover:to-indigo-700 text-paper font-bold rounded-xl transition-all duration-300 shadow-xl hover:shadow-2xl transform hover:-translate-y-1"
        >
          <Globe className="h-5 w-5 mr-3 group-hover:rotate-12 transition-transform duration-300" />
          Find a domain
          <ArrowRight className="ml-2 h-5 w-5 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
        </Link>
        <Link
          href={buyHref('hosting')}
          className="inline-flex items-center px-8 py-4 bg-paper border-2 border-hairline text-ink-2 font-semibold rounded-xl hover:bg-paper-2 hover:border-hairline transition-all duration-200"
        >
          <Server className="h-5 w-5 mr-3" aria-hidden />
          See hosting plans
        </Link>
      </div>

      {/* Three unlabelled grey icons used to sit here; they said nothing (9 Oct 2026). */}
      <p className="mt-10 text-sm text-ink-3 text-center px-4">
        The first year of a domain is free with yearly hosting.
      </p>
    </div>
  );
}
