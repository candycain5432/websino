import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
// Fonts first: the @font-face rules have to be in the sheet before anything reads
// `--font-display`, or the first paint lands in a fallback and reflows.
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
