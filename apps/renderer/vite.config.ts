import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { variantAliases } from '../../scripts/variant-alias.mjs';

// base: './' ist zwingend: Die Desktop-App lädt den Build über file://,
// absolute Asset-Pfade würden dort ins Leere zeigen.
//
// @variant / @variant-manifest zeigen auf die Verdrahtungsdatei der Variante
// aus OHRGANIZE_VARIANT (Vorgabe: default aus dem Register); nur deren Module
// landen im Bundle. Typecheck und tsx lesen dieselben Aliasse aus tsconfig.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: variantAliases(import.meta.dirname, { wiringExt: '.ts' }),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
