import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // NEXUS tests must be deterministic: no shared global state between files.
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
});
