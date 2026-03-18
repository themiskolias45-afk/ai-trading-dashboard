import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist'
  },
  server: {
    proxy: {
      // In dev, forward /api/* → local backend on port 4000
      '/api': {
        target:      'http://localhost:4000',
        changeOrigin: true,
      }
    }
  }
})
