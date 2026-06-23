import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
      '/rides': {
        target: 'http://localhost:8765',
      },
      '/api': {
        target: 'http://localhost:8765',
      },
    },
  },
})
