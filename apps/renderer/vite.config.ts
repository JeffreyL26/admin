import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' ist zwingend — die Desktop-App lädt den Build über file://,
// absolute Asset-Pfade würden dort ins Leere zeigen.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
