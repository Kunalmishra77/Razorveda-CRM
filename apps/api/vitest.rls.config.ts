import { defineConfig } from 'vitest/config';

/** Database-backed isolation suite. Requires DATABASE_URL. Never skips. */
export default defineConfig({
  test: { include: ['test/rls/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
