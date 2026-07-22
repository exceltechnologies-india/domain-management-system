'use client';

import { motion } from 'framer-motion';
import Image from 'next/image';
import { Award, Shield, Globe, CheckCircle, Target, Lightbulb, Users, TrendingDown } from 'lucide-react';
import Navigation from '@/components/Navigation';
import HeroSection from '@/components/HeroSection';
import Section from '@/components/Section';
import FeatureCard from '@/components/FeatureCard';
import StatsCard from '@/components/StatsCard';
import Footer from '@/components/Footer';

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="pt-14 sm:pt-16"
      >
        <HeroSection
          variant="brand"
          background="image"
          backgroundImage="/about-us-hero.jpg"
          overlayOpacity={0.85}
          className="min-h-[50vh] sm:min-h-[58vh] flex items-center py-10 sm:py-14"
        >
          <div className="text-center px-4 max-w-4xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="inline-flex items-center gap-2 mb-5 sm:mb-6 bg-white/10 backdrop-blur-md border border-white/25 rounded-full pl-1.5 pr-4 py-1.5 shadow-lg"
            >
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary-500/90">
                <Award className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-white text-[11px] sm:text-xs font-semibold tracking-[0.2em] uppercase">
                About Anutech Digital
              </span>
            </motion.div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold mb-4 sm:mb-5 drop-shadow-lg" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              Built for businesses that take their <span className="text-primary-300">online identity</span> seriously
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-white/90 max-w-2xl mx-auto drop-shadow-md">
              Domain and hosting solutions delivered with innovation, security, and exceptional service.
            </p>
          </div>
        </HeroSection>
      </motion.div>

      <Section background="white" padding="md" className="relative overflow-hidden">
        {/* Decorative gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary-50/30 via-white to-primary-50/20 pointer-events-none" />

        <div className="max-w-6xl mx-auto relative z-10">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
              className="text-center lg:text-left"
            >
              <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                <Target className="h-3.5 w-3.5" />
                Our Journey
              </div>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-5" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                Our Story
              </h2>
              <p className="text-lg text-gray-600 mb-6 leading-relaxed max-w-2xl mx-auto lg:mx-0">
                Anutech Digital Private Limited was founded with a simple mission: to make domain and hosting management
                simple, secure, and accessible for businesses of all sizes. We recognized the
                need for a comprehensive platform that integrates seamlessly with industry-leading
                services while providing an intuitive user experience.
              </p>
              <p className="text-lg text-gray-600 leading-relaxed max-w-2xl mx-auto lg:mx-0">
                Today, we're proud to serve thousands of customers across India, helping them
                manage their digital presence with confidence and ease.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="relative"
            >
              <div className="relative rounded-2xl overflow-hidden shadow-2xl border-4 border-white transform hover:scale-[1.02] transition-transform duration-500">
                <Image
                  src="/team-photo.jpg"
                  alt="Our Team"
                  width={600}
                  height={400}
                  className="w-full h-auto object-cover"
                />
                <div className="absolute inset-0 bg-primary-600/5 hover:bg-transparent transition-colors duration-300" />
              </div>
              {/* Accent decoration */}
              <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-gradient-to-br from-primary-400/20 to-primary-500/20 rounded-full blur-3xl z-[-1]" />
            </motion.div>
          </div>
        </div>
      </Section>

      <Section background="white" padding="md" className="relative overflow-hidden">
        {/* Decorative gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary-50/40 via-white to-primary-50/30 pointer-events-none" />

        <div className="relative z-10">
          <div className="text-center mb-10 sm:mb-14">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                <Lightbulb className="h-3.5 w-3.5" />
                Mission & Vision
              </div>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                What drives us
              </h2>
              <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
                Two principles guide every decision — from the registrar APIs we choose to the dashboards we build.
              </p>
            </motion.div>
          </div>

          <div className="grid md:grid-cols-2 gap-5 sm:gap-6">
            {([
              {
                icon: Target,
                tint: 'primary',
                title: 'Our Mission',
                body: 'Empower businesses to establish and maintain their digital presence with confidence — through cutting-edge domain and hosting solutions that are secure by default and simple to use.',
              },
              {
                icon: Lightbulb,
                tint: 'blue',
                title: 'Our Vision',
                body: 'Become the global leader in web infrastructure technology — setting new standards for security, reliability, and customer satisfaction across the digital infrastructure space.',
              },
            ] as const).map((card, i) => {
              const Icon = card.icon;
              const colors = card.tint === 'primary'
                ? { bg: 'bg-primary-50', text: 'text-primary-600', hover: 'group-hover:bg-primary-100', border: 'hover:border-primary-200' }
                : { bg: 'bg-primary-50', text: 'text-primary-600', hover: 'group-hover:bg-primary-100', border: 'hover:border-primary-200' };
              return (
                <motion.div
                  key={card.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className={`group bg-white rounded-2xl p-6 sm:p-7 border border-gray-200 shadow-sm hover:shadow-md transition-all duration-300 ${colors.border}`}
                >
                  <div className="flex items-start gap-4 mb-4">
                    <div className={`p-3 rounded-xl ${colors.bg} ${colors.text} ${colors.hover} transition-colors shrink-0`}>
                      <Icon className="h-6 w-6" />
                    </div>
                    <h3 className="text-xl sm:text-2xl font-bold text-gray-900 pt-1.5">{card.title}</h3>
                  </div>
                  <p className="text-base text-gray-600 leading-relaxed">{card.body}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </Section>

      <Section background="white" padding="md" className="relative overflow-hidden">
        {/* Decorative gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary-50/30 via-white to-primary-50/20 pointer-events-none" />

        <div className="relative z-10">
          <div className="text-center mb-10 sm:mb-14">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
                <Shield className="h-3.5 w-3.5" />
                Our Advantages
              </div>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                What sets us apart
              </h2>
              <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
                The reasons businesses and individuals across India trust us with their online identity.
              </p>
            </motion.div>
          </div>

          <div className="grid md:grid-cols-3 gap-5 sm:gap-6">
            {([
              { icon: TrendingDown, title: 'Best Pricing', body: 'Competitive pricing with transparent costs, no hidden fees, and special offers on multi-domain and bulk registrations.' },
              { icon: Globe, title: 'Seamless Integration', body: 'Domain and hosting services that connect cleanly — one dashboard, one bill, one support team for your entire stack.' },
              { icon: Users, title: 'Expert Support', body: '24/7 access to a real team of domain and hosting specialists — quick responses, real fixes, no scripts.' },
            ] as const).map((card, i) => {
              const Icon = card.icon;
              return (
                <motion.div
                  key={card.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.08 }}
                  className="group bg-white rounded-2xl p-5 sm:p-6 border border-gray-200 shadow-sm hover:shadow-md hover:border-primary-200 transition-all duration-300"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="p-2 rounded-xl bg-primary-50 text-primary-600 group-hover:bg-primary-100 transition-colors shrink-0">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 pt-1">{card.title}</h3>
                  </div>
                  <p className="text-sm sm:text-base text-gray-600 leading-relaxed">{card.body}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </Section>



      <Footer />
    </div>
  );
}