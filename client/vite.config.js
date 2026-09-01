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
        target: 'http://localhost:4000',
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
  },
})
