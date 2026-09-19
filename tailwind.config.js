/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
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
  plugins: [],
}
