/** @type {import('next').NextConfig} */
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Production optimizations for security
  compiler: {
    // Strips console.* calls from the CLIENT bundle only (browser JS).
    // Server-side code (API routes, middleware, server components) is NOT affected —
    // those logs still reach Cloud Logging. Use serverLogger for structured server logs.
    removeConsole: process.env.NODE_ENV === "production",
  },

  // Disable source maps in production (prevent code inspection)
  productionBrowserSourceMaps: false,
  // Enable standalone output for Docker
  output: 'standalone',

  serverExternalPackages: ['@google-cloud/tasks'],
}

module.exports = withBundleAnalyzer(nextConfig);