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
      workbox: {
        // The API is never cached or answered by the service worker.
        navigateFallbackDenylist: [/^\/api\//],
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
