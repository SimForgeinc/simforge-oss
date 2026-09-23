import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./scripts/build-test-harness.mjs'],
  },
});
