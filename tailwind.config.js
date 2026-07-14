/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Anutech brand azure — anchored on the logo/favicon blues
        // (600 = #0177E1 dominant, 500 = #0180E5, 800 = #01489D shadow-fold).
        // App-wide brand color-scheme token (Brand Step 2, app-wide pass).
        primary: {
          50: '#e9f4fe',
          100: '#cfe8fd',
          200: '#a6d4fb',
          300: '#6db8f8',
          400: '#2e9bf1',
          500: '#0180e5',
          600: '#0177e1',
          700: '#0161be',
          800: '#01489d',
          900: '#0b3a7a',
        },
      },
    },
  },
  plugins: [],
}
