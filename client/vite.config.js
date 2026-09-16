import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // The face-api model files (and manifest/logo/service worker) live in the
  // true repo root's public/ — server/src/lib/faceEngine.js reads them
  // directly off disk too, so this folder is shared between client and
  // server rather than living inside either one.
  publicDir: '../public',
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        // Overridable so the browser-E2E harness can point the same proxy at
        // its isolated API instance. Keeping the client on ONE origin is not
        // cosmetic: the refresh cookie is SameSite=Lax outside production, so
        // talking to a different origin in dev silently breaks session restore
        // on reload. Production is genuinely cross-site (Vercel + Render) and
        // uses SameSite=None + Secure instead — see server/src/lib/tokens.js.
        target: process.env.VITE_DEV_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('jspdf') || id.includes('html2canvas')) {
              return 'vendor-pdf';
            }
            if (id.includes('xlsx')) {
              return 'vendor-excel';
            }
            if (id.includes('face-api.js')) {
              return 'vendor-faceapi';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('react-router-dom') || id.includes('react-dom') || id.includes('react')) {
              return 'vendor-react';
            }
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-utils/setup.js',
    globals: false,
    // The browser E2E specs under e2e/ are Playwright's, and Playwright's
    // test.describe() throws when a different runner imports it. Vitest owns
    // the component/unit tests under src/ only.
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
