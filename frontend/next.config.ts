import type { NextConfig } from "next";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const nextConfig: NextConfig = {
  devIndicators: false,
  
  // Increase body size limit for file uploads
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
    // Increase proxy body size limit for large file uploads (50MB)
    proxyClientMaxBodySize: '50mb',
  },

  // Enable keepAlive for proxy connections (helps with long-running requests)
  httpAgentOptions: {
    keepAlive: true,
  },
  
  // Proxy API requests to backend (except auth routes)
  async rewrites() {
    return [
      {
        source: '/api/auth/:path*',
        destination: '/api/auth/:path*', // Keep auth routes local to Next.js
      },
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
