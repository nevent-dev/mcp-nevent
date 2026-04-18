import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only pick up unit/integration tests under src/tests/.
    // The tests/ directory at the project root contains standalone E2E scripts
    // (e.g. analytics-e2e.test.ts) that require live credentials and are not
    // meant to be executed as part of the Vitest suite.
    include: ['src/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.config.ts',
      ],
    },
  },
});
