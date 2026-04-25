import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev, Vite serves the SPA on :5173 and proxies /api/v1 + WebSocket to the FastAPI app on :8000.
// In production, FastAPI serves the built dist directly.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
