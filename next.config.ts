import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['puppeteer', 'puppeteer-core'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'dcld85wa7rf0u.cloudfront.net' },
      { protocol: 'https', hostname: '**.cloudfront.net' },
      { protocol: 'https', hostname: 'cdn.sanity.io' },
      { protocol: 'https', hostname: 'static.wixstatic.com' },
      // Add gallery domains here as new venues are scraped
    ],
  },
};

export default nextConfig;
