import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A subprocess case pays a Node start plus a source transform per spawn
    // (a few seconds on a loaded machine); the default 5 s is a per-case wall
    // for pure unit tests, not for the CLI's end-to-end contract.
    testTimeout: 60_000,
    env: {
      // The subprocess suites (cli-smoke, cli-template-new, ...) run the real
      // `bin/simforge.js`. Under the development condition its `#main` import
      // and every workspace dependency resolve to source, so the suites need
      // no dist/ build of this package or of anything it depends on.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=development', '--import=tsx'].filter(Boolean).join(' '),
    },
  },
});
