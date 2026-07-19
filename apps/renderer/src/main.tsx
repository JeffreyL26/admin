import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './design/layout.css';
import { initTheme } from './design/theme';
import App from './App';

initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
