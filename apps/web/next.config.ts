import type { NextConfig } from 'next';
import path from 'node:path';

// Load the repo-root .env for local development (hosts like Railway inject env vars directly).
try {
  process.loadEnvFile(path.join(import.meta.dirname, '../../.env'));
} catch {
  /* no .env file */
}

/**
 * The public address from APP_URL. Behind a forwarding proxy (GitHub Codespaces, some hosts) the
 * request's Host header is the internal one (localhost:3000), so Next.js would reject server
 * actions (login, saving text) from the public address unless it is listed here.
 */
const publicUrl = (() => {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL) : undefined;
  } catch {
    return undefined;
  }
})();

const nextConfig: NextConfig = {
  transpilePackages: ['@app/core', '@app/db'],
  serverExternalPackages: ['pg', 'pg-boss', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  poweredByHeader: false,
  allowedDevOrigins: publicUrl ? [publicUrl.hostname] : [],
  experimental: {
    serverActions: {
      // Server actions only carry text; videos go to storage with signed URLs.
      bodySizeLimit: '2mb',
      allowedOrigins: publicUrl ? [publicUrl.host] : [],
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
