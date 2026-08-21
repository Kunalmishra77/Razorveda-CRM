import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. The RLS isolation suite lives in test/rls/ and is excluded
 * here on purpose: it requires a live database and must FAIL rather than skip
 * when one is absent. A test that silently skips turns "we never ran it" into
 * "it passed", which for RLS is the one failure mode we cannot afford.
 *
 * Run it with: npm run test:rls -w @razorveda/api
 */
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/rls/**'] },
});
