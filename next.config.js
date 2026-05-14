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

  // API versioning: /api/v1/<anything> is a stable alias for the current
  // /api/<anything> route. Clients can opt into the versioned URL at their pace.
  // When a breaking change is needed in the future, add a sibling
  // /api/v2/<anything> route handler and leave v1 untouched. Middleware
  // strips the /api/v1/ prefix when classifying admin/public API paths
  // (see middleware.ts).
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: '/api/:path*',
      },
    ];
  },
}

module.exports = withBundleAnalyzer(nextConfig);