#!/usr/bin/env node
// `#main` is the package's private entry (package.json "imports"): the built
// dist/main.js, or src/main.ts under the `development` condition, so a
// workspace checkout runs the CLI from source like every other package.
await import('#main');
