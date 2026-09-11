import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    coverage: {
      // Only the code where correctness is load-bearing. UI coverage numbers
      // are noise; these two packages decide whether the casino is honest.
      include: ['packages/fair/src/**', 'packages/engine/src/**'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
