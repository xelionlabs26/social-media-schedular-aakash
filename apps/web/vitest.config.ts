import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next'],
    environment: 'node',
    // DB-backed test files share one database; run files one at a time.
    fileParallelism: false,
    env: {
      AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
  },
});
