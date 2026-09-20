import React from 'react';
import ReactDOM from 'react-dom/client';
import '@ohrganize/fonts/creato-display.css';
import '@fontsource-variable/plus-jakarta-sans';
import './design/tokens.css';
import './design/portal.css';
import { VARIANT, VARIANT_MARKER } from '@variant-manifest';
import { initTheme } from './design/theme';
import App from './App';

initTheme();
// Variante am Dokument (Marker fuer scripts/check-variant.mjs).
document.documentElement.dataset.variant = VARIANT.id;
document.documentElement.dataset.variantMarker = VARIANT_MARKER;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
