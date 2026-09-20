import React from 'react';
import ReactDOM from 'react-dom/client';
import '@ohrganize/fonts/creato-display.css';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './design/layout.css';
import { VARIANT, VARIANT_MARKER } from '@variant-manifest';
import { initTheme } from './design/theme';
import App from './App';

initTheme();
// Variante am Dokument: fuer Stilregeln je Ausgabe und als Marker fuer
// scripts/check-variant.mjs (die Zeichenkette muss im Bundle stehen).
document.documentElement.dataset.variant = VARIANT.id;
document.documentElement.dataset.variantMarker = VARIANT_MARKER;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
