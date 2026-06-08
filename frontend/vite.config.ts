import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Auto-update: when a new build is deployed, the service worker activates
      // immediately and reloads the app — no manual cache-clear / re-add needed.
      registerType: 'autoUpdate',
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Portfolio Tracker',
        short_name: 'Portfolio',
        description: 'Multi-client investment portfolio tracker',
        start_url: '/dashboard',
        display: 'standalone',
        background_color: '#f9fafb',
        theme_color: '#2563eb',
        orientation: 'portrait-primary',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Precache the built app shell + assets only. The API is a separate origin
        // (portfolio-api.danderud.ca) so it's never cached — data always stays live.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
