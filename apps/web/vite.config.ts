import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { variantAliases } from '../../scripts/variant-alias.mjs';

// Mitarbeitenden-Portal (Web). Anders als der Desktop-Renderer wird dieses
// Build über HTTP ausgeliefert: kein base './', BrowserRouter statt
// HashRouter. Der ausliefernde Server muss unbekannte Pfade auf index.html
// umschreiben (SPA-Fallback, siehe docs/web-portal.md).
//
// @variant / @variant-manifest: Verdrahtung der Variante aus OHRGANIZE_VARIANT
// (Vorgabe: default aus dem Register), siehe scripts/variant-alias.mjs.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: variantAliases(import.meta.dirname, { wiringExt: '.tsx' }),
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
