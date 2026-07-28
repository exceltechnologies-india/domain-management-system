'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Server, Shield, Zap, Globe, Clock, Headphones,
  Database, Cloud, Check, HelpCircle, Sparkles
} from 'lucide-react';
import Navigation from '@/components/Navigation';
import HeroSection from '@/components/HeroSection';
import Section from '@/components/Section';
import PricingCard from '@/components/PricingCard';
import FAQItem from '@/components/FAQItem';
import Footer from '@/components/Footer';
import { useSession } from 'next-auth/react';
import { useCartStore } from '@/store/cartStore';
import type { CartItem } from '@/lib/types';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import toast from 'react-hot-toast';
import { HOSTING_PLANS, CUSTOM_PLAN_FEATURES } from '@/config/hosting-plans';
import { getDeviceFingerprint } from '@/lib/device-fingerprint';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';
import { trackStartTrial } from '@/lib/journey';

interface User {
  firstName: string;
  lastName: string;
  role: string;
}

export default function HostingPage() {
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();
  const { data: session } = useSession();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('yearly');
  const { addItem, items: cartItems } = useCartStore();

  const handleStartTrial = async (plan: typeof HOSTING_PLANS[string]) => {
    trackStartTrial();
    if (!user) {
      router.push(`/login?returnUrl=${encodeURIComponent('/hosting')}`);
      return;
    }

    const deviceFingerprint = await getDeviceFingerprint().catch(() => '');

    const result = await apiClient.post<{ eligible?: boolean; code?: string; reason?: string }>(
      '/api/v1/user/hosting/trial-eligibility',
      { planId: plan.id, deviceFingerprint }
    );

    if (!result.ok) {
      toast.error('Unable to check trial eligibility. Please try again.');
      return;
    }
    const data = result.data;

    if (!data.eligible) {
      toast.error(data.reason || 'You are not eligible for a free trial');
      return;
    }

    addTrialToCart(plan);
  };

  const addTrialToCart = (plan: typeof HOSTING_PLANS[string]) => {
    const uniqueHostingId = `hosting-trial-${plan.id}-${Date.now()}`;
    const trialItem: CartItem = {
      domainName: uniqueHostingId,
      price: 0,
      currency: plan.currency,
      registrationPeriod: 15,
      periodUnit: 'days',
      itemType: 'hosting' as const,
      billingCycle: 'yearly',
      isTrial: true,
      hostingPlan: {
        id: plan.id,
        name: plan.name + ' Hosting',
        period: 15,
        features: [...plan.features, '15-Day Free Trial', '30-Day Money-Back Guarantee'],
        serverPackage: plan.serverPackage,
        // Preserve the underlying plan's monthly price so the checkout
        // page can show "then ₹X/yr" accurately. CartItem.price stays 0
        // for trials (it's the today-charge) — hostingPlan.price carries
        // the post-trial recurring rate. Schema landed in 19ec2d2 so the
        // field persists across save/load cycles.
        price: plan.price,
      },
    };

    addItem(trialItem);
    toast.success(`${plan.name} free trial added! ₹0 today, then billed yearly after 15 days.`);
    router.push('/cart');
  };

  const handleChoosePlan = (plan: typeof HOSTING_PLANS[string]) => {
    // Check if there's already a domain in the cart that doesn't have hosting yet
    const existingDomain = cartItems.find(
      item => (!item.itemType || item.itemType === 'domain')
    );
 
    // Check if any existing hosting item is already linked to this domain
    const isDomainAlreadyLinked = existingDomain && cartItems.some(
      item => item.itemType === 'hosting' && item.linkedDomain === existingDomain.domainName
    );
 
    // Always generate a unique ID for the hosting item itself
    const uniqueHostingId = `hosting-${plan.id}-${Date.now()}`;
 
    const isMonthly = billingCycle === 'monthly';
    let finalPrice = isMonthly ? plan.price * 2 : plan.price;
    let finalPeriod = isMonthly ? 1 : 12;
    let periodUnit: 'months' = 'months';

    const hostingItem: CartItem & { linkedDomain?: string } = {
      domainName: uniqueHostingId,
      price: finalPrice,
      currency: plan.currency,
      registrationPeriod: finalPeriod,
      periodUnit: periodUnit,
      itemType: 'hosting' as const,
      billingCycle: billingCycle,
      hostingPlan: {
        id: plan.id, // Ensure planId is passed for backend lookup
        name: plan.name + ' Hosting',
        period: finalPeriod,
        features: [
          ...plan.features,
          ...(billingCycle === 'yearly' ? ["30-Day Money-Back Guarantee"] : [])
        ],
        serverPackage: plan.serverPackage,
      },
    };
 
    // Auto-link if we found a domain and it's not already linked to another hosting plan
    if (existingDomain && !isDomainAlreadyLinked) {
      hostingItem.linkedDomain = existingDomain.domainName;
      logger.log(`🔗 [HOSTING-PAGE] Auto-linking ${plan.name} to existing domain: ${existingDomain.domainName}`);
    }
 
    addItem(hostingItem);
    toast.success(`${plan.name} added to cart!`);
    router.push('/cart');
  };

  useEffect(() => {
    if (session?.user) {
      setUser({
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        role: session.user.role || 'user',
      });
    } else {
      setUser(null);
    }
  }, [session]);

  const hostingFeatures = [
    {
      icon: <Zap className="h-5 w-5" />,
      title: "Blazing Fast Speed",
      description: "Experience superior performance with our NVMe SSD storage and LiteSpeed servers tailored for high-speed delivery."
    },
    {
      icon: <Shield className="h-5 w-5" />,
      title: "Enhanced Security",
      description: "Keep your website safe with free SSL certificates, automated daily backups, and advanced DDoS protection included."
    },
    {
      icon: <Headphones className="h-5 w-5" />,
      title: "24/7 Expert Support",
      description: "Our dedicated support team is available round-the-clock to assist you with any technical issues or questions."
    },
    {
      icon: <Globe className="h-5 w-5" />,
      title: "99.9% Uptime Guarantee",
      description: "We promise reliable hosting with a 99.9% uptime guarantee, ensuring your website is always accessible to visitors."
    },
    {
      icon: <Database className="h-5 w-5" />,
      title: "Hosting Control Panel",
      description: "Manage your hosting with a powerful, user-friendly control panel — complete website management, email accounts, databases, and more, all in one place."
    },
    {
      icon: <Cloud className="h-5 w-5" />,
      title: "Easy Migration",
      description: "Moving from another host? Our experts will migrate your website to our servers for free with zero downtime."
    }
  ];

  const faqs = [
    {
      question: "What is the difference between specific hosting plans?",
      answer: "Our Starter plan is perfect for beginners with one website. Standard adds more storage and allows hosting for up to 5 websites. Plus enhances resources for growing sites, while Custom offers solutions for larger scale needs."
    },
    {
      question: "Do you offer a free SSL certificate?",
      answer: "Yes! All our plans include a free SSL certificate to ensure your website is secure and trusted by visitors."
    },
    {
      question: "Can I upgrade my plan later?",
      answer: "Absolutely. You can upgrade your hosting plan at any time through your dashboard as your website grows and needs more resources."
    },
    {
      question: "Is there a money-back guarantee?",
      answer: "Yes, we offer a 30-day money-back guarantee on all our yearly hosting plans. If you're not completely satisfied with your annual subscription, you can get a full refund within the first 30 days. Please note that monthly plans and domain registrations are not covered by this guarantee."
    },
    {
      question: "Do you provide website backups?",
      answer: "We provide weekly automated backups for Starter and Standard plans, and daily backups for Plus plans to ensure your data is always safe."
    }
  ];

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--google-bg-secondary)' }}>
      <Navigation user={user} />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="pt-12 sm:pt-16"
      >
        {/* Hero Section */}
        <HeroSection
          background="image"
          backgroundImage="/hosting.jpg"
          variant="brand"
          overlayOpacity={0.88}
          className="min-h-[60vh] sm:min-h-[66vh] flex items-center py-10 sm:py-14"
        >
          <div className="text-center max-w-4xl mx-auto px-4">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="inline-flex items-center gap-2 mb-5 sm:mb-6 bg-white/10 backdrop-blur-md border border-white/25 rounded-full pl-1.5 pr-4 py-1.5 shadow-lg"
            >
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary-500/90">
                <Server className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-white text-[11px] sm:text-xs font-semibold tracking-[0.2em] uppercase">
                Web Hosting
              </span>
            </motion.div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold mb-5 text-white drop-shadow-md" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              Fast, Secure & <span className="text-primary-400">Reliable</span> Web Hosting
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-white/90 mb-8 max-w-2xl mx-auto leading-relaxed">
              Launch your website with a hosting provider that gives you the speed, security, and support you need to grow online.
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-3">
              <a href="#pricing" className="inline-flex items-center justify-center gap-2 bg-white text-primary-600 px-7 py-3 rounded-full font-semibold text-base shadow-lg hover:shadow-xl hover:bg-gray-50 transition-all">
                View Plans
                <Sparkles className="h-4 w-4" />
              </a>
            </div>
            <div className="mt-7 flex justify-center gap-6 text-white/80 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-4 w-4 text-green-400" />
                30-day money-back guarantee (Yearly only)
              </span>
            </div>
          </div>
        </HeroSection>

        {/* Pricing Section */}
        <Section background="white" id="pricing" className="scroll-mt-20 relative overflow-hidden">
          {/* Decorative gradient background */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary-50/30 via-white to-primary-50/20 pointer-events-none" />

          <div className="relative z-10">
            <div className="text-center mb-12">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                  <Database className="h-3.5 w-3.5" />
                  Web Hosting Plans
                </div>
                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  Choose your hosting plan
                </h2>
                <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto mb-8">
                  Powerful hosting backed by Google Servers — pick the tier that fits today and grow as you go.
                </p>
                
                {/* Billing Cycle Toggle */}
                <div className="flex justify-center items-center gap-4 mb-8" role="group" aria-label="Billing cycle">
                  <span id="billing-monthly-label" className={`text-sm font-semibold ${billingCycle === 'monthly' ? 'text-gray-900' : 'text-gray-500'}`}>Monthly</span>
                  <button
                    role="switch"
                    aria-checked={billingCycle === 'yearly'}
                    aria-label="Toggle billing cycle — currently yearly saves 50%"
                    aria-labelledby="billing-monthly-label billing-yearly-label"
                    onClick={() => setBillingCycle(billingCycle === 'monthly' ? 'yearly' : 'monthly')}
                    className="relative inline-flex h-7 w-14 items-center rounded-full bg-primary-500 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        billingCycle === 'yearly' ? 'translate-x-8' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span id="billing-yearly-label" className={`text-sm font-semibold flex items-center gap-2 ${billingCycle === 'yearly' ? 'text-gray-900' : 'text-gray-500'}`}>
                    Yearly
                    <span className="bg-green-100 text-green-700 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold">Save 50%</span>
                  </span>
                </div>
              </motion.div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 max-w-7xl mx-auto px-4">
              {Object.values(HOSTING_PLANS).map((plan) => {
                const isMonthly = billingCycle === 'monthly';
                const monthlyPrice = plan.price * 2;
                const yearlyEquivalentMonthlyPrice = plan.price;
                const displayPrice = isMonthly ? monthlyPrice.toFixed(2) : yearlyEquivalentMonthlyPrice.toFixed(2);
                
                return (
                  <div key={plan.id} className="group flex flex-col gap-4">
                    <PricingCard
                      title={plan.name}
                      subtitle={plan.description}
                      price={displayPrice}
                      period="/mo"
                      originalPrice={!isMonthly ? monthlyPrice.toFixed(2) : ""}
                      discountBadge={!isMonthly ? "Save 50%" : ""}
                      renewalPrice={isMonthly ? `Renews at ₹${monthlyPrice.toFixed(2)}/mo` : `Renews at ₹${yearlyEquivalentMonthlyPrice.toFixed(2)}/mo`}
                      isPopular={plan.isPopular}
                      features={[
                        ...plan.features.map(f => ({
                          text: f,
                          included: true,
                          highlight: plan.highlightFeatures?.includes(f)
                        })),
                        // Add the guarantee only if it's yearly
                        ...(!isMonthly ? [{
                          text: "30-Day Money-Back Guarantee",
                          included: true,
                          highlight: true
                        }] : [])
                      ]}
                      buttonText="Buy Now"
                      onButtonClick={() => handleChoosePlan(plan)}
                    />
                    {!isMonthly && plan.id === 'starter' && (
                      <button
                        onClick={() => handleStartTrial(plan)}
                        className="w-full py-2.5 px-4 text-sm font-semibold text-purple-700 border-2 border-purple-300 rounded-xl hover:bg-purple-50 hover:border-purple-500 transition-all duration-200 flex items-center justify-center gap-2"
                      >
                        <span>🎁</span>
                        Start 15-Day Free Trial
                      </button>
                    )}
                  </div>
                );
              })}

              <PricingCard
                title="Custom"
                subtitle="Enterprise solutions"
                price="Custom"
                currency=""
                period=""
                originalPrice=""
                discountBadge=""
                features={CUSTOM_PLAN_FEATURES}
                buttonText="Contact Us"
                buttonLink="/contact#contact-form"
              />
            </div>
          </div>
        </Section>

        {/* Complementary Services Section */}
        <Section background="gray" className="relative overflow-hidden">
          <div className="text-center mb-10 sm:mb-14">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <div className="inline-flex items-center gap-2 mb-4 bg-white border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700 shadow-sm">
                <Sparkles className="h-3.5 w-3.5" />
                Complementary Services
              </div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                Everything else you need
              </h2>
              <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
                Add-on services that pair naturally with hosting — handled by the same team, on the same dashboard.
              </p>
            </motion.div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6 max-w-6xl mx-auto">
            {([
              { img: '/server-infrastructure.jpg', alt: 'SSL Certificates', title: 'SSL Certificates', body: 'Secure your website with trusted SSL certificates. Boost customer confidence and your search-engine ranking.', cta: 'Learn More', href: '/contact', variant: 'primary' as const },
              { img: '/service-webdesign.jpg', alt: 'Web Design & Development', title: 'Web Design & Development', body: 'Build your website from scratch with our expert developers and designers — pixel-perfect, performance-tuned.', cta: 'Order Now', href: '/contact', variant: 'primary' as const },
              { img: '/service-gcloud.jpg', alt: 'Google Cloud & Workspace', title: 'Google Cloud & Workspace', body: 'Professional email, online storage, shared calendars, video meetings, and the rest of the Google Workspace suite.', cta: 'Contact Us', href: '/contact', variant: 'outline' as const },
            ] as const).map((svc, i) => (
              <motion.div
                key={svc.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.08 }}
                className="group bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-primary-200 transition-all duration-300 overflow-hidden flex flex-col"
              >
                <div className="relative w-full h-44 overflow-hidden">
                  <Image
                    src={svc.img}
                    alt={svc.alt}
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </div>
                <div className="p-5 sm:p-6 flex flex-col flex-grow">
                  <h3 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">{svc.title}</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-5 flex-grow leading-relaxed">{svc.body}</p>
                  <Link
                    href={svc.href}
                    className={`inline-flex items-center justify-center px-5 py-2.5 rounded-xl font-medium text-sm transition-colors ${
                      svc.variant === 'primary'
                        ? 'bg-primary-600 hover:bg-primary-800 text-white'
                        : 'bg-white text-primary-600 border border-primary-500/40 hover:bg-primary-500/5 hover:border-primary-500'
                    }`}
                  >
                    {svc.cta}
                  </Link>
                </div>
              </motion.div>
            ))}
          </div>
        </Section>

        {/* Features Section */}
        <Section background="white" className="relative overflow-hidden">
          {/* Decorative gradient background */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary-50/40 via-white to-primary-50/30 pointer-events-none" />

          <div className="relative z-10">
            <div className="text-center mb-12">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                  <Server className="h-3.5 w-3.5" />
                  Powered by Google
                </div>
                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-4" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  Built on enterprise-grade infrastructure
                </h2>
                <p className="text-base sm:text-lg text-gray-600 leading-relaxed max-w-3xl mx-auto" style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}>
                  <strong className="text-primary-700">Web Hosting backed by Google Servers</strong> — delivering performance, reliability, and security for everything from a personal site to a production app.
                </p>
              </motion.div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
              {hostingFeatures.map((feature, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: index * 0.06 }}
                  className="group bg-white rounded-2xl p-5 sm:p-6 border border-gray-200 shadow-sm hover:shadow-md hover:border-primary-200 transition-all duration-300"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="p-2 rounded-xl bg-primary-50 text-primary-600 group-hover:bg-primary-100 transition-colors shrink-0">
                      {feature.icon}
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 pt-1">{feature.title}</h3>
                  </div>
                  <p className="text-sm sm:text-base text-gray-600 leading-relaxed">{feature.description}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </Section>

        {/* FAQ Section */}
        <Section background="white">
          <div className="max-w-3xl mx-auto">
            <div className="text-center mb-10 sm:mb-14">
              <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                <HelpCircle className="h-3.5 w-3.5" />
                FAQ
              </div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                Frequently Asked Questions
              </h2>
              <p className="text-base sm:text-lg text-gray-600">
                Short answers to the things people ask before signing up.
              </p>
            </div>

            <div className="space-y-4">
              {faqs.map((faq, index) => (
                <FAQItem
                  key={index}
                  question={faq.question}
                  answer={faq.answer}
                  // Open the first item by default
                  isOpen={index === 0}
                />
              ))}
            </div>
          </div>
        </Section>

        <Footer />
      </motion.div>
    </div>
  );
}
