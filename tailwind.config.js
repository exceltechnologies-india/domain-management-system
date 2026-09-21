/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontSize: {
        /* Micro-label size used by sidebar section headings and table headers.
           Ported alongside the ResellerOS colour tokens — two agents reached
           for `text-3xs` from that design language and had to fall back to
           `text-[10px]` because it did not exist here. Same computed value. */
        '3xs': ['0.625rem', { lineHeight: '1rem' }],
      },
      fontFamily: {
        /* Display serif for the ported ResellerOS surfaces.
           NOT next/font/google: this app deliberately self-hosts Inter because
           fonts.googleapis.com was unreachable during the 2026-06-20 deploy
           (see app/layout.tsx). Reaching for a Google-hosted DM Serif Display
           here would walk straight back into that. A system serif stack costs
           one download less and cannot fail a build. */
        serif: ['Georgia', 'Cambria', '"Times New Roman"', 'serif'],
      },
      colors: {
        /* ─── ResellerOS tokens — see :root in app/globals.css ───────────────
           Additive. The `primary` scale below is untouched, so no existing
           screen changes; these exist for surfaces ported from the billing app. */
        paper: {
          DEFAULT: 'hsl(var(--paper) / <alpha-value>)',
          2: 'hsl(var(--paper-2) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'hsl(var(--ink) / <alpha-value>)',
          2: 'hsl(var(--ink-2) / <alpha-value>)',
          3: 'hsl(var(--ink-3) / <alpha-value>)',
          4: 'hsl(var(--ink-4) / <alpha-value>)',
        },
        hairline: {
          DEFAULT: 'hsl(var(--hairline) / <alpha-value>)',
          strong: 'hsl(var(--hairline-strong) / <alpha-value>)',
        },
        amber: {
          DEFAULT: 'hsl(var(--amber) / <alpha-value>)',
          soft: 'hsl(var(--amber-soft) / <alpha-value>)',
          ink: 'hsl(var(--amber-ink) / <alpha-value>)',
        },
        /* Status + info. Tailwind already ships `emerald`/`rose`/`indigo`
           scales; these DEFAULT/soft/ink keys extend them, so `bg-emerald-50`
           and friends keep working while `bg-emerald-soft` becomes available. */
        emerald: {
          DEFAULT: 'hsl(var(--emerald) / <alpha-value>)',
          soft: 'hsl(var(--emerald-soft) / <alpha-value>)',
          ink: 'hsl(var(--emerald-ink) / <alpha-value>)',
        },
        rose: {
          DEFAULT: 'hsl(var(--rose) / <alpha-value>)',
          soft: 'hsl(var(--rose-soft) / <alpha-value>)',
          ink: 'hsl(var(--rose-ink) / <alpha-value>)',
        },
        indigo: {
          DEFAULT: 'hsl(var(--indigo) / <alpha-value>)',
          soft: 'hsl(var(--indigo-soft) / <alpha-value>)',
          ink: 'hsl(var(--indigo-ink) / <alpha-value>)',
        },
        // Anutech brand azure — anchored on the logo/favicon blues
        // (600 = #0177E1 dominant, 500 = #0180E5, 800 = #01489D shadow-fold).
        // App-wide brand color-scheme token (Brand Step 2, app-wide pass).
        // Driven by CSS variables (see app/globals.css :root) so the palette
        // can be re-themed at runtime — the public frontend switches to violet
        // via <html data-theme="landing"> when the landing is the homepage.
        primary: {
          50: 'rgb(var(--primary-50) / <alpha-value>)',
          100: 'rgb(var(--primary-100) / <alpha-value>)',
          200: 'rgb(var(--primary-200) / <alpha-value>)',
          300: 'rgb(var(--primary-300) / <alpha-value>)',
          400: 'rgb(var(--primary-400) / <alpha-value>)',
          500: 'rgb(var(--primary-500) / <alpha-value>)',
          600: 'rgb(var(--primary-600) / <alpha-value>)',
          700: 'rgb(var(--primary-700) / <alpha-value>)',
          800: 'rgb(var(--primary-800) / <alpha-value>)',
          900: 'rgb(var(--primary-900) / <alpha-value>)',
        },
      },
    },
  },
  /* `animate-in`, `fade-in`, `zoom-in-95` and `slide-in-from-right` were
     already written across ~10 places in this app — every admin modal, the
     pending-domains drawer, the admin content wrapper. None of them did
     anything: the utilities come from this plugin and it was never installed,
     so the classes were inert strings that read exactly like working
     animation. ResellerOS has had it all along, which is where the idiom came
     from. Installing it makes those sites behave the way they are written. */
  plugins: [require('tailwindcss-animate')],
}
