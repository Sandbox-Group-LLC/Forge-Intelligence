import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4000,
    strictPort: false,
    hmr: false,
    allowedHosts: true
  },
  preview: {
    host: '0.0.0.0',
    port: 4000
  }
})
