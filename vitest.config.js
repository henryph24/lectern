import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.js'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.js'],
          setupFiles: ['test/setup-env.js'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
