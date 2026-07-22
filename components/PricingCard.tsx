'use client';

import { Check, Info } from 'lucide-react';
import Link from 'next/link';

interface PricingFeature {
  text: string;
  tooltip?: string;
  included: boolean;
  highlight?: boolean;
}

interface PricingCardProps {
  title: string;
  subtitle: string;
  price: string;
  originalPrice?: string;
  currency?: string;
  period?: string;
  renewalPrice?: string;
  discountBadge?: string;
  isPopular?: boolean;
  buttonText?: string;
  buttonLink?: string;
  features: PricingFeature[];
  highlightColor?: string;
  onButtonClick?: () => void;
}

export default function PricingCard({
  title,
  subtitle,
  price,
  originalPrice,
  currency = '₹',
  period = '/mo',
  renewalPrice,
  discountBadge,
  isPopular = false,
  buttonText = 'Choose plan',
  buttonLink = '#',
  features,
  highlightColor = 'blue', // 'purple' | 'blue'
  onButtonClick,
}: PricingCardProps) {

  const isPurple = highlightColor === 'purple';
  const popularBorderCls = isPurple
    ? 'border-2 border-[#7C3AED] shadow-[0_0_25px_-5px_rgba(124,58,237,0.25)] md:scale-105 z-10'
    : 'border-2 border-primary-600 shadow-[0_0_25px_-5px_rgba(1,119,225,0.25)] md:scale-105 z-10';
  const ribbonCls = isPurple ? 'bg-[#7C3AED]' : 'bg-primary-600';
  const buttonPopularCls = isPurple
    ? 'bg-[#7C3AED] text-white hover:bg-[#6D28D9] shadow-md hover:shadow-lg'
    : 'bg-primary-600 text-white hover:bg-primary-800 shadow-md hover:shadow-lg';
  const buttonPlainCls = isPurple
    ? 'bg-white text-[#7C3AED] border-2 border-[#7C3AED] hover:bg-[#7C3AED]/5'
    : 'bg-white text-primary-600 border-2 border-primary-600 hover:bg-primary-500/5';

  return (
    <div className={`relative flex flex-col h-full bg-white rounded-2xl transition-all duration-500 ${isPopular
      ? popularBorderCls
      : 'border border-gray-200 shadow-sm hover:shadow-xl hover:-translate-y-1'
      }`}>
      {isPopular && (
        <div className={`absolute top-0 left-0 right-0 py-1.5 ${ribbonCls} text-white text-center text-xs font-bold uppercase tracking-wider rounded-t-xl z-20`}>
          Most Popular
        </div>
      )}

      <div className={`p-6 ${isPopular ? 'pt-10' : ''} text-center sm:text-left`}>
        {discountBadge && (
          <div className="flex justify-center sm:justify-end mb-2">
            <span className="bg-red-50 text-red-600 text-xs font-bold px-2 py-1 rounded-full">{discountBadge} OFF</span>
          </div>
        )}

        <h3 className="text-xl font-bold text-gray-900 mb-2">{title}</h3>
        <p className="text-gray-500 text-sm mb-6 h-10">{subtitle}</p>

        <div className="mb-6">
          {originalPrice && (
            <div className="text-gray-400 text-sm line-through mb-1">{currency}{originalPrice}</div>
          )}
          <div className="flex items-baseline justify-center sm:justify-start">
            <span className="text-4xl font-bold text-gray-900">{currency}{price}</span>
            <span className="text-gray-500 ml-1">{period}</span>
          </div>
          {renewalPrice && (
            <p className="text-gray-500 text-xs mt-2">{renewalPrice}</p>
          )}
        </div>


        {onButtonClick ? (
          <button
            onClick={onButtonClick}
            className={`block w-full py-3 px-4 rounded-lg text-center font-semibold transition-all duration-200 ${isPopular ? buttonPopularCls : buttonPlainCls}`}
          >
            {buttonText}
          </button>
        ) : (
          <Link
            href={buttonLink}
            className={`block w-full py-3 px-4 rounded-lg text-center font-semibold transition-all duration-200 ${isPopular ? buttonPopularCls : buttonPlainCls}`}
          >
            {buttonText}
          </Link>
        )}
      </div>

      <div className="p-6 pt-0 flex-grow">
        <ul className="space-y-4">
          {features.map((feature, index) => (
            <li key={index} className="flex items-center justify-center sm:justify-start text-sm">
              <Check className={`h-5 w-5 mr-2 sm:mr-3 flex-shrink-0 ${feature.included ? 'text-green-500' : 'text-gray-300'}`} />
              <div className="flex-initial sm:flex-1 text-center sm:text-left">
                <span className={`${feature.highlight ? 'font-semibold text-gray-900' : 'text-gray-600'} ${!feature.included && 'text-gray-400'}`}>
                  {feature.text}
                </span>
              </div>
              {feature.tooltip && (
                <div className="group relative ml-2">
                  <Info className="h-4 w-4 text-gray-400 cursor-help" />
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity w-48 text-center pointer-events-none z-50">
                    {feature.tooltip}
                    <div className="absolute top-100 left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
