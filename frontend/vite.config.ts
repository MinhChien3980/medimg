import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // REST API (Spring Boot core-service).
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      // Object storage (SeaweedFS S3). The Host header MUST stay `localhost:5173`:
      // presigned URLs are signed by the backend for that host (SigV4 signs the Host header).
      '/medimg': {
        target: 'http://localhost:8333',
        changeOrigin: false,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // Browser tests under e2e/ run with Playwright (`npm run e2e`).
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 15000,
    restoreMocks: true,
  },
});
