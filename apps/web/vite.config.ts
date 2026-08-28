import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mitarbeitenden-Portal (Web). Anders als der Desktop-Renderer wird dieses
// Build über HTTP ausgeliefert: kein base './', BrowserRouter statt
// HashRouter. Der ausliefernde Server muss unbekannte Pfade auf index.html
// umschreiben (SPA-Fallback, siehe docs/web-portal.md).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
