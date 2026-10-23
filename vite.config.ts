import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: process.env.GAMETRACKER_VITE_OUT_DIR || 'dist',
    sourcemap:
      process.env.GAMETRACKER_VITE_SOURCEMAP === 'hidden' ? 'hidden' : false,
    rollupOptions: {
      maxParallelFileOps: 128,
    },
  },
});
