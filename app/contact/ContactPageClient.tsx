'use client';

import { motion } from 'framer-motion';
import { Mail, MessageCircle } from 'lucide-react';
import Navigation from '@/components/Navigation';
import HeroSection from '@/components/HeroSection';
import Section from '@/components/Section';
import ContactForm from '@/components/ContactForm';
import ContactInfo from '@/components/ContactInfo';
import ContactMap from '@/components/ContactMap';
import Footer from '@/components/Footer';

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation />

      <div className="pt-14 sm:pt-16">
      <HeroSection
        variant="brand"
        background="image"
        backgroundImage="/contact-us-hero.jpeg"
        overlayOpacity={0.85}
        className="min-h-[50vh] sm:min-h-[56vh] flex items-center py-10 sm:py-14"
      >
        <div className="text-center px-4 max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="inline-flex items-center gap-2 mb-5 sm:mb-6 bg-white/10 backdrop-blur-md border border-white/25 rounded-full pl-1.5 pr-4 py-1.5 shadow-lg"
          >
            <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary-500/90">
              <Mail className="h-3.5 w-3.5 text-white" />
            </span>
            <span className="text-white text-[11px] sm:text-xs font-semibold tracking-[0.2em] uppercase">
              Contact Us
            </span>
          </motion.div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold mb-4 sm:mb-5 drop-shadow-lg" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
            We&apos;re a <span className="text-primary-400">message away</span>
          </h1>
          <p className="text-base sm:text-lg md:text-xl text-white/90 max-w-2xl mx-auto drop-shadow-md">
            Questions, support requests, or partnership ideas — our team responds fast.
          </p>
        </div>
      </HeroSection>
      </div>

      <Section background="white" padding="md" className="relative overflow-hidden">
        {/* Decorative gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary-50/30 via-white to-primary-50/20 pointer-events-none" />

        <div className="relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-10 sm:mb-14 flex flex-col items-center"
          >
            <div className="inline-flex items-center gap-2 mb-4 bg-primary-50 border border-primary-100 rounded-full px-3 py-1.5 text-xs sm:text-sm font-semibold text-primary-700">
              <MessageCircle className="h-3.5 w-3.5" />
              Get In Touch
            </div>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              We&apos;re here to help
            </h2>
            <p className="text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
              Have a question, hit a snag, or want to talk pricing? Reach out and a real person will get back to you.
            </p>
          </motion.div>

          <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 max-w-7xl mx-auto">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="flex flex-col"
            >
              <ContactInfo />
            </motion.div>
            <motion.div
              id="contact-form"
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="flex flex-col"
            >
              <ContactForm />
            </motion.div>
          </div>
        </div>
      </Section>

      {/* Map Section */}
      <Section background="gray" padding="md">
        <ContactMap />
      </Section>

      <Footer />
    </div>
  );
}