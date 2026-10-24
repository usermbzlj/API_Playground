import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiPort = Number(process.env.PORT || 8787);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    host: 'localhost',
    proxy: {
      '/api/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      '/api': { target: `http://127.0.0.1:${apiPort}` },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 650 },
});
