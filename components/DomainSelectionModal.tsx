'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, X, ArrowRight, CheckCircle, Info, Search, AlertCircle } from 'lucide-react';
import Modal from './Modal';
import { useCartStore } from '@/store/cartStore';
import toast from 'react-hot-toast';

interface DomainSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan: {
    id?: string;
    name: string;
    price: number;
    features: string[];
  } | null;
  existingDomainName?: string;
  onSuccess?: (newDomain: string) => void;
}

export default function DomainSelectionModal({
  isOpen,
  onClose,
  plan,
  existingDomainName,
  onSuccess
}: DomainSelectionModalProps) {
  const [domainName, setDomainName] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState('');
  const { addItem, removeItem, updateItem, items } = useCartStore();

  useEffect(() => {
    if (isOpen) {
      if (existingDomainName && !existingDomainName.startsWith('hosting-')) {
        setDomainName(existingDomainName);
      } else {
        setDomainName(''); // Clear domain name if it's a placeholder or new item
      }
      setError(''); // Clear error on open
    }
  }, [isOpen, existingDomainName]);

  const validateDomain = (domain: string) => {
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
    return domainRegex.test(domain);
  };

  const handleContinue = async () => {
    if (!domainName) {
      setError('Please enter a domain name');
      return;
    }

    if (!validateDomain(domainName)) {
      setError('Please enter a valid domain name (e.g., example.com)');
      return;
    }

    setError('');
    setIsAdding(true);

    try {
      if (!plan) return;

      const newDomain = domainName.toLowerCase();

      if (existingDomainName) {
        // If we're updating an existing placeholder item
        const existingHostingItem = items.find(
          (item) => item.itemType === 'hosting' && item.domainName === existingDomainName
        );

        if (existingHostingItem) {
          // Update the existing item's domain name
          updateItem(existingDomainName, { ...existingHostingItem, domainName: newDomain });
          toast.success(`${plan.name} updated for ${newDomain}!`);
        } else {
          // This case should ideally not happen if existingDomainName is provided
          // but if it does, we'll treat it as adding a new item.
          const hostingItem = {
            domainName: newDomain,
            price: plan.price,
            currency: 'INR',
            registrationPeriod: 12,
            itemType: 'hosting' as const,
            hostingPlan: {
              name: plan.name,
              period: 12,
              features: plan.features,
            },
          };
          addItem(hostingItem);
          toast.success(`${plan.name} for ${newDomain} added to cart!`);
        }
      } else {
        // Adding a fresh item (original behavior)
        const hostingItem = {
          domainName: newDomain,
          price: plan.price,
          currency: 'INR',
          registrationPeriod: 12,
          itemType: 'hosting' as const,
          hostingPlan: {
            name: plan.name,
            period: 12,
            features: plan.features,
          },
        };
        addItem(hostingItem);
        toast.success(`${plan.name} for ${newDomain} added to cart!`);
      }

      if (onSuccess) {
        onSuccess(newDomain);
      }
      onClose();
    } catch (err) {
      toast.error(existingDomainName ? 'Failed to update hosting item' : 'Failed to add hosting to cart');
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Setup Your Hosting"
      size="md"
    >
      <div className="py-2">
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6 flex gap-3">
          <Info className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800">
            <p className="font-semibold mb-1">Domain Name Required</p>
            <p>We require a domain name to set up your hosting service. Enter the domain you want to use with this hosting plan.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="domainName" className="block text-sm font-medium text-gray-700 mb-2">
              Domain Name
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Globe className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                id="domainName"
                className={`block w-full pl-10 pr-3 py-3 border rounded-xl shadow-sm focus:ring-primary-500 focus:border-primary-500 transition-colors sm:text-sm ${error ? 'border-red-300 bg-red-50' : 'border-gray-300'
                  }`}
                placeholder="example.com"
                value={domainName}
                onChange={(e) => {
                  setDomainName(e.target.value);
                  if (error) setError('');
                }}
                onKeyPress={(e) => e.key === 'Enter' && handleContinue()}
              />
            </div>
            {!error && (
              <p className="mt-1.5 text-xs text-gray-500">
                Correct format: <span className="text-gray-700 font-medium italic">mysite.com</span> or <span className="text-gray-700 font-medium italic">myblog.in</span>
              </p>
            )}
            {error && (
              <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
                <AlertCircle className="h-4 w-4" /> {error}
              </p>
            )}
          </div>


          <div className="pt-4 flex flex-col gap-3">
            <button
              onClick={handleContinue}
              disabled={isAdding}
              className="w-full bg-primary-600 hover:bg-primary-700 text-white font-bold py-3 px-6 rounded-xl shadow-lg transition-all transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAdding ? 'Adding to Cart...' : 'Continue to Checkout'}
              {!isAdding && <ArrowRight className="h-5 w-5 group-hover:translate-x-1 transition-transform" />}
            </button>

            <p className="text-center text-xs text-gray-500">
              Note: If you don't own this domain yet, you should also add it to your cart for registration.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
