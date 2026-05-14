'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { Search, Shield, CreditCard, Globe, Star, Users, Clock, Smartphone, Headphones, Mail, Phone, MapPin, ArrowRight, CheckCircle, TrendingUp, Database, Server, Wifi, ChevronDown, TrendingDown } from 'lucide-react';
import Navigation from '@/components/Navigation';
import HeroSection from '@/components/HeroSection';
import Section from '@/components/Section';
import FeatureCard from '@/components/FeatureCard';
import StatsCard from '@/components/StatsCard';
import DomainSearch from '@/components/DomainSearch';
import ClientOnly from '@/components/ClientOnly';
import Footer from '@/components/Footer';
import ChatWidget from '@/components/ChatWidget';
import { safeLocalStorage } from '@/lib/storage';

interface User {
  firstName: string;
  lastName: string;
  role: string;
}

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Check if user is logged in (client-side only)
    if (typeof window !== 'undefined') {
      const getCookieValue = (name: string) => {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop()?.split(';').shift();
        return null;
      };

      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const userData = safeLocalStorage.getItem('user');

      if (token && userData) {
        try {
          setUser(JSON.parse(userData));
        } catch (error) {
          // Error parsing user data
        }
      }
    }
  }, []);

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--google-bg-secondary)' }}>
      <Navigation user={user} />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="pt-14 sm:pt-16"
      >
        <HeroSection
          background="image"
          backgroundImage="/domain-1.jpeg"
          overlayOpacity={0.92}
          className="min-h-[64vh] sm:min-h-[58vh] flex items-center py-14 sm:py-12"
        >
          <div className="text-center w-full px-2 sm:px-4">
            {/* Eyebrow: icon + label inline */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="inline-flex items-center gap-2 mb-5 sm:mb-6 bg-white/10 backdrop-blur-md border border-white/25 rounded-full pl-1.5 pr-4 py-1.5 shadow-lg"
            >
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-blue-500/90">
                <Globe className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-white text-[11px] sm:text-xs font-semibold tracking-[0.2em] uppercase">
                Domain Registration
              </span>
            </motion.div>

            {/* Domain Search Feature */}
            <div className="w-full max-w-screen-2xl mx-auto px-2">
              <DomainSearch
                className="mb-0"
                redirectOnSearch={true}
                title={
                  <span className="text-white drop-shadow-md">
                    Claim Your Piece of the <span className="text-blue-400">Digital World</span>
                  </span>
                }
                subtitle="Join 5,000+ happy customers who have secured their identity with Anutech."
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
                  Anutech Digital Private Limited is a professional <strong className="text-primary-700">domain registration and web hosting platform</strong> that helps individuals and businesses secure their online identity.
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

        {/* Web Hosting Services Section */}
        <Section background="white" className="relative overflow-hidden">
          {/* Decorative gradient background */}
          <div className="absolute inset-0 bg-gradient-to-br from-blue-50/40 via-white to-primary-50/30 pointer-events-none" />

          <div className="max-w-screen-2xl mx-auto relative z-10">
            <div className="grid lg:grid-cols-2 gap-12 items-center mb-16">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="text-center lg:text-left"
              >
                <div className="inline-flex items-center gap-2 mb-4 bg-blue-50 border border-blue-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-blue-700">
                  <Server className="h-3.5 w-3.5" />
                  Powered by Google
                </div>
                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-5" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  Web Hosting Services
                </h2>
                <p className="text-lg sm:text-xl text-gray-600 leading-relaxed mb-6" style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}>
                  Anutech Digital Private Limited provides <strong className="text-blue-700">Web Hosting backed by Google Servers</strong> - delivering enterprise-grade performance, reliability, and security for your websites and applications.
                </p>
                <p className="text-gray-600 leading-relaxed">
                  Our infrastructure is designed to scale with your business, ensuring that your website remains fast and accessible even during traffic spikes.
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.2 }}
                className="relative"
              >
                <div className="relative rounded-2xl overflow-hidden shadow-2xl border-4 border-white">
                  <Image
                    src="/server-infrastructure.jpg"
                    alt="Server Infrastructure"
                    width={800}
                    height={600}
                    className="w-full h-auto object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />
                </div>
                {/* Decorative elements — hidden on mobile to prevent horizontal overflow */}
                <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-blue-100 rounded-full z-[-1] opacity-50 hidden sm:block" />
                <div className="absolute -top-6 -left-6 w-32 h-32 bg-primary-100 rounded-full z-[-1] opacity-50 hidden sm:block" />
              </motion.div>
            </div>

            <div className="grid sm:grid-cols-2 gap-5 sm:gap-6">
              {([
                { title: 'Google Cloud Infrastructure', body: "Powered by Google's world-class server fleet with global data centres, delivering lightning-fast load times and a 99.9% uptime guarantee." },
                { title: 'Scalable Performance', body: 'Automatic resource scaling, NVMe SSD storage, and distributed architecture so traffic spikes never compromise performance.' },
                { title: 'Enterprise Security', body: 'Free SSL certificates, DDoS protection, automated backups, malware scanning, and enterprise-grade firewalls baked in.' },
                { title: 'Easy Management', body: 'Friendly control panel, one-click WordPress installer, email hosting, and 24/7 expert support for a seamless hosting experience.' },
              ] as const).map((card, i) => (
                <motion.div
                  key={card.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.08 }}
                  className="group bg-white rounded-2xl p-5 sm:p-6 border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-200 transition-all duration-300 text-left"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="p-2 rounded-xl bg-blue-50 text-blue-600 group-hover:bg-blue-100 transition-colors shrink-0">
                      <CheckCircle className="h-5 w-5" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 pt-1">{card.title}</h3>
                  </div>
                  <p className="text-sm sm:text-base text-gray-600 leading-relaxed">{card.body}</p>
                </motion.div>
              ))}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="flex justify-center mt-10"
            >
              <Link
                href="/hosting#pricing"
                className="group relative bg-gradient-to-r from-primary-600 to-blue-600 text-white hover:from-primary-700 hover:to-blue-700 font-bold py-4 px-10 rounded-full shadow-xl hover:shadow-2xl transition-all duration-300 flex items-center gap-2 overflow-hidden"
              >
                <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-10 transition-opacity duration-300" />
                <Server className="h-5 w-5 group-hover:rotate-12 transition-transform duration-300" />
                <span>Explore Hosting Plans</span>
                <ArrowRight className="h-5 w-5 group-hover:translate-x-1 transition-transform duration-300" />
              </Link>
            </motion.div>
          </div>
        </Section>

        <Section background="white">
          <div className="text-center mb-10 sm:mb-14">
            <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
              <Star className="h-3.5 w-3.5" />
              Everything in one place
            </div>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              Complete Web Solutions Platform
            </h2>
            <p className="text-base sm:text-lg text-gray-600 max-w-3xl mx-auto" style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}>
              Domain registration, reliable hosting, and the tools you need to launch and grow online — backed by 24/7 support.
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
              icon={<Server className="h-8 w-8" />}
              title="Powerful Hosting"
              description="High-performance web hosting with free SSL, NVMe SSD storage, and one-click installers for WordPress and other apps"
            />
            <FeatureCard
              icon={<Headphones className="h-8 w-8" />}
              title="24/7 Expert Support"
              description="Get help anytime with our dedicated support team via email, phone, or chat for domain setup, transfers, and technical assistance"
            />
            <FeatureCard
              icon={<Clock className="h-8 w-8" />}
              title="DirectAdmin Panel"
              description="Manage your hosting with DirectAdmin - a powerful control panel for website management, email accounts, databases, and complete server control"
            />
          </div>
        </Section>

        <Section background="gray">
          <div className="text-center mb-10 sm:mb-14">
            <div className="inline-flex items-center gap-2 mb-4 bg-white border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700 shadow-sm">
              <TrendingUp className="h-3.5 w-3.5" />
              Our Impact
            </div>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              Trusted by thousands across India
            </h2>
            <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
              Numbers that reflect a stable, growing platform — handled with the seriousness your online identity deserves.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-8">
            <StatsCard
              icon={<Globe className="h-6 w-6" />}
              value="10,000+"
              label="Domains Managed"
              trend="up"
              trendValue="15% this month"
            />
            <StatsCard
              icon={<Users className="h-6 w-6" />}
              value="5,000+"
              label="Happy Customers"
              trend="up"
              trendValue="25% this month"
            />
            <StatsCard
              icon={<Shield className="h-6 w-6" />}
              value="99.9%"
              label="Uptime"
              trend="neutral"
              trendValue="Last 30 days"
            />
            <StatsCard
              icon={<Clock className="h-6 w-6" />}
              value="24/7"
              label="Support"
              trend="neutral"
              trendValue="Always available"
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

      <ChatWidget />
    </div>
  );
}