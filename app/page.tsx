'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Search, Shield, CreditCard, Globe, Star, Clock, Headphones, CheckCircle, Database } from 'lucide-react';
import Navigation from '@/components/Navigation';
import HeroSection from '@/components/HeroSection';
import Section from '@/components/Section';
import FeatureCard from '@/components/FeatureCard';
import DomainSearch from '@/components/DomainSearch';
import ClientOnly from '@/components/ClientOnly';
import Footer from '@/components/Footer';
import ChatWidget from '@/components/ChatWidget';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function HomePage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--google-bg-secondary)' }}>
      <Navigation />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="pt-14 sm:pt-16"
      >
        <HeroSection
          background="image"
          backgroundImage="/domain-1.jpeg"
          variant="brand"
          overlayOpacity={0.96}
          className="flex items-center py-12 sm:py-16 lg:min-h-[56vh]"
        >
          <div className="text-center w-full max-w-3xl mx-auto">
            {/* Eyebrow */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="inline-flex items-center gap-2 mb-6 sm:mb-7 bg-white/15 border border-white/20 rounded-full px-3.5 py-1.5"
            >
              <Globe className="h-3.5 w-3.5 text-blue-200" />
              <span className="text-white/90 text-[11px] sm:text-xs font-semibold tracking-[0.18em] uppercase">
                Domain Registration
              </span>
            </motion.div>

            {/* Headline + subtitle (rendered here for a tighter rhythm with the
                search box below; DomainSearch handles the input + results). */}
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.05 }}
            >
              <h1
                // At lg the one-line headline is wider than the max-w-3xl
                // hero container, so it would overflow (and look off-centre).
                // `w-max` sizes the h1 to the line, `max-w-none` drops the
                // inherited cap, and left-1/2 + -translate-x-1/2 centres that
                // block on the container's centre (= viewport centre) without
                // widening the search box. Mobile/tablet keep the normal
                // text-centre wrap.
                className="text-white text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight leading-[1.1] mb-3 sm:mb-4 lg:whitespace-nowrap lg:w-max lg:max-w-none lg:relative lg:left-1/2 lg:-translate-x-1/2"
                style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
              >
                Claim Your Piece of the{' '}
                <span className="text-blue-300">Digital World</span>
              </h1>
              <p className="text-blue-100/85 text-sm sm:text-base max-w-xl mx-auto mb-6 sm:mb-8 leading-relaxed">
                Join 5,000+ customers who&apos;ve secured their identity with Anutech.
              </p>
            </motion.div>

            {/* Domain Search — light theme renders a solid white card that
                reads crisply against the blue hero background. */}
            <div className="w-full">
              <DomainSearch
                className="mb-0"
                redirectOnSearch={true}
                showHeroText={false}
                theme="light"
                compact
              />
            </div>
          </div>
        </HeroSection>

        {/* Clear Service Description Section */}
        <Section background="white" className="relative overflow-hidden">
          {/* Decorative gradient background */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary-50/30 via-white to-blue-50/20 pointer-events-none" />

          <div className="max-w-screen-2xl mx-auto relative z-10">
            <div className="text-center mb-12">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                  <Globe className="h-3.5 w-3.5" />
                  Domain Services
                </div>
                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-4" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  Domain Registration & Management
                </h2>
                <p className="text-lg sm:text-xl text-gray-600 leading-relaxed px-4 max-w-3xl mx-auto" style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}>
                  Anutech Digital Private Limited is a professional <strong className="text-primary-700">domain registration and management platform</strong> that helps individuals and businesses secure their online identity.
                </p>
              </motion.div>
            </div>

            <div className="grid sm:grid-cols-2 gap-5 sm:gap-6">
              {([
                { title: 'Domain Buying', body: 'Purchase new domain names from our extensive catalog across 100+ extensions including .com, .in, .org, .net, and more — with instant registration.' },
                { title: 'Domain Management', body: 'Manage every domain from a single dashboard — configure DNS, update nameservers, enable WHOIS privacy, transfer in, and set up auto-renewal.' },
                { title: 'DNS Configuration', body: 'Full DNS controls to connect your domain to hosting, email, and other platforms with A, AAAA, CNAME, MX, and TXT records.' },
                { title: 'Domain Renewals', body: 'Keep domains active with easy renewal, optional auto-renew, and timely expiration reminders so you never lose what you own.' },
              ] as const).map((card, i) => (
                <motion.div
                  key={card.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.08 }}
                  className="group bg-white rounded-2xl p-5 sm:p-6 border border-gray-200 shadow-sm hover:shadow-md hover:border-primary-200 transition-all duration-300 text-left"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="p-2 rounded-xl bg-primary-50 text-primary-600 group-hover:bg-primary-100 transition-colors shrink-0">
                      <CheckCircle className="h-5 w-5" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 pt-1">{card.title}</h3>
                  </div>
                  <p className="text-sm sm:text-base text-gray-600 leading-relaxed">{card.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </Section>

        <Section background="white">
          <div className="text-center mb-10 sm:mb-14">
            <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
              <Star className="h-3.5 w-3.5" />
              Everything in one place
            </div>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              Everything you need to own your domain
            </h2>
            <p className="text-base sm:text-lg text-gray-600 max-w-3xl mx-auto" style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}>
              Search, register, and manage your domains from one clean dashboard — with transparent pricing and 24/7 support.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            <FeatureCard
              icon={<Search className="h-8 w-8" />}
              title="Domain Registration"
              description="Search and register available domains instantly across .com, .in, .org, and 100+ TLDs with transparent pricing and real-time availability"
            />
            <FeatureCard
              icon={<Shield className="h-8 w-8" />}
              title="Domain Management"
              description="Complete control panel to manage your domains - update DNS records, configure nameservers, enable privacy protection, and renew domains"
            />
            <FeatureCard
              icon={<CreditCard className="h-8 w-8" />}
              title="Secure Purchase"
              description="Buy domains securely with Razorpay payment gateway - supports credit/debit cards, UPI, net banking, and digital wallets"
            />
            <FeatureCard
              icon={<Shield className="h-8 w-8" />}
              title="WHOIS Privacy"
              description="Keep your personal contact details off the public WHOIS record with built-in privacy protection on supported extensions"
            />
            <FeatureCard
              icon={<Clock className="h-8 w-8" />}
              title="Renewals & Reminders"
              description="Never lose a domain — optional auto-renew plus timely expiration reminders keep every name you own active"
            />
            <FeatureCard
              icon={<Headphones className="h-8 w-8" />}
              title="24/7 Expert Support"
              description="Get help anytime with our dedicated support team via email, phone, or chat for domain setup, transfers, and technical assistance"
            />
          </div>
        </Section>

        <Section background="white">
          <div className="text-center mb-10 sm:mb-14">
            <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
              <Database className="h-3.5 w-3.5" />
              How it works
            </div>
            <h3 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              From idea to live domain in three steps
            </h3>
            <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
              Simple, secure, and professional — search, purchase, and manage entirely from your dashboard.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5 sm:gap-6 relative">
            {/* Connector line between steps on desktop */}
            <div className="hidden md:block absolute top-12 left-[16%] right-[16%] h-px bg-gradient-to-r from-transparent via-primary-200 to-transparent pointer-events-none" />

            {([
              { num: 1, icon: Search, title: 'Search & Select', body: 'Find available domain names instantly across 100+ extensions with real-time availability and transparent pricing.' },
              { num: 2, icon: CreditCard, title: 'Purchase Securely', body: 'Pay through Razorpay with full card, UPI, and net-banking support. Your registrant details are signed and encrypted.' },
              { num: 3, icon: Globe, title: 'Manage & Configure', body: 'Update DNS, nameservers, privacy protection, and renewals from one clean dashboard. We handle the registrar bits.' },
            ] as const).map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.num}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className="relative bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-center"
                >
                  <div className="relative w-20 h-20 mx-auto mb-4">
                    <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary-50 to-blue-50" />
                    <div className="relative flex items-center justify-center h-full">
                      <Icon className="h-9 w-9 text-primary-600" />
                    </div>
                    <span className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-primary-600 text-white text-xs font-bold flex items-center justify-center shadow-md border-2 border-white">
                      {step.num}
                    </span>
                  </div>
                  <h4 className="text-lg sm:text-xl font-semibold text-gray-900 mb-2">{step.title}</h4>
                  <p className="text-sm sm:text-base text-gray-600 leading-relaxed">{step.body}</p>
                </motion.div>
              );
            })}
          </div>
        </Section>


        <Footer />
      </motion.div>

      <ErrorBoundary label="ChatWidget" fallback={null}>
        <ChatWidget />
      </ErrorBoundary>
    </div>
  );
}