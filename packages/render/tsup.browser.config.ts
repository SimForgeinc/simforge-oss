import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'web/headless': 'src/web/headless.ts' },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  // The generated `dist/harness.html` loads `web/headless.js` over `file://`,
  // so every workspace specifier reachable from it must be inlined. Only the
  // host-neutral `/shared` entry is bundled: the package root loads the N-API
  // binding and must stay external so a browser-only import fails loudly here
  // instead of shipping Node bindings into the harness.
  noExternal: [
    '@simforge-oss/asset-catalog',
    '@simforge-oss/engine',
    '@simforge-oss/native-runtime/shared',
    '@simforge-oss/openscenario',
    '@simforge-oss/playback',
    '@simforge-oss/scenario',
    '@simforge-oss/viewer',
    'fflate',
    'three',
    'zod',
  ],
  external: ['zlib'],
  clean: false,
  outDir: 'dist',
});
