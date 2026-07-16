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
})
