import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { applyTheme, cachedTheme } from './lib/theme.js';
// Fonts first: the @font-face rules have to be in the sheet before anything reads
// `--font-display`, or the first paint lands in a fallback and reflows.
import './styles/fonts.css';
import './styles/tokens.css';
// After the tokens they override, and before anything that reads them.
import './styles/themes.css';
import './styles/base.css';

/*
 * The theme goes on before React does.
 *
 * Reading the cached choice here, synchronously, is what stops every load painting the
 * default green for as long as it takes the account to answer and then snapping to the
 * chosen room. The account is still the authority - the settings screen reconciles with
 * it - but the first frame has to be drawn from something, and a stale guess that is
 * almost always right beats a correct answer that arrives after the paint.
 */
applyTheme(cachedTheme());

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
