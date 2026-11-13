import type { NextConfig } from 'next';
import path from 'node:path';

// Load the repo-root .env for local development (hosts like Railway inject env vars directly).
try {
  process.loadEnvFile(path.join(import.meta.dirname, '../../.env'));
} catch {
  /* no .env file */
}

const nextConfig: NextConfig = {
  transpilePackages: ['@app/core', '@app/db'],
  serverExternalPackages: ['pg', 'pg-boss', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Server actions only carry text; videos go to storage with signed URLs.
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
