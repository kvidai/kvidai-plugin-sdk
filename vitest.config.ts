import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // templates/ holds .tmpl files, but keep any stray test there out of the SDK's own run
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
      reporter: ['text', 'text-summary'],
    },
  },
});
