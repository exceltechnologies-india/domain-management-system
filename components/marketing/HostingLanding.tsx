'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import {
  Cloud, Zap, Lock, RefreshCw, Rocket, Headphones, CheckCircle, XCircle, Minus,
  ArrowRight, ShieldCheck, CreditCard, Globe, Server, Star, Check,
  LayoutDashboard, Bell,
} from 'lucide-react';
import Navigation from '@/components/Navigation';
import Section from '@/components/Section';
import PricingCard from '@/components/PricingCard';
import FAQItem from '@/components/FAQItem';
import Footer from '@/components/Footer';
import ChatWidget from '@/components/ChatWidget';
import { ErrorBoundary } from '@/components/ErrorBoundary';

/** Serialized hosting plan passed from the server (subset of HostingPlan). */
export interface LandingPlan {
  planId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  features: string[];
  highlightFeatures: string[];
  isPopular: boolean;
}

const TRIAL_CTA = '/hosting#pricing';

function symbolFor(currency: string): string {
  return currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
}

const TRUSTED_LOGOS = ['travelizo', 'Crafto.', 'TechSolution', 'Brilliant', 'GrowMore Digital'];

const FEATURES = [
  { icon: Cloud, title: 'Google Cloud Infrastructure', body: 'Enterprise-grade infrastructure for maximum speed, security & reliability.' },
  { icon: Zap, title: 'Lightning Fast Performance', body: 'NVMe SSD storage, LiteSpeed servers and an optimized stack for ultra-fast websites.' },
  { icon: Lock, title: 'Free SSL Certificate', body: 'Secure your website with a free SSL certificate + HTTPS activation.' },
  { icon: RefreshCw, title: 'Daily Backups', body: 'Automatic daily backups keep your data safe and restorable.' },
  { icon: Rocket, title: 'Free Website Migration', body: "We'll move your website to Anutech for FREE. No technical hassle." },
  { icon: Headphones, title: '24×7 Expert Support', body: 'Real people, real support. Get help anytime via chat, ticket or call.' },
];

// per-row: how a typical host compares — 'yes' | 'no' | 'partial'
const COMPARISON: { feature: string; typical: 'yes' | 'no' | 'partial' }[] = [
  { feature: 'Google Cloud Infrastructure', typical: 'no' },
  { feature: 'Free SSL Certificate', typical: 'yes' },
  { feature: 'Free Website Migration', typical: 'partial' },
  { feature: '15-Day Free Trial', typical: 'no' },
  { feature: 'Daily Backups', typical: 'yes' },
  { feature: '99.99% Uptime Guarantee', typical: 'partial' },
  { feature: '24×7 Expert Support', typical: 'no' },
  { feature: 'No Hidden Fees', typical: 'no' },
];

const STEPS = [
  { num: 1, icon: CreditCard, title: 'Create Your Account', body: 'Sign up in less than 60 seconds. No credit card required.' },
  { num: 2, icon: Globe, title: 'Choose Domain', body: 'Register a new domain or connect your existing one.' },
  { num: 3, icon: Server, title: 'Build Your Website', body: 'Install WordPress or use one-click apps to build your site.' },
  { num: 4, icon: Rocket, title: 'Go Live & Upgrade', body: 'Launch your website. Upgrade anytime if you love our service!' },
];

const TESTIMONIALS = [
  { quote: 'Anutech Hosting is fast, reliable and the support team is outstanding. Highly recommended!', name: 'Ravi Sharma', role: 'Founder, TechSolution' },
  { quote: 'Our website migrated seamlessly and the performance boost is amazing. Great support!', name: 'Priya Mehta', role: 'Marketing Head, Crafto' },
  { quote: 'Finally, a hosting company that actually cares about its customers. 10/10!', name: 'Amit Verma', role: 'CEO, DigitalGrow' },
  { quote: 'Affordable pricing with premium features. Best decision for our business.', name: 'Sneha Iyer', role: 'Co-founder, Travelizo' },
];

const FAQS = [
  { question: 'How does the 15-Day Free Trial work?', answer: 'Start your trial with full access to all hosting features for 15 days — no credit card required. If you love it, upgrade to a paid plan anytime. If not, simply let it expire.' },
  { question: 'Do I need a credit card to start the trial?', answer: 'No. You can start your 15-day free trial without entering any payment details. You only pay when you decide to continue after the trial.' },
  { question: 'Can I migrate my website to Anutech for free?', answer: 'Yes! We offer free website migration on all plans. Our team moves your site over with no downtime and no technical hassle on your end.' },
  { question: 'What happens after the 15-Day Trial?', answer: 'When the trial ends you can convert to any paid plan to keep your website live. Your first invoice is generated only at that point — that is when your card / UPI mandate is charged for the first time.' },
  { question: 'Do you offer a money-back guarantee?', answer: 'Yes, we offer a 30-day money-back guarantee on all yearly hosting plans. Monthly plans and domain registrations are not covered by this guarantee.' },
  { question: 'Can I upgrade or downgrade my plan anytime?', answer: 'Absolutely. You can change your plan at any time from your dashboard, and we prorate the difference automatically.' },
];

export default function HostingLanding({ plans }: { plans: LandingPlan[] }) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('yearly');

  return (
    <div className="min-h-screen bg-white">
      <Navigation />

      <div className="pt-14 sm:pt-16">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden bg-gradient-to-b from-violet-50/70 via-white to-white">
          <div className="absolute -top-24 -right-24 w-[30rem] h-[30rem] rounded-full bg-violet-100/50 blur-3xl pointer-events-none" />
          <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 py-14 sm:py-20 relative">
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-12 items-center">
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
                <div className="inline-flex items-center gap-2 mb-5 bg-violet-100 text-violet-700 rounded-full px-3 py-1.5 text-[11px] sm:text-xs font-bold tracking-wide uppercase">
                  <Rocket className="h-3.5 w-3.5" />
                  15-Day Free Trial · No Credit Card Required
                </div>
                <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-gray-900 leading-[1.08] mb-5" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  Launch Your Business Website{' '}
                  <span className="bg-gradient-to-r from-[#7C3AED] to-[#6D28D9] bg-clip-text text-transparent">FREE for 15 Days</span>
                </h1>
                <p className="text-base sm:text-lg text-gray-600 leading-relaxed mb-8 max-w-xl">
                  Enterprise-grade web hosting powered by Google Cloud. Free SSL, daily backups, free migration and 24×7 expert support.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 mb-6">
                  <Link href={TRIAL_CTA} className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#22C55E] to-[#16A34A] hover:from-[#16A34A] hover:to-[#15803D] text-white font-bold py-3.5 px-7 rounded-xl shadow-lg hover:shadow-xl transition-all active:scale-95">
                    <Rocket className="h-5 w-5" />
                    Start Your 15-Day Free Trial
                  </Link>
                  <Link href="#pricing" className="inline-flex items-center justify-center gap-2 bg-white text-gray-800 font-bold py-3.5 px-7 rounded-xl border border-gray-200 shadow-sm hover:border-violet-300 hover:text-violet-700 transition-all">
                    View Hosting Plans
                  </Link>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-500">
                  {['No Credit Card Required', 'Full Access to All Features', 'Cancel Anytime'].map((t) => (
                    <span key={t} className="inline-flex items-center gap-1.5"><CheckCircle className="h-4 w-4 text-green-500" />{t}</span>
                  ))}
                </div>
              </motion.div>

              {/* Dashboard mock */}
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 }} className="hidden lg:block">
                <div className="rounded-2xl border border-gray-200 shadow-2xl overflow-hidden bg-white">
                  <div className="flex items-center gap-1.5 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                    <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                    <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                    <span className="ml-3 text-[11px] text-gray-400 font-medium">app.anutech.in · Dashboard</span>
                  </div>
                  <div className="flex">
                    {/* sidebar */}
                    <div className="w-32 shrink-0 border-r border-gray-100 p-3 hidden xl:block">
                      <div className="flex items-center gap-1.5 mb-4 px-1">
                        <div className="h-5 w-5 rounded bg-gradient-to-br from-[#7C3AED] to-[#6D28D9]" />
                        <span className="text-[11px] font-bold text-gray-800">ANUTECH</span>
                      </div>
                      {['Dashboard', 'Websites', 'Domains', 'Emails', 'Files', 'Databases', 'Backups', 'Security', 'Settings'].map((n, i) => (
                        <div key={n} className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg mb-0.5 text-[11px] ${i === 0 ? 'bg-violet-50 text-violet-700 font-semibold' : 'text-gray-500'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${i === 0 ? 'bg-violet-600' : 'bg-gray-300'}`} />
                          {n}
                        </div>
                      ))}
                    </div>
                    {/* main */}
                    <div className="flex-1 p-4 min-w-0">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900">Welcome back, Abhishek! 👋</p>
                          <p className="text-[11px] text-gray-500">Here&apos;s what&apos;s happening with your website today.</p>
                        </div>
                        <div className="flex items-center gap-2 text-gray-300">
                          <Bell className="h-4 w-4" />
                          <LayoutDashboard className="h-4 w-4" />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        {[
                          { label: 'Website', value: 'Active', sub: 'mybusiness.com', tint: 'text-green-600' },
                          { label: 'Storage', value: '12.6 / 20 GB', sub: '63% Used', tint: 'text-violet-600' },
                          { label: 'Bandwidth', value: '32 / 100 GB', sub: '32% Used', tint: 'text-violet-600' },
                        ].map((s) => (
                          <div key={s.label} className="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
                            <p className="text-[9px] uppercase tracking-wide text-gray-400">{s.label}</p>
                            <p className={`text-[11px] font-bold ${s.tint}`}>{s.value}</p>
                            <p className="text-[9px] text-gray-400 mt-0.5">{s.sub}</p>
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2 rounded-lg border border-gray-100 p-3">
                          <p className="text-[10px] font-semibold text-gray-500 mb-2">Performance <span className="text-green-500">+12.9%</span></p>
                          <svg viewBox="0 0 200 60" className="w-full h-14">
                            <polyline fill="none" stroke="#7C3AED" strokeWidth="2.5" points="0,45 28,40 56,44 84,30 112,34 140,20 168,24 200,8" />
                          </svg>
                        </div>
                        <div className="rounded-lg border border-gray-100 p-3">
                          <p className="text-[10px] font-semibold text-gray-500 mb-2">Quick Actions</p>
                          {['Create Website', 'Install WordPress', 'Add Domain'].map((a) => (
                            <p key={a} className="text-[9px] text-gray-500 mb-1 flex items-center gap-1"><span className="h-1 w-1 rounded-full bg-violet-500" />{a}</p>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ── Trust bar ────────────────────────────────────────────────── */}
        <section className="border-y border-gray-100 bg-white">
          <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              <div>
                <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-violet-600 mb-3 text-center lg:text-left">Trusted by 1,000+ businesses</p>
                <div className="flex flex-wrap items-center justify-center lg:justify-start gap-x-6 gap-y-2">
                  {TRUSTED_LOGOS.map((l) => (
                    <span key={l} className="text-sm sm:text-base font-bold text-gray-400/80" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>{l}</span>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-4 sm:gap-8">
                {[
                  { icon: Star, value: '1,000+', label: 'Happy Customers' },
                  { icon: ShieldCheck, value: '99.99%', label: 'Uptime Guarantee' },
                  { icon: Rocket, value: '5+', label: 'Years of Trust' },
                  { icon: Headphones, value: '24×7', label: 'Expert Support' },
                ].map((s) => {
                  const Icon = s.icon;
                  return (
                    <div key={s.label} className="flex flex-col items-center text-center">
                      <Icon className="h-4 w-4 text-violet-600 mb-1" />
                      <p className="text-base sm:text-lg font-extrabold text-gray-900">{s.value}</p>
                      <p className="text-[10px] sm:text-xs text-gray-500">{s.label}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* ── Features ─────────────────────────────────────────────────── */}
        <Section background="white">
          <div className="text-center mb-10 sm:mb-14">
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">Everything you need to succeed online</p>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>Powerful Features. Unmatched Performance.</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 sm:gap-5">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <motion.div key={f.title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: i * 0.05 }}
                  className="group bg-white rounded-2xl p-5 border border-gray-200 shadow-sm hover:shadow-md hover:border-violet-200 transition-all">
                  <div className="inline-flex p-2.5 rounded-xl bg-violet-50 text-violet-600 group-hover:bg-violet-100 transition-colors mb-3">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-sm font-bold text-gray-900 mb-1.5">{f.title}</h3>
                  <p className="text-xs text-gray-600 leading-relaxed">{f.body}</p>
                </motion.div>
              );
            })}
          </div>
        </Section>

        {/* ── Comparison ───────────────────────────────────────────────── */}
        <Section background="gray">
          <div className="max-w-3xl mx-auto text-center mb-10">
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">Why choose Anutech?</p>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>Better Hosting. Better Results.</h2>
          </div>
          <div className="max-w-2xl mx-auto overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="grid grid-cols-[1fr_auto_auto]">
              <div className="px-4 sm:px-6 py-4 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-500">Feature</div>
              <div className="px-4 sm:px-6 py-4 bg-violet-600 border-b border-violet-700 text-sm font-bold text-white text-center whitespace-nowrap">Anutech</div>
              <div className="px-4 sm:px-6 py-4 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-500 text-center whitespace-nowrap">Typical Host</div>
              {COMPARISON.map((row, i) => (
                <div key={row.feature} className="contents">
                  <div className={`px-4 sm:px-6 py-3.5 text-sm text-gray-700 ${i < COMPARISON.length - 1 ? 'border-b border-gray-100' : ''}`}>{row.feature}</div>
                  <div className={`px-4 sm:px-6 py-3.5 flex justify-center bg-violet-50/40 ${i < COMPARISON.length - 1 ? 'border-b border-gray-100' : ''}`}>
                    <CheckCircle className="h-5 w-5 text-green-500" />
                  </div>
                  <div className={`px-4 sm:px-6 py-3.5 flex justify-center ${i < COMPARISON.length - 1 ? 'border-b border-gray-100' : ''}`}>
                    {row.typical === 'yes' ? <CheckCircle className="h-5 w-5 text-green-500" />
                      : row.typical === 'partial' ? <Minus className="h-5 w-5 text-amber-400" />
                        : <XCircle className="h-5 w-5 text-gray-300" />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── How the trial works ──────────────────────────────────────── */}
        <Section background="white">
          <div className="text-center mb-10 sm:mb-14">
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">Get started in minutes</p>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>How the 15-Day Free Trial Works</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div key={step.num} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: i * 0.08 }}
                  className="relative bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-center">
                  <div className="relative w-16 h-16 mx-auto mb-4">
                    <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-violet-50 to-primary-50" />
                    <div className="relative flex items-center justify-center h-full"><Icon className="h-7 w-7 text-violet-600" /></div>
                    <span className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center shadow-md border-2 border-white">{step.num}</span>
                  </div>
                  <h4 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">{step.title}</h4>
                  <p className="text-sm text-gray-600 leading-relaxed">{step.body}</p>
                </motion.div>
              );
            })}
          </div>
        </Section>

        {/* ── Pricing (DB-driven) ──────────────────────────────────────── */}
        <Section background="gray" id="pricing">
          <div className="text-center mb-8 sm:mb-10">
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">Choose the perfect plan for you</p>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>Simple, Transparent Pricing</h2>
            <p className="text-base text-gray-600">Start with a 15-day free trial — no credit card required.</p>
          </div>

          {/* Billing toggle — segmented control */}
          <div className="flex justify-center mb-10">
            <div className="inline-flex items-center gap-1 bg-gray-100 rounded-full p-1">
              <button
                type="button"
                onClick={() => setBillingCycle('monthly')}
                aria-pressed={billingCycle === 'monthly'}
                className={`px-5 py-2 rounded-full text-sm font-semibold transition-all ${
                  billingCycle === 'monthly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBillingCycle('yearly')}
                aria-pressed={billingCycle === 'yearly'}
                className={`inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-semibold transition-all ${
                  billingCycle === 'yearly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Yearly
                <span className="text-[10px] font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Save up to 60%</span>
              </button>
            </div>
          </div>

          {plans.length === 0 ? (
            <p className="text-center text-gray-500">Plans are being updated — please check back shortly.</p>
          ) : (
            <div className={`grid grid-cols-1 md:grid-cols-2 ${plans.length >= 4 ? 'xl:grid-cols-4' : 'lg:grid-cols-3'} gap-6 max-w-7xl mx-auto items-start`}>
              {plans.map((plan) => {
                const cur = symbolFor(plan.currency);
                const isMonthly = billingCycle === 'monthly';
                const monthlyPrice = plan.price * 2;
                const displayPrice = (isMonthly ? monthlyPrice : plan.price).toFixed(2);
                return (
                  <PricingCard
                    key={plan.planId}
                    title={plan.name}
                    subtitle={plan.description}
                    price={displayPrice}
                    currency={cur}
                    period="/mo"
                    originalPrice={!isMonthly ? monthlyPrice.toFixed(2) : ''}
                    discountBadge={!isMonthly ? 'Save 50%' : ''}
                    renewalPrice={isMonthly ? `Renews at ${cur}${monthlyPrice.toFixed(2)}/mo` : `Renews at ${cur}${plan.price.toFixed(2)}/mo`}
                    isPopular={plan.isPopular}
                    highlightColor="purple"
                    buttonText="Start Free Trial"
                    buttonLink={TRIAL_CTA}
                    features={[
                      ...plan.features.map((f) => ({ text: f, included: true, highlight: plan.highlightFeatures.includes(f) })),
                      ...(!isMonthly ? [{ text: '30-Day Money-Back Guarantee', included: true, highlight: true }] : []),
                    ]}
                  />
                );
              })}
            </div>
          )}
          <p className="text-center text-sm text-gray-500 mt-8">15-Day Money-Back Guarantee · Cancel Anytime</p>
        </Section>

        {/* ── Testimonials ─────────────────────────────────────────────── */}
        <Section background="white">
          <div className="text-center mb-10 sm:mb-14">
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">What our customers say</p>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>Loved by 1,000+ Businesses</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
            {TESTIMONIALS.map((t, i) => (
              <motion.div key={t.name} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: i * 0.06 }}
                className="bg-white rounded-2xl p-6 border border-gray-200 shadow-sm">
                <div className="flex gap-0.5 mb-3">{Array.from({ length: 5 }).map((_, s) => (<Star key={s} className="h-4 w-4 fill-yellow-400 text-yellow-400" />))}</div>
                <p className="text-sm text-gray-700 leading-relaxed mb-4">&ldquo;{t.quote}&rdquo;</p>
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-sm font-bold">{t.name.charAt(0)}</div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                    <p className="text-xs text-gray-500">{t.role}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </Section>

        {/* ── FAQ (two-column) ─────────────────────────────────────────── */}
        <Section background="gray">
          <div className="grid lg:grid-cols-3 gap-8 lg:gap-12">
            <div className="lg:col-span-1">
              <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">Frequently asked questions</p>
              <h2 className="text-3xl sm:text-4xl font-bold text-gray-900" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                Got Questions?<br />We&apos;ve Got Answers.
              </h2>
            </div>
            <div className="lg:col-span-2 space-y-3">
              {FAQS.map((f) => (<FAQItem key={f.question} question={f.question} answer={f.answer} />))}
            </div>
          </div>
        </Section>

        {/* ── Final CTA ────────────────────────────────────────────────── */}
        <section className="bg-gradient-to-r from-[#7C3AED] to-[#4F46E5]">
          <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 py-14 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>Ready to Launch Your Website?</h2>
            <p className="text-violet-100 mb-7 max-w-2xl mx-auto">Join 1,000+ businesses who trust Anutech for their online success.</p>
            <Link href={TRIAL_CTA} className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#22C55E] to-[#16A34A] hover:from-[#16A34A] hover:to-[#15803D] text-white font-bold py-3.5 px-8 rounded-xl shadow-lg hover:shadow-xl transition-all active:scale-95">
              <Rocket className="h-5 w-5" />
              Start Your 15-Day Free Trial
              <ArrowRight className="h-5 w-5" />
            </Link>
            <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-violet-100 mt-6">
              {['15-Day Free Trial', 'No Credit Card Required', 'Cancel Anytime'].map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" />{t}</span>
              ))}
            </div>
          </div>
        </section>

        <Footer />
      </div>

      <ErrorBoundary label="ChatWidget" fallback={null}>
        <ChatWidget />
      </ErrorBoundary>
    </div>
  );
}
