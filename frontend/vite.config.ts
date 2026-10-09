import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist/public', emptyOutDir: false },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:3000', '/ws': { target: 'ws://127.0.0.1:3000', ws: true } },
  },
});
