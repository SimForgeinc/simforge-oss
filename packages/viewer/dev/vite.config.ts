import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';

// `editor.html` mounts the React surface, and this package declares react as
// a peer dependency rather than owning a copy. Both specifiers are pinned to
// the Studio app's install -- the pairing that actually ships -- so the page
// cannot end up with two React instances and dead hooks.
const studioRequire = createRequire(path.join(__dirname, '../../../studio/package.json'));

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      react: path.dirname(studioRequire.resolve('react/package.json')),
      'react-dom': path.dirname(studioRequire.resolve('react-dom/package.json')),
    },
  },
  server: { port: 5177, strictPort: true, fs: { allow: ['../..', '../../..'] } },
});
