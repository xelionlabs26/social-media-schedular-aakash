import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    // Several DB test files share one test database and ffmpeg tests are CPU heavy.
    fileParallelism: false,
    env: {
      AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
  },
});
