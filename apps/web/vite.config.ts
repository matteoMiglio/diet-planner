import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // A custom service worker, because reminders need push and notificationclick handlers.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Precache the barcode reader's WebAssembly too, so scanning works offline.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      // Icons are generated from public/icon.svg at build time.
      // index.html sets light/dark theme colours itself.
      pwaAssets: { image: 'public/icon.svg', injectThemeColor: false },
      manifest: {
        name: 'Diet Planner',
        short_name: 'Diet',
        description: 'Plan, check in, and track the diet.',
        start_url: '/',
        display: 'standalone',
        background_color: '#f6f5f1',
        theme_color: '#2f6b4f',
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
