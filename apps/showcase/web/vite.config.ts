import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/artifacts': 'http://127.0.0.1:4317',
    },
  },
  build: { outDir: 'dist' },
});
