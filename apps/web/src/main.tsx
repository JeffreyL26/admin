import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/source-serif-4';
import './design/tokens.css';
import './design/portal.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
